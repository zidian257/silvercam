import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from '../lib/util.ts';
import type { ActpipeConfig } from '../types.ts';
import type { FSWatcher } from 'chokidar';

const VIDEO_RE = /^DJI_\d{4,}.*\.MP4$/i; // DJI_0001.MP4（§2.2 指纹）与 DJI_YYYYMMDDHHMMSS*.MP4（§4.2 时间戳文件名）都接受
const OUTPUT_RE = /_dash\.MP4$/i; // 排除流水线自己的产物
const DCIM_DIR_RE = /^DJI[ _]001$/i; // 官方口径 "DCIM/DJI 001"，兼容下划线变体

// 已处理判定（src/lib/db.ts 的 store 满足此形状）
export interface WatchStore {
  isProcessed(rec: { path: string; size: number; mtime: number }): boolean;
}

// diskutil info -plist 转 JSON 的结果，字段由 macOS 决定，按需读取
export type DiskutilInfo = Record<string, any>;

export interface VolumeWatcherOpts {
  volumesRoot?: string;
  config?: ActpipeConfig | null;
  store?: WatchStore | null;
  debounceMs?: number;
  stabilityMs?: number;
  log?: (msg: string) => void;
}

export class VolumeWatcher extends EventEmitter {
  volumesRoot: string;
  config: ActpipeConfig | null | undefined;
  store: WatchStore | null | undefined;
  debounceMs: number;
  stabilityMs: number;
  log: (msg: string) => void;
  watcher: FSWatcher | null;
  timers: Map<string, NodeJS.Timeout>;
  knownVolumes: Set<string>;

  constructor({ volumesRoot = '/Volumes', config, store, debounceMs = 1500, stabilityMs = 1000, log = console.log }: VolumeWatcherOpts = {}) {
    super();
    this.volumesRoot = volumesRoot;
    this.config = config;
    this.store = store;
    this.debounceMs = debounceMs;
    this.stabilityMs = stabilityMs;
    this.log = log;
    this.watcher = null;
    this.timers = new Map();
    this.knownVolumes = new Set();
  }

  async start(): Promise<this> {
    const { watch } = await import('chokidar');
    this.knownVolumes = new Set(this.listVolumes());
    this.watcher = watch(this.volumesRoot, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
    });
    this.watcher.on('addDir', (p) => this.#onVolumeEvent(p));
    this.watcher.on('add', (p) => {
      if (path.dirname(p) === this.volumesRoot) this.#onVolumeEvent(p);
    });
    // 卸载时移出 knownVolumes：否则拔卡再插（同挂载点）会被永久忽略
    this.watcher.on('unlinkDir', (p) => {
      if (path.dirname(p) !== this.volumesRoot) return;
      this.knownVolumes.delete(p);
      const t = this.timers.get(p);
      if (t) { clearTimeout(t); this.timers.delete(p); }
    });
    this.watcher.on('error', (e) => this.log(`[watch] watcher 错误：${(e as Error).message}`));
    this.log(`[watch] 监听 ${this.volumesRoot}（FSEvents 推送）`);
    return this;
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    await this.watcher?.close();
  }

