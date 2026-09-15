import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { paths, resolveSkinDir } from '../lib/paths.ts';
import { parseFit, processRecords } from '../modules/fit.ts';
import type { ProcessedSamples } from '../modules/fit.ts';
import { renderWindowToCache, skinHash, lookupCache, cacheKey } from '../modules/render.ts';
import { hashFile, waitSwapBudget } from '../lib/util.ts';
import type { ConfigRef, LogFn } from './services/config.ts';

// render 注入参数（生产 = renderWindowToCache；测试传 fake 记录 spec）
export interface PregenRenderSpec {
  skinDir: string;
  fitFile: string;
  samples: ProcessedSamples;
  width: number;
  height: number;
  fps: number;
  fromFitS: number;
  toFitS: number;
  tabs: number;
  log: (msg: string) => void;
}
export type PregenRenderFn = (spec: PregenRenderSpec) => Promise<unknown>;

export interface PregenOptions {
  configRef: ConfigRef;
  queue?: { running: boolean } | null;
  log?: LogFn;
  render?: PregenRenderFn | null;
  cacheComplete?: ((key: string) => boolean | Promise<boolean>) | null;
  idlePollMs?: number;
}

// FIT 库监听 → 串行预生成 PNG 序列。Strava 同步、手动载入、API 上传的 .fit 都落进库目录，
// watcher 即「有了 FIT 就自动跑渲染」的统一挂钩；任务渲染同 key 直接 cache HIT。
// 资源纪律：一次只跑一个；生产队列忙或 swap 风暴时等待——预生成是闲时加速，不抢生产资源。
export class PregenService {
  configRef: ConfigRef;
  queue: { running: boolean } | null;
  log: LogFn;
  render: PregenRenderFn;
  cacheComplete: (key: string) => boolean | Promise<boolean>;
  idlePollMs: number;
  pending: Set<string>; // 去重：同一 FIT 在队/在渲染只算一份
  fifo: string[];
  working: boolean;
  watcher: FSWatcher | null;

  // render / cacheComplete 可注入（测试用 fake）；生产默认走真实渲染与缓存索引
  constructor({ configRef, queue = null, log = console.log, render = null, cacheComplete = null, idlePollMs = 15000 }: PregenOptions) {
    this.configRef = configRef;
    this.queue = queue;
    this.log = log;
    this.render = render ?? (renderWindowToCache as any); // render.ts 的 spec.samples 声明为 SamplesGrid，与 fit.ts 实际产出的 ProcessedSamples 存在领域类型差（见汇报）
    this.cacheComplete = cacheComplete ?? ((key: string) => !!lookupCache(key));
    this.idlePollMs = idlePollMs;
    this.pending = new Set();
    this.fifo = [];
    this.working = false;
    this.watcher = null;
  }

  // 队列消化完毕（测试与停机用）
  async whenIdle() {
    while (this.working || this.fifo.length) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async start() {
    const cfg = this.configRef.current;
    if (cfg.pregen?.enabled === false) {
      this.log('[pregen] 已禁用（pregen.enabled=false）');
      return;
    }
    const dirs = new Set([cfg.fit_library_dir ?? paths.fits]);
    if (cfg.fit_watch_dir) dirs.add(cfg.fit_watch_dir); // 额外监听源（如 Strava 之外的导出入口）
    const { watch } = await import('chokidar');
    this.watcher = watch([...dirs], {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    });
    this.watcher.on('add', (p) => {
      if (p.toLowerCase().endsWith('.fit')) this.enqueue(p);
    });
    this.log(`[pregen] 监听 FIT 库：${[...dirs].join('、')}（新 FIT 自动生成 PNG 序列）`);

    // 启动补扫：近期入库但缓存缺失的 FIT（服务停机期间同步进来的）
    const bootDays = cfg.pregen?.boot_days ?? 7;
    if (bootDays > 0) {
      const cutoff = Date.now() - bootDays * 86400_000;
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.toLowerCase().endsWith('.fit')) continue;
          const p = path.join(dir, f);
          try {
            if (fs.statSync(p).mtimeMs >= cutoff) this.enqueue(p);
          } catch {
            // 文件刚好被挪走：跳过
          }
        }
      }
    }
  }

  enqueue(fitFile: string) {
    if (this.pending.has(fitFile)) return;
    this.pending.add(fitFile);
    this.fifo.push(fitFile);
    this.#pump();
  }

  async stop() {
    await this.watcher?.close();
    this.watcher = null;
  }

  async #pump() {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const fitFile = this.fifo.shift();
        if (!fitFile) break;
        try {
          await this.#renderOne(fitFile);
        } catch (e) {
          this.log(`[pregen] 失败 ${path.basename(fitFile)}: ${(e as Error).message}`);
        } finally {
          this.pending.delete(fitFile);
        }
      }
    } finally {
      this.working = false;
    }
  }

  async #renderOne(fitFile: string) {
    const cfg = this.configRef.current;
    const skinDir = resolveSkinDir(cfg.skin);
    if (!skinDir || !fs.existsSync(skinDir)) {
      this.log(`[pregen] 皮肤不存在 ${cfg.skin}，跳过 ${path.basename(fitFile)}`);
      return;
    }
    const { records } = parseFit(fitFile);
    const samples = processRecords(records, { smoothWindowS: cfg.smooth_window_s });
    const fps = cfg.pregen?.fps ?? cfg.overlay_fps; // null = 跟随生产规格，任务渲染直接 HIT
    const fitHashValue = await hashFile(fitFile);
    const skinHashValue = await skinHash(skinDir);
    for (const res of cfg.pregen?.resolutions ?? []) {
      const [w, h] = String(res).split('x').map(Number);
      const key = cacheKey({ fitHashValue, skinHashValue, width: w, height: h, fps });
      if (await this.cacheComplete(key)) {
        this.log(`[pregen] 缓存已存在，跳过 ${path.basename(fitFile)} ${w}x${h}@${fps}`);
        continue;
      }
      // 闲时纪律：生产队列忙 → 等空闲；swap 风暴 → 等平息
      if (this.queue?.running) {
        this.log('[pregen] 任务队列忙，等空闲…');
        while (this.queue?.running) {
          await new Promise((r) => setTimeout(r, this.idlePollMs));
        }
      }
      await waitSwapBudget({ budgetMb: cfg.max_swap_mb, log: (m: string) => this.log(`[pregen] ${m}`) });
      this.log(`[pregen] 渲染 ${path.basename(fitFile)} ${w}x${h}@${fps}（0..${samples.count - 1}s）`);
      await this.render({
        skinDir,
        fitFile,
        samples,
        width: w,
        height: h,
        fps,
        fromFitS: 0,
        toFitS: samples.count - 1,
        tabs: cfg.render_tabs,
        log: (m: string) => this.log(`[pregen] ${m}`),
      });
      this.log(`[pregen] 完成 ${key}`);
    }
  }
}
