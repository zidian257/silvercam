import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, hashFile, writeJsonAtomic } from '../lib/util.ts';

export interface IngestProgress {
  copied: number;
  total: number;
  percent: number;
}

export interface IngestFileOpts {
  stagingDir?: string;
  checksum?: boolean;
  onProgress?: ((p: IngestProgress) => void) | null;
}

export interface IngestResult {
  src: string;
  staged: string;
  size: number;
  mtime_ms: number;
  checksum_ok: boolean | null;
  reused: boolean;
  size_ok?: boolean;
  mtime_ok?: boolean;
}

export async function ingestFile(src: string, { stagingDir, checksum = false, onProgress = null }: IngestFileOpts = {}): Promise<IngestResult> {
  const srcStat = fs.statSync(src);
  const destDir = ensureDir(stagingDir as string);
  const dest = path.join(destDir, path.basename(src));

  if (fs.existsSync(dest)) {
    const d = fs.statSync(dest);
    if (d.size === srcStat.size) {
      const result: IngestResult = {
        src: path.resolve(src),
        staged: dest,
        size: d.size,
        mtime_ms: Math.round(d.mtimeMs),
        checksum_ok: null,
        reused: true,
      };
      if (checksum) result.checksum_ok = (await hashFile(src)) === (await hashFile(dest));
      return result;
    }
    fs.rmSync(dest);
  }

  const tmp = `${dest}.part`;
  await copyWithProgress(src, tmp, srcStat.size, onProgress);
  fs.renameSync(tmp, dest);
  fs.utimesSync(dest, srcStat.atime, srcStat.mtime);

  const d = fs.statSync(dest);
  if (d.size !== srcStat.size) {
    throw new Error(`ingest size mismatch: ${src} ${srcStat.size} -> ${dest} ${d.size}`);
  }
  const result: IngestResult = {
    src: path.resolve(src),
    staged: dest,
    size: d.size,
    mtime_ms: Math.round(d.mtimeMs),
    size_ok: true,
    mtime_ok: Math.round(d.mtimeMs) === Math.round(srcStat.mtimeMs),
    checksum_ok: null,
    reused: false,
  };
  if (checksum) result.checksum_ok = (await hashFile(src)) === (await hashFile(dest));
  return result;
}

async function copyWithProgress(src: string, dest: string, total: number, onProgress: ((p: IngestProgress) => void) | null): Promise<void> {
  const { pipeline } = await import('node:stream/promises');
  const read = fs.createReadStream(src);
  const write = fs.createWriteStream(dest);
  let done = 0;
  read.on('data', (chunk: Buffer) => {
    done += chunk.length;
    onProgress?.({ copied: done, total, percent: Math.min(100, (done / total) * 100) });
  });
  await pipeline(read, write);
}

export async function ingestToJob(src: string, jobDir: string | null, opts: IngestFileOpts & { stagingRoot?: string } = {}): Promise<IngestResult> {
  const stagingDir = path.join(opts.stagingRoot as string, jobDir ? path.basename(jobDir) : 'misc');
  const result = await ingestFile(src, { ...opts, stagingDir });
  if (jobDir) writeJsonAtomic(path.join(jobDir, 'ingest.json'), result);
  return result;
}