  listVolumes(): string[] {
    try {
      return fs
        .readdirSync(this.volumesRoot)
        .map((n) => path.join(this.volumesRoot, n))
        .filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());
    } catch {
      return [];
    }
  }

  #onVolumeEvent(volPath: string): void {
    if (this.timers.has(volPath)) clearTimeout(this.timers.get(volPath));
    // FSEvents 回调内只做入队；防抖后按"当前实际挂载"为准做幂等
    this.timers.set(
      volPath,
      setTimeout(() => {
        this.timers.delete(volPath);
        this.#probeVolume(volPath).catch((e) => this.log(`[watch] 探测 ${volPath} 失败：${(e as Error).message}`));
      }, this.debounceMs)
    );
  }

  async #probeVolume(volPath: string): Promise<void> {
    if (!fs.existsSync(volPath)) return; // 已拔出/合并事件
    if (this.knownVolumes.has(volPath)) return;
    this.knownVolumes.add(volPath);

    const info = await diskutilInfo(volPath);
    const camera = findCameraFiles(volPath);
    if (!camera) {
      // 首接新设备时关键诊断：挂载了但被忽略，必须留下原因（无 DCIM / 无 DJI 目录 / 文件名不匹配）
      const dcim = path.join(volPath, 'DCIM');
      if (!fs.existsSync(dcim)) {
        this.log(`[watch] ${volPath} 挂载（无 DCIM 目录，非相机卷，忽略）`);
      } else {
        let subs: string[] = [];
        try { subs = fs.readdirSync(dcim); } catch {}
        this.log(`[watch] ${volPath} 有 DCIM=[${subs.join(', ')}] 但未命中相机指纹（DJI 目录或 DJI_*.MP4），忽略`);
      }
      return;
    }
    const whitelist = this.config?.volume_whitelist ?? [];
    if (whitelist.length) {
      const name = path.basename(volPath);
      if (!whitelist.includes(name) && !whitelist.includes(info?.VolumeUUID)) {
        this.log(`[watch] ${volPath} 有相机指纹但不在白名单，忽略`);
        return;
      }
    }
    this.log(`[watch] 检测到运动相机卷：${volPath}${info?.VolumeUUID ? ` (${info.VolumeUUID})` : ''}`);

    this.log(`[watch] ${volPath} 命中 ${camera.files.length} 个视频，逐个检查大小稳定性（每个约 ${this.stabilityMs}ms）…`);
    const files = [];
    for (const f of camera.files) {
      const stable = await waitSizeStable(f, this.stabilityMs);
      if (!stable) {
        this.log(`[watch] ${f} 大小未稳定，暂不入队`);
        continue;
      }
      const st = fs.statSync(f);
      const rec = { path: f, size: st.size, mtime: Math.round(st.mtimeMs) };
      if (this.store?.isProcessed(rec)) {
        this.log(`[watch] ${path.basename(f)} 已处理过，跳过`);
        continue;
      }
      files.push(rec);
    }
    if (!files.length) return;
    this.emit('media_found', {
      volume: {
        path: volPath,
        name: path.basename(volPath),
        uuid: info?.VolumeUUID ?? null,
        protocol: info?.BusProtocol ?? info?.DeviceBusProtocol ?? null,
        filesystem: info?.FilesystemType ?? info?.FilesystemName ?? null,
      },
      files,
    });
  }

  async simulate(volPath: string): Promise<void> {
    this.knownVolumes.delete(volPath);
    await this.#probeVolume(volPath);
  }
}

export function findCameraFiles(volPath: string): { dir: string; files: string[] } | null {
  const dcim = path.join(volPath, 'DCIM');
  if (!fs.existsSync(dcim)) return null;
  let djiDir: string | null = null;
  for (const d of fs.readdirSync(dcim)) {
    if (DCIM_DIR_RE.test(d)) {
      djiDir = path.join(dcim, d);
      break;
    }
  }
  if (!djiDir) return null;
  const files = fs
    .readdirSync(djiDir)
    .filter((f) => VIDEO_RE.test(f) && !OUTPUT_RE.test(f))
    .map((f) => path.join(djiDir, f))
    .sort();
  return files.length ? { dir: djiDir, files } : null;
}

export async function waitSizeStable(file: string, intervalMs = 1000): Promise<boolean> {
  const a = fs.statSync(file, { throwIfNoEntry: false });
  if (!a) return false;
  await sleep(intervalMs);
  const b = fs.statSync(file, { throwIfNoEntry: false });
  return !!b && a.size === b.size;
}

export async function diskutilInfo(volPath: string): Promise<DiskutilInfo | null> {
  const r = await run('diskutil', ['info', '-plist', volPath]);
  if (r.code !== 0) return null;
  const j = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: r.stdout });
  if (j.code !== 0) return null;
  try {
    return JSON.parse(j.stdout);
  } catch {
    return null;
  }
}
