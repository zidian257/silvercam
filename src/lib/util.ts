import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RunOptions {
  input?: string;
  timeout?: number;
  cwd?: string;
}

export interface RunResult {
  code: number | string; // execFile 失败时 err.code 可能是 'ENOENT' 这类字符串
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[] = [], { input, timeout = 120000, cwd }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code !== undefined && err.killed) {
        reject(new Error(`${cmd} timed out after ${timeout}ms`));
        return;
      }
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
    if (input !== undefined) {
      child.stdin!.write(input);
      child.stdin!.end();
    }
  });
}

export async function runOk(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r;
}

// idleMs：空闲看门狗——stdout/stderr 都静默超过该时长即 SIGKILL 并 reject，
// 防 ffmpeg 卡死把整列拖停（ffmpeg -progress 正常时每秒都有输出）。
// signal：外部取消（如 pipeline 有任务失败），abort 即 SIGKILL 并 reject。
export interface SpawnStreamOptions {
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  cwd?: string;
  idleMs?: number;
  signal?: AbortSignal | null;
}

export function spawnStream(cmd: string, args: string[], { onLine, onStderr, cwd, idleMs = 0, signal = null }: SpawnStreamOptions = {}): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${cmd} 被取消（pipeline abort）`));
      return;
    }
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let idleTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} 被取消（pipeline abort）`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const armIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} 静默超过 ${Math.round(idleMs / 1000)}s，判定卡死已终止`));
      }, idleMs);
    };
    armIdle();
    child.stdout.on('data', (chunk) => {
      armIdle();
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine?.(line);
      }
    });
    if (onStderr) child.stderr.on('data', (c) => { armIdle(); onStderr(c.toString()); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) onLine?.(buf);
      code === 0 ? resolve({ code }) : reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// `sysctl vm.swapusage` 输出解析："vm.swapusage: total = 6144.00M  used = 1770.25M  free = 4373.75M"
// 返回已用 MB；解析失败返回 null（调用方按无限制处理）
export function parseSwapUsage(text: string | null | undefined): number | null {
  const m = /used\s*=\s*([\d.]+)M/i.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

export async function swapUsedMb(): Promise<number | null> {
  try {
    const r = await run('sysctl', ['vm.swapusage']);
    return parseSwapUsage(r.stdout);
  } catch {
    return null;
  }
}

// swap 水位门（速率制）：超预算且仍在增长（>growthThresholdMb/采样间隔）才等待；
// 存量占用连续 stableRounds 次采样稳定即放行（macOS 不回卷，外国应用遗留 swap 可稳挂数小时）。
// 调用方：queue 重阶段启动前、pregen 渲染前。budgetMb=0 关闭。
export interface SwapBudgetOptions {
  budgetMb: number;
  log?: (msg: string) => void;
  signal?: AbortSignal | null;
  intervalMs?: number;
  growthThresholdMb?: number;
  stableRounds?: number;
}

export async function waitSwapBudget({
  budgetMb,
  log = () => {},
  signal = null,
  intervalMs = 5000,
  growthThresholdMb = 30,
  stableRounds = 3,
}: SwapBudgetOptions): Promise<void> {
  if (!budgetMb) return;
  let prev: number | null = null;
  let stable = 0;
  let waited = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    const used = await swapUsedMb();
    if (used == null || used <= budgetMb) return;
    if (prev != null) {
      const growth = used - prev;
      if (growth > growthThresholdMb) {
        stable = 0;
        if (waited % 60000 < intervalMs) log(`内存水位：swap ${Math.round(used)}MB 超预算且增长中（+${Math.round(growth)}MB/5s），暂缓重负载`);
      } else if (++stable >= stableRounds) {
        log(`内存水位：swap ${Math.round(used)}MB 超预算 ${budgetMb}MB 但连续稳定，判定存量占用（非风暴），放行`);
        return;
      }
    } else if (waited % 60000 < intervalMs) {
      log(`内存水位：swap 已用 ${Math.round(used)}MB > 预算 ${budgetMb}MB，采样观测增长趋势…`);
    }
    prev = used;
    waited += intervalMs;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function parseFps(value: unknown): number {
  if (value == null) return 0;
  const s = String(value);
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b ? a / b : 0;
  }
  return Number(s) || 0;
}

export function parseTimecode(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return input;
  const s = String(input).trim();
  if (/^-?[\d.]+$/.test(s)) return Number(s);
  const neg = s.startsWith('-');
  const parts = s.replace(/^-/, '').split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`bad timecode: ${input}`);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return neg ? -sec : sec;
}

export function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}'${String(r).padStart(2, '0')}"` : `${m}'${String(r).padStart(2, '0')}"`;
}

