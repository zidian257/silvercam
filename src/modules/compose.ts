import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, localDay, padFrame, parseClipName, spawnStream, uniquePath } from '../lib/util.ts';
import type { ProgressPayload } from '../types.ts';

export interface FfmpegArgsOpts {
  video: string;
  framesPattern: string | null;
  startNumber?: number;
  overlayFps?: number;
  videoFps?: number;
  lut?: string | null;
  out: string;
  encoder?: string;
  bitrate?: string;
  tenBit?: boolean;
  durationS?: number | null;
  scaleOverlayTo?: [number, number] | null;
  overlayDelayS?: number;
}

export function buildFfmpegArgs({
  video,
  framesPattern,
  startNumber,
  overlayFps,
  videoFps,
  lut = null,
  out,
  encoder = 'hevc_videotoolbox',
  bitrate = '45M',
  tenBit = false,
  durationS = null, // 输出截断到源视频时长（PNG 序列按窗口渲染可能略长）
  scaleOverlayTo = null, // [w, h] 当仪表盘画布分辨率与视频不一致时
  overlayDelayS = 0, // 视频开拍早于 FIT 起点（负 offset）时，overlay 延后入场；头部画面无仪表盘
}: FfmpegArgsOpts): string[] {
  // lut 可为 '+' 连接的链（依次套用）；单 LUT 时与原逻辑一致
  const lutStage = lut
    ? String(lut).split('+').map((p) => `lut3d='${p.replace(/'/g, "'\\''")}'`).join(',')
    : 'null';

  // framesPattern 为空：该段与 FIT 数据窗口无交集（如码表提前停表），只套 LUT 不叠仪表盘
  let filter;
  // -hwaccel videotoolbox：软解 4K50 10bit HEVC 是全链最大瓶颈（实测 0.25x→0.49x）
  const args = ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'videotoolbox', '-i', video];
  if (framesPattern) {
    const scaleStage = scaleOverlayTo ? `,scale=${scaleOverlayTo[0]}:${scaleOverlayTo[1]}` : '';
    const delayStage = overlayDelayS > 0 ? `,setpts=PTS+${overlayDelayS}/TB` : '';
    filter =
      `[0:v]${lutStage}[base];` +
      `[1:v]fps=${videoFps},format=rgba${scaleStage}${delayStage}[ov];` +
      `[base][ov]overlay=0:0:format=auto[out]`;
    args.push('-framerate', String(overlayFps), '-start_number', String(startNumber), '-i', framesPattern);
  } else {
    filter = `[0:v]${lutStage}[out]`;
  }
  args.push(
    '-filter_complex', filter,
    '-map', '[out]', '-map', '0:a?',
    '-c:v', encoder,
    '-b:v', bitrate,
  );
  if (encoder.includes('hevc')) {
    args.push('-tag:v', 'hvc1');
    // VideoToolbox 不会把 -color_* 写进 HEVC VUI，需 bitstream filter 强制改写
    args.push('-bsf:v', 'hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1');
  }
  if (tenBit) args.push('-pix_fmt', 'p010le', '-profile:v', 'main10');
  // LUT 输出即 Rec.709 SDR，色彩标签必须显式打，否则播放器按错误值解释
  args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  args.push('-c:a', 'copy', '-progress', 'pipe:1', '-nostats', '-n');
  if (durationS) args.push('-t', String(durationS));
  args.push(out);
  return args;
}

// 输出按拍摄日期（本地时区）分桶：DJI 文件名内嵌开拍时刻；非 DJI 命名回退处理当天
function outputDay(videoFile: string, date: Date | null = null): string {
  const startMs = date ? null : parseClipName(videoFile)?.start_ms;
  return localDay(startMs ?? date?.getTime() ?? Date.now());
}

export function outputPathFor({ outputDir, videoFile, skin, date = null }: {
  outputDir: string;
  videoFile: string;
  skin: string;
  date?: Date | null;
}): string {
  const dir = ensureDir(path.join(outputDir, outputDay(videoFile, date)));
  const base = path.basename(videoFile).replace(/\.[^.]+$/, '');
  return uniquePath(path.join(dir, `${base}_${skin}_dash.mp4`));
}

