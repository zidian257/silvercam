import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { paths } from '../lib/paths.ts';
import { ensureDir, hashFile, hashFiles, padFrame, readJson, round, writeJsonAtomic } from '../lib/util.ts';
import { buildSkin, buildSkinHtml, skinInputs } from './skin-build.ts';
import type { FitSample, ProgressPayload, SamplesGrid } from '../types.ts';

// page.evaluate 的回调在浏览器上下文执行；tsconfig 不含 DOM lib，这里按 any 声明这两个全局
declare const window: any;
declare const document: any;

// cache_index.json 的形状（本模块写入/读取）
export interface RenderCacheIndex {
  complete?: boolean;
  ranges?: [number, number][];
  created_at?: string;
  [k: string]: unknown; // 其余字段透传
}

export function sampleAt(samples: SamplesGrid, fitSeconds: number): FitSample {
  const f = Math.min(Math.max(fitSeconds, 0), samples.count - 1);
  const lo = Math.floor(f);
  const hi = Math.min(lo + 1, samples.count - 1);
  const frac = f - lo;
  const a = samples.samples[lo];
  const b = samples.samples[hi];
  const out: FitSample = { t: a.t, i: round(f, 3) as number };
  for (const field of samples.fields) {
    if (field === 'position') {
      if (a.position && b.position) {
        out.position = {
          lat: a.position.lat + (b.position.lat - a.position.lat) * frac,
          lon: a.position.lon + (b.position.lon - a.position.lon) * frac,
        };
      } else {
        out.position = a.position ?? b.position ?? null;
      }
      continue;
    }
    const va = a[field] as number | null;
    const vb = b[field] as number | null;
    if (va != null && vb != null) out[field] = va + (vb - va) * frac;
    else out[field] = va ?? vb ?? null;
  }
  return out;
}

// 皮肤内容哈希：皮肤目录全部文件 + 共享件 _lib（改动共享件必须使渲染缓存失效）
export async function skinHash(skinDir: string): Promise<string> {
  return hashFiles(skinInputs(skinDir));
}

export function cacheKey({ fitHashValue, skinHashValue, width, height, fps }: {
  fitHashValue: string;
  skinHashValue: string;
  width: number;
  height: number;
  fps: number;
}): string {
  return `${fitHashValue.slice(0, 12)}-${skinHashValue.slice(0, 12)}-${width}x${height}@${fps}`;
}

export function cacheDirFor(key: string): string {
  return path.join(paths.renderCache, key);
}

export function lookupCache(key: string, needFirstFrame: number | null = null, needLastFrame: number | null = null): { dir: string; framesDir: string; index: RenderCacheIndex } | null {
  const dir = cacheDirFor(key);
  const index: RenderCacheIndex | null = readJson(path.join(dir, 'cache_index.json'));
  if (!index) return null;
  if (needFirstFrame == null) {
    return index.complete ? { dir, framesDir: path.join(dir, 'frames'), index } : null;
  }
  const covered = (index.ranges ?? []).some(([a, b]) => a <= needFirstFrame && b >= needLastFrame!);
  return covered ? { dir, framesDir: path.join(dir, 'frames'), index } : null;
}

// 渲染用页面目录 = 皮肤编译产物（entry.js/entry.css/字体）+ 内联数据的 index.html。
// 皮肤按 Skin.svelte 导出的 CANVAS 分辨率排版，页面加载后经 ACTPIPE.binding.canvas 回报
export async function preparePageDir({ skinDir, samples, destDir }: {
  skinDir: string;
  samples: SamplesGrid;
  destDir: string;
}): Promise<{ pageUrl: string }> {
  ensureDir(destDir);
  const { dir: buildDir } = await buildSkin({ skinDir, name: path.basename(skinDir) });
  for (const f of fs.readdirSync(buildDir)) {
    fs.copyFileSync(path.join(buildDir, f), path.join(destDir, f));
  }
  fs.writeFileSync(path.join(destDir, 'index.html'), buildSkinHtml({ data: samples }));
  return { pageUrl: `file://${path.join(destDir, 'index.html')}` };
}

