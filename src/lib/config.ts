import fs from 'node:fs';
import type { ActpipeConfig } from '../types.ts';
import { paths, ensureDirs, expandHome } from './paths.ts';
import { readJson, writeJsonAtomic } from './util.ts';

export const DEFAULTS: ActpipeConfig = {
  port: 8787,
  output_dir: '~/Movies/DashCam',
  staging_retention: 'keep', // keep | delete_on_success
  delete_from_card_after_success: false,
  staging_checksum: false,
  dlog_policy: 'ask', // always_lut | never_lut | ask
  dlog_memory: {}, // "<serial>|<w>x<h>@<fps>" -> "lut" | "no_lut"
  camera_serial: 'unknown',
  default_lut: 'dlogm_rec709',
  luts: {}, // name -> path; resolved against luts dir when relative
  lut_names: {}, // name -> 中文显示名（仅 UI 展示用，接口传值仍用英文 name）
  global_bias_seconds: 0,
  fit_autopick: 'ask', // ask | newest_in_dir
  fit_dirs: ['~/Downloads', '~/Desktop'],
  fit_library_dir: null, // inbox FIT 下拉库目录；null = ~/.config/actpipe/fits
  raw_subdir: 'raw', // 无 FIT 纯拷贝输出的子目录名（<output_dir>/<日期>/<raw_subdir>/原名.MP4）
  fit_watch_dir: null, // 额外 FIT 监听源（pregen 始终监听 FIT 库，此项是附加目录）；null 关闭
  inbox_copy_on_detect: false, // true = 检到素材立即拷 staging；false = 只 probe，确认后才拷贝（省磁盘，但确认前卡不能拔）
  skin: 'virb_like',
  overlay_fps: 10,
  render_tabs: 4,
  smooth_window_s: 3,
  pregen: { enabled: true, fps: null, resolutions: ['3840x2160'], boot_days: 7 }, // fps null = 跟随 overlay_fps（生产规格，任务渲染直接 HIT）；boot_days = 启动补扫最近 N 天入库的 FIT
  encoder: 'hevc_videotoolbox', // hevc_videotoolbox | h264_videotoolbox
  bitrate: '45M',
  ten_bit_output: false,
  encode_concurrency: 2, // 合并任务并行编码段数；VideoToolbox 硬编共享有余量，瓶颈在 CPU 滤镜链
  render_concurrency: 1, // 并行渲染段数（Chromium 内存大户，>1 需自行评估内存）
  max_swap_mb: 3072, // swap 已用超过此值时暂缓启动新的渲染/编码（防交换风暴拖垮整机）；0 = 关闭水位门
  volume_whitelist: [], // volume names or UUIDs; empty = accept any camera-fingerprinted volume
  cache: { ttl_days: 14, max_gb: 20 },
  notify_sound: 'Glass',
  // 全站鉴权：password_hash 非空即开启（actpipe passwd <密码> 设置）；公网映射前务必设置
  auth: { password_hash: null },
  // Strava 集成：授权后，插入相机时自动把活动 streams 合成为 .fit 入库（见 modules/strava.js）
  strava: { client_id: null, client_secret: null, access_token: null, refresh_token: null, expires_at: 0, athlete: null, auto_sync: true, sync_days: 14 },
};

function isPlainObject(v: any): boolean {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge<T extends Record<string, any>>(base: T, extra: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out as T;
}

export function loadConfig(): ActpipeConfig {
  ensureDirs();
  const fileCfg = readJson(paths.config, {} as Record<string, unknown>);
  const cfg = merge(DEFAULTS, fileCfg);
  for (const key of ['output_dir', 'fit_watch_dir', 'fit_library_dir'] as const) {
    if (cfg[key]) cfg[key] = expandHome(cfg[key]);
  }
  if (!cfg.fit_library_dir) cfg.fit_library_dir = paths.fits;
  cfg.fit_dirs = (cfg.fit_dirs || []).map(expandHome as (p: string) => string);
  return cfg;
}

export function saveConfig(cfg: ActpipeConfig): ActpipeConfig {
  ensureDirs();
  writeJsonAtomic(paths.config, cfg);
  return cfg;
}

// LUT 解析：支持链式 "a+b"（依次套用，如 D-Log 还原 + Rec.709 大师滤镜），
// 链式规格返回 '+' 连接的绝对路径字符串；任一环无法解析则整链返回 null。
export function resolveLutPath(cfg: ActpipeConfig, nameOrPath: string | null | undefined, _seen: Set<string> = new Set()): string | null {
  if (!nameOrPath) return null;
  if (nameOrPath.includes('+')) {
    if (_seen.has(nameOrPath)) return null;
    _seen.add(nameOrPath);
    const parts = nameOrPath.split('+').map((s) => resolveLutPath(cfg, s.trim(), _seen));
    return parts.every(Boolean) && parts.length ? parts.join('+') : null;
  }
  if (nameOrPath.includes('/') || nameOrPath.endsWith('.cube')) {
    return expandHome(nameOrPath);
  }
  if (_seen.has(nameOrPath)) return null;
  _seen.add(nameOrPath);
  const mapped = cfg.luts?.[nameOrPath];
  if (mapped) return resolveLutPath(cfg, mapped, _seen);
  const candidate = `${paths.luts}/${nameOrPath}.cube`;
  return fs.existsSync(candidate) ? candidate : null;
}

export interface LutInfo {
  name: string;
  label: string | null;
  path: string;
  exists: boolean;
  default: boolean;
}

export function listLuts(cfg: ActpipeConfig): LutInfo[] {
  const out: LutInfo[] = [];
  const seen = new Set<string>();
  const label = (name: string): string | null => cfg.lut_names?.[name] ?? null;
  for (const [name, p] of Object.entries(cfg.luts || {})) {
    const full = resolveLutPath(cfg, name);
    const exists = full ? full.split('+').every((x) => fs.existsSync(x)) : false;
    out.push({ name, label: label(name), path: full ?? p, exists, default: name === cfg.default_lut });
    seen.add(name);
  }
  if (fs.existsSync(paths.luts)) {
    for (const f of fs.readdirSync(paths.luts).filter((f) => f.endsWith('.cube'))) {
      const name = f.replace(/\.cube$/, '');
      if (seen.has(name)) continue;
      out.push({ name, label: label(name), path: `${paths.luts}/${f}`, exists: true, default: name === cfg.default_lut });
    }
  }
  return out;
}
