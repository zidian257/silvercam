// 快剪任务服务：对已出片任务（jobs done）做「L0 确定性分析 → 硬编渲染」。
// 两条路：
//   粗剪——create 只给 job_id，服务端 assembleHeuristic 从事件菜单兜底圈 ~30s；
//   精剪——agent（pi + quickcut skill）先 POST /quickcuts/analyze 拿事件菜单，
//         抽帧验证后把精确剪辑点 cuts 交给 create 渲染。
// 快剪是轻任务（~30s 硬编），走自己的串行通道一次一个，不挤主队列 JobQueue。
// 记录持久化 <ACTPIPE_HOME>/quickcuts.json；渲染不可断点续跑，进程重启时中间态任务直接标记 failed。
// 注意：Feathers wrapService 用 Object.create(实例) 的包装对象调方法，ES #私有方法会丢品牌检查
// （Receiver must be an instance of class）——Feathers service 只能用 TS private（擦除型），不能跑 #。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BadRequest, NotFound } from '@feathersjs/errors';
import { paths, ensureDirs } from '../lib/paths.ts';
import { readJson, run, writeJsonAtomic } from '../lib/util.ts';
import { assembleHeuristic, detectEvents, normalizeSamples, planFromCuts, quickcutOutputPathFor, renderQuickcut } from '../modules/quickcut.ts';
import type { QuickcutPlan, QuickcutSegment } from '../modules/quickcut.ts';
import type { Job, SegmentArtifacts } from '../types.ts';
import type { ConfigRef, LogFn } from './services/config.ts';

export type QuickcutState = 'queued' | 'analyzing' | 'rendering' | 'done' | 'failed';

export interface QuickcutCut {
  start: number;
  end: number;
  label?: string;
}

export interface QuickcutRecord {
  id: string;
  job_id: string;
  cuts: QuickcutCut[] | null; // 创建入参：外部指定的精确剪辑点；null = 服务端兜底粗剪
  state: QuickcutState;
  percent: number;
  plan: QuickcutPlan | null;
  out: string | null;
  error: string | null;
  created_at: string;
}

// 任务来源的结构面：只需要按 id 查任务（生产 JobQueue 与测试桩都满足）
export interface JobLookup {
  get(id: string): Job | null;
}

// 渲染依赖注入口：与 renderQuickcut 签名兼容（测试注入 stub 避免真编码）
export type QuickcutRenderFn = (args: {
  video: string;
  acts: { start: number; end: number }[];
  out: string;
  log: (msg: string) => void;
  onProgress: (percent: number) => void;
}) => Promise<{ out: string; durationS: number }>;

export interface QuickcutDeps {
  queue: JobLookup;
  configRef: ConfigRef;
  log?: LogFn;
  render?: QuickcutRenderFn;
}

// 视频真实时长用 ffprobe 读输出文件本身，不信各段 probe 之和（封装间隙/精度会累计误差）
async function probeDurationS(file: string): Promise<number> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(r.stdout.trim());
  if (r.code !== 0 || !Number.isFinite(d) || d <= 0) throw new Error(`ffprobe 读取时长失败: ${file}`);
  return d;
}

export class QuickcutService {
  queue: JobLookup;
  configRef: ConfigRef;
  log: LogFn;
  render: QuickcutRenderFn;
  file: string;
  items: QuickcutRecord[];
  lane: Promise<unknown>; // 串行消化通道：上一个任务的 promise 链下一个

  constructor({ queue, configRef, log = console.log, render = renderQuickcut }: QuickcutDeps) {
    this.queue = queue;
    this.configRef = configRef;
    this.log = log;
    this.render = render;
    ensureDirs();
    this.file = path.join(paths.home, 'quickcuts.json');
    this.items = readJson<QuickcutRecord[]>(this.file, []);
    // 进程重启时处于中间态的任务标记 failed（渲染不可续跑，重来即新建任务）
    let interrupted = 0;
    for (const it of this.items) {
      if (it.state !== 'done' && it.state !== 'failed') {
        it.state = 'failed';
        it.error = '进程重启中断';
        interrupted++;
      }
    }
    if (interrupted) {
      this.save();
      this.log(`[quickcuts] ${interrupted} 个中间态任务因进程重启标记为失败`);
    }
    this.lane = Promise.resolve();
  }