// 无 FIT 纯拷贝的输出路径：<output_dir>/<拍摄日期>/raw/原名.原扩展名（不转码）
export function rawOutputPathFor({ outputDir, videoFile, rawSubdir = 'raw', date = null }: {
  outputDir: string;
  videoFile: string;
  rawSubdir?: string;
  date?: Date | null;
}): string {
  const dir = ensureDir(path.join(outputDir, outputDay(videoFile, date), rawSubdir));
  return uniquePath(path.join(dir, path.basename(videoFile)));
}

// 多段合并成品的输出路径：以首段命名，<base>_<skin>_merged_dash.mp4
export function mergedOutputPathFor({ outputDir, videoFile, skin, date = null }: {
  outputDir: string;
  videoFile: string;
  skin: string;
  date?: Date | null;
}): string {
  const dir = ensureDir(path.join(outputDir, outputDay(videoFile, date)));
  const base = path.basename(videoFile).replace(/\.[^.]+$/, '');
  return uniquePath(path.join(dir, `${base}_${skin}_merged_dash.mp4`));
}

// 拼接多条同参数编码的中间成片：优先流拷贝（快且无质量损失），失败回退重编码
export async function concatVideos({ inputs, out, encoder = 'hevc_videotoolbox', bitrate = '45M', log = () => {} }: {
  inputs: string[];
  out: string;
  encoder?: string;
  bitrate?: string;
  log?: (msg: string) => void;
}): Promise<{ out: string; mode: 'copy' | 'reencode' }> {
  const listFile = path.join(os.tmpdir(), `actpipe-concat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  fs.writeFileSync(listFile, inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', '-n', out];
      log(`ffmpeg ${args.join(' ')}`);
      await spawnStream('ffmpeg', args, {});
      return { out, mode: 'copy' };
    } catch (e) {
      log(`concat 流拷贝失败（${(e as Error).message}），回退重编码`);
      fs.rmSync(out, { force: true });
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', encoder, '-b:v', bitrate, '-tag:v', 'hvc1'];
    if (encoder.includes('hevc')) {
      args.push('-bsf:v', 'hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1');
    }
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'copy', '-movflags', '+faststart', '-n', out);
    log(`ffmpeg ${args.join(' ')}`);
    await spawnStream('ffmpeg', args, {});
    return { out, mode: 'reencode' };
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

export async function composeVideo(opts: FfmpegArgsOpts, { durationS = null, onProgress = null, log = () => {}, idleMs = 180000, signal = null }: {
  durationS?: number | null;
  onProgress?: ((p: ProgressPayload) => void) | null;
  log?: (msg: string) => void;
  idleMs?: number;
  signal?: AbortSignal | null;
} = {}): Promise<{ out: string; args: string[] }> {
  const args = buildFfmpegArgs(opts);
  log(`ffmpeg ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  let stderrTail = '';
  try {
    await spawnStream('ffmpeg', args, {
    idleMs,
    signal,
    onLine: (line: string) => {
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === 'out_time_ms' && durationS) {
        const outS = Number(v) / 1e6;
        onProgress?.({
          stage: 'encode',
          out_s: outS,
          percent: Math.min(100, (outS / durationS) * 100),
        });
      } else if (k === 'fps') {
        onProgress?.({ stage: 'encode', fps: Number(v) });
      } else if (k === 'speed') {
        onProgress?.({ stage: 'encode', speed: v });
      } else if (k === 'progress' && v === 'end') {
        onProgress?.({ stage: 'encode', percent: 100 });
      }
    },
    onStderr: (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    },
  });
  } catch (e) {
    throw new Error(`${(e as Error).message}\nffmpeg stderr:\n${stderrTail.trim()}`);
  }
  return { out: opts.out, args };
}

export function framesExist(framesDir: string, firstFrame: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    if (!fs.existsSync(path.join(framesDir, `${padFrame(firstFrame + i)}.png`))) return false;
  }
  return true;
}
