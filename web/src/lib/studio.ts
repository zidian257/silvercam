// studio 页的领域逻辑（纯函数，与 DOM/WebGL 解耦直接可测）

// FIT 采样点：可读字段由 samples.fields 清单决定（speed/heart_rate/position/...），值按 any 透传插值
export interface StudioSample {
  [field: string]: any;
}

// /api/align/samples 响应（t0_ms 仅锚定用，插值不依赖）
export interface StudioSamples {
  count: number;
  t0_ms?: number;
  fields: string[];
  samples: StudioSample[];
}

// 只做时间锚定时的最小采样形状
export interface SamplesAnchor {
  count: number;
  t0_ms: number;
}

// 同次录制的切段信息（对齐/跳转用）
export interface SegmentInfo {
  i?: number;
  duration?: number | null;
  creation_time_utc_ms?: number | null;
  [k: string]: any;
}

// .cube 解析结果（dmin/dmax 三元组对应 RGB）
export interface CubeLut {
  size: number;
  dmin: [number, number, number];
  dmax: [number, number, number];
  data: Float32Array;
}

export interface LutOptionArgs {
  qsLut?: string | null;
  sourceLut?: string | null;
  dlogSuspected?: boolean;
  defaultLut?: string | null;
  optionValues?: string[];
}

// studio 对齐来源（任务 / 素材 / 临时预览）
export interface StudioSource {
  kind?: string;
  state?: string;
  running?: boolean;
  [k: string]: any;
}

export interface SavePlanResult {
  visible: boolean;
  label: string;
  hint: string;
  disabled?: boolean;
  heavy?: boolean;
}

export function mmss(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const neg = s < 0;
  const a = Math.abs(s);
  return `${neg ? '-' : ''}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}`;
}

// 与服务端 render.js 同款的采样插值：对齐页实时驱动皮肤
export function sampleAt(samples: StudioSamples, fitSeconds: number): StudioSample {
  const f = Math.min(Math.max(fitSeconds, 0), samples.count - 1);
  const lo = Math.floor(f);
  const hi = Math.min(lo + 1, samples.count - 1);
  const frac = f - lo;
  const a = samples.samples[lo];
  const b = samples.samples[hi];
  const out: StudioSample = { t: a.t, i: Math.round(f * 1000) / 1000 };
  for (const field of samples.fields) {
    if (field === 'position') {
      if (a.position && b.position) {
        out.position = {
          lat: a.position.lat + (b.position.lat - a.position.lat) * frac,
          lon: a.position.lon + (b.position.lon - a.position.lon) * frac,
        };
      } else out.position = a.position ?? b.position ?? null;
      continue;
    }
    const va = a[field];
    const vb = b[field];
    if (va != null && vb != null) out[field] = va + (vb - va) * frac;
    else out[field] = va ?? vb ?? null;
  }
  return out;
}

// .cube 解析（WebGL 预览 LUT 用）
export function parseCube(text: string): CubeLut {
  let size: number | null = null;
  let dmin: [number, number, number] = [0, 0, 0];
  let dmax: [number, number, number] = [1, 1, 1];
  const vals: number[] = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
    if (m) { size = Number(m[1]); continue; }
    m = /^DOMAIN_MIN\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i.exec(line);
    if (m) { dmin = [Number(m[1]), Number(m[2]), Number(m[3])]; continue; }
    m = /^DOMAIN_MAX\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i.exec(line);
    if (m) { dmax = [Number(m[1]), Number(m[2]), Number(m[3])]; continue; }
    if (/^[\d.eE+-]/.test(line)) {
      const p = line.split(/\s+/).map(Number);
      if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) vals.push(p[0], p[1], p[2]);
    }
  }
  if (!size || vals.length !== size * size * size * 3) {
    throw new Error(`LUT 解析失败（size=${size}, 数据点=${vals.length / 3}）`);
  }
  return { size, dmin, dmax, data: new Float32Array(vals) };
}

// 数据窗口：当前段视频内 [lo, hi] 秒区间有 FIT 数据（仪表盘出现）；无交集返回 null
export function dataWindow({ duration, count, offset }: { duration: number | null; count: number | null; offset: number | null }): [number, number] | null {
  if (duration == null || count == null || offset == null) return null;
  const lo = Math.max(0, -offset);
  const hi = Math.min(duration, count - 1 - offset);
  return lo < hi ? [lo, hi] : null;
}