  async find() {
    // 新 → 旧
    return this.items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(id: string) {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new NotFound('not found');
    return it;
  }

  async create(data: any) {
    const body = data ?? {};
    if (typeof body.job_id !== 'string' || !body.job_id) throw new BadRequest('job_id required');
    const job = this.queue.get(body.job_id);
    if (!job) throw new BadRequest(`job not found: ${body.job_id}`);
    this.prepare(job); // state/output/samples/segments 校验，不满足即 400

    // 外部指定剪辑点（agent 精剪）；缺省则 run 阶段用兜底组装
    let cuts: QuickcutCut[] | null = null;
    if (body.cuts != null) {
      try {
        planFromCuts(body.cuts); // 干跑一次做校验（400 而非建出注定失败的任务）
      } catch (e) {
        throw new BadRequest((e as Error).message);
      }
      cuts = body.cuts;
    }

    const rec: QuickcutRecord = {
      id: crypto.randomUUID().slice(0, 8),
      job_id: job.id,
      cuts,
      state: 'queued',
      percent: 0,
      plan: null,
      out: null,
      error: null,
      created_at: new Date().toISOString(),
    };
    this.items.push(rec);
    this.save();
    this.enqueue(rec);
    return { ...rec }; // 返回快照：异步消化立即开始，调用方拿到的是入队时刻
  }

  // POST /quickcuts/analyze { job_id }：只分析不渲染——事件菜单 + 兜底计划 + 视频信息。
  // 快剪 agent 的路标：菜单里 videoS=null 的事件不在任何段覆盖内，不可用于剪辑。
  async analyze(data: any) {
    const body = data ?? {};
    if (typeof body.job_id !== 'string' || !body.job_id) throw new BadRequest('job_id required');
    const job = this.queue.get(body.job_id);
    if (!job) throw new BadRequest(`job not found: ${body.job_id}`);
    const { video, grid, segments } = this.prepare(job);
    const samples = normalizeSamples(grid.samples, grid.t0_ms);
    const videoDurationS = await probeDurationS(video);
    return {
      job_id: job.id,
      video,
      videoDurationS,
      segments,
      events: detectEvents(samples, { segments, videoDurationS }),
      plan: assembleHeuristic({ samples, segments, videoDurationS }),
    };
  }

  // ---------- 内部 ----------

  private save() {
    writeJsonAtomic(this.file, this.items);
  }

  // 串行通道：任务按入队顺序逐个消化；单个失败不断链（run 内部已兜底）
  private enqueue(rec: QuickcutRecord) {
    this.lane = this.lane.then(() => this.run(rec)).catch(() => {});
  }

  // 从任务产物推导快剪输入：merged 成片、FIT 样本网格、逐段映射（videoT = fitElapsed − offsetSeconds）。
  // 合并任务读 <dir>/seg<i>/，单段任务读 <dir>/ 本身；seg 的 offset 优先取 artifacts，缺了读 session.json。
  // create 阶段调用即 400 校验；run 阶段再调一次取数（失败则任务转 failed）。
  private prepare(job: Job): { video: string; grid: any; segments: QuickcutSegment[] } {
    if (job.state !== 'done') throw new BadRequest(`任务 ${job.id} 状态为 ${job.state}，快剪需要已出片（done）任务`);
    const video = job.artifacts?.output;
    if (!video || !fs.existsSync(video)) throw new BadRequest(`任务 ${job.id} 的成片文件不存在（${video ?? '无 output'}）`);

    const merged = !!job.artifacts?.segments?.length;
    const segArts: (SegmentArtifacts | undefined)[] = merged ? job.artifacts.segments! : [job.artifacts];
    const segDir = (i: number) => (merged ? path.join(job.dir, `seg${i}`) : job.dir);

    const grid = readJson(path.join(segDir(0), 'samples.json')) as any; // 各段共享同一 FIT，seg0 即全程样本
    if (!grid || !Number.isFinite(grid.t0_ms) || !Array.isArray(grid.samples) || !grid.samples.length) {
      throw new BadRequest(`任务 ${job.id} 缺少 FIT 样本（seg0/samples.json），不支持快剪`);
    }

    let videoStartS = 0;
    const segments: QuickcutSegment[] = segArts.map((art, i) => {
      const durationS: unknown = art?.probe?.duration;
      const session = art?.session ?? (readJson(path.join(segDir(i), 'session.json')) as any);
      const offsetSeconds: unknown = session?.offset_seconds;
      if (typeof durationS !== 'number' || !Number.isFinite(durationS) || typeof offsetSeconds !== 'number' || !Number.isFinite(offsetSeconds)) {
        throw new BadRequest(`任务 ${job.id} 第 ${i + 1} 段缺少 probe 时长或 offset`);
      }
      const seg: QuickcutSegment = { videoStartS, durationS, offsetSeconds };
      videoStartS += durationS;
      return seg;
    });
    return { video, grid, segments };
  }

  private async run(rec: QuickcutRecord): Promise<void> {
    try {
      const job = this.queue.get(rec.job_id);
      if (!job) throw new Error(`job not found: ${rec.job_id}`);
      const { video, grid, segments } = this.prepare(job);

      // analyzing：外部给了 cuts 就直接采纳，否则 L0 兜底组装圈幕
      rec.state = 'analyzing';
      this.save();
      if (rec.cuts) {
        rec.plan = planFromCuts(rec.cuts);
      } else {
        const samples = normalizeSamples(grid.samples, grid.t0_ms);
        const videoDurationS = await probeDurationS(video);
        rec.plan = assembleHeuristic({ samples, segments, videoDurationS });
      }
      this.save();
      this.log(`[quickcuts] ${rec.id}: ${rec.cuts ? '外部剪辑点' : 'L0 兜底'}出 ${rec.plan.acts.length} 幕共 ${rec.plan.totalS.toFixed(1)}s（丢弃 ${rec.plan.dropped.length} 幕）`);

      // rendering：N 幕 trim + concat 单次硬编；输出与成片同目录（重名自增）
      rec.state = 'rendering';
      this.save();
      const out = quickcutOutputPathFor(video);
      const r = await this.render({
        video,
        acts: rec.plan!.acts,
        out,
        log: (m: string) => this.log(m),
        onProgress: (p: number) => {
          rec.percent = p; // 进度只留在内存（轮询可读），状态迁移才落盘
        },
      });
      rec.out = r.out;
      rec.percent = 100;
      rec.state = 'done';
      this.save();
      this.log(`[quickcuts] ${rec.id}: done → ${r.out}`);
    } catch (e) {
      rec.error = (e as Error).message;
      rec.state = 'failed';
      this.save();
      this.log(`[quickcuts] ${rec.id}: FAILED ${rec.error}`);
    }
  }
}
