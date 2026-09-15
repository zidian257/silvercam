import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../lib/paths.ts';
import { readJson, writeJsonAtomic } from '../lib/util.ts';
import { parseFit } from './fit.ts';
import type { ActpipeConfig } from '../types.ts';

// FIT 库目录扫描：起止时间解析结果按 path+mtime+size 缓存到磁盘（cache/fitlib.json），
// 目录内容签名不变时直接命中内存——不会每次 list 都解析 FIT。

export interface FitLibEntry {
  name: string;
  path: string;
  start_ms: number;
  end_ms: number;
  duration_s: number;
  sport: string | null;
}

interface FitlibCacheEntry {
  start_ms: number;
  end_ms: number;
  sport: string | null;
}

let memCache: { dir: string; sig: string; fits: FitLibEntry[] } | null = null;

const diskCacheFile = () => path.join(paths.cache, 'fitlib.json');

export function listFits(cfg: ActpipeConfig): FitLibEntry[] {
  const dir = cfg.fit_library_dir;
  if (!dir || !fs.existsSync(dir)) return [];
  const stats = new Map<string, { mtime: number; size: number }>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.fit')) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      stats.set(p, { mtime: st.mtimeMs, size: st.size });
    } catch { /* 读到一半消失的跳过 */ }
  }
  const sig = [...stats.entries()].map(([p, s]) => `${p}:${s.mtime}:${s.size}`).sort().join('|');
  if (memCache?.dir === dir && memCache.sig === sig) return memCache.fits;

  const disk: Record<string, FitlibCacheEntry> = readJson(diskCacheFile(), {});
  const fits: FitLibEntry[] = [];
  let dirty = false;
  for (const [p, s] of stats) {
    const key = `${p}:${s.mtime}:${s.size}`;
    let e = disk[key];
    if (!e) {
      try {
        const { records, session } = parseFit(p);
        e = { start_ms: records[0].t, end_ms: records[records.length - 1].t, sport: session?.sport ?? null };
        disk[key] = e;
        dirty = true;
      } catch {
        continue; // 解析失败的 FIT 不进库
      }
    }
    fits.push({
      name: path.basename(p),
      path: p,
      start_ms: e.start_ms,
      end_ms: e.end_ms,
      duration_s: Math.round((e.end_ms - e.start_ms) / 1000),
      sport: e.sport,
    });
  }
  if (dirty) writeJsonAtomic(diskCacheFile(), disk);
  fits.sort((a, b) => b.start_ms - a.start_ms);
  memCache = { dir, sig, fits };
  return fits;
}

// 智能预选：视频窗口 [startMs, startMs+durationS] 与 FIT 窗口重叠最大的那个；无重叠返回 null
export function suggestFit(fits: Pick<FitLibEntry, 'path' | 'start_ms' | 'end_ms'>[], { startMs, durationS }: { startMs: number | null; durationS: number | null }): string | null {
  if (startMs == null || !durationS) return null;
  const v1 = startMs + durationS * 1000;
  let best = null;
  let bestOverlap = 0;
  for (const f of fits) {
    const overlap = Math.min(v1, f.end_ms) - Math.max(startMs, f.start_ms);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = f;
    }
  }
  return best?.path ?? null;
}
