import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import type { ConfigRef } from './services/config.ts';

// ---- 全站鉴权：单用户密码 + HMAC 签名会话 cookie ----
// 设计要点：
// - 密码只存 scrypt 哈希（config.auth.password_hash），不明文不落日志；
// - 会话令牌 = base64url(exp).hmac(secret)，无状态；secret 持久化在数据目录（0600），重启不失效；
// - cookie HttpOnly + SameSite=Lax：JS 读不到；跨站写请求不携带（防 CSRF），
//   但顶级 GET 跳转携带——OAuth 回跳（Strava → /api/strava/callback）靠它才能带着会话回来；
// - 本机 CLI 用数据目录里的 cli-token（0600）走 X-Actpipe-Token 头直通；
// - 未配置密码 = 鉴权关闭（本地默认体验不变）；`actpipe passwd <pw>` 开启。
// middleware/authorized 只用原生 req/res API（writeHead/end/headers），
// 同一份逻辑可同时挂在 Express 中间件链与 engine.io（socket.io）的 engine.use 上。

export function hashPassword(password: unknown) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: unknown, stored: string | null | undefined) {
  const m = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored ?? '');
  if (!m) return false;
  const actual = crypto.scryptSync(String(password), m[1], 32);
  const expected = Buffer.from(m[2], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function signToken(secret: string, ttlSec = 30 * 86400) {
  const payload = String(Math.floor(Date.now() / 1000) + ttlSec);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyToken(secret: string, token: string | null | undefined) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token ?? '');
  if (!m) return false;
  const payload = Buffer.from(m[1], 'base64url').toString();
  const expectSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(expectSig);
  const b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now() / 1000;
}

// 数据目录下读取或生成 32B 随机串（0600），用于 session secret / CLI token
function loadOrCreateKey(file: string) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* 不存在则生成 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

// ---- 登录限流：公网唯一暴露的攻击面就是 /api/login ----
// 内存滑动窗口：每 IP 每分钟最多 LOGIN_MAX_ATTEMPTS 次尝试，超限 429。
// 计全部尝试（成功也不清窗口——简单且防探测）；回环地址豁免（本机调试不被锁）。
// 单用户单机，不需要 redis。调用侧 IP 取 req.ip（app 已 trust proxy，隧道后为最左可信源）。
export const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_MAX_ATTEMPTS = 10;

export function createLoginRateLimiter({ windowMs = LOGIN_WINDOW_MS, maxAttempts = LOGIN_MAX_ATTEMPTS, now = () => Date.now() } = {}) {
  const hits = new Map<string, number[]>(); // ip -> 窗口内尝试时间戳
  const EXEMPT = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  function allow(ip: string | undefined | null): boolean {
    if (!ip || EXEMPT.has(ip)) return true;
    const t = now();
    if (hits.size > 1024) { // 内存上限兜底：顺路清掉滑出窗口的 key
      for (const [k, v] of hits) if (t - v[v.length - 1]! >= windowMs) hits.delete(k);
    }
    const arr = (hits.get(ip) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= maxAttempts) { hits.set(ip, arr); return false; }
    arr.push(t);
    hits.set(ip, arr);
    return true;
  }
  return { allow };
}

export const SESSION_COOKIE = 'actpipe_session';

