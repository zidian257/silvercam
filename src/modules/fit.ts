import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- fitsdk 的 index.d.ts 用无扩展名 re-export，nodenext 解析不到；运行时 index.js 正常，导入绑定按 any 处理
import { Decoder, Stream } from '@garmin/fitsdk';
import { round, writeJsonAtomic } from '../lib/util.ts';
import type { ProbeResult } from '../types.ts';

const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

const NUMERIC_FIELDS = ['speed', 'altitude', 'heart_rate', 'cadence', 'power', 'grade', 'distance', 'temperature'];
const MAX_INTERP_GAP_S = 10;

// 解码后的单条记录：t 为 UTC 毫秒，其余字段缺测为 null
export interface FitRecord {
  t: number;
  speed: number | null;
  altitude: number | null;
  heart_rate: number | null;
  cadence: number | null;
  power: number | null;
  grade: number | null;
  distance: number | null;
  temperature: number | null;
  lat: number | null;
  lon: number | null;
  [field: string]: number | null; // processRecords 按字段名索引
}

export interface FitSessionSummary {
  start_time: string | null;
  sport: string | null;
  total_elapsed_time: number | null;
}

export interface FitSampleRow {
  t: string; // ISO 时间戳
  position?: { lat: number | null; lon: number | null } | null;
  [field: string]: unknown;
}

export interface ProcessedSamples {
  version: number;
  t0: string;
  t0_ms: number;
  interval_ms: number;
  count: number;
  fields: string[];
  grade_recomputed: boolean;
  samples: FitSampleRow[];
}

export interface AnchorResult {
  ok: boolean;
  reason?: string;
  offset_seconds?: number | null;
  creation_time?: string;
  fit_start?: string;
  fit_end?: string;
  bias_seconds?: number;
  in_range?: boolean;
  source?: string;
  warnings: string[];
}

export function decodeFit(buf: Uint8Array): { records: FitRecord[]; session: FitSessionSummary | null } {
  const decoder = new Decoder(Stream.fromByteArray(new Uint8Array(buf)));
  if (!decoder.isFIT()) throw new Error('not a FIT file');
  if (!decoder.checkIntegrity()) throw new Error('FIT CRC check failed');
  const { messages, errors } = decoder.read() as { messages: any; errors: unknown[] }; // FIT SDK 记录字段形状由 SDK 决定，按 any 处理
  if (errors?.length) throw new Error(`FIT decode errors: ${errors.map(String).join('; ')}`);

  const records = (messages.recordMesgs ?? [])
    .filter((r: any) => r.timestamp)
    .map((r: any) => ({
      t: new Date(r.timestamp).getTime(),
      speed: num(r.enhancedSpeed ?? r.speed),
      altitude: num(r.enhancedAltitude ?? r.altitude),
      heart_rate: num(r.heartRate),
      cadence: num(r.cadence),
      power: num(r.power),
      grade: num(r.grade),
      distance: num(r.distance),
      temperature: num(r.temperature),
      lat: r.positionLat != null ? r.positionLat * SEMICIRCLE_TO_DEG : null,
      lon: r.positionLong != null ? r.positionLong * SEMICIRCLE_TO_DEG : null,
    }))
    .sort((a: FitRecord, b: FitRecord) => a.t - b.t);

  if (!records.length) throw new Error('no record messages');

  const session = messages.sessionMesgs?.[0] ?? null;
  return {
    records,
    session: session
      ? {
          start_time: session.startTime ? new Date(session.startTime).toISOString() : null,
          sport: session.sport ?? null,
          total_elapsed_time: session.totalElapsedTime ?? null,
        }
      : null,
  };
}

