// 快剪 L0 确定性内核：把一次骑行的叙事结构剪成 ~30s 短片。
// 不依赖任何模型——FIT 状态机按场景模板圈出各幕窗口，agent/VLM 只是其上的抛光层（L1）。
//
// 关键纪律：FIT 时间轴上的所有定位都用「流逝秒」（样本时间戳 − 活动起点），
// 绝不用数组下标——码表自动暂停会在时间轴上留下空洞，下标 ≠ 流逝时间。
// FIT 流逝秒 → merged 视频秒的映射是逐段的：videoT = fitElapsed − seg.offsetSeconds，
// 段覆盖区间 fitElapsed ∈ [offset, offset+duration)，未覆盖的幕丢弃并记录原因。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { uniquePath } from '../lib/util.ts';

export interface QuickcutSegment {
  videoStartS: number;   // 该段在 merged 视频里的起始秒
  durationS: number;     // 段时长（秒）
  offsetSeconds: number; // session.offset_seconds：videoT = fitElapsed − offsetSeconds
}

export interface NormalizedSample {
  tS: number; // FIT 流逝秒（时间戳 − 活动起点）
  speed?: number | null;      // m/s
  altitude?: number | null;   // m
  heart_rate?: number | null;
  power?: number | null;
  grade?: number | null;      // %
}

export interface QuickcutAct {
  key: string;   // departure / rollout / climb / summit / descent / return
  label: string; // 出发 / 上路 / 爬坡 / 登顶 / 放坡 / 收尾
  start: number; // merged 视频秒
  end: number;
  reason: string; // 选取依据（日志与 UI 展示）
}

export interface QuickcutPlan {
  scenario: string;
  acts: QuickcutAct[];
  dropped: { key: string; label: string; reason: string }[];
  totalS: number; // 实际成片时长（各幕时长求和）
}

export interface Detection {
  fitS: number;
  reason: string;
}

interface DetectCtx {
  s: NormalizedSample[];
}

export interface Detections {
  firstMove: Detection | null;
  climbPeak: Detection | null;
  summit: Detection | null;
  descentPeak: Detection | null;
}

export interface ActCandidate {
  act: Omit<QuickcutAct, 'start' | 'end'> & { durationS: number };
  centerS: number | 'head' | 'tail' | null;
}

export interface ScenarioIo {
  preambleS: number | null; // 视频开头到 FIT 数据出现的秒数（4+2 的车内段）
  tailS: number | null;     // FIT 数据结束到视频结尾的秒数（回到车内的段）
  videoDurationS: number;
}

export interface ScenarioTemplate {
  label: string;
  buildActs: (d: Detections, io: ScenarioIo) => ActCandidate[];
}

// ---------- 样本归一化 ----------

export function normalizeSamples(rawSamples: { t: number | string; [k: string]: unknown }[], fitStartMs: number): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of rawSamples) {
    const tMs = typeof r.t === 'number' ? r.t : Date.parse(r.t);
    if (!Number.isFinite(tMs)) continue;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      tS: (tMs - fitStartMs) / 1000,
      speed: num(r.speed),
      altitude: num(r.altitude),
      heart_rate: num(r.heart_rate),
      power: num(r.power),
      grade: num(r.grade),
    });
  }
  out.sort((a, b) => a.tS - b.tS);
  return out;
}

// ---------- FIT 流逝秒 → merged 视频秒 ----------

export function fitToVideo(segments: QuickcutSegment[], fitS: number): number | null {
  for (const seg of segments) {
    const local = fitS - seg.offsetSeconds;
    if (local >= 0 && local < seg.durationS) return seg.videoStartS + local;
  }
  return null;
}

// ---------- 探测器 ----------

const speedOf = (s: NormalizedSample) => s.speed ?? 0;

// 首次持续移动：speed > 1.5 m/s 连续 5 个样本
function detectFirstMove({ s }: DetectCtx) {
  for (let i = 0; i + 4 < s.length; i++) {
    if (s.slice(i, i + 5).every((x) => speedOf(x) > 1.5)) {
      return { fitS: s[i].tS, reason: `首次持续移动 ${(speedOf(s[i]) * 3.6).toFixed(1)}km/h` };
    }
  }
  return null;
}

