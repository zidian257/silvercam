// fetch 封装：401（鉴权开启但未登录）统一走未登录处理（默认跳登录页，带回跳地址）

// 后端 JSON 响应的最小接口：只列页面实际消费的字段，其余键按 any 透传（外部数据）
export interface LutEntry {
  name: string;
  label?: string;
  path?: string;
  [k: string]: any;
}

export interface InboxProbe {
  duration?: number | null;
  color?: unknown; // ffprobe 色彩元数据透传，形状由外部决定
  [k: string]: any;
}

export interface InboxItem {
  id: string;
  src?: string;
  recorded_at?: string | null;
  seq?: number | null;
  size?: number | null;
  status?: string;
  probe?: InboxProbe | null;
  ingest?: { state?: string; percent?: number } | null;
  job_id?: string | null;
  src_exists?: boolean;
  [k: string]: any;
}

export interface JobRow {
  id: string;
  state?: string;
  progress?: { percent?: number; [k: string]: any } | null;
  [k: string]: any;
}

type UnauthorizedHandler = () => void;

const defaultUnauthorized: UnauthorizedHandler = () => {
  const next = location.pathname + location.search;
  location.href = `/login?next=${encodeURIComponent(next)}`;
};
let onUnauthorized: UnauthorizedHandler = defaultUnauthorized;

// 测试注入用；传 null 恢复默认跳转
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn ?? defaultUnauthorized;
}

export async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('unauthorized');
  }
  return res;
}

export async function getJson<T = any>(path: string): Promise<T> {
  const r = await api(path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

export async function postJson<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `POST ${path} → ${r.status}`);
  return data;
}