// 页面就绪 + 读取设计分辨率算 zoom（等字体加载完，保证首帧不错字）
async function setupPage(page: Page, pageUrl: string, width: number): Promise<void> {
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof window.renderFrame === 'function' && document.fonts.status === 'loaded');
  const canvasW = await page.evaluate(() => window.ACTPIPE?.binding?.canvas?.width ?? 0);
  const zoom = canvasW ? width / canvasW : 1;
  if (zoom !== 1) await page.evaluate((z) => { document.body.style.zoom = String(z); }, zoom);
}

export async function renderFrames({
  skinDir,
  samples,
  outDir,
  width = 3840,
  height = 2160,
  overlayFps = 10,
  fromFitS,        // 起点（FIT 绝对时间轴秒，自 t0 起）
  toFitS,          // 终点
  tabs = 4,
  onProgress = null,
  log = () => {},
  signal = null,   // pipeline abort：帧循环检出即抛错，finally 关浏览器
}: {
  skinDir: string;
  samples: SamplesGrid;
  outDir: string;
  width?: number;
  height?: number;
  overlayFps?: number;
  fromFitS: number;
  toFitS: number;
  tabs?: number;
  onProgress?: ((p: ProgressPayload) => void) | null;
  log?: (msg: string) => void;
  signal?: AbortSignal | null;
}): Promise<{ framesDir: string; pattern: string; firstFrame: number; lastFrame: number; count: number; width: number; height: number; fps: number }> {
  const framesDir = ensureDir(path.join(outDir, 'frames'));
  const firstFrame = Math.round(fromFitS * overlayFps);
  const lastFrame = Math.round(toFitS * overlayFps);
  const total = lastFrame - firstFrame + 1;

  const pageDir = path.join(outDir, '.page');
  const { pageUrl } = await preparePageDir({ skinDir, samples, destDir: pageDir });

  const todo: number[] = [];
  for (let n = firstFrame; n <= lastFrame; n++) {
    const p = path.join(framesDir, `${padFrame(n)}.png`);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) todo.push(n);
  }
  if (todo.length < total) log(`resume: ${total - todo.length}/${total} frames already rendered`);

  const browser = await chromium.launch({ headless: true });
  let done = 0;
  try {
    const workers = Math.max(1, Math.min(tabs, todo.length || 1));
    const chunks = Array.from({ length: workers }, (): number[] => []);
    todo.forEach((n, i) => chunks[i % workers].push(n));
    await Promise.all(
      chunks.map(async (chunk) => {
        if (!chunk.length) return;
        const page = await browser.newPage({ viewport: { width, height } });
        await setupPage(page, pageUrl, width);
        for (const n of chunk) {
          if (signal?.aborted) throw new Error('渲染被取消（pipeline abort）');
          const fitS = n / overlayFps;
          const sample = sampleAt(samples, fitS);
          await page.evaluate(([t, s]) => window.renderFrame(t, s), [fitS, sample]);
          await page.screenshot({ path: path.join(framesDir, `${padFrame(n)}.png`), omitBackground: true });
          done++;
          onProgress?.({ frame: n, done, total: todo.length, percent: round((done / todo.length) * 100, 1) as number });
        }
        await page.close();
      })
    );
  } finally {
    await browser.close();
  }

  return { framesDir, pattern: path.join(framesDir, '%05d.png'), firstFrame, lastFrame, count: total, width, height, fps: overlayFps };
}

