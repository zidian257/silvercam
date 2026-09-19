// 快剪 L0 确定性内核：从 FIT 数据探测「事件菜单」，再由调用方（兜底组装或外部 agent）圈幕剪辑。
// 不依赖任何模型——叙事不是写死的场景模板，而是数据里有什么就出什么事件：
// 通用事件（片头/首次移动/停顿/极速/巡航/终停/片尾）任何素材都有；
// 条件事件（功率峰/冲刺/心率峰/海拔极值/坡度翻转/GPS 折返点）有对应数据才出现。
//
// 关键纪律：FIT 时间轴上的所有定位都用「流逝秒」（样本时间戳 − 活动起点），
// 绝不用数组下标——码表自动暂停会在时间轴上留下空洞，下标 ≠ 流逝时间。
// FIT 流逝秒 → merged 视频秒的映射是逐段的：videoT = fitElapsed − seg.offsetSeconds，
// 段覆盖区间 fitElapsed ∈ [offset, offset+duration)，未覆盖的事件 videoS=null（调用方不可用其剪辑）。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { run, uniquePath } from '../lib/util.ts';

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
  position?: { lat: number; lon: number } | null;
}

export interface QuickcutAct {
  key: string;   // 槽位 key（兜底组装）或 cutN（外部指定）
  label: string; // 中文幕名
  start: number; // merged 视频秒
  end: number;
  reason: string; // 选取依据（日志与 UI 展示）
}

export interface QuickcutPlan {
  acts: QuickcutAct[];
  dropped: { key: string; label: string; reason: string }[];
  totalS: number; // 实际成片时长（各幕时长求和）
}

// 事件：数据里探测到的「可看时刻」。
// score 是活动内相对强度（0-100，窗口均值/全程样本极值之类），供排序参考；
// 位置型事件（片头/片尾/首次移动/终停/坡度翻转/折返点）没有强度语义，固定 50。
export interface QuickcutEvent {
  type: EventType;
  fitS: number | null;   // FIT 流逝秒锚点；片头/片尾是视频侧事件，fitS=null
  videoS: number | null; // merged 视频秒；不在任何段覆盖内为 null（不可用于剪辑）
  windowS: number;       // 建议窗口（秒）
  score: number;
  desc: string;          // 人话描述（含数值，供 agent/日志直接读）
  // 停顿事件专有：停顿区间的视频秒边界（供音频扫描定位；null = 端点不在视频覆盖内）
  fromVideoS?: number | null;
  toVideoS?: number | null;
  audio?: PauseAudioInfo; // annotatePauseAudio 附的人声标记
}

// 停顿窗的音频指纹：响亮切片呈持续的人声形态才算 talk（一声过路噪声不算）
export interface PauseAudioInfo {
  talk: boolean;
  fromS: number | null; // 人声区起点（视频秒）
  toS: number | null;   // 人声区终点
  peakDb: number | null;
}

export type EventType =
  | 'head' | 'tail'                       // 视频片头/片尾（数据开始前/后的车内段之类）
  | 'first_move' | 'final_stop'           // 首次持续移动 / 最终停止
  | 'pause'                               // 显著停顿（≥20s 静止，最多列 5 个）
  | 'cruise'                              // 最长连续移动
  | 'speed_peak'                          // 极速窗（10s 均速最大）
  | 'power_peak' | 'sprint'               // 功率峰（20s 窗口）/ 冲刺（5s 爆发），需功率计
  | 'hr_peak'                             // 心率峰（10s 窗口），需心率带
  | 'alt_high' | 'alt_low'                // 海拔极值（全程量程 >30m 才出）
  | 'grade_flip'                          // 坡度翻转（持续爬坡接持续放坡的转折点）
  | 'turnaround';                         // GPS 折返点（距起点最远），需定位

export const EVENT_LABELS: Record<EventType, string> = {
  head: '片头', tail: '片尾',
  first_move: '首次移动', final_stop: '最终停止',
  pause: '停顿', cruise: '最长巡航',
  speed_peak: '极速',
  power_peak: '功率峰', sprint: '冲刺', hr_peak: '心率峰',
  alt_high: '制高点', alt_low: '海拔最低', grade_flip: '坡度翻转', turnaround: '折返点',
};