export function parseFit(file: string): { records: FitRecord[]; session: FitSessionSummary | null } {
  try {
    return decodeFit(fs.readFileSync(file));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hasGps(records: FitRecord[]): boolean {
  return records.some((r) => r.lat != null && r.lon != null);
}

export function processRecords(records: FitRecord[], { smoothWindowS = 3 }: { smoothWindowS?: number } = {}): ProcessedSamples {
  const t0 = Math.floor(records[0].t / 1000) * 1000;
  const t1 = records[records.length - 1].t;
  const count = Math.round((t1 - t0) / 1000) + 1;

  const grid: { t: number; lo: number }[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i * 1000;
    while (cursor < records.length - 1 && records[cursor + 1].t <= t) cursor++;
    grid.push({ t, lo: cursor });
  }

  const fields: string[] = [];
  const columns: Record<string, (number | null)[] | null> = {};
  for (const field of [...NUMERIC_FIELDS, 'lat', 'lon']) {
    const present = records.some((r) => r[field] != null);
    if (!present) {
      columns[field] = null;
      continue;
    }
    if (field !== 'lat' && field !== 'lon') fields.push(field);
    const col = new Array(count).fill(null);
    for (let i = 0; i < count; i++) {
      const { t, lo } = grid[i];
      col[i] = interpolateAt(records, lo, t, field);
    }
    columns[field] = col;
  }
  if (hasGps(records)) fields.push('position');

  // 坡度重算：FIT 无 grade 字段时用 altitude + distance
  let gradeRecomputed = false;
  if (!columns.grade && columns.altitude && columns.distance) {
    columns.grade = recomputeGrade(columns.altitude, columns.distance);
    if (columns.grade.some((v) => v != null)) {
      fields.push('grade');
      gradeRecomputed = true;
    }
  }

  const half = Math.max(0, Math.floor(smoothWindowS / 2));
  if (half > 0) {
    for (const field of ['speed', 'altitude', 'heart_rate', 'cadence', 'power', 'grade']) {
      if (columns[field]) columns[field] = smooth(columns[field], half);
    }
  }

  const samples: FitSampleRow[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const s: FitSampleRow = { t: new Date(t0 + i * 1000).toISOString() };
    for (const field of fields) {
      if (field === 'position') {
        const lat = columns.lat?.[i];
        const lon = columns.lon?.[i];
        s.position = lat != null && lon != null ? { lat: round(lat, 7), lon: round(lon, 7) } : null;
      } else {
        s[field] = round(columns[field]?.[i], field === 'grade' ? 2 : 2);
      }
    }
    samples[i] = s;
  }

  return {
    version: 1,
    t0: new Date(t0).toISOString(),
    t0_ms: t0,
    interval_ms: 1000,
    count,
    fields,
    grade_recomputed: gradeRecomputed,
    samples,
  };
}

function interpolateAt(records: FitRecord[], lo: number, t: number, field: string): number | null {
  const find = (from: number, direction: number): FitRecord | null => {
    for (let i = from; i >= 0 && i < records.length; i += direction) {
      if (records[i][field] != null) return records[i];
      if (Math.abs(records[i].t - t) > MAX_INTERP_GAP_S * 1000) return null;
    }
    return null;
  };
  const va = find(lo, -1);
  const vb = find(lo + 1, 1) ?? va;
  if (!va && !vb) return null;
  if (!va) return vb![field];
  if (!vb) return va[field];
  if (vb.t === va.t) return va[field];
  const f = Math.min(1, Math.max(0, (t - va.t) / (vb.t - va.t)));
  return (va[field] as number) + ((vb[field] as number) - (va[field] as number)) * f;
}

function smooth(col: (number | null)[], half: number): (number | null)[] {
  const out: (number | null)[] = new Array(col.length).fill(null);
  for (let i = 0; i < col.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(col.length - 1, i + half); j++) {
      if (col[j] != null) {
        sum += col[j]!;
        n++;
      }
    }
    out[i] = n ? sum / n : null;
  }
  return out;
}

function recomputeGrade(altitude: (number | null)[], distance: (number | null)[]): (number | null)[] {
  const n = altitude.length;
  const out: (number | null)[] = new Array(n).fill(null);
  const win = 3;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(n - 1, i + win);
    const dAlt = altitude[b]! - altitude[a]!;
    const dDist = distance[b]! - distance[a]!;
    out[i] = dDist >= 2 ? (dAlt / dDist) * 100 : 0;
  }
  return out;
}