const LOGIN_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>actpipe — 登录</title>
<link rel="icon" type="image/svg+xml" href="/favicon.ico">
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 14px/1.5 -apple-system, "PingFang SC", sans-serif; background: #F4F5F2; color: #191C17; }
  .box { background: #ffffff; border: 1px solid #E3E6E0; border-radius: 12px; padding: 28px 32px; width: 300px;
         box-shadow: 0 8px 24px rgba(25, 28, 23, .08); }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .sub { color: #5B6258; font-size: 12px; margin-bottom: 18px; }
  input { width: 100%; box-sizing: border-box; background: #ffffff; color: #191C17; border: 1px solid #C9CEC5;
          border-radius: 8px; padding: 9px 12px; font: inherit; margin-bottom: 12px; }
  button { width: 100%; background: #3E6B34; color: #fff; border: 0; border-radius: 8px; padding: 9px; font: inherit; cursor: pointer; }
  .err { color: #D64545; font-size: 12px; min-height: 16px; margin-bottom: 6px; }
</style></head>
<body><form class="box" id="f">
  <h1>actpipe</h1>
  <div class="sub">此站点已开启访问保护</div>
  <div class="err" id="e"></div>
  <input type="password" id="p" placeholder="密码" autofocus autocomplete="current-password">
  <button type="submit">登录</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('p').value }) });
  if (r.ok) {
    const next = new URLSearchParams(location.search).get('next') ?? '/dash';
    location.href = next.startsWith('/') ? next : '/dash'; // 防 open-redirect
  } else {
    const b = await r.json().catch(() => null); // 429 时显示限流文案而非「密码错误」
    document.getElementById('e').textContent = (b && b.error) || '密码错误';
    document.getElementById('p').select();
  }
});
</script></body></html>`;

// 原生 req/res 中间件签名：Express / engine.io / upgrade 分发三链共用；url 在三链上必有值
export type RawRequest = IncomingMessage & { url: string };
export type RawMiddleware = (req: RawRequest, res: ServerResponse, next: (err?: unknown) => void) => void;

// 只要求能挂 get/post 路由（feathers Application 与 Express app 按 arity 都满足）
interface RouteMounter {
  get(path: string, handler: (req: Request, res: Response) => unknown): unknown;
  post(path: string, handler: (req: Request, res: Response) => unknown): unknown;
}

export function createAuth({ configRef, dataDir }: { configRef: ConfigRef; dataDir: string }) {
  const secret = loadOrCreateKey(path.join(dataDir, 'session-secret'));
  const cliToken = loadOrCreateKey(path.join(dataDir, 'cli-token'));
  const enabled = () => !!configRef.current.auth?.password_hash;

  const cookieToken = (req: IncomingMessage) => {
    const m = /(?:^|;\s*)actpipe_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  // req 是原生 http.IncomingMessage（Express / engine.io / upgrade 分发共用）
  const authorized = (req: IncomingMessage) => {
    const tok = cookieToken(req);
    if (tok && verifyToken(secret, tok)) return true;
    return req.headers['x-actpipe-token'] === cliToken; // 本机 CLI 直通
  };

  function middleware(): RawMiddleware {
    return (req, res, next) => {
      if (!enabled()) return next();
      const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const p = req.url.slice(0, req.url.length - q.length);
      if (p === '/login' || p === '/api/login' || p === '/favicon.ico') return next();
      if (authorized(req)) return next();
      // API/WS/socket.io 一律 401；页面 302 到登录页（next 回跳）
      if (req.headers.upgrade || p.startsWith('/api') || p.startsWith('/jobs') || p.startsWith('/socket.io')) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(p + q)}` });
      res.end();
    };
  }

  function mountRoutes(app: RouteMounter) {
    const loginLimiter = createLoginRateLimiter();
    app.get('/login', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
    });
    app.post('/api/login', (req, res) => {
      if (!enabled()) return res.json({ ok: true, disabled: true });
      if (!loginLimiter.allow(req.ip)) return res.status(429).json({ error: '尝试过于频繁，稍后再试' });
      const body = req.body ?? {};
      if (!verifyPassword(body.password, configRef.current.auth.password_hash)) {
        return res.status(401).json({ error: '密码错误' });
      }
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(signToken(secret))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
      return res.json({ ok: true });
    });
    app.post('/api/logout', (req, res) => {
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return res.json({ ok: true });
    });
  }

  return { enabled, middleware, mountRoutes, cliToken, secret, authorized };
}

export type Auth = ReturnType<typeof createAuth>;