// ---------- 样本归一化 ----------

export function normalizeSamples(rawSamples: { t: number | string; [k: string]: unknown }[], fitStartMs: number): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of rawSamples) {
    const tMs = typeof r.t === 'number' ? r.t : Date.parse(r.t);
    if (!Number.isFinite(tMs)) continue;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const pos = r.position as { lat?: unknown; lon?: unknown } | null | undefined;
    out.push({
      tS: (tMs - fitStartMs) / 1000,
      speed: num(r.speed),
      altitude: num(r.altitude),
      heart_rate: num(r.heart_rate),
      power: num(r.power),
      grade: num(r.grade),
      position: pos && typeof pos.lat === 'number' && typeof pos.lon === 'number' ? { lat: pos.lat, lon: pos.lon } : null,
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
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const kmh = (ms: number) => `${(ms * 3.6).toFixed(1)}km/h`;

// 最佳滑动窗口：win 个样本为一窗，score 返回 null 表示该窗不合格；返回窗口中心下标与分值
function bestWindow(s: NormalizedSample[], win: number, score: (w: NormalizedSample[]) => number | null): { i: number; v: number } | null {
  let best: { v: number; i: number } | null = null;
  for (let i = 0; i + win <= s.length; i++) {
    const v = score(s.slice(i, i + win));
    if (v != null && (best == null || v > best.v)) best = { v, i };
  }
  return best ? { i: best.i + Math.floor(win / 2), v: best.v } : null;
}

// 某字段在窗口内的均值（窗口内至少一半样本有值才算数）
function fieldAvg(w: NormalizedSample[], field: 'speed' | 'heart_rate' | 'power' | 'altitude' | 'grade'): number | null {
  const vals = w.map((x) => x[field]).filter((v): v is number => v != null);
  return vals.length >= w.length / 2 ? avg(vals) : null;
}

// 窗口均值相对全程样本极值的百分位（峰值类事件的 score）
function relPeak(windowAvg: number, s: NormalizedSample[], field: 'speed' | 'heart_rate' | 'power'): number {
  const max = Math.max(...s.map((x) => x[field] ?? 0));
  return max > 0 ? Math.round((windowAvg / max) * 100) : 50;
}

// 速度 ≥1.5 m/s 视为移动；连续 run 的时长按流逝秒跨度计（自动暂停的空洞如实计入）
function speedRuns(s: NormalizedSample[], moving: boolean, minDurS: number): { from: number; to: number; durS: number }[] {
  const runs: { from: number; to: number; durS: number }[] = [];
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const hit = moving ? speedOf(s[i]) >= 1.5 : speedOf(s[i]) < 1.5;
    if (hit && start < 0) start = i;
    if ((!hit || i === s.length - 1) && start >= 0) {
      const to = hit && i === s.length - 1 ? i : i - 1;
      const durS = s[to].tS - s[start].tS;
      if (durS >= minDurS) runs.push({ from: start, to, durS });
      start = -1;
    }
  }
  return runs;
}

// 球面距离（米），够折返点这种量级用
function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ---------- 事件菜单 ----------

// 同一类型、锚点相距 <60s 的重复事件只留高分者（不同类型允许同地共现——互为佐证，正是看点）
function dedupeEvents(events: QuickcutEvent[]): QuickcutEvent[] {
  const byType = new Map<EventType, QuickcutEvent[]>();
  for (const e of events) {
    const list = byType.get(e.type) ?? [];
    const near = list.find((x) => x.fitS != null && e.fitS != null && Math.abs(x.fitS - e.fitS) < 60);
    if (near) {
      if (e.score > near.score) list[list.indexOf(near)] = e;
    } else list.push(e);
    byType.set(e.type, list);
  }
  return [...byType.values()].flat();
}

export function detectEvents(
  s: NormalizedSample[],
  { segments = [], videoDurationS = null }: { segments?: QuickcutSegment[]; videoDurationS?: number | null } = {},
): QuickcutEvent[] {
  if (!s.length) return [];
  const toVideo = (fitS: number) => (segments.length ? fitToVideo(segments, fitS) : null);
  const ev = (e: Omit<QuickcutEvent, 'videoS'> & { fitS: number }): QuickcutEvent => ({ ...e, videoS: toVideo(e.fitS) });
  const out: QuickcutEvent[] = [];
  const t0 = s[0].tS;
  const tEnd = s[s.length - 1].tS;

  // 片头 / 片尾（视频侧事件：数据开始前/后相机多录的部分）
  if (videoDurationS != null) {
    const firstDataT = segments.length ? fitToVideo(segments, t0) : null;
    const lastDataT = segments.length ? fitToVideo(segments, tEnd) : null;
    if (firstDataT != null && firstDataT > 1) {
      out.push({ type: 'head', fitS: null, videoS: 0, windowS: 4, score: 50, desc: `片头（数据出现前 ${firstDataT.toFixed(0)}s）`, fromVideoS: 0, toVideoS: firstDataT });
    }
    if (lastDataT != null && videoDurationS - lastDataT > 1) {
      out.push({ type: 'tail', fitS: null, videoS: videoDurationS, windowS: 4, score: 50, desc: `片尾（数据结束后还有 ${(videoDurationS - lastDataT).toFixed(0)}s）`, fromVideoS: lastDataT, toVideoS: videoDurationS });
    }
  }

  // 首次持续移动 / 最终停止
  const firstRun = speedRuns(s, true, 0).find((r) => r.to - r.from >= 4);
  if (firstRun && firstRun.from > 0) {
    out.push(ev({ type: 'first_move', fitS: s[firstRun.from].tS, windowS: 3, score: 50, desc: `首次持续移动 ${kmh(speedOf(s[firstRun.from]))}` }));
  }
  const stops = speedRuns(s, false, 10);
  const lastStop = stops.length && stops[stops.length - 1].to === s.length - 1 ? stops[stops.length - 1] : null;
  if (lastStop && lastStop.from > 0) {
    out.push(ev({ type: 'final_stop', fitS: s[lastStop.from].tS, windowS: 4, score: 50, desc: `最终停止（此前移动 ${(s[lastStop.from].tS - t0).toFixed(0)}s）` }));
  }

  // 显著停顿（≥20s 静止；排除起点前与终停，最多列 5 个最长的）
  const pauses = speedRuns(s, false, 20)
    .filter((r) => r.from > 0 && r !== lastStop)
    .sort((a, b) => b.durS - a.durS)
    .slice(0, 5);
  const longestPause = pauses[0]?.durS ?? 1;
  for (const p of pauses) {
    const mid = s[Math.floor((p.from + p.to) / 2)].tS;
    out.push({
      ...ev({ type: 'pause', fitS: mid, windowS: 4, score: Math.round((p.durS / longestPause) * 100), desc: `停顿 ${p.durS.toFixed(0)}s` }),
      fromVideoS: toVideo(s[p.from].tS),
      toVideoS: toVideo(s[p.to].tS),
    });
  }

  // 最长巡航（连续移动 ≥3 m/s 的最长一段，取中点）
  const cruises = speedRuns(s.map((x) => ({ ...x, speed: speedOf(x) >= 3 ? 2 : 0 })), true, 60);
  if (cruises.length) {
    const c = cruises.sort((a, b) => b.durS - a.durS)[0];
    out.push(ev({ type: 'cruise', fitS: s[Math.floor((c.from + c.to) / 2)].tS, windowS: 8, score: 100, desc: `最长巡航 ${(c.durS / 60).toFixed(1)} 分钟` }));
  }

  // 极速窗（10 样本均速最大）
  const sp = bestWindow(s, 10, (w) => fieldAvg(w, 'speed'));
  if (sp && sp.v > 5) {
    out.push(ev({ type: 'speed_peak', fitS: s[sp.i].tS, windowS: 8, score: relPeak(sp.v, s, 'speed'), desc: `极速 ${kmh(sp.v)}` }));
  }

  // 功率峰 / 冲刺（需功率计）
  if (s.some((x) => x.power != null)) {
    const pp = bestWindow(s, 20, (w) => fieldAvg(w, 'power'));
    if (pp) out.push(ev({ type: 'power_peak', fitS: s[pp.i].tS, windowS: 7, score: relPeak(pp.v, s, 'power'), desc: `功率峰 20s 均 ${Math.round(pp.v)}W` }));
    const sr = bestWindow(s, 5, (w) => fieldAvg(w, 'power'));
    if (sr) out.push(ev({ type: 'sprint', fitS: s[sr.i].tS, windowS: 3, score: relPeak(sr.v, s, 'power'), desc: `冲刺 5s 均 ${Math.round(sr.v)}W` }));
  }

  // 心率峰（需心率带）
  if (s.some((x) => x.heart_rate != null)) {
    const hr = bestWindow(s, 10, (w) => fieldAvg(w, 'heart_rate'));
    if (hr) out.push(ev({ type: 'hr_peak', fitS: s[hr.i].tS, windowS: 6, score: relPeak(hr.v, s, 'heart_rate'), desc: `心率峰 ${Math.round(hr.v)}bpm` }));
  }

  // 海拔极值（量程 >30m 才出；取极值附近最静止的点——停下来的那一幕）
  const alts = s.map((x) => x.altitude).filter((v): v is number => v != null);
  if (alts.length) {
    const maxAlt = Math.max(...alts);
    const minAlt = Math.min(...alts);
    const range = maxAlt - minAlt;
    if (range > 30) {
      const extreme = (target: number, band: number) => {
        let best: NormalizedSample | null = null;
        for (const x of s) {
          if (x.altitude != null && Math.abs(x.altitude - target) <= band) {
            if (!best || speedOf(x) < speedOf(best)) best = x;
          }
        }
        return best;
      };
      const hi = extreme(maxAlt, 2);
      if (hi) out.push(ev({ type: 'alt_high', fitS: hi.tS, windowS: 4, score: 100, desc: `制高点 ${Math.round(maxAlt)}m（量程 ${Math.round(range)}m）` }));
      const lo = extreme(minAlt, 2);
      if (lo) out.push(ev({ type: 'alt_low', fitS: lo.tS, windowS: 4, score: 100, desc: `海拔最低 ${Math.round(minAlt)}m` }));
    }
  }

  // 坡度翻转：前 40 样本均坡度 ≥2%、后 40 样本 ≤−1.5%，找高差最大的转折（登顶不停车的情形）
  if (s.length >= 100 && s.some((x) => x.grade != null)) {
    const win = 40;
    let best: { i: number; pre: number; post: number } | null = null;
    for (let i = win; i + win <= s.length; i++) {
      const pre = fieldAvg(s.slice(i - win, i), 'grade');
      const post = fieldAvg(s.slice(i, i + win), 'grade');
      if (pre == null || post == null || pre < 2 || post > -1.5) continue;
      if (!best || pre - post > best.pre - best.post) best = { i, pre, post };
    }
    if (best) out.push(ev({ type: 'grade_flip', fitS: s[best.i].tS, windowS: 4, score: Math.min(100, Math.round((best.pre - best.post) * 10)), desc: `坡度翻转（+${best.pre.toFixed(1)}% 转 ${best.post.toFixed(1)}%）` }));
  }

  // GPS 折返点：距起点最远的样本
  const pts = s.filter((x) => x.position != null);
  if (pts.length > 10) {
    const origin = pts[0].position!;
    let best: NormalizedSample | null = null;
    let maxD = 0;
    for (const x of pts) {
      const d = haversineM(origin, x.position!);
      if (d > maxD) { maxD = d; best = x; }
    }
    if (best && maxD > 500) {
      out.push(ev({ type: 'turnaround', fitS: best.tS, windowS: 4, score: 50, desc: `折返点（距起点 ${(maxD / 1000).toFixed(1)}km）` }));
    }
  }

  // 菜单按时间轴排序（片头/片尾用 videoS 天然落在两端；未覆盖事件排在覆盖事件之后供参考）
  return dedupeEvents(out).sort((a, b) => {
    const ka = a.videoS ?? (a.fitS != null ? Number.MAX_SAFE_INTEGER / 2 + a.fitS : 0);
    const kb = b.videoS ?? (b.fitS != null ? Number.MAX_SAFE_INTEGER / 2 + b.fitS : 0);
    return ka - kb;
  });
}

// ---------- 停顿窗音频扫描（人声标记） ----------

const AUDIO_BUCKET_S = 5; // 聚合桶宽（秒）
const AUDIO_TALK_DB = -25; // 响度阈值：DJI 风噪抑制下骑行基线远低于此，近场人声显著高于此
const AUDIO_TALK_MIN_BUCKETS = 3; // 至少 ~15s 持续响亮才算「有人声」，过路噪声/一声快门不触发
const AUDIO_SCAN_CAP_S = 600; // 单个停顿最多扫的时长（-vn 只解音频，600s ≈ 5s；上限只为防病态素材，别截断真实人声区——beat 取人声区收尾，截断会认错结尾）

// 单次 ffmpeg astats 全窗扫描 → 5s 桶能量均值（dB 转线性能量求均值再转回）
export async function scanPauseAudio(video: string, fromS: number, toS: number): Promise<PauseAudioInfo> {
  const durS = Math.max(1, Math.min(toS - fromS, AUDIO_SCAN_CAP_S));
  const r = await run('ffmpeg', [
    '-hide_banner', '-ss', fromS.toFixed(2), '-t', durS.toFixed(2), '-i', video,
    '-vn', // 只解音频：不选视频流（否则 4K 白解码，240s 窗从 ~90s 降到 ~2s）
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg astats 退出码 ${r.code}`);

  // 输出是 frame/pts_time 行与 RMS_level 行交替：配对后按 5s 桶聚合
  const buckets = new Map<number, { sum: number; n: number }>();
  let pts: number | null = null;
  for (const line of r.stdout.split('\n')) {
    const pm = /pts_time:([\d.]+)/.exec(line);
    if (pm) { pts = Number(pm[1]); continue; }
    const rm = /RMS_level=(-?[\d.eE+-]+)/.exec(line);
    if (!rm || pts == null) continue;
    const db = Number(rm[1]);
    if (!Number.isFinite(db) || db <= -90) continue; // -inf/静音桶不进能量均值
    const i = Math.floor(pts / AUDIO_BUCKET_S);
    const b = buckets.get(i) ?? { sum: 0, n: 0 };
    b.sum += 10 ** (db / 10); // 能量线性叠加
    b.n++;
    buckets.set(i, b);
  }
  const loud: { i: number; db: number }[] = [];
  for (const [i, b] of [...buckets.entries()].sort((a, z) => a[0] - z[0])) {
    if (!b.n) continue;
    const db = 10 * Math.log10(b.sum / b.n);
    if (db > AUDIO_TALK_DB) loud.push({ i, db });
  }
  if (loud.length < AUDIO_TALK_MIN_BUCKETS) {
    return { talk: false, fromS: null, toS: null, peakDb: loud.length ? Math.max(...loud.map((x) => x.db)) : null };
  }
  return {
    talk: true,
    fromS: fromS + loud[0].i * AUDIO_BUCKET_S,
    toS: Math.min(fromS + (loud[loud.length - 1].i + 1) * AUDIO_BUCKET_S, fromS + durS),
    peakDb: Math.max(...loud.map((x) => x.db)),
  };
}

// 给停顿事件附人声标记（desc 追加人声区间/安静）。扫描失败不挡流程——事件退化为普通停顿。
// 停顿间并发扫描；只有边界都在视频覆盖内、且时长 ≥15s 的停顿值得扫
export async function annotatePauseAudio(events: QuickcutEvent[], video: string): Promise<QuickcutEvent[]> {
  await Promise.all(events.map(async (e) => {
    if (e.type !== 'pause' || e.fromVideoS == null || e.toVideoS == null) return;
    if (e.toVideoS - e.fromVideoS < 15) return;
    try {
      const a = await scanPauseAudio(video, e.fromVideoS, e.toVideoS);
      e.audio = a;
      e.desc += a.talk && a.fromS != null && a.toS != null
        ? `（${a.fromS.toFixed(0)}–${a.toS.toFixed(0)}s 有人声）`
        : '（安静）';
    } catch { /* 标记失败不挡流程 */ }
  }));
  return events;
}

// ---------- 兜底组装：事件菜单 → ~30s 粗剪 ----------

// 槽位偏好：generic 运动短片的骨架。每槽按 types 顺序优先（power_peak 先于 hr_peak）、同型按 score；
// 与已选幕窗口重叠（留 2s 余量）时让位给同槽下一个候选，都没有则丢弃并记录原因。
const HEURISTIC_SLOTS: { key: string; label: string; types: EventType[]; durationS: number }[] = [
  { key: 'departure', label: '出发', types: ['head'], durationS: 4 },
  { key: 'rollout', label: '上路', types: ['first_move'], durationS: 3 },
  { key: 'effort', label: '发力', types: ['power_peak', 'hr_peak'], durationS: 7 },
  { key: 'high', label: '制高点', types: ['alt_high'], durationS: 4 },
  { key: 'speed', label: '极速', types: ['speed_peak'], durationS: 8 },
  { key: 'finish', label: '收尾', types: ['tail'], durationS: 4 },
];

export function assembleHeuristic({
  samples,
  segments,
  videoDurationS,
}: {
  samples: NormalizedSample[];
  segments: QuickcutSegment[];
  videoDurationS: number;
}): QuickcutPlan {
  if (!samples.length) throw new Error('快剪需要 FIT 样本（无数据素材不支持）');
  const events = detectEvents(samples, { segments, videoDurationS });

  const acts: QuickcutAct[] = [];
  const dropped: QuickcutPlan['dropped'] = [];
  const picked: { start: number; end: number }[] = []; // 已选幕窗口（视频秒）

  for (const slot of HEURISTIC_SLOTS) {
    const candidates = events
      .filter((e) => slot.types.includes(e.type) && e.videoS != null)
      .sort((a, b) => slot.types.indexOf(a.type) - slot.types.indexOf(b.type) || b.score - a.score);
    const win = (center: number) => ({ start: center - slot.durationS / 2, end: center + slot.durationS / 2 });
    const overlaps = (w: { start: number; end: number }) => picked.some((p) => w.start < p.end + 2 && p.start - 2 < w.end);
    const event = candidates.find((e) => e.type === 'head' || e.type === 'tail' || !overlaps(win(e.videoS!)));
    if (!event) {
      const reason = !events.some((e) => slot.types.includes(e.type))
        ? '数据中无此类事件'
        : candidates.length
          ? '候选与已选幕窗口重叠'
          : '事件不在任何视频段的 FIT 覆盖内';
      dropped.push({ key: slot.key, label: slot.label, reason });
      continue;
    }
    // 片头/片尾贴边圈窗，其余以事件为中心
    let start: number, end: number;
    if (event.type === 'head') {
      const preambleS = fitToVideo(segments, samples[0].tS) ?? 0;
      start = Math.min(3, preambleS / 4);
      end = start + slot.durationS;
    } else if (event.type === 'tail') {
      end = videoDurationS - 1;
      start = end - slot.durationS;
    } else {
      start = Math.max(0, event.videoS! - slot.durationS / 2);
      end = Math.min(videoDurationS, start + slot.durationS);
      start = Math.max(0, end - slot.durationS);
    }
    picked.push({ start, end });
    acts.push({
      key: slot.key,
      label: slot.label,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      reason: event.desc,
    });
  }

  return { acts, dropped, totalS: acts.reduce((a, x) => a + (x.end - x.start), 0) };
}

// 外部（agent/CLI）指定的精确剪辑点 → plan。cuts 至少一条，0 ≤ start < end。
export function planFromCuts(cuts: { start: number; end: number; label?: string }[]): QuickcutPlan {
  if (!Array.isArray(cuts) || !cuts.length) throw new Error('cuts 至少一条');
  const acts: QuickcutAct[] = cuts.map((c, i) => {
    if (typeof c.start !== 'number' || typeof c.end !== 'number' || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start) {
      throw new Error(`cuts[${i}] 非法：需要 0 ≤ start < end`);
    }
    return { key: `cut${i + 1}`, label: c.label || `片段${i + 1}`, start: c.start, end: c.end, reason: '外部指定' };
  });
  return { acts, dropped: [], totalS: acts.reduce((a, x) => a + (x.end - x.start), 0) };
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
