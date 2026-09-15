import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { paths, resolveSkinDir, ensureDirs } from '../lib/paths.ts';
import { loadConfig, resolveLutPath, saveConfig } from '../lib/config.ts';
import { fmtDuration, readJson, round, writeJsonAtomic } from '../lib/util.ts';
import * as interact from '../modules/interact.ts';
import { ingestFile } from '../modules/ingest.ts';
import { probeFile, decideLut } from '../modules/probe.ts';
import { fitToFiles } from '../modules/fit.ts';
import { renderWindowToCache, skinHash, lookupCache, cacheKey } from '../modules/render.ts';
import { composeVideo, outputPathFor, rawOutputPathFor, mergedOutputPathFor, concatVideos } from '../modules/compose.ts';
import { ensureDir, hashFile, waitSwapBudget } from '../lib/util.ts';
import { runPipeline } from './pipeline.ts';
import type {
  ActpipeConfig,
  FramesArtifact,
  Job,
  JobParams,
  JobState,
  LutDecision,
  ProgressPayload,
  ProbeResult,
  SamplesGrid,
  SessionInfo,
} from '../types.ts';

// 已处理文件记账 store（实现见 lib/db.ts，归其代理）：队列只消费 markProcessed 一个方法
export interface ProcessedStore {
  markProcessed(entry: { path: string; size: number; mtime: number; jobId: string }): void;
}

// 入队参数：JobParams 的可选子集，缺省字段由 add() 按配置补齐
export type AddJobParams = Partial<JobParams> & Pick<JobParams, 'video'>;

// 合并任务单段的阶段进度：阶段名 → 进行中百分比 | 'done'（未开始 = 键不存在）
export type MergeStageProgress = Record<string, number | 'done' | undefined>;

// pipeline.ts 的任务/事件结构（其导出类型由其代理补齐，此处先本地定义）
type PipelineTask = { name: string; lane: string; deps: string[]; run: (signal: AbortSignal) => Promise<void> };
type PipelineLaneEvent = { type: 'start' | 'end'; name: string; lane: string };

export const STATES = ['queued', 'ingesting', 'probing', 'awaiting_fit', 'rendering', 'encoding', 'copying', 'done', 'failed'] as const;

// progress 事件按字段独立到达（ffmpeg -progress 的 out_time_ms/fps/speed 各发各的），
// 必须合并而非覆盖——否则 percent 刚写入就被 speed 冲掉（分段 encode 进度卡段基底的 bug）
export function mergeProgress(prev: ProgressPayload | null | undefined, payload: ProgressPayload): ProgressPayload {
  return { ...(prev ?? {}), ...payload };
}

// 合并任务段内阶段耗时权重（实测 4K50 10bit 流水线：ingest≈7min / probe+fit≈1.5min / render≈13min / encode≈41min@0.6x）
export const MERGE_STAGE_WEIGHTS = { ingest: 0.12, prep: 0.02, render: 0.2, encode: 0.66 };

// 合并任务整体进度：各段按权重折算后取均值；concat 固定占最后 1%
// segStages[i][stage] = 进行中百分比（number）| 'done' | undefined（未开始）
export function mergeJobPercent(segStages: MergeStageProgress[]): number {
  const n = segStages.length;
  if (!n) return 0;
  let sum = 0;
  for (const s of segStages) {
    for (const [stage, w] of Object.entries(MERGE_STAGE_WEIGHTS)) {
      const v = s[stage];
      if (v === 'done') sum += w;
      else if (typeof v === 'number') sum += (w * Math.min(100, Math.max(0, v))) / 100;
    }
  }
  return Math.min(99, Math.round((sum / n) * 990) / 10);
}

// FIT 锚定失败的专用错误：流水线取消其余段，任务转 awaiting_fit 而非 failed
export class AwaitFitError extends Error {
  segIndex: number;
  constructor(message: string, segIndex: number) {
    super(message);
    this.name = 'AwaitFit';
    this.segIndex = segIndex;
  }
}

export class JobQueue extends EventEmitter {
  config: ActpipeConfig;
  store: ProcessedStore | null;
  jobs: Map<string, Job>;
  running: boolean;
  currentId: string | null;
  _cardDeps: number;

  constructor({ config = null, store = null }: { config?: ActpipeConfig | null; store?: ProcessedStore | null } = {}) {
    super();
    this.config = config ?? loadConfig();
    this.store = store;
    this.jobs = new Map();
    this.running = false;
    this.currentId = null;
    ensureDirs();
    this.#loadExisting();
    // 卡依赖计数基线：从「>0」掉到「0」的瞬间发一次「可以卸载 SD 卡」通知（见 #maybeNotifyCardFree）
    this._cardDeps = this.#cardDepsPending();
    this.#kick(); // 启动即续跑遗留的 queued 任务（#loadExisting 只改状态不驱动队列）
  }

