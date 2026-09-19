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

export const SESSION_COOKIE = 'actpipe_session';

const LOGIN_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>actpipe — 登录</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 14px/1.5 -apple-system, "PingFang SC", sans-serif; background: #14161a; color: #e8e8e8; }
  .box { background: #1d2026; border: 1px solid #2c313a; border-radius: 12px; padding: 28px 32px; width: 300px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .sub { color: #8b95a5; font-size: 12px; margin-bottom: 18px; }
  input { width: 100%; box-sizing: border-box; background: #0f1114; color: #e8e8e8; border: 1px solid #3a404c;
          border-radius: 8px; padding: 9px 12px; font: inherit; margin-bottom: 12px; }
  button { width: 100%; background: #2f6fed; color: #fff; border: 0; border-radius: 8px; padding: 9px; font: inherit; cursor: pointer; }
  .err { color: #ff7b72; font-size: 12px; min-height: 16px; margin-bottom: 6px; }
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
    document.getElementById('e').textContent = '密码错误';
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
      if (p === '/login' || p === '/api/login') return next();
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
    app.get('/login', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
    });
    app.post('/api/login', (req, res) => {
      if (!enabled()) return res.json({ ok: true, disabled: true });
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