export function parseFilenameTimestamp(file: string): number | null {
  const m = /DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(path.basename(file));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // 文件名内嵌的是本地开拍时刻，按系统时区换算回 UTC
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export function computeAnchor({
  creationTimeUtcMs,
  videoFile = null,
  fitStartMs,
  fitEndMs,
  biasSeconds = 0,
  filenameToleranceS = 10,
  videoDurationS = null,
}: {
  creationTimeUtcMs: number | null;
  videoFile?: string | null;
  fitStartMs: number;
  fitEndMs: number;
  biasSeconds?: number;
  filenameToleranceS?: number;
  videoDurationS?: number | null;
}): AnchorResult {
  const warnings: string[] = [];
  if (creationTimeUtcMs == null) {
    return { ok: false, reason: 'no_creation_time', warnings };
  }

  if (videoFile) {
    const fileTs = parseFilenameTimestamp(videoFile);
    if (fileTs != null) {
      const deltaS = (creationTimeUtcMs - fileTs) / 1000;
      if (Math.abs(deltaS) > filenameToleranceS) {
        warnings.push(
          `creation_time 与文件名时间戳相差 ${deltaS.toFixed(1)}s（> ${filenameToleranceS}s），相机可能未对时或固件行为变化`
        );
      }
    }
  }

  const offsetSeconds = (creationTimeUtcMs - fitStartMs) / 1000 + biasSeconds;
  // 判定锚定有效性：视频窗口 [creation, creation+duration] 与 FIT 窗口有交集即可。
  // 视频先于 FIT 开始（负 offset，如先开相机后开码表）是合法场景：开头一段无数据，overlay 延后入场。
  const vEndMs = videoDurationS != null ? creationTimeUtcMs + videoDurationS * 1000 : creationTimeUtcMs;
  const inRange = creationTimeUtcMs <= fitEndMs && vEndMs >= fitStartMs - 60_000;
  if (inRange && offsetSeconds < 0) {
    warnings.push(`视频开拍早于 FIT 起点 ${(-offsetSeconds).toFixed(1)}s：片头这段时间无数据，仪表盘延后出现`);
  }
  // bias 可能把该段整个推出 FIT 数据窗口（如码表提前停表）：整段无仪表盘，仅套 LUT
  if (inRange && videoDurationS != null) {
    const fitLenS = (fitEndMs - fitStartMs) / 1000;
    if (offsetSeconds >= fitLenS || offsetSeconds + videoDurationS <= 0) {
      warnings.push('该段与 FIT 数据窗口无交集，整段无仪表盘数据');
    }
  }
  if (!inRange) {
    warnings.push(
      `锚定点 ${new Date(creationTimeUtcMs).toISOString()} 落在 FIT 活动时间范围 ` +
        `[${new Date(fitStartMs).toISOString()} .. ${new Date(fitEndMs).toISOString()}] 之外，需手填 offset_seconds`
    );
  }
  return {
    ok: inRange,
    offset_seconds: round(offsetSeconds, 3),
    creation_time: new Date(creationTimeUtcMs).toISOString(),
    fit_start: new Date(fitStartMs).toISOString(),
    fit_end: new Date(fitEndMs).toISOString(),
    bias_seconds: biasSeconds,
    in_range: inRange,
    warnings,
  };
}

export function buildSession({ fitFile, processed, anchor, availableFields }: {
  fitFile: string;
  processed: ProcessedSamples;
  anchor: AnchorResult | null;
  availableFields?: string[] | null;
}) {
  const fitStartMs = processed.t0_ms;
  const fitEndMs = fitStartMs + (processed.count - 1) * processed.interval_ms;
  return {
    fit_file: path.resolve(fitFile),
    activity: {
      start: new Date(fitStartMs).toISOString(),
      end: new Date(fitEndMs).toISOString(),
      duration_s: Math.round((fitEndMs - fitStartMs) / 1000),
    },
    offset_seconds: anchor?.offset_seconds ?? null,
    anchor: anchor ?? null,
    fields: availableFields ?? processed.fields,
  };
}

export async function fitToFiles(fitFile: string, { probe = null, videoFile = null, biasSeconds = 0, smoothWindowS = 3, outDir = null, offsetOverride = null }: {
  probe?: (ProbeResult & { creation_time_utc_ms?: number | null }) | null;
  videoFile?: string | null;
  biasSeconds?: number;
  smoothWindowS?: number;
  outDir?: string | null;
  offsetOverride?: number | null;
} = {}) {
  const { records } = parseFit(fitFile);
  const processed = processRecords(records, { smoothWindowS });
  const fitStartMs = processed.t0_ms;
  const fitEndMs = fitStartMs + (processed.count - 1) * processed.interval_ms;

  let anchor: AnchorResult | null = null;
  if (offsetOverride != null) {
    anchor = {
      ok: true,
      offset_seconds: offsetOverride,
      source: 'manual',
      in_range: true,
      warnings: [],
    };
  } else if (probe?.creation_time_utc_ms != null) {
    anchor = computeAnchor({
      creationTimeUtcMs: probe.creation_time_utc_ms,
      videoFile: videoFile ?? probe.file,
      fitStartMs,
      fitEndMs,
      biasSeconds,
      videoDurationS: probe.duration ?? null,
    });
  }

  const session = buildSession({ fitFile, processed, anchor });
  if (outDir) {
    writeJsonAtomic(path.join(outDir, 'samples.json'), processed);
    writeJsonAtomic(path.join(outDir, 'session.json'), session);
  }
  return { samples: processed, session };
}