// 窗口均值工具：返回最佳窗口中心下标
function bestWindow(s: NormalizedSample[], win: number, score: (w: NormalizedSample[]) => number | null): number | null {
  let best: { v: number; i: number } | null = null;
  for (let i = 0; i + win <= s.length; i++) {
    const w = s.slice(i, i + win);
    const v = score(w);
    if (v != null && (best == null || v > best.v)) best = { v, i };
  }
  return best ? best.i + Math.floor(win / 2) : null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// 爬坡努力峰：20 样本窗口、平均坡度 ≥3%，按功率（无功率则心率）取最大
function detectClimbPeak({ s }: DetectCtx) {
  const field = s.some((x) => x.power != null) ? 'power' : s.some((x) => x.heart_rate != null) ? 'heart_rate' : null;
  const score = (w: NormalizedSample[]) => {
    const g = avg(w.map((x) => x.grade ?? 0));
    if (g < 3) return null;
    if (field) {
      const vals = w.map((x) => x[field] as number | null).filter((v): v is number => v != null);
      if (vals.length >= w.length / 2) return avg(vals);
    }
    return g; // 无努力字段时退化为坡度最大窗
  };
  const i = bestWindow(s, 20, score);
  if (i == null) return null;
  const g = avg(s.slice(Math.max(0, i - 10), i + 10).map((x) => x.grade ?? 0));
  const effort = field ? ` ${field === 'power' ? '功率' : '心率'}≈${Math.round(avg(s.slice(Math.max(0, i - 10), i + 10).map((x) => (x[field] as number | null) ?? 0)))}${field === 'power' ? 'W' : 'bpm'}` : '';
  return { fitS: s[i].tS, reason: `爬坡努力峰：坡度≈${g.toFixed(1)}%${effort}` };
}

// 登顶：海拔极大值附近找最静止（速度最小）的点——山顶停下来的那一幕
function detectSummit({ s }: DetectCtx) {
  const alts = s.map((x) => x.altitude).filter((v): v is number => v != null);
  if (!alts.length) return null;
  const maxAlt = Math.max(...alts);
  let best: NormalizedSample | null = null;
  for (const x of s) {
    if (x.altitude != null && x.altitude >= maxAlt - 2) {
      if (!best || speedOf(x) < speedOf(best)) best = x;
    }
  }
  if (!best) return null;
  return { fitS: best.tS, reason: `登顶：海拔 ${Math.round(best.altitude!)}m（全程最高）` };
}

// 放坡：10 样本窗口、平均坡度 ≤−2%，按平均速度取最大
function detectDescentPeak({ s }: DetectCtx) {
  const i = bestWindow(s, 10, (w) => {
    if (avg(w.map((x) => x.grade ?? 0)) > -2) return null;
    return avg(w.map(speedOf));
  });
  if (i != null) {
    const v = avg(s.slice(Math.max(0, i - 5), i + 5).map(speedOf));
    return { fitS: s[i].tS, reason: `放坡极速：${(v * 3.6).toFixed(1)}km/h` };
  }
  let fastest: NormalizedSample | null = null;
  for (const x of s) if (!fastest || speedOf(x) > speedOf(fastest)) fastest = x;
  return fastest && speedOf(fastest) > 5 ? { fitS: fastest.tS, reason: `速度极值 ${(speedOf(fastest) * 3.6).toFixed(1)}km/h（未检出坡度）` } : null;
}

// ---------- 场景模板：4+2 爬山 ----------

export const SCENARIO_RIDE_4PLUS2 = 'ride_4plus2';

export const SCENARIOS: Record<string, ScenarioTemplate> = {
  [SCENARIO_RIDE_4PLUS2]: {
    label: '4+2 爬山',
    buildActs: (d, io) => [
      // 出发：开车门——视频最开头（相机先于码表开录的那段车内画面）
      { act: { key: 'departure', label: '出发', durationS: 4, reason: `视频开头车内段（${io.preambleS?.toFixed(0)}s 后才开表）` }, centerS: 'head' },
      // 上路：首次持续移动
      { act: { key: 'rollout', label: '上路', durationS: 3, reason: d.firstMove?.reason ?? '' }, centerS: d.firstMove?.fitS ?? null },
      // 爬坡：努力峰
      { act: { key: 'climb', label: '爬坡', durationS: 7, reason: d.climbPeak?.reason ?? '' }, centerS: d.climbPeak?.fitS ?? null },
      // 登顶：海拔最高处的静止点
      { act: { key: 'summit', label: '登顶', durationS: 4, reason: d.summit?.reason ?? '' }, centerS: d.summit?.fitS ?? null },
      // 放坡：极速
      { act: { key: 'descent', label: '放坡', durationS: 8, reason: d.descentPeak?.reason ?? '' }, centerS: d.descentPeak?.fitS ?? null },
      // 收尾：回到车边——视频最后 4s
      { act: { key: 'return', label: '收尾', durationS: 4, reason: `视频结尾车内段（数据结束后还有 ${io.tailS?.toFixed(0)}s）` }, centerS: 'tail' },
    ],
  },
};

export function runDetectors(samples: NormalizedSample[]): Detections {
  const ctx = { s: samples };
  return {
    firstMove: detectFirstMove(ctx),
    climbPeak: detectClimbPeak(ctx),
    summit: detectSummit(ctx),
    descentPeak: detectDescentPeak(ctx),
  };
}

// ---------- 主入口 ----------

export function analyzeQuickcut({
  samples,
  segments,
  videoDurationS,
  scenario = SCENARIO_RIDE_4PLUS2,
}: {
  samples: NormalizedSample[];
  segments: QuickcutSegment[];
  videoDurationS: number;
  scenario?: string;
}): QuickcutPlan {
  const tpl = SCENARIOS[scenario];
  if (!tpl) throw new Error(`未知快剪场景: ${scenario}`);
  if (!samples.length) throw new Error('快剪需要 FIT 样本（无数据素材不支持）');

  // 头部车内段长 = FIT 流逝 0 在视频里的位置（首段覆盖起点之前都是车内）
  const firstDataT = fitToVideo(segments, samples[0].tS);
  const lastDataT = fitToVideo(segments, samples[samples.length - 1].tS);
  const io: ScenarioIo = {
    preambleS: firstDataT != null && firstDataT > 1 ? firstDataT : null,
    tailS: lastDataT != null && videoDurationS - lastDataT > 1 ? videoDurationS - lastDataT : null,
    videoDurationS,
  };

  const acts: QuickcutAct[] = [];
  const dropped: QuickcutPlan['dropped'] = [];
  for (const { act, centerS } of tpl.buildActs(runDetectors(samples), io)) {
    let start: number, end: number;
    if (centerS === 'head') {
      if (io.preambleS == null || io.preambleS < 8) { dropped.push({ ...act, reason: '开头车内段不足 8s（非 4+2 录制形态）' }); continue; }
      start = Math.min(3, io.preambleS / 4);
      end = start + act.durationS;
    } else if (centerS === 'tail') {
      if (io.tailS == null || io.tailS < 6) { dropped.push({ ...act, reason: '结尾车内段不足 6s（非 4+2 录制形态）' }); continue; }
      end = videoDurationS - 1;
      start = end - act.durationS;
    } else if (centerS == null) {
      dropped.push({ ...act, reason: '探测器未找到特征点' });
      continue;
    } else {
      const v = fitToVideo(segments, centerS);
      if (v == null) { dropped.push({ ...act, reason: '特征点不在任何视频段的 FIT 覆盖内' }); continue; }
      start = Math.max(0, v - act.durationS / 2);
      end = Math.min(videoDurationS, start + act.durationS);
      start = Math.max(0, end - act.durationS);
    }
    acts.push({ ...act, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
  }

  return { scenario, acts, dropped, totalS: acts.reduce((a, x) => a + (x.end - x.start), 0) };
}

// ---------- 输出命名 ----------

export function quickcutOutputPathFor(videoPath: string): string {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '').replace(/_dash$/, '');
  return uniquePath(path.join(dir, `${base}_kuaijian.mp4`));
}

// ---------- 渲染：N 幕 trim + concat 单次编码 ----------

async function probeHasAudio(video: string): Promise<boolean> {
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', video]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
  return r.code === 0 && r.out.includes('audio');
}

export async function renderQuickcut({
  video,
  acts,
  out,
  encoder = 'hevc_videotoolbox',
  bitrate = '45M',
  log = () => {},
  onProgress = null,
  signal = null,
}: {
  video: string;
  acts: { start: number; end: number }[];
  out: string;
  encoder?: string;
  bitrate?: string;
  log?: (msg: string) => void;
  onProgress?: ((percent: number) => void) | null;
  signal?: AbortSignal | null;
}): Promise<{ out: string; durationS: number }> {
  if (!acts.length) throw new Error('快剪计划为空');
  const hasAudio = await probeHasAudio(video);
  const totalS = acts.reduce((a, x) => a + (x.end - x.start), 0);

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const a of acts) args.push('-ss', String(a.start), '-i', video);
  const filters: string[] = [];
  const pads: string[] = [];
  acts.forEach((a, i) => {
    const dur = (a.end - a.start).toFixed(3);
    filters.push(`[${i}:v]trim=0:${dur},setpts=PTS-STARTPTS[v${i}]`);
    pads.push(`[v${i}]`);
    if (hasAudio) {
      filters.push(`[${i}:a]atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`);
      pads.push(`[a${i}]`);
    }
  });
  filters.push(`${pads.join('')}concat=n=${acts.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (hasAudio) args.push('-map', '[a]');
  args.push('-c:v', encoder, '-b:v', bitrate);
  if (encoder.includes('videotoolbox')) args.push('-pix_fmt', 'p010le', '-profile:v', 'main10', '-tag:v', 'hvc1');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', out);

  log(`[quickcut] 渲染 ${acts.length} 幕共 ${totalS.toFixed(1)}s → ${out}`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args, { signal: signal ?? undefined });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_ms=(\d+)/.exec(line.trim());
        if (m && onProgress) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / totalS) * 100)));
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-500)}`))));
  });
  onProgress?.(100);
  return { out, durationS: totalS };
}
