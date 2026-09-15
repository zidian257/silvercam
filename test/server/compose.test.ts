import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFfmpegArgs, outputPathFor, rawOutputPathFor, mergedOutputPathFor, framesExist } from '../../src/modules/compose.ts';
import { localDay } from '../../src/lib/util.ts';

const VIDEO = 'DJI_20260906100100.MP4'; // 文件名内嵌 2026-09-06 10:01 本地

test('buildFfmpegArgs: LUT 链按顺序生成多个 lut3d 滤镜', () => {
  const args = buildFfmpegArgs({ video: 'in.mp4', framesPattern: null, out: 'o.mp4', lut: '/a.cube+/b.cube' });
  const filter = args[args.indexOf('-filter_complex') + 1];
  const stages = [...filter.matchAll(/lut3d='([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(stages, ['/a.cube', '/b.cube']);
  assert.equal(filter, "[0:v]lut3d='/a.cube',lut3d='/b.cube'[out]");
});

test('buildFfmpegArgs: 无 LUT 时 lutStage 为 null 透传', () => {
  const args = buildFfmpegArgs({ video: 'in.mp4', framesPattern: null, out: 'o.mp4' });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.equal(filter, '[0:v]null[out]');
});

test('buildFfmpegArgs: overlay 支路含 fps/format，可带 scale 与延迟入场', () => {
  const args = buildFfmpegArgs({
    video: 'in.mp4', framesPattern: '/f/%05d.png', startNumber: 600, overlayFps: 10, videoFps: 30,
    out: 'o.mp4', scaleOverlayTo: [3840, 2160], overlayDelayS: 12.5,
  });
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filter.includes('[1:v]fps=30,format=rgba,scale=3840:2160,setpts=PTS+12.5/TB[ov]'));
  assert.ok(filter.includes('[base][ov]overlay=0:0:format=auto[out]'));
  // PNG 序列作为第二个输入，start_number 定位窗口首帧
  assert.equal(args[args.indexOf('-start_number') + 1], '600');
});

test('buildFfmpegArgs: hevc 打 hvc1 标签并强制 bt709 VUI；tenBit 上 main10', () => {
  const args = buildFfmpegArgs({ video: 'i.mp4', framesPattern: null, out: 'o.mp4', encoder: 'hevc_videotoolbox', tenBit: true });
  assert.ok(args.includes('-tag:v') && args.includes('hvc1'));
  assert.ok(args.some((a) => a.includes('hevc_metadata=colour_primaries=1')));
  assert.ok(args.includes('p010le') && args.includes('main10'));
  // LUT 输出即 Rec.709 SDR，色彩标签必须显式
  assert.equal(args[args.indexOf('-color_primaries') + 1], 'bt709');
  assert.equal(args[args.indexOf('-color_trc') + 1], 'bt709');
  assert.equal(args[args.indexOf('-colorspace') + 1], 'bt709');
});

test('buildFfmpegArgs: durationS 截断输出，音频流拷贝', () => {
  const args = buildFfmpegArgs({ video: 'i.mp4', framesPattern: null, out: 'o.mp4', durationS: 95.5 });
  assert.equal(args[args.indexOf('-t') + 1], '95.5');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('buildFfmpegArgs: 主输入启用 videotoolbox 硬解（实测全链 ~2x）', () => {
  const args = buildFfmpegArgs({ video: 'i.mp4', framesPattern: null, out: 'o.mp4' });
  assert.equal(args[args.indexOf('-hwaccel') + 1], 'videotoolbox');
  assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i')); // 必须在输入前生效
});

test('输出路径：按文件名内嵌拍摄日期（本地）分桶', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-compose-'));
  const out = outputPathFor({ outputDir: dir, videoFile: VIDEO, skin: 'topline' });
  assert.equal(out, path.join(dir, '2026-09-06', 'DJI_20260906100100_topline_dash.mp4'));
  const raw = rawOutputPathFor({ outputDir: dir, videoFile: VIDEO });
  assert.equal(raw, path.join(dir, '2026-09-06', 'raw', VIDEO));
  const merged = mergedOutputPathFor({ outputDir: dir, videoFile: VIDEO, skin: 'rail' });
  assert.equal(merged, path.join(dir, '2026-09-06', 'DJI_20260906100100_rail_merged_dash.mp4'));
});

test('输出路径：非 DJI 命名回退处理当天；重名自动加序号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-compose-'));
  const out = outputPathFor({ outputDir: dir, videoFile: 'holiday.mov', skin: 's' });
  assert.equal(out, path.join(dir, localDay(), 'holiday_s_dash.mp4'));
  fs.writeFileSync(out, 'x');
  const out2 = outputPathFor({ outputDir: dir, videoFile: 'holiday.mov', skin: 's' });
  assert.equal(out2, path.join(dir, localDay(), 'holiday_s_dash_2.mp4'));
});

test('framesExist: 帧序列齐全才算存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-frames-'));
  for (const n of ['00600', '00601', '00602']) fs.writeFileSync(path.join(dir, `${n}.png`), '');
  assert.equal(framesExist(dir, 600, 3), true);
  assert.equal(framesExist(dir, 600, 4), false);
});