  // 还没完成拷贝、后续步骤仍需插卡的入队任务段数
  //（origin 预拷贝的读 staging、非卡来源的直读，都不算卡依赖）
  #cardDepsPending(): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (['done', 'failed'].includes(j.state)) continue;
      if ((j.params.segments?.length ?? 0) > 1) {
        j.params.segments!.forEach((s, i) => {
          if (!s.origin && s.video?.startsWith('/Volumes/') && j.steps[`seg${i}:ingest`] !== 'done') n++;
        });
      } else if (!j.params.origin && j.params.video?.startsWith('/Volumes/') && j.steps.ingest !== 'done') {
        n++;
      }
    }
    return n;
  }

  // 已入队素材的卡拷贝全部完成的瞬间，通知可以卸载 SD 卡（每批一次，不打扰）
  #maybeNotifyCardFree(): void {
    const n = this.#cardDepsPending();
    if (n === 0 && this._cardDeps > 0) {
      interact
        .notify({
          title: 'actpipe：可以卸载 SD 卡了',
          message: '已入队的素材全部拷贝到本机磁盘，后续出片不再读卡',
          sound: this.config.notify_sound,
        })
        .catch(() => {});
    }
    this._cardDeps = n;
  }

  #loadExisting(): void {
    if (!fs.existsSync(paths.jobs)) return;
    for (const id of fs.readdirSync(paths.jobs)) {
      const file = path.join(paths.jobs, id, 'job.json');
      const job = readJson(file) as Job | null;
      if (!job) continue;
      if (!['done', 'failed', 'awaiting_fit'].includes(job.state)) {
        job.state = 'queued'; // 进程重启后断点续跑：已完成步骤会被跳过
        this.#save(job);
      }
      this.jobs.set(id, job);
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  add(params: AddJobParams): Job {
    const id = newJobId();
    const dir = path.join(paths.jobs, id);
    fs.mkdirSync(dir, { recursive: true });
    const job: Job = {
      id,
      dir,
      created_at: new Date().toISOString(),
      state: 'queued',
      error: null,
      params: {
        video: params.video,
        fit: params.fit ?? null,
        skin: params.skin ?? this.config.skin,
        lut: params.lut ?? null, // null = 按 probe 决策自动；'none' = 显式不套
        offset_seconds: params.offset_seconds ?? null,
        bias_seconds: params.bias_seconds ?? null, // 时间轴整体平移（正 = 数据延后），null = 用全局 global_bias_seconds
        direct: params.direct ?? false,
        // 多段合并：同一次录制被相机切段（~20GB 一段）且共用同一 FIT 时，
        // segments 按拍摄时间排序 [{video, origin, origin_size, origin_mtime}]，逐段处理后拼接为一条
        segments: params.segments ?? null,
        // 审核页预拷贝：video 已在 staging，origin 记录卡上原始路径用于去重记账
        origin: params.origin ?? null,
        origin_size: params.origin_size ?? null,
        origin_mtime: params.origin_mtime ?? null,
      },
      steps: {},
      artifacts: {},
      progress: null,
    };
    this.#save(job);
    this.jobs.set(id, job);
    this.#maybeNotifyCardFree(); // 新入队的卡依赖先把计数抬起来，拷完那一刻才会触发通知
    this.#kick();
    return job;
  }

  attachFit(id: string, fitPath: string): Job {
    const job = this.#mustGet(id);
    job.params.fit = fitPath;
    if (job.state === 'awaiting_fit' || job.state === 'failed') job.state = 'queued';
    this.#save(job);
    this.#kick();
    return job;
  }

  // 时间轴对齐：整体平移 bias 秒（正 = 数据延后），重跑 fit/render/compose（+concat）。
  // 码表与相机时钟各有偏差，纯时间戳锚定无法发现，用此人工校准。
  realign(id: string, biasSeconds: unknown): Job {
    const job = this.#mustGet(id);
    if (typeof biasSeconds !== 'number' || !Number.isFinite(biasSeconds)) throw new Error('bias_seconds 必须是数字');
    // 进行中的状态才拒绝；'done' 事件发出的瞬间循环尚未退出，但对该任务改步骤已安全
    if (['ingesting', 'probing', 'rendering', 'encoding'].includes(job.state)) {
      throw new Error('任务正在运行，等它结束后再调整');
    }
    if (!job.params.fit || job.params.fit === 'none') throw new Error('该任务没有 FIT（纯拷贝），无需对齐');

    const isMerge = (job.params.segments?.length ?? 0) > 1;
    const segCount = isMerge ? job.params.segments!.length : 1;
    const missing: string[] = [];
    for (let i = 0; i < segCount; i++) {
      const art = isMerge ? job.artifacts.segments?.[i] : job.artifacts;
      const staged = art?.ingest?.staged;
      if (staged && fs.existsSync(staged)) continue;
      // staging 已清理：源还在就回退为重新 ingest（probe 一并重跑），源也没了才没救
      const segP = isMerge ? job.params.segments![i] : job.params;
      const src = segP.origin ?? segP.video;
      if (src && fs.existsSync(src)) {
        if (segP.origin) {
          // params.video 指向已消失的 staging 副本，改回原始来源路径
          segP.video = segP.origin;
          segP.origin = null;
          segP.origin_size = null;
          segP.origin_mtime = null;
        }
        if (isMerge) {
          job.steps[`seg${i}:ingest`] = undefined;
          job.steps[`seg${i}:probe`] = undefined;
          job.artifacts.segments![i] = {};
        } else {
          job.steps.ingest = undefined;
          job.steps.probe = undefined;
          delete job.artifacts.ingest;
          delete job.artifacts.probe;
        }
      } else {
        missing.push(path.basename(src ?? `seg${i}`));
      }
    }
    if (missing.length) throw new Error(`源文件不可用（卡已拔出且 staging 已清理）：${missing.join('、')}`);

    job.params.bias_seconds = biasSeconds;
    // bias 语义取代手动绝对 offset：各段按自己的开拍时刻锚定后整体平移，段间不累积误差
    job.params.offset_seconds = null;
    for (const k of Object.keys(job.steps)) {
      if (/^(seg\d+:)?(fit|render|compose)$/.test(k) || k === 'concat') job.steps[k] = undefined;
    }
    if (isMerge) {
      for (const art of job.artifacts.segments ?? []) {
        if (art?.intermediate && fs.existsSync(art.intermediate)) fs.rmSync(art.intermediate, { force: true }); // ffmpeg -n 不覆盖已有文件，重跑前清掉中间成片
      }
    }
    job.artifacts.output = null;
    job.error = null;
    job.state = 'queued';
    this.#log(job, `realign: bias_seconds=${biasSeconds}，重跑 fit/render/compose${isMerge ? '/concat' : ''}`);
    this.#save(job);
    this.#kick();
    return job;
  }

  setOffset(id: string, offsetSeconds: number | null): Job {
    const job = this.#mustGet(id);
    job.params.offset_seconds = offsetSeconds;
    job.steps.fit = undefined;
    job.steps.render = undefined;
    job.steps.compose = undefined;
    // 合并任务：所有分段的对齐/渲染/合成与最终拼接一并重跑
    for (const k of Object.keys(job.steps)) {
      if (/^seg\d+:(fit|render|compose)$/.test(k) || k === 'concat') job.steps[k] = undefined;
    }
    if (job.state === 'awaiting_fit' || job.state === 'failed') job.state = 'queued';
    this.#save(job);
    this.#kick();
    return job;
  }

  #mustGet(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  }

  #save(job: Job): void {
    writeJsonAtomic(path.join(job.dir, 'job.json'), job);
  }

  #setState(job: Job, state: JobState): void {
    job.state = state;
    job.progress = null;
    this.#save(job);
    this.#emit(job, { type: 'state', state });
    this.#log(job, `state -> ${state}`);
  }

  #emit(job: Job, payload: Record<string, unknown>): void {
    this.emit('event', { jobId: job.id, ...payload });
  }

  #progress(job: Job, payload: ProgressPayload): void {
    job.progress = mergeProgress(job.progress, payload);
    this.#emit(job, { type: 'progress', ...job.progress });
  }

  #log(job: Job, line: string): void {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    fs.appendFileSync(path.join(job.dir, 'log.txt'), text);
    this.#emit(job, { type: 'log', line });
  }

  #kick(): void {
    if (this.running) return;
    this.running = true;
    setImmediate(() => this.#loop());
  }

  async #loop(): Promise<void> {
    for (;;) {
      const job = this.list().find((j) => j.state === 'queued');
      if (!job) break;
      this.currentId = job.id;
      await this.#runJob(job);
      this.currentId = null;
    }
    this.running = false;
  }

  async #runJob(job: Job): Promise<void> {
    const startedAt = Date.now();
    try {
      if ((job.params.segments?.length ?? 0) > 1) {
        await this.#runMergeJob(job, startedAt);
        return;
      }
      await this.#stepIngest(job);
      if (job.params.fit === 'none') {
        // 无 FIT：纯拷贝路径（ingest 后原样复制到 <output_dir>/<日期>/raw/，不上 overlay）
        await this.#stepCopy(job);
        this.#setState(job, 'done');
        const elapsed = fmtDuration((Date.now() - startedAt) / 1000);
        this.#log(job, `done in ${elapsed}, output: ${job.artifacts.output}（纯拷贝）`);
        // interact.ts 的签名由其代理补齐中，先按 any 过边界
        await (interact.notify as any)({
          title: '素材已拷贝',
          message: `${path.basename(job.params.video)}（无 FIT，未加 overlay）`,
          sound: this.config.notify_sound,
          openPath: job.artifacts.output,
        });
        this.#afterSuccess(job);
        return;
      }
      await this.#stepProbe(job);
      const cont = await this.#stepFit(job);
      if (!cont) return;
      await this.#stepRender(job);
      await this.#stepCompose(job);
      this.#setState(job, 'done');
      const elapsed = fmtDuration((Date.now() - startedAt) / 1000);
      const out = job.artifacts.output;
      this.#log(job, `done in ${elapsed}, output: ${out}`);
      // interact.ts 的签名由其代理补齐中，先按 any 过边界
      await (interact.notify as any)({
        title: '出片完成',
        message: `${path.basename(job.params.video)} ${elapsed}`,
        sound: this.config.notify_sound,
        openPath: out,
      });
      this.#afterSuccess(job);
    } catch (e: any) {
      job.state = 'failed';
      job.error = e.message;
      this.#save(job);
      this.#emit(job, { type: 'state', state: 'failed', error: e.message });
      this.#log(job, `FAILED: ${e.stack ?? e.message}`);
      await interact.notify({
        title: '出片失败',
        message: `${path.basename(job.params.video)}: ${e.message}`,
        sound: 'Basso',
      });
    }
  }

  #stepDone(job: Job, name: string): boolean {
    return job.steps?.[name] === 'done';
  }

  #markStep(job: Job, name: string): void {
    job.steps[name] = 'done';
    this.#save(job);
  }

  async #stepIngest(job: Job): Promise<void> {
    if (this.#stepDone(job, 'ingest')) return;
    this.#setState(job, 'ingesting');
    const src = job.params.video;
    if (job.params.origin) {
      // 审核页已预拷贝到 staging：不再复制，ingest 记账用卡上原始路径（去重/删卡都按原始来源算）
      job.artifacts.ingest = {
        src: job.params.origin,
        staged: src,
        size: job.params.origin_size ?? fs.statSync(src).size,
        mtime_ms: job.params.origin_mtime ?? Math.round(fs.statSync(src).mtimeMs),
        direct: true,
        pre_staged: true,
      };
    } else if (job.params.direct || !src.startsWith('/Volumes/')) {
      const st = fs.statSync(src);
      job.artifacts.ingest = { src, staged: src, size: st.size, mtime_ms: Math.round(st.mtimeMs), direct: true };
    } else {
      const stagingDir = path.join(paths.staging, job.id);
      // ingest.ts 的选项/返回类型由其代理补齐中，先按 any 过边界（返回含 IngestArtifact 全部字段）
      job.artifacts.ingest = await (ingestFile as any)(src, {
        stagingDir,
        checksum: this.config.staging_checksum,
        onProgress: (p: ProgressPayload) => this.#progress(job, { stage: 'ingest', ...p }),
      });
    }
    this.#save(job);
    this.#log(job, `ingest: ${job.artifacts.ingest!.staged} (${job.artifacts.ingest!.size} bytes)`);
    this.#markStep(job, 'ingest');
    this.#maybeNotifyCardFree();
  }

  // 纯拷贝：staging（或直读源）原样复制到成品目录的 raw 子目录，不转码
  async #stepCopy(job: Job): Promise<void> {
    if (this.#stepDone(job, 'copy')) return;
    this.#setState(job, 'copying');
    const src = job.artifacts.ingest!.staged;
    const out = rawOutputPathFor({
      outputDir: this.config.output_dir,
      videoFile: job.params.video,
      rawSubdir: this.config.raw_subdir ?? 'raw',
    });
    await fs.promises.copyFile(src, out);
    job.artifacts.output = out;
    this.#log(job, `copy: ${out}`);
    this.#markStep(job, 'copy');
    this.#save(job);
  }

  async #stepProbe(job: Job): Promise<void> {
    if (this.#stepDone(job, 'probe')) return;
    this.#setState(job, 'probing');
    const staged = job.artifacts.ingest!.staged;
    // probe.ts 的返回类型由其代理补齐中，先断言为共享 ProbeResult
    const probe = (await probeFile(staged)) as ProbeResult;
    let decision: LutDecision;
    if (job.params.lut === 'none') {
      decision = { apply: false, lut: null, reason: 'explicit:none' };
    } else if (job.params.lut) {
      decision = { apply: true, lut: resolveLutPath(this.config, job.params.lut), reason: 'explicit' };
    } else {
      decision = await decideLut(probe, { config: this.config, interact });
      if (decision.remember_key) {
        this.config.dlog_memory = { ...(this.config.dlog_memory ?? {}), [decision.remember_key]: decision.apply ? 'lut' : 'no_lut' };
        saveConfig(this.config);
      }
    }
    if (decision.apply && decision.lut && !decision.lut.split('+').every((p) => fs.existsSync(p))) {
      this.#log(job, `警告：LUT 文件不存在 ${decision.lut}，按不套 LUT 继续`);
      decision = { ...decision, apply: false, lut: null, reason: `${decision.reason}+lut_missing` };
    }
    probe.lut_decision = decision;
    writeJsonAtomic(path.join(job.dir, 'probe.json'), probe);
    job.artifacts.probe = probe;
    this.#log(job, `probe: ${probe.width}x${probe.height}@${probe.fps} ${probe.codec} ${probe.bit_depth}bit, lut=${decision.apply ? decision.lut : 'no'} (${decision.reason})`);
    this.#markStep(job, 'probe');
    this.#save(job);
  }

  async #stepFit(job: Job): Promise<boolean> {
    if (this.#stepDone(job, 'fit')) return true;
    this.#setState(job, 'probing');

    if (!job.params.fit) {
      const picked = await this.#pickFit(job);
      if (!picked) {
        this.#setState(job, 'awaiting_fit');
        await interact.notify({
          title: '需要 .fit 文件',
          message: `${path.basename(job.params.video)} 等待选择 FIT 文件（actpipe run 或 POST /jobs/${job.id}/fit）`,
        });
        return false;
      }
      job.params.fit = picked;
    }

    const probe = job.artifacts.probe;
    // fit.ts 的选项/返回类型由其代理补齐中，先按 any 过边界，session 断言为共享 SessionInfo
    const { session } = (await (fitToFiles as any)(job.params.fit!, {
      probe,
      videoFile: probe!.file,
      biasSeconds: job.params.bias_seconds ?? this.config.global_bias_seconds ?? 0,
      smoothWindowS: this.config.smooth_window_s,
      outDir: job.dir,
      offsetOverride: job.params.offset_seconds,
    })) as { session: SessionInfo };
    job.artifacts.session = session;

    if (!session.anchor?.ok && job.params.offset_seconds == null) {
      this.#save(job);
      this.#setState(job, 'awaiting_fit');
      for (const w of session.anchor?.warnings ?? []) this.#log(job, `警告：${w}`);
      await interact.notify({
        title: 'FIT 时间对齐失败',
        message: `锚定点超出 FIT 活动范围，请手填 offset（actpipe run --offset）`,
        sound: 'Basso',
      });
      return false;
    }
    for (const w of session.anchor?.warnings ?? []) this.#log(job, `警告：${w}`);
    this.#log(job, `fit: offset=${session.offset_seconds}s, fields=${session.fields.join(',')}`);
    this.#markStep(job, 'fit');
    this.#save(job);
    return true;
  }

  async #pickFit(job: Job): Promise<string | null> {
    if (this.config.fit_autopick === 'newest_in_dir') {
      let newest: { path: string; mtime: number } | null = null;
      for (const dir of this.config.fit_dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!f.toLowerCase().endsWith('.fit')) continue;
          const p = path.join(dir, f);
          const mtime = fs.statSync(p).mtimeMs;
          if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
        }
      }
      if (newest) {
        this.#log(job, `fit_autopick: ${newest.path}`);
        return newest.path;
      }
    }
    return interact.chooseFile({ prompt: `选择 ${path.basename(job.params.video)} 对应的 .fit 文件` });
  }

  async #stepRender(job: Job): Promise<void> {
    if (this.#stepDone(job, 'render')) return;
    this.#setState(job, 'rendering');
    const probe = job.artifacts.probe!;
    const session = job.artifacts.session!;
    const offset = session.offset_seconds ?? 0;
    const delayS = Math.max(0, -offset); // 视频先于 FIT 开始：overlay 延后这么久入场
    const renderFromS = Math.max(0, offset);
    const duration = probe.duration;
    const fps = this.config.overlay_fps;
    const skinDir = resolveSkinDir(job.params.skin);
    if (!skinDir || !fs.existsSync(skinDir)) throw new Error(`皮肤不存在: ${job.params.skin}`);

    const fitHashValue = await hashFile(job.params.fit!);
    const skinHashValue = await skinHash(skinDir);
    const key = cacheKey({ fitHashValue, skinHashValue, width: probe.width, height: probe.height, fps });
    const samples: SamplesGrid = readJson(path.join(job.dir, 'samples.json'));

    const firstFrame = Math.round(renderFromS * fps);
    const lastFrame = Math.round(Math.min(samples.count - 1, offset + duration + 1) * fps);
    const fromFitS = renderFromS;
    const toFitS = Math.min(samples.count - 1, offset + duration + 1);

    let frames: Omit<FramesArtifact, 'first_frame' | 'delay_s'>;
    if (toFitS <= fromFitS) {
      // bias 后该段整个落在 FIT 数据窗口外（如码表提前停表）：整段无仪表盘，仅套 LUT
      this.#log(job, `render: 该段与 FIT 数据窗口无交集（offset=${offset.toFixed(1)}s），整段无仪表盘`);
      frames = { empty: true, framesDir: null, pattern: null, fps, width: null, height: null, cache: 'empty' };
    } else {
    // render.ts 的签名由其代理补齐中，先按 any 过边界
    const cached = (lookupCache as any)(key, firstFrame, lastFrame);
    if (cached) {
      this.#log(job, `render cache HIT: ${key}，跳过渲染段`);
      frames = {
        framesDir: cached.framesDir,
        pattern: path.join(cached.framesDir, '%05d.png'),
        fps,
        width: cached.index.width,
        height: cached.index.height,
        cache: 'hit',
      };
    } else {
      this.#log(job, `render cache MISS: 渲染窗口 ${fromFitS.toFixed(1)}s..${toFitS.toFixed(1)}s @${fps}fps`);
      // render.ts 的签名由其代理补齐中，先按 any 过边界
      const result = await (renderWindowToCache as any)({
        skinDir,
        fitFile: job.params.fit,
        samples,
        width: probe.width,
        height: probe.height,
        fps,
        fromFitS,
        toFitS,
        tabs: this.config.render_tabs,
        onProgress: (p: ProgressPayload) => this.#progress(job, { stage: 'render', ...p }),
        log: (m: string) => this.#log(job, m),
      });
      frames = { framesDir: result.framesDir, pattern: result.pattern, fps, width: result.width, height: result.height, cache: 'miss' };
    }
    }
    job.artifacts.frames = { ...frames, first_frame: firstFrame, delay_s: delayS };
    this.#log(job, `render: frames=${frames.framesDir} start_number=${firstFrame}`);
    this.#markStep(job, 'render');
    this.#save(job);
  }

  async #stepCompose(job: Job): Promise<void> {
    if (this.#stepDone(job, 'compose')) return;
    this.#setState(job, 'encoding');
    const probe = job.artifacts.probe!;
    const frames = job.artifacts.frames!;
    const decision = probe.lut_decision;
    const out = outputPathFor({ outputDir: this.config.output_dir, videoFile: job.params.video, skin: job.params.skin });
    const scaleOverlayTo =
      frames.width && frames.height && (frames.width !== probe.width || frames.height !== probe.height)
        ? [probe.width, probe.height]
        : null;
    // compose.ts 的签名由其代理补齐中，先按 any 过边界
    await (composeVideo as any)(
      {
        video: job.artifacts.ingest!.staged,
        framesPattern: frames.empty ? null : frames.pattern,
        startNumber: frames.first_frame,
        overlayFps: frames.fps,
        videoFps: probe.fps,
        lut: decision?.apply ? decision.lut : null,
        out,
        encoder: this.config.encoder,
        bitrate: this.config.bitrate,
        tenBit: this.config.ten_bit_output,
        durationS: probe.duration,
        scaleOverlayTo,
        overlayDelayS: frames.delay_s ?? 0,
      },
      {
        durationS: probe.duration,
        onProgress: (p: ProgressPayload) => this.#progress(job, p),
        log: (m: string) => this.#log(job, m),
      }
    );
    job.artifacts.output = out;
    writeJsonAtomic(path.join(job.dir, 'compose.json'), { out, encoder: this.config.encoder, bitrate: this.config.bitrate });
    this.#log(job, `compose: ${out}`);
    this.#markStep(job, 'compose');
    this.#save(job);
  }

  // 多段合并任务：段内 ingest→probe→fit→render→compose，段间流水线并行——
  // ingest 串行（保 SD 卡随机读带宽）、probe/fit 串行（保 LUT 决策顺序与手动 offset 顺推）、
  // render/encode 按 encode_concurrency/render_concurrency 并发（硬编共享有余量，瓶颈在 CPU 滤镜链），
  // 最后拼接为一条成片。重阶段启动前过 swap 水位门（防交换风暴）。
  // 每段按自己的拍摄时间在 FIT 里独立锚定 offset，段间断口不漂移；LUT 决策首段定、全段共用；
  // 步骤键 seg<i>:<step> 落盘，进程重启可断点续跑（isDone 跳过已完成步骤）。
  async #runMergeJob(job: Job, startedAt: number): Promise<void> {
    const segs = job.params.segments!;
    const total = segs.length;
    job.artifacts.segments ??= segs.map(() => ({}));
    let sharedLut: LutDecision | null = job.artifacts.merge_lut ?? null; // 首段决策后全段复用

    // 进度聚合：segProg[i][stage] = 进行中百分比 | 'done'；stage 文案带各 encode 的实时 speed
    const segProg: MergeStageProgress[] = segs.map(() => ({}));
    const segSpeed: (string | null)[] = segs.map(() => null);
    segs.forEach((_, i) => {
      const k = (n: string) => `seg${i}:${n}`;
      if (this.#stepDone(job, k('ingest'))) segProg[i].ingest = 'done';
      if (this.#stepDone(job, k('probe')) && this.#stepDone(job, k('fit'))) segProg[i].prep = 'done';
      if (this.#stepDone(job, k('render'))) segProg[i].render = 'done';
      if (this.#stepDone(job, k('compose'))) segProg[i].encode = 'done';
    });
    const report = () => {
      const active: string[] = [];
      segProg.forEach((s, i) => {
        for (const [st, v] of Object.entries(s)) {
          if (typeof v === 'number') active.push(`seg${i + 1}/${total} ${st}${st === 'encode' && segSpeed[i] ? ` ${segSpeed[i]}` : ''}`);
        }
      });
      this.#progress(job, { stage: active.join(' + ') || 'merge', percent: mergeJobPercent(segProg) });
    };
    const stageDone = (i: number, stage: string) => {
      segProg[i][stage] = 'done';
      report();
    };

    // 状态解析：活跃车道 → 任务状态（encoding > rendering > probing > ingesting）
    const activeLanes = new Map<string, number>();
    const refreshState = () => {
      const order: [string, JobState][] = [['encode', 'encoding'], ['render', 'rendering'], ['prep', 'probing'], ['ingest', 'ingesting']];
      const hit = order.find(([lane]) => (activeLanes.get(lane) ?? 0) > 0);
      const next = hit ? hit[1] : 'encoding'; // 无活跃车道 = concat 阶段
      if (job.state !== next) this.#setState(job, next);
    };

    const tasks: PipelineTask[] = [];
    segs.forEach((seg, i) => {
      const art = job.artifacts.segments![i];
      const key = (n: string) => `seg${i}:${n}`;
      const tag = `seg${i + 1}/${total}`;
      const segDir = ensureDir(path.join(job.dir, `seg${i}`));
      const prepDeps = [key('ingest')];
      if (i > 0) prepDeps.push(`seg${i - 1}:probe`);
      const fitDeps = [key('probe')];
      if (i > 0) fitDeps.push(`seg${i - 1}:fit`);

      tasks.push({
        name: key('ingest'), lane: 'ingest', deps: [],
        run: async () => {
          segProg[i].ingest = 0;
          report();
          if (seg.origin) {
            art.ingest = {
              src: seg.origin,
              staged: seg.video,
              size: seg.origin_size ?? fs.statSync(seg.video).size,
              mtime_ms: seg.origin_mtime ?? Math.round(fs.statSync(seg.video).mtimeMs),
              direct: true,
              pre_staged: true,
            };
          } else if (!seg.video.startsWith('/Volumes/')) {
            const st = fs.statSync(seg.video);
            art.ingest = { src: seg.video, staged: seg.video, size: st.size, mtime_ms: Math.round(st.mtimeMs), direct: true };
          } else {
            // ingest.ts 的选项/返回类型由其代理补齐中，先按 any 过边界
            art.ingest = await (ingestFile as any)(seg.video, {
              stagingDir: path.join(segDir, 'staging'),
              checksum: this.config.staging_checksum,
              onProgress: (p: ProgressPayload) => { segProg[i].ingest = p.percent; report(); },
            });
          }
          this.#log(job, `${tag} ingest: ${art.ingest!.staged} (${art.ingest!.size} bytes)`);
          this.#markStep(job, key('ingest'));
          this.#save(job);
          this.#maybeNotifyCardFree();
          stageDone(i, 'ingest');
        },
      });

      tasks.push({
        name: key('probe'), lane: 'prep', deps: prepDeps,
        run: async () => {
          segProg[i].prep = 0;
          report();
          // probe.ts 的返回类型由其代理补齐中，先断言为共享 ProbeResult
          const probe = (await probeFile(art.ingest!.staged)) as ProbeResult;
          let decision: LutDecision;
          if (sharedLut) {
            decision = { ...sharedLut, reason: `${sharedLut.reason}+shared` };
          } else if (job.params.lut === 'none') {
            decision = { apply: false, lut: null, reason: 'explicit:none' };
          } else if (job.params.lut) {
            decision = { apply: true, lut: resolveLutPath(this.config, job.params.lut), reason: 'explicit' };
          } else {
            decision = await decideLut(probe, { config: this.config, interact });
            if (decision.remember_key) {
              this.config.dlog_memory = { ...(this.config.dlog_memory ?? {}), [decision.remember_key]: decision.apply ? 'lut' : 'no_lut' };
              saveConfig(this.config);
            }
          }
          if (decision.apply && decision.lut && !decision.lut.split('+').every((p) => fs.existsSync(p))) {
            this.#log(job, `警告：LUT 文件不存在 ${decision.lut}，按不套 LUT 继续`);
            decision = { ...decision, apply: false, lut: null, reason: `${decision.reason}+lut_missing` };
          }
          if (!sharedLut) {
            sharedLut = decision;
            job.artifacts.merge_lut = decision;
          }
          probe.lut_decision = decision;
          art.probe = probe;
          writeJsonAtomic(path.join(segDir, 'probe.json'), probe);
          this.#log(job, `${tag} probe: ${probe.width}x${probe.height}@${probe.fps} ${probe.codec} ${probe.bit_depth}bit, lut=${decision.apply ? decision.lut : 'no'} (${decision.reason})`);
          this.#markStep(job, key('probe'));
          this.#save(job);
          segProg[i].prep = 50; // prep = probe + fit，probe 完算一半
          report();
        },
      });

      tasks.push({
        name: key('fit'), lane: 'prep', deps: fitDeps,
        run: async () => {
          // 手动 offset 只锚首段，后续按各段时长顺推；从 artifacts 累加，断点续跑也正确
          let manualOffset: number | null = job.params.offset_seconds ?? null;
          if (manualOffset != null) {
            for (let j = 0; j < i; j++) manualOffset += job.artifacts.segments![j]?.probe?.duration ?? 0;
          }
          // fit.ts 的选项/返回类型由其代理补齐中，先按 any 过边界，session 断言为共享 SessionInfo
          const { session } = (await (fitToFiles as any)(job.params.fit!, {
            probe: art.probe,
            videoFile: art.probe!.file ?? art.ingest!.staged,
            biasSeconds: job.params.bias_seconds ?? this.config.global_bias_seconds ?? 0,
            smoothWindowS: this.config.smooth_window_s,
            outDir: segDir,
            offsetOverride: manualOffset,
          })) as { session: SessionInfo };
          art.session = session;
          if (!session.anchor?.ok) {
            this.#save(job);
            for (const w of session.anchor?.warnings ?? []) this.#log(job, `警告：${w}`);
            throw new AwaitFitError(`第 ${i + 1} 段（${path.basename(seg.video)}）锚定点超出 FIT 活动范围`, i);
          }
          for (const w of session.anchor?.warnings ?? []) this.#log(job, `警告：${w}`);
          this.#log(job, `${tag} fit: offset=${session.offset_seconds}s`);
          this.#markStep(job, key('fit'));
          this.#save(job);
          stageDone(i, 'prep');
        },
      });

      tasks.push({
        name: key('render'), lane: 'render', deps: [key('fit')],
        run: async (signal) => {
          await this.#waitHeavyLane(job, signal);
          segProg[i].render = 0;
          report();
          const probe = art.probe!;
          const offset = art.session!.offset_seconds ?? 0;
          const delayS = Math.max(0, -offset); // 视频先于 FIT 开始：overlay 延后这么久入场
          const renderFromS = Math.max(0, offset);
          const fps = this.config.overlay_fps;
          const skinDir = resolveSkinDir(job.params.skin);
          if (!skinDir || !fs.existsSync(skinDir)) throw new Error(`皮肤不存在: ${job.params.skin}`);
          const fitHashValue = await hashFile(job.params.fit!);
          const skinHashValue = await skinHash(skinDir);
          const ck = cacheKey({ fitHashValue, skinHashValue, width: probe.width, height: probe.height, fps });
          const samples: SamplesGrid = readJson(path.join(segDir, 'samples.json'));
          const firstFrame = Math.round(renderFromS * fps);
          const lastFrame = Math.round(Math.min(samples.count - 1, offset + probe.duration + 1) * fps);
          const fromFitS = renderFromS;
          const toFitS = Math.min(samples.count - 1, offset + probe.duration + 1);
          if (toFitS <= fromFitS) {
            // bias 后该段整个落在 FIT 数据窗口外（如码表提前停表）：整段无仪表盘，仅套 LUT
            this.#log(job, `${tag} render: 与 FIT 数据窗口无交集（offset=${offset.toFixed(1)}s），整段无仪表盘`);
            art.frames = { empty: true, framesDir: null, pattern: null, fps, width: null, height: null, first_frame: firstFrame, delay_s: 0 };
          } else {
            // render.ts 的签名由其代理补齐中，先按 any 过边界
            const cached = (lookupCache as any)(ck, firstFrame, lastFrame);
            if (cached) {
              this.#log(job, `${tag} render cache HIT: ${ck}`);
              art.frames = { framesDir: cached.framesDir, pattern: path.join(cached.framesDir, '%05d.png'), fps, width: cached.index.width, height: cached.index.height, first_frame: firstFrame, delay_s: delayS };
            } else {
              this.#log(job, `${tag} render MISS: ${fromFitS.toFixed(1)}s..${toFitS.toFixed(1)}s @${fps}fps`);
              // render.ts 的签名由其代理补齐中，先按 any 过边界
              const result = await (renderWindowToCache as any)({
                skinDir,
                fitFile: job.params.fit,
                samples,
                width: probe.width,
                height: probe.height,
                fps,
                fromFitS,
                toFitS,
                tabs: this.config.render_tabs,
                onProgress: (p: ProgressPayload) => { segProg[i].render = p.percent; report(); },
                log: (m: string) => this.#log(job, m),
                signal,
              });
              art.frames = { framesDir: result.framesDir, pattern: result.pattern, fps, width: result.width, height: result.height, first_frame: firstFrame, delay_s: delayS };
            }
          }
          this.#markStep(job, key('render'));
          this.#save(job);
          stageDone(i, 'render');
        },
      });

      tasks.push({
        name: key('compose'), lane: 'encode', deps: [key('render')],
        run: async (signal) => {
          await this.#waitHeavyLane(job, signal);
          segProg[i].encode = 0;
          report();
          const probe = art.probe!;
          const frames = art.frames!;
          const decision = probe.lut_decision;
          art.intermediate = path.join(segDir, 'composed.mp4');
          const scaleOverlayTo =
            frames.width && frames.height && (frames.width !== probe.width || frames.height !== probe.height)
              ? [probe.width, probe.height]
              : null;
          try {
            // compose.ts 的签名由其代理补齐中，先按 any 过边界
            await (composeVideo as any)(
              {
                video: art.ingest!.staged,
                framesPattern: frames.empty ? null : frames.pattern,
                startNumber: frames.first_frame,
                overlayFps: frames.fps,
                videoFps: probe.fps,
                lut: decision?.apply ? decision.lut : null,
                out: art.intermediate,
                encoder: this.config.encoder,
                bitrate: this.config.bitrate,
                tenBit: this.config.ten_bit_output,
                durationS: probe.duration,
                scaleOverlayTo,
                overlayDelayS: frames.delay_s ?? 0,
              },
              {
                durationS: probe.duration,
                onProgress: (p: ProgressPayload) => {
                  if (p.speed != null) segSpeed[i] = p.speed;
                  if (p.percent != null) segProg[i].encode = p.percent;
                  report();
                },
                log: (m: string) => this.#log(job, m),
                signal,
              }
            );
          } catch (e) {
            fs.rmSync(art.intermediate, { force: true }); // ffmpeg -n 不覆盖：失败/中止的半成品必须清掉
            throw e;
          }
          this.#log(job, `${tag} composed: ${art.intermediate}`);
          this.#markStep(job, key('compose'));
          this.#save(job);
          stageDone(i, 'encode');
        },
      });
    });

    tasks.push({
      name: 'concat', lane: 'encode', deps: segs.map((_, i) => `seg${i}:compose`),
      run: async () => {
        this.#progress(job, { stage: 'concat', percent: 99 });
        const inputs = job.artifacts.segments!.map((s) => s.intermediate);
        const out = mergedOutputPathFor({ outputDir: this.config.output_dir, videoFile: job.params.video, skin: job.params.skin });
        // compose.ts 的签名由其代理补齐中，先按 any 过边界
        const r = await (concatVideos as any)({ inputs, out, encoder: this.config.encoder, bitrate: this.config.bitrate, log: (m: string) => this.#log(job, m) });
        job.artifacts.output = r.out;
        this.#log(job, `concat(${r.mode}): ${r.out}`);
        this.#markStep(job, 'concat');
        this.#save(job);
      },
    });

    try {
      // pipeline.ts 的签名由其代理补齐中，先按 any 过边界（tasks 结构见本地 PipelineTask）
      await (runPipeline as any)(tasks, {
        lanes: {
          ingest: 1,
          prep: 1,
          render: Math.max(1, this.config.render_concurrency ?? 1),
          encode: Math.max(1, this.config.encode_concurrency ?? 2),
        },
        isDone: (name: string) => this.#stepDone(job, name),
        onEvent: (e: PipelineLaneEvent) => {
          activeLanes.set(e.lane, (activeLanes.get(e.lane) ?? 0) + (e.type === 'start' ? 1 : -1));
          refreshState();
        },
      });
    } catch (e: any) {
      if (e.name === 'AwaitFit') {
        // 与单段路径一致：转 awaiting_fit 等人工 offset（setOffset 会重置所有分段后置步骤）
        this.#setState(job, 'awaiting_fit');
        await interact.notify({
          title: 'FIT 时间对齐失败',
          message: `${e.message}，请手填 offset（actpipe run --offset）`,
          sound: 'Basso',
        });
        return;
      }
      throw e;
    }

    this.#setState(job, 'done');
    const elapsed = fmtDuration((Date.now() - startedAt) / 1000);
    this.#log(job, `done in ${elapsed}, output: ${job.artifacts.output}（${total} 段合并）`);
    // interact.ts 的签名由其代理补齐中，先按 any 过边界
    await (interact.notify as any)({
      title: '合并出片完成',
      message: `${total} 段 → ${path.basename(job.artifacts.output!)}（${elapsed}）`,
      sound: this.config.notify_sound,
      openPath: job.artifacts.output,
    });
    this.#afterMergeSuccess(job);
  }

  // 重阶段（render/encode）启动前的内存水位门（速率制实现见 util.waitSwapBudget）：
  // swap 超预算且仍在增长才等待；外国应用留下的存量 swap 不阻塞。max_swap_mb=0 关闭
  async #waitHeavyLane(job: Job, signal: AbortSignal): Promise<void> {
    // util.ts 的选项类型由其代理补齐中，先按 any 过边界
    await (waitSwapBudget as any)({ budgetMb: this.config.max_swap_mb, signal, log: (m: string) => this.#log(job, m) });
  }

  #afterMergeSuccess(job: Job): void {
    for (const art of job.artifacts.segments ?? []) {
      const ingest = art.ingest;
      if (!ingest) continue;
      if (this.store) {
        this.store.markProcessed({ path: ingest.src, size: ingest.size, mtime: ingest.mtime_ms, jobId: job.id });
      }
      if (this.config.staging_retention === 'delete_on_success' && (!ingest.direct || ingest.pre_staged)) {
        fs.rmSync(path.dirname(ingest.staged), { recursive: true, force: true });
      }
      if (this.config.delete_from_card_after_success && ingest.src?.startsWith('/Volumes/')) {
        this.#log(job, `delete_from_card_after_success 开启：删除卡上原始文件 ${ingest.src}`);
        fs.rmSync(ingest.src, { force: true });
      }
    }
  }

  #afterSuccess(job: Job): void {
    const ingest = job.artifacts.ingest;
    if (this.store && ingest) {
      this.store.markProcessed({ path: ingest.src, size: ingest.size, mtime: ingest.mtime_ms, jobId: job.id });
    }
    if (this.config.staging_retention === 'delete_on_success' && ingest && (!ingest.direct || ingest.pre_staged)) {
      fs.rmSync(path.dirname(ingest.staged), { recursive: true, force: true });
    }
    if (this.config.delete_from_card_after_success && ingest?.src?.startsWith('/Volumes/')) {
      this.#log(job, 'delete_from_card_after_success 开启：删除卡上原始文件');
      fs.rmSync(ingest.src, { force: true });
    }
  }
}

function newJobId(): string {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '-',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
