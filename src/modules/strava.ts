import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- fitsdk 的 index.d.ts 用无扩展名 re-export，nodenext 解析不到；运行时 index.js 正常，导入绑定按 any 处理
import { Encoder } from '@garmin/fitsdk';
import { saveConfig } from '../lib/config.ts';
import type { ActpipeConfig } from '../types.ts';

// Strava 集成：OAuth 授权后拉活动 streams（时间/GPS/心率/功率/踏频/速度/海拔），
// 在本地重新合成为标准 .fit 写入 FIT 库——下游的自动预选、合并分组、预览逻辑全部复用。
// 授权只需一次：refresh_token 长期有效，access_token 过期自动刷新并落盘。

const AUTH_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API_BASE = 'https://www.strava.com/api/v3';
const DEG_TO_SEMICIRCLE = 2 ** 31 / 180;

// Strava API 响应的最小形状（只列消费到的字段）
interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: any; // 外部数据，仅取 id/firstname/lastname
  message?: string;
}

export interface StravaAthlete {
  id: number | null;
  name: string | null;
}

export interface StravaActivity {
  id: number;
  name?: string;
  start_date: string;
  start_date_local?: string;
  sport_type: string;
  elapsed_time?: number;
  distance?: number;
  total_elevation_gain?: number;
}

// streams（key_by_type）原始负载：字段名 -> { data }，数据列形状由 Strava 决定，按 any 处理
type StravaStreams = Record<string, { data?: any[] } | undefined>;

export interface StravaSyncResult {
  connected: boolean;
  added: string[];
  skipped: number;
  total: number;
}

export function isConfigured(cfg: ActpipeConfig): boolean {
  return !!(cfg.strava?.client_id && cfg.strava?.client_secret);
}

export function isConnected(cfg: ActpipeConfig): boolean {
  return !!cfg.strava?.refresh_token;
}

export function authUrl(cfg: ActpipeConfig, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: String(cfg.strava.client_id),
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read_all',
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body: Record<string, unknown>): Promise<StravaTokenResponse> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as StravaTokenResponse;
  if (!r.ok) throw new Error(`Strava token 请求失败 ${r.status}: ${j.message ?? JSON.stringify(j)}`);
  return j;
}

export async function exchangeCode(cfg: ActpipeConfig, code: string): Promise<StravaAthlete> {
  const j = await tokenRequest({
    client_id: cfg.strava.client_id,
    client_secret: cfg.strava.client_secret,
    code,
    grant_type: 'authorization_code',
  });
  cfg.strava.access_token = j.access_token;
  cfg.strava.refresh_token = j.refresh_token;
  cfg.strava.expires_at = j.expires_at;
  const a = j.athlete ?? {};
  cfg.strava.athlete = { id: a.id, name: [a.firstname, a.lastname].filter(Boolean).join(' ') || null };
  saveConfig(cfg);
  return cfg.strava.athlete as StravaAthlete;
}

async function ensureAccessToken(cfg: ActpipeConfig): Promise<string> {
  if (!isConnected(cfg)) throw new Error('Strava 未连接（先到 dash 页完成授权）');
  const nowS = Math.floor(Date.now() / 1000);
  if (cfg.strava.access_token && cfg.strava.expires_at > nowS + 60) return cfg.strava.access_token;
  const j = await tokenRequest({
    client_id: cfg.strava.client_id,
    client_secret: cfg.strava.client_secret,
    refresh_token: cfg.strava.refresh_token,
    grant_type: 'refresh_token',
  });
  cfg.strava.access_token = j.access_token;
  cfg.strava.refresh_token = j.refresh_token;
  cfg.strava.expires_at = j.expires_at;
  saveConfig(cfg);
  return j.access_token;
}

