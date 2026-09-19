import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  hashPassword, verifyPassword, signToken, verifyToken, createAuth,
} from '../../src/server/auth.ts';

// createApp 级联前的最小装配与 app.js 一致：feathersExpress + json + auth 中间件
import { feathers } from '@feathersjs/feathers';
import feathersExpress, { json, type Application } from '@feathersjs/express';
import type { Express, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { ActpipeConfig } from '../../src/types.ts';

// app.request 不存在于 Express：起真实 HTTP 端口发请求（redirect: manual 保持不跳转语义）
async function request(app: Application, path: string, init: RequestInit = {}) {
  const server = await app.listen(0);
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try {
    return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { redirect: 'manual', ...init });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

// ---- 密码哈希 ----
test('hashPassword/verifyPassword: 正确密码通过，错误密码拒绝', () => {
  const h = hashPassword('ride-fast-2026');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(verifyPassword('ride-fast-2026', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('ride-fast-2026', 'garbage'), false);
  assert.equal(verifyPassword('ride-fast-2026', null), false);
});

test('hashPassword: 同一密码两次哈希不同（随机盐）', () => {
  assert.notEqual(hashPassword('x'), hashPassword('x'));
});

// ---- 会话令牌 ----
test('signToken/verifyToken: 签发可验，篡改与过期拒绝', () => {
  const secret = 's'.repeat(32);
  const tok = signToken(secret, 60);
  assert.equal(verifyToken(secret, tok), true);
  assert.equal(verifyToken('other-secret-padded-xxxxxxxxxxxx', tok), false);
  assert.equal(verifyToken(secret, tok.slice(0, -2) + 'xx'), false);
  assert.equal(verifyToken(secret, 'not-a-token'), false);
  assert.equal(verifyToken(secret, signToken(secret, -10)), false); // 已过期
});

// ---- 中间件 + 登录路由（挂在真实 Feathers/Express 上跑） ----
function mkApp({ passwordHash = hashPassword('pw123'), cliTokenFile }: { passwordHash?: string | null; cliTokenFile?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-auth-'));
  const configRef = { current: { auth: { password_hash: passwordHash } } as ActpipeConfig };
  const auth = createAuth({ configRef, dataDir: dir });
  // @feathersjs/express 是 CJS：运行时 module.exports 即函数本身，类型端默认导入只解析到命名空间；
  // feathers 的 Application 类型 Omit 掉了 Express 的 get/set（路由注册），交叉回来
  const app = (feathersExpress as unknown as (feathersApp?: ReturnType<typeof feathers>) => Application & Express)(feathers());
  app.use(json());
  app.use(auth.middleware());
  auth.mountRoutes(app);
  app.get('/dash', (req: Request, res: Response) => res.type('html').send('<b>dash</b>'));
  app.get('/api/inbox', (req: Request, res: Response) => res.json([]));
  return { app, auth, dir };
}

test('开启鉴权：页面未登录 302 到 /login，API 未登录 401', async () => {
  const { app } = mkApp();
  const r1 = await request(app, '/dash');
  assert.equal(r1.status, 302);
  assert.equal(new URL(r1.headers.get('location')!, 'http://x').pathname, '/login');
  const r2 = await request(app, '/api/inbox');
  assert.equal(r2.status, 401);
});

test('登录流程：错误密码 401，正确密码签发 cookie，携 cookie 可访问', async () => {
  const { app } = mkApp();
  const bad = await request(app, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  const ok = await request(app, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw123' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie')!;
  assert.match(cookie, /actpipe_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/); // OAuth 回跳（顶级 GET 导航）需要携带会话
  const r = await request(app, '/dash', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(r.status, 200);
});

test('logout 后 cookie 失效', async () => {
  const { app } = mkApp();
  const ok = await request(app, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw123' }) });
  const cookie = ok.headers.get('set-cookie')!.split(';')[0];
  const out = await request(app, '/api/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
});

test('本机 CLI token 直通（X-Actpipe-Token）', async () => {
  const { app, auth } = mkApp();
  const r = await request(app, '/api/inbox', { headers: { 'x-actpipe-token': auth.cliToken } });
  assert.equal(r.status, 200);
  const bad = await request(app, '/api/inbox', { headers: { 'x-actpipe-token': 'wrong' } });
  assert.equal(bad.status, 401);
});

test('未配置密码 = 鉴权关闭，全部放行', async () => {
  const { app } = mkApp({ passwordHash: null });
  const r = await request(app, '/dash');
  assert.equal(r.status, 200);
});

test('/login 页面本身不需要登录', async () => {
  const { app } = mkApp();
  const r = await request(app, '/login');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /actpipe/);
});
