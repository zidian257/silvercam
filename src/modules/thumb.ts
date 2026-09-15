import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDirs } from '../lib/paths.ts';
import { runOk } from '../lib/util.ts';

// inbox 素材的胶片条预览：按时长 10/35/60/85% 抽 4 帧，各缩到 360px 宽横向拼一条 jpg，
// 缓存到 ~/.config/actpipe/thumbs/<id>.jpg。
// USB 卡随机读极慢：所有生成走全局串行队列（一次一个 ffmpeg），同 id 复用同一 Promise 去重；
// 每个取点单独一次 ffmpeg（-ss 前置快速 seek），避免单进程 4 路并发解码拖垮卡。
// 生成失败由调用方记日志，不影响 inbox 流程。

export function thumbPath(id: string): string {
  return path.join(paths.thumbs, `${id}.jpg`);
}

let queue: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<string>>();

export function generateFilmstrip(video: string, durationS: number, id: string): Promise<string> {
  const running = inflight.get(id);
  if (running) return running;
  const p = queue.then(() => extract(video, durationS, id));
  inflight.set(id, p);
  const done = p.finally(() => inflight.delete(id));
  queue = done.catch(() => {});
  return done;
}

async function extract(video: string, durationS: number, id: string): Promise<string> {
  ensureDirs();
  const out = thumbPath(id);
  if (fs.existsSync(out)) return out; // 排队期间已被别的调用生成
  const tmpDir = path.join(paths.thumbs, `.${id}.${process.pid}.tmp`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const dur = Number(durationS) || 0;
    const last = Math.max(0, dur - 0.5); // 防止末点越过 EOF 抽不到帧
    const pts = [0.1, 0.35, 0.6, 0.85].map((p) => Math.min(dur * p, last));
    const frames: string[] = [];
    for (let i = 0; i < pts.length; i++) {
      const f = path.join(tmpDir, `${i}.jpg`);
      await runOk('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', pts[i].toFixed(3), '-i', video,
        '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', '-y', f,
      ], { timeout: 60000 });
      frames.push(f);
    }
    const tmpOut = path.join(tmpDir, 'strip.jpg');
    const args = ['-hide_banner', '-loglevel', 'error'];
    for (const f of frames) args.push('-i', f);
    args.push(
      '-filter_complex',
      `${frames.map((_, i) => `[${i}:v]`).join('')}hstack=inputs=${frames.length},format=yuvj420p[out]`,
      '-map', '[out]', '-frames:v', '1', '-q:v', '4', '-y', tmpOut,
    );
    await runOk('ffmpeg', args, { timeout: 30000 });
    fs.renameSync(tmpOut, out);
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