export async function renderPreviewFrame({ skinDir, samples, width, height, atFitS, backgroundImage = null }: {
  skinDir: string;
  samples: SamplesGrid;
  width: number;
  height: number;
  atFitS: number;
  backgroundImage?: string | null;
}): Promise<{ png: Buffer; sample: FitSample }> {
  const tmp = fs.mkdtempSync(path.join(paths.cache, 'preview-'));
  const { pageUrl } = await preparePageDir({ skinDir, samples, destDir: tmp });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await setupPage(page, pageUrl, width);
    if (backgroundImage) {
      await page.evaluate((img) => {
        document.body.style.backgroundImage = `url("file://${img}")`;
        document.body.style.backgroundSize = 'cover';
      }, backgroundImage);
    }
    const sample = sampleAt(samples, atFitS);
    await page.evaluate(([t, s]) => window.renderFrame(t, s), [atFitS, sample]);
    const png = await page.screenshot({ omitBackground: !backgroundImage });
    return { png, sample };
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderWindowToCache({
  skinDir,
  fitFile,
  samples,
  width,
  height,
  fps,
  fromFitS,
  toFitS,
  tabs = 4,
  onProgress = null,
  log = () => {},
  signal = null,
}: {
  skinDir: string;
  fitFile: string;
  samples: SamplesGrid;
  width: number;
  height: number;
  fps: number;
  fromFitS: number;
  toFitS: number;
  tabs?: number;
  onProgress?: ((p: ProgressPayload) => void) | null;
  log?: (msg: string) => void;
  signal?: AbortSignal | null;
}) {
  const fitHashValue = await hashFile(fitFile);
  const skinHashValue = await skinHash(skinDir);
  const key = cacheKey({ fitHashValue, skinHashValue, width, height, fps });
  const dir = cacheDirFor(key);
  const result = await renderFrames({
    skinDir, samples, outDir: dir, width, height, overlayFps: fps, fromFitS, toFitS, tabs, onProgress, log, signal,
  });
  const sessionLenS = samples.count - 1;
  const complete = fromFitS <= 0 && toFitS >= sessionLenS;
  const indexPath = path.join(dir, 'cache_index.json');
  const prev: RenderCacheIndex | null = readJson(indexPath);
  const ranges = mergeRanges([...(prev?.ranges ?? []), [result.firstFrame, result.lastFrame] as [number, number]]);
  writeJsonAtomic(indexPath, {
    key,
    fit_hash: fitHashValue,
    skin_hash: skinHashValue,
    width, height, fps,
    first_frame: ranges[0][0],
    last_frame: ranges[ranges.length - 1][1],
    session_first_frame: 0,
    session_last_frame: Math.round(sessionLenS * fps),
    ranges,
    complete,
    created_at: prev?.created_at ?? new Date().toISOString(),
  });
  return { key, dir, ...result };
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export async function cleanCache({ ttlDays = 14, maxGb = 20, log = () => {} }: {
  ttlDays?: number;
  maxGb?: number;
  log?: (msg: string) => void;
} = {}): Promise<void> {
  if (!fs.existsSync(paths.renderCache)) return;
  const now = Date.now();
  const entries = fs.readdirSync(paths.renderCache).map((name) => {
    const dir = path.join(paths.renderCache, name);
    const index = readJson(path.join(dir, 'cache_index.json'));
    return { name, dir, createdAt: index?.created_at ? Date.parse(index.created_at) : 0, size: dirSize(dir) };
  });
  for (const e of entries) {
    if (ttlDays > 0 && now - e.createdAt > ttlDays * 86400_000) {
      log(`[cache] TTL 过期清理 ${e.name}`);
      fs.rmSync(e.dir, { recursive: true, force: true });
    }
  }
  const remaining = entries.filter((e) => fs.existsSync(e.dir)).sort((a, b) => a.createdAt - b.createdAt);
  let total = remaining.reduce((a, e) => a + e.size, 0);
  const cap = maxGb * 1024 ** 3;
  while (total > cap && remaining.length) {
    const oldest = remaining.shift()!;
    log(`[cache] 容量超限清理 ${oldest.name}`);
    fs.rmSync(oldest.dir, { recursive: true, force: true });
    total -= oldest.size;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch {}
  return total;
}
