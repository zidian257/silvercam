import path from 'node:path';
import { feathers } from '@feathersjs/feathers';
import feathersExpress, { rest, json, raw, serveStatic } from '@feathersjs/express';
import socketio from '@feathersjs/socketio';
import type { Request, Response, NextFunction } from 'express';
import { paths, REPO_ROOT } from '../lib/paths.ts';
import { createAuth } from './auth.ts';
import { JobsService } from './services/jobs.ts';
import type { QueueLike } from './services/jobs.ts';
import { InboxService } from './services/inbox.ts';
import { FitsService } from './services/fits.ts';
import { QuickcutService } from './quickcuts.ts';
import { ConfigService } from './services/config.ts';
import type { ConfigRef } from './services/config.ts';
import { createPagesRouter } from './middleware/pages.ts';
import { createMediaRouter } from './middleware/media.ts';
import { configureRealtime } from './realtime.ts';
import type { Inbox } from './inbox.ts';
import type { VolumeWatcher } from '../modules/watch.ts';

// @feathersjs/express 运行时 default export 是可调用函数（module.exports = Object.assign(fn, exports)），
// 但其 .d.ts 在 nodenext 下解析为 CJS 命名空间、类型上不可调用 → 收窄到其 default 签名
type FeathersExpressFactory = (typeof import('@feathersjs/express'))['default'];

// 装配上下文：queue 用结构面（生产 JobQueue 与 API 测试桩都满足），refs 是可变挂载点
export interface AppRefs {
  watcher?: VolumeWatcher | null;
}
export interface AppContext {
  queue: QueueLike;
  configRef: ConfigRef;
  inbox: Inbox | null;
  refs: AppRefs;
}

// Feathers v5 custom method 在 REST 上走 x-service-method 头、签名 (data, params)；
// 现有 URL 契约是路径段形态（POST /jobs/:id/fit、POST /api/inbox/commit 等）。
// 桥：路径段 → 头 + url 重写；实例 id 经 req.feathers.route 放回 params.route.__id
// （rest 层会把 lookup 出的 __id 从 params.route 剥离，而 req.feathers 在 params 组装时展开在其后）。
const CUSTOM_METHOD_ROUTES = [
  { re: /^(\/jobs\/[^/]+)\/(fit|offset|bias)$/, withId: true },
  { re: /^(\/api\/inbox)\/(commit)$/, withId: false },
  { re: /^(\/api\/inbox\/[^/]+)\/(align|reopen)$/, withId: true },
  { re: /^(\/quickcuts)\/(analyze)$/, withId: false },
];
function customMethodBridge(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'POST') return next();
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const p = req.url.slice(0, req.url.length - q.length);
  for (const { re, withId } of CUSTOM_METHOD_ROUTES) {
    const m = re.exec(p);
    if (!m) continue;
    req.url = m[1] + q;
    req.headers['x-service-method'] = m[2];
    if (withId) req.feathers = { ...req.feathers, route: { __id: decodeURIComponent(m[1].split('/').pop()!) } };
    return next();
  }
  return next();
}

// Feathers/Express 装配：鉴权中间件收口全部路由（含页面/静态资源/socket.io 握手），/login 与 /api/login 豁免；
// 原生 WS /jobs/:id/progress 的 upgrade 鉴权在 index.js 的 upgrade 分发里做
export function createApp({ queue, configRef, inbox = null, refs = {} }: { queue: QueueLike; configRef: ConfigRef; inbox?: Inbox | null; refs?: AppRefs }) {
  const app = (feathersExpress as unknown as FeathersExpressFactory)(feathers());
  const ctx: AppContext = { queue, configRef, inbox, refs };

  const auth = createAuth({ configRef, dataDir: paths.home });
  app.set('auth', auth); // index.js 取去用于 upgrade 分发前的鉴权判定

  app.use(json());
  // POST /api/fits 的 body 是原始 .fit 字节：该路径单独挂 raw 解析（FitsService.create 收 Buffer）
  app.use('/api/fits', raw({ type: () => true, limit: '32mb' }));
  app.use(auth.middleware());
  auth.mountRoutes(app);
  app.use(customMethodBridge);

  app.configure(rest());
  app.configure(socketio((io) => {
    // engine.io 不走 Express 中间件链，握手/轮询在同一 middleware 上单独收口
    io.engine.use(auth.middleware());
  }));

  app.use('jobs', new JobsService({ queue }), { methods: ['find', 'get', 'create', 'fit', 'offset', 'bias'], events: ['progress'] });
  // 快剪：对已出片任务剪 ~30s 短片；轻任务走服务内部串行通道，不挤主队列
  app.use('quickcuts', new QuickcutService({ queue, configRef }), { methods: ['find', 'get', 'create', 'analyze'] });
  app.use('api/inbox', new InboxService(ctx), { methods: ['find', 'remove', 'commit', 'align', 'reopen'] });
  app.use('api/fits', new FitsService({ configRef }), { methods: ['find', 'create'] });
  app.use('config', new ConfigService(ctx), { methods: ['find', 'update'] });

  configureRealtime(app, { queue });

  // Svelte 构建产物（web/dist）静态伺服；鉴权中间件已先行收口
  app.use('/app', serveStatic(path.join(REPO_ROOT, 'web', 'dist')));
  app.use(createPagesRouter());
  app.use(createMediaRouter(ctx));

  app.use((req: Request, res: Response) => res.status(404).json({ error: 'not found' }));
  // 统一错误出口：FeathersError → { error: message } + err.code（前端 postJson 读 data.error）
  // eslint-disable-next-line no-unused-vars
  app.use((err: any, req: Request, res: Response, next: NextFunction) => { // err: FeathersError 形态（code/status 动态）
    const raw = err.code ?? err.status ?? err.statusCode;
    const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
    if (status >= 500) console.error('[http] 未捕获错误:', err);
    res.status(status).json({ error: err.message ?? 'internal error' });
  });

  return app;
}