// 各段自动锚定 offset（bias 之前）
export function autoOffset(seg: SegmentInfo | null | undefined, samples: SamplesAnchor | null | undefined): number | null {
  if (!seg || seg.creation_time_utc_ms == null || !samples) return null;
  return (seg.creation_time_utc_ms - samples.t0_ms) / 1000;
}

// 本段无数据时找数据落在哪一段（FIT 可能骑在同次录制的另一段上）
export function findDataSegment(segments: SegmentInfo[] | null | undefined, curSegIdx: number, bias: number, samples: SamplesAnchor | null | undefined): { seg: SegmentInfo; fitS: number } | null {
  if (!samples) return null;
  for (const g of segments ?? []) {
    if (g.i === curSegIdx || g.creation_time_utc_ms == null) continue;
    const off = autoOffset(g, samples)! + bias; // 上面已排除 creation_time_utc_ms 为空，off 必非 null
    const lo = Math.max(0, -off);
    if (lo <= (g.duration ?? 0) && lo + off <= samples.count - 1) return { seg: g, fitS: lo + off };
  }
  return null;
}

// 底部读数行
export function captionFor(sample: StudioSample | null | undefined, fitS: number, currentTime: number): string {
  if (!sample) return '';
  const kmh = sample.speed != null ? `${(sample.speed * 3.6).toFixed(1)} km/h` : '--';
  const hr = sample.heart_rate != null ? Math.round(sample.heart_rate) : '--';
  const pwr = sample.power != null ? `${Math.round(sample.power)}W` : '--';
  const cad = sample.cadence != null ? Math.round(sample.cadence) : '--';
  const dist = sample.distance != null ? `${(sample.distance / 1000).toFixed(2)}km` : '--';
  return `t=${mmss(currentTime)} · FIT t=${fitS.toFixed(0)}s · 速度 ${kmh} · 心率 ${hr} · 功率 ${pwr} · 踏频 ${cad} · 里程 ${dist}`;
}

// LUT 初始值：query > 任务记录的链 > D-Log 嫌疑用默认 > none；
// 任务里存的是解析后的绝对路径/链：按文件名映射回下拉里的命名项
export function lutOptionValue({ qsLut = null, sourceLut = null, dlogSuspected = false, defaultLut = null, optionValues = [] }: LutOptionArgs): string {
  let init: string = qsLut ?? sourceLut ?? (dlogSuspected ? defaultLut : null) ?? 'none';
  if (init !== 'none' && !optionValues.includes(init)) {
    const base = String(init).split(',')[0].split('+')[0].split('/').pop()!.replace(/\.cube$/i, '');
    if (optionValues.includes(base)) init = base;
  }
  return init; // 不在选项里时调用方负责追加一个自定义 option
}

// 定格状态行：定格后显示当前 bias 对应的 FIT 起点视频时刻（fitS=0 ⇒ t=−offset，随微调实时更新）
export function pinStatusFor(pinned: boolean, offset: number | null | undefined): string {
  if (!pinned || offset == null) return '';
  return `FIT 起点 @ ${mmss(-offset)}`;
}

// 保存按钮的形态（按 source kind/state）
export function savePlan(source: StudioSource | null | undefined): SavePlanResult {
  if (!source || source.kind === 'adhoc') {
    return { visible: false, label: '', hint: '临时预览模式：不落盘。正式出片用 actpipe run --offset 或素材库里对齐' };
  }
  if (source.kind === 'job') {
    const heavy = ['done', 'failed'].includes(source.state!); // kind=job 的来源必带 state
    return {
      visible: true,
      label: heavy ? '保存 bias 并重渲' : '保存 bias',
      hint: source.running ? '任务运行中，结束后可保存' : heavy ? '已完成任务：保存会重新渲染+转码（旧成片保留）' : '任务尚未出片：保存后直接生效',
      disabled: !!source.running,
      heavy,
    };
  }
  return { visible: true, label: '保存对齐', hint: '存到该素材上，「开始处理」时随任务入队', disabled: false, heavy: false };
}
