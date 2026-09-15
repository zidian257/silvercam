import path from 'node:path';
import { parseFps, runOk, writeJsonAtomic } from '../lib/util.ts';
import { resolveLutPath } from '../lib/config.ts';
import type { ActpipeConfig, LutDecision, ProbeResult } from '../types.ts';

export interface ProbeColor {
  space: string;
  primaries: string;
  trc: string;
  range: string;
}

export interface ProbeAudio {
  codec: string | null;
  channels: number | null;
  sample_rate: number | null;
}

// probeFile 的完整返回：共享 ProbeResult + 管线实际使用的附加字段
export interface ProbeInfo extends ProbeResult {
  bitrate: number;
  pix_fmt: string | null;
  color: ProbeColor;
  has_audio: boolean;
  audio: ProbeAudio | null;
  creation_time: string | null;
  creation_time_utc_ms: number | null;
  tags: Record<string, string>;
}

export async function probeFile(file: string): Promise<ProbeInfo> {
  const r = await runOk('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const raw = JSON.parse(r.stdout) as any; // ffprobe 原始输出，字段形状由 ffprobe 决定
  const v = (raw.streams || []).find((s: any) => s.codec_type === 'video');
  if (!v) throw new Error(`no video stream in ${file}`);
  const a = (raw.streams || []).find((s: any) => s.codec_type === 'audio');
  const fps = parseFps(v.avg_frame_rate) || parseFps(v.r_frame_rate);
  const creationTime = raw.format?.tags?.creation_time ?? v.tags?.creation_time ?? null;
  return {
    file: path.resolve(file),
    width: v.width,
    height: v.height,
    fps: Math.round(fps * 1000) / 1000,
    duration: Number(raw.format?.duration ?? v.duration ?? 0),
    bitrate: Number(raw.format?.bit_rate ?? v.bit_rate ?? 0),
    codec: v.codec_name,
    pix_fmt: v.pix_fmt,
    bit_depth: v.bits_per_raw_sample ? Number(v.bits_per_raw_sample) : v.pix_fmt?.includes('10') ? 10 : 8,
    color: {
      space: v.color_space ?? 'unknown',
      primaries: v.color_primaries ?? 'unknown',
      trc: v.color_transfer ?? 'unknown',
      range: v.color_range ?? 'unknown',
    },
    has_audio: !!a,
    audio: a
      ? {
          codec: a.codec_name ?? null,
          channels: a.channels ?? null,
          sample_rate: a.sample_rate ? Number(a.sample_rate) : null,
        }
      : null,
    creation_time: creationTime,
    creation_time_utc_ms: creationTime ? Date.parse(creationTime) : null,
    // DJI 等厂商写在 format.tags 里的私有信息（com.dji.* / make / model / encoder 之类），有就存
    tags: pickTags(raw.format?.tags),
  };
}

function pickTags(tags: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(tags ?? {})) {
    if (/dji/i.test(k) || /^(make|model|encoder)$/i.test(k)) out[k] = String(val);
  }
  return out;
}

// looksDlog / memoryKey / decideLut 只消费这几项（probe.test.ts 的桩也只给这些）
export interface DlogProbeShape {
  file: string;
  width: number;
  height: number;
  fps: number;
  codec?: string;
  bit_depth?: number;
  color?: { space?: string; primaries?: string; trc?: string; range?: string };
}

// 10-bit HEVC 才有可能需要还原 LUT：不足 10bit 一定不是 D-Log，直接排除；
// 10bit 有可能有可能不是（DJI 的 D-Log 与普通色彩都写 bt709 标签，色彩标签无区分度），
// 所以这里只按位深+编码圈定「嫌疑范围」，最终由 ask 策略问人/记忆裁决。
export function looksDlog(probe: DlogProbeShape): boolean {
  const tenBit = (probe.bit_depth ?? 8) >= 10;
  const hevc = /hevc|h265/i.test(probe.codec ?? '');
  return tenBit && hevc;
}

export function memoryKey(probe: DlogProbeShape, serial = 'unknown'): string {
  return `${serial}|${probe.width}x${probe.height}@${Math.round(probe.fps)}`;
}

export interface DlogLutDecision extends LutDecision {
  dlog_suspected: boolean;
}

// decideLut 只读的配置面（ActpipeConfig 或测试桩都满足）
export interface DecideLutConfig {
  dlog_policy?: ActpipeConfig['dlog_policy'];
  default_lut?: string;
  luts?: Record<string, string>;
  camera_serial?: string;
  dlog_memory?: Record<string, 'lut' | 'no_lut'>;
}

export interface DecideLutDeps {
  config: DecideLutConfig;
  interact: { confirm?: (opts: { title?: string; message?: string }) => Promise<boolean | null> };
  serial?: string | null;
}

export async function decideLut(probe: DlogProbeShape, { config, interact, serial = null }: DecideLutDeps): Promise<DlogLutDecision> {
  const policy = config.dlog_policy ?? 'ask';
  const lutPath = resolveLutPath(config as ActpipeConfig, config.default_lut ?? null);
  const noLut = { apply: false, lut: null, reason: 'policy', dlog_suspected: looksDlog(probe) };

  if (policy === 'never_lut') return noLut;
  if (policy === 'always_lut') {
    return { apply: true, lut: lutPath, reason: 'policy', dlog_suspected: looksDlog(probe) };
  }

  // ask：先查记忆（相机序列号 + 分辨率/帧率档位）
  const key = memoryKey(probe, serial ?? config.camera_serial ?? 'unknown');
  const remembered = config.dlog_memory?.[key];
  if (remembered === 'lut') return { apply: true, lut: lutPath, reason: `memory:${key}`, dlog_suspected: true };
  if (remembered === 'no_lut') return { apply: false, lut: null, reason: `memory:${key}`, dlog_suspected: looksDlog(probe) };

  if (!looksDlog(probe)) {
    return { apply: false, lut: null, reason: 'heuristic:not_dlog', dlog_suspected: false };
  }

  const message = [
    `文件：${path.basename(probe.file)}`,
    `${probe.width}x${probe.height}@${Math.round(probe.fps)} ${probe.codec} ${probe.bit_depth}-bit`,
    `color: ${probe.color!.space}/${probe.color!.primaries}/${probe.color!.trc}`,
    '',
    '10-bit HEVC 素材，可能是 D-Log M（也可能不是），是否套用 Rec.709 LUT？',
  ].join('\n');
  const yes = await interact.confirm!({ title: 'D-Log M 素材确认', message });
  if (yes === null) {
    // 弹窗无人应答：10-bit 疑似 D-Log 按套 LUT 继续（D-Log 是常态素材），
    // 不写记忆、不带 remember_key——这不是用户的选择
    return { apply: true, lut: lutPath, reason: 'auto:no_answer', dlog_suspected: true };
  }
  return {
    apply: yes,
    lut: yes ? lutPath : null,
    reason: 'user',
    remember_key: key,
    dlog_suspected: true,
  };
}

export async function probeToFile(file: string, outFile: string | null, opts: Partial<DecideLutDeps> = {}): Promise<Omit<ProbeInfo, 'lut_decision'> & { lut_decision: DlogLutDecision | null }> {
  const probe = await probeFile(file);
  const decision = opts.config ? await decideLut(probe, opts as DecideLutDeps) : null;
  const out = { ...probe, lut_decision: decision };
  if (outFile) writeJsonAtomic(outFile, out);
  return out;
}
