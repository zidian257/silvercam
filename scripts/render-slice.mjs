// 演示切片渲染：复用管线模块（fitToFiles → renderWindowToCache → composeVideo），
// 不经过队列，用于快速出某支视频在某套皮肤下的成品切片。
// 用法: node scripts/render-slice.mjs <video> <fit> <offset_seconds> <skin[,skin...]> [lut[,lut...]] [out_dir]
//   lut 支持名字/链式名（如 dlogm_mei），'none' = 不套；缺省 = none
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSkinDir } from '../src/lib/paths.js';
import { loadConfig, resolveLutPath } from '../src/lib/config.js';
import { readJson, hashFile, ensureDir, uniquePath, localDay, parseClipName } from '../src/lib/util.js';
import { probeFile } from '../src/modules/probe.js';
import { fitToFiles } from '../src/modules/fit.js';
import { renderWindowToCache, skinHash, lookupCache, cacheKey } from '../src/modules/render.js';
import { composeVideo } from '../src/modules/compose.js';

const [video, fitFile, offsetS, skinsArg, lutsArg, outDirArg] = process.argv.slice(2);
if (!video || !fitFile || offsetS == null || !skinsArg) {
  console.error('usage: node scripts/render-slice.mjs <video> <fit> <offset_seconds> <skin[,skin...]> [lut[,lut...]] [out_dir]');
  process.exit(2);
}
const offset = Number(offsetS);
const config = loadConfig();
const probe = await probeFile(video);
console.log(`probe: ${probe.width}x${probe.height}@${probe.fps} ${probe.codec}, duration=${probe.duration}s`);

const lutSpecs = (lutsArg ?? 'none').split(',').map((name) => {
  if (name === 'none' || name === '') return { name: 'nolut', path: null };
  const p = resolveLutPath(config, name);
  if (!p) { console.error(`LUT 无法解析: ${name}`); process.exit(2); }
  return { name: name.replaceAll('+', '-'), path: p };
});

for (const skin of skinsArg.split(',')) {
  const skinDir = resolveSkinDir(skin);
  if (!skinDir || !fs.existsSync(skinDir)) { console.error(`皮肤不存在: ${skin}`); continue; }
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), `slice-${skin}-`));
  const { session } = await fitToFiles(fitFile, {
    probe,
    videoFile: video,
    biasSeconds: config.global_bias_seconds,
    smoothWindowS: config.smooth_window_s,
    outDir: jobDir,
    offsetOverride: offset,
  });
  if (session.offset_seconds !== offset) console.warn(`warn: session offset=${session.offset_seconds} != ${offset}`);
  const samples = readJson(path.join(jobDir, 'samples.json'));
  const fps = config.overlay_fps;
  const fitHashValue = await hashFile(fitFile);
  const skinHashValue = await skinHash(skinDir);
  const key = cacheKey({ fitHashValue, skinHashValue, width: probe.width, height: probe.height, fps });
  const effOffset = session.offset_seconds ?? offset;
  const delayS = Math.max(0, -effOffset); // 视频先于 FIT 开始：overlay 延后入场
  const renderFromS = Math.max(0, effOffset);
  const firstFrame = Math.round(renderFromS * fps);
  const lastFrame = Math.round(Math.min(samples.count - 1, effOffset + probe.duration + 1) * fps);

  let framesDir;
  const cached = lookupCache(key, firstFrame, lastFrame);
  if (cached) {
    console.log(`[${skin}] render cache HIT ${key}`);
    framesDir = cached.framesDir;
  } else {
    const fromFitS = renderFromS;
    const toFitS = Math.min(samples.count - 1, effOffset + probe.duration + 1);
    console.log(`[${skin}] render MISS: ${fromFitS.toFixed(1)}s..${toFitS.toFixed(1)}s @${fps}fps`);
    const r = await renderWindowToCache({
      skinDir, fitFile, samples, width: probe.width, height: probe.height, fps,
      fromFitS, toFitS, tabs: config.render_tabs, log: (m) => console.log(`[${skin}] ${m}`),
    });
    framesDir = r.framesDir;
  }

  const day = localDay(parseClipName(video)?.start_ms ?? Date.now());
  const base = path.basename(video).replace(/\.[^.]+$/, '');
  for (const lut of lutSpecs) {
    const outDir = ensureDir(path.join(outDirArg ?? config.output_dir, day));
    const out = uniquePath(path.join(outDir, `${base}_${skin}_${lut.name}_dash.mp4`));
    await composeVideo(
      {
        video,
        framesPattern: path.join(framesDir, '%05d.png'),
        startNumber: firstFrame,
        overlayFps: fps,
        videoFps: probe.fps,
        lut: lut.path,
        out,
        encoder: config.encoder,
        bitrate: config.bitrate,
        tenBit: config.ten_bit_output,
        durationS: probe.duration,
        overlayDelayS: delayS,
      },
      { durationS: probe.duration, log: () => {} },
    );
    console.log(`[${skin}/${lut.name}] done -> ${out}`);
  }
  fs.rmSync(jobDir, { recursive: true, force: true });
}