async function apiGet(cfg: ActpipeConfig, p: string): Promise<any> { // Strava API 原始 JSON，各调用方按最小形状消费
  const token = await ensureAccessToken(cfg);
  const r = await fetch(`${API_BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) throw new Error('Strava 授权已被撤销，请重新连接');
  if (r.status === 429) throw new Error('Strava API 限流（100/15min），稍后再试');
  if (!r.ok) throw new Error(`Strava API ${r.status}`);
  return r.json();
}

export function listActivities(cfg: ActpipeConfig, { afterS, beforeS, perPage = 30 }: {
  afterS?: number;
  beforeS?: number;
  perPage?: number;
} = {}): Promise<StravaActivity[]> {
  const q = new URLSearchParams({ per_page: String(perPage) });
  if (afterS) q.set('after', String(afterS));
  if (beforeS) q.set('before', String(beforeS));
  return apiGet(cfg, `/athlete/activities?${q}`);
}

const STREAM_KEYS = 'time,latlng,altitude,heartrate,watts,cadence,velocity_smooth,distance,temp';

export function fetchStreams(cfg: ActpipeConfig, activityId: number): Promise<StravaStreams> {
  return apiGet(cfg, `/activities/${activityId}/streams?keys=${STREAM_KEYS}&key_by_type=true`);
}

const SPORT_MAP: Record<string, string> = {
  Ride: 'cycling', VirtualRide: 'cycling', EBikeRide: 'cycling', GravelRide: 'cycling',
  MountainBikeRide: 'cycling', EMountainBikeRide: 'cycling',
  Run: 'running', TrailRun: 'running', VirtualRun: 'running',
  Walk: 'walking', Hike: 'hiking', Swim: 'swimming',
};

// streams（key_by_type）→ 标准 .fit 字节；latlng 由度转半圆度；缺哪个字段就不写哪个
export function streamsToFitBytes(activity: StravaActivity, streams: StravaStreams): Uint8Array {
  const time = streams.time?.data;
  if (!time?.length) throw new Error('活动没有时间序列数据');
  const startMs = new Date(activity.start_date).getTime();
  const col = (k: string) => streams[k]?.data ?? null;
  const latlng = col('latlng');
  const cols = {
    altitude: col('altitude'), heartRate: col('heartrate'), power: col('watts'),
    cadence: col('cadence'), speed: col('velocity_smooth'), distance: col('distance'), temperature: col('temp'),
  };

  const enc = new Encoder();
  enc.writeMesg({ mesgNum: 0, type: 'activity', timeCreated: new Date(startMs), manufacturer: 'strava' });
  for (let i = 0; i < time.length; i++) {
    const msg: any = { mesgNum: 20, timestamp: new Date(startMs + time[i] * 1000) }; // FIT 记录字段按 SDK profile 透传
    const ll = latlng?.[i];
    if (ll) {
      msg.positionLat = ll[0] * DEG_TO_SEMICIRCLE;
      msg.positionLong = ll[1] * DEG_TO_SEMICIRCLE;
    }
    for (const [field, data] of Object.entries(cols)) {
      const v = data?.[i];
      if (v != null && Number.isFinite(v)) msg[field] = v;
    }
    enc.writeMesg(msg);
  }
  const endMs = startMs + time[time.length - 1] * 1000;
  enc.writeMesg({
    mesgNum: 18,
    timestamp: new Date(endMs),
    startTime: new Date(startMs),
    sport: SPORT_MAP[activity.sport_type] ?? 'generic',
    totalElapsedTime: activity.elapsed_time ?? time[time.length - 1],
    totalDistance: activity.distance ?? cols.distance?.[time.length - 1] ?? 0,
    totalAscent: activity.total_elevation_gain ?? undefined,
  });
  return enc.close();
}

// 文件名：<活动名>_<活动id>.fit；活动名清洗掉路径危险字符。id 用于去重
function fitFileName(activity: StravaActivity): string {
  const safe = String(activity.name ?? '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .trim()
    .slice(0, 40);
  return `${safe || 'strava'}_${activity.id}.fit`;
}

// 拉最近 days 天的活动，库里没有的合成 fit 入库；返回 { added, skipped, total }
export async function syncFits(cfg: ActpipeConfig, { days = null, log = () => {} }: {
  days?: number | null;
  log?: (msg: string) => void;
} = {}): Promise<StravaSyncResult> {
  if (!isConnected(cfg)) return { connected: false, added: [], skipped: 0, total: 0 };
  const syncDays = days ?? cfg.strava?.sync_days ?? 14;
  const afterS = Math.floor(Date.now() / 1000) - syncDays * 86400;
  const activities = await listActivities(cfg, { afterS });

  const dir = cfg.fit_library_dir!; // loadConfig 保证非 null（缺省回退 paths.fits）
  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set(
    fs.readdirSync(dir)
      .map((f) => /_(\d+)\.fit$/i.exec(f)?.[1])
      .filter(Boolean)
  );

  const added: string[] = [];
  let skipped = 0;
  for (const a of activities) {
    if (existing.has(String(a.id))) {
      skipped++;
      continue;
    }
    try {
      const streams = await fetchStreams(cfg, a.id);
      const bytes = streamsToFitBytes(a, streams);
      const file = path.join(dir, fitFileName(a));
      fs.writeFileSync(file, Buffer.from(bytes));
      added.push(path.basename(file));
      log(`[strava] 入库：${path.basename(file)}（${a.start_date_local ?? a.start_date}）`);
    } catch (e) {
      skipped++;
      log(`[strava] 跳过 ${a.name ?? a.id}：${(e as Error).message}`);
    }
  }
  return { connected: true, added, skipped, total: activities.length };
}