export function fmtDateTime(dt: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

// DJI 文件名解析：DJI_20250809165324_0019_D.MP4 → 拍摄时间 + 序号 19（source: 'filename'）；
// 无序号变体 DJI_20250906123000.MP4 也按时间戳解析（seq 为 null）；
// 老式无时间戳的 DJI_0001.MP4 兜底用文件 mtime（source: 'mtime'）；完全不匹配返回 null。
function parseTs14(digits: string): Date | null {
  const [y, mo, d, h, mi, s] = [
    digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8),
    digits.slice(8, 10), digits.slice(10, 12), digits.slice(12, 14),
  ].map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  const valid =
    mo >= 1 && mo <= 12 && h <= 23 && mi <= 59 && s <= 60 &&
    dt.getMonth() === mo - 1 && dt.getDate() === d; // 排除 2月31日 这类进位假日期
  return valid ? dt : null;
}

export interface ClipNameInfo {
  recorded_at: string | null;
  seq: number | null;
  source: 'filename' | 'mtime';
  start_ms: number | null;
}

export function parseClipName(file: string, mtimeMs: number | null = null): ClipNameInfo | null {
  const base = path.basename(file);
  const ts = base.match(/^DJI_(\d{14})_(\d+)_[A-Z]\.[A-Za-z0-9]+$/);
  if (ts) {
    const dt = parseTs14(ts[1]);
    if (!dt) return null;
    return { recorded_at: fmtDateTime(dt), seq: Number(ts[2]), source: 'filename', start_ms: dt.getTime() };
  }
  const plain = base.match(/^DJI_(\d+)\.[A-Za-z0-9]+$/);
  if (plain) {
    if (plain[1].length === 14) {
      const dt = parseTs14(plain[1]);
      if (dt) return { recorded_at: fmtDateTime(dt), seq: null, source: 'filename', start_ms: dt.getTime() };
    }
    return {
      recorded_at: mtimeMs != null ? fmtDateTime(new Date(mtimeMs)) : null,
      seq: Number(plain[1]),
      source: 'mtime',
      start_ms: mtimeMs,
    };
  }
  return null;
}

// 本地日期 YYYY-MM-DD（输出目录分桶用；toISOString 是 UTC，UTC+8 晚间处理会错一天）
export function localDay(ms: number = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function hashFile(file: string, algo = 'sha1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export function hashString(s: string, algo = 'sha1'): string {
  return crypto.createHash(algo).update(s).digest('hex');
}

export async function hashFiles(files: string[], algo = 'sha1'): Promise<string> {
  const h = crypto.createHash(algo);
  for (const f of files) {
    h.update(path.basename(f));
    h.update(await hashFile(f, algo));
  }
  return h.digest('hex');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonAtomic(file: string, obj: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T;
export function readJson(file: string): any; // 无 fallback：解析失败返回 null，内容形状由调用方判断
export function readJson(file: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function round(n: number | null | undefined, decimals = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function padFrame(n: number): string {
  return String(n).padStart(5, '0');
}

export function uniquePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let i = 2; ; i++) {
    const candidate = path.join(dir, `${base}_${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export async function which(cmd: string): Promise<string | null> {
  const r = await run('which', [cmd]);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  // launchd/pm2 自启动的进程 PATH 很薄，兜底查常见安装位置
  for (const p of [`/opt/homebrew/bin/${cmd}`, `/usr/local/bin/${cmd}`]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function escapeAppleScript(s: unknown): string {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
