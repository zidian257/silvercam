// 引入 transport-commons 的类型增强（publish/channel 在运行时由 socketio 装配 mixin，
// 类型是模块增强，不 import 一次就不进编译图）
import type {} from '@feathersjs/transport-commons';
import type { Server } from 'node:http';
import type { Application } from '@feathersjs/feathers';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Auth } from './auth.ts';
import type { QueueLike } from './services/jobs.ts';

// 实时分发，两条链路共吃 queue 'event'：
// ① /jobs/:id/progress 原生 WS（CLI 消费，协议原样：连接发 snapshot，之后 queue event 按 jobId 透传）
// ② jobs service emit('progress') → socket.io channel 'everybody' 广播（机制就位，暂无前端消费者）
export function configureRealtime(app: Application, { queue }: { queue: QueueLike }) {
  const jobs = app.service('jobs');
  jobs.publish('progress', () => app.channel('everybody'));
  jobs.publish(() => app.channel('everybody')); // created/patched/updated 等默认事件同频道
  app.on('connection', (conn) => app.channel('everybody').join(conn));
  queue.on('event', (ev) => jobs.emit('progress', ev));
}

// 原生 WS 与 socket.io 共存：http.Server 的 'upgrade' 事件按 path 分发——
// /socket.io/ 开头的不碰（engine.io 自己的 upgrade 监听会接管），
// /jobs/:id/progress 用 noServer 模式的 ws 处理（先过鉴权），其余一律销毁。
export function attachProgressWebSocket(server: Server, { queue, auth }: { queue: QueueLike; auth: Auth }) {
  const wss = new WebSocketServer({ noServer: true });
  const hub = new Map<string, Set<WebSocket>>();

  // queue 事件负载是动态的（progress/snapshot 等合并形态），按 any 透传
  queue.on('event', (ev: any) => {
    const subs = hub.get(ev.jobId);
    if (!subs?.size) return;
    const payload = JSON.stringify(ev);
    for (const ws of subs) {
      try { ws.send(payload); } catch {}
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url as string, 'http://localhost').pathname;
    if (pathname.startsWith('/socket.io/')) return;
    const m = /^\/jobs\/([^/]+)\/progress$/.exec(pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    // upgrade 请求不经过 Express 中间件链，鉴权在分发前手动收口（cookie 会话或 X-Actpipe-Token）
    if (auth.enabled() && !auth.authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const id = m[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!hub.has(id)) hub.set(id, new Set());
      hub.get(id)!.add(ws);
      ws.on('close', () => hub.get(id)?.delete(ws));
      const job = queue.get(id);
      if (job) ws.send(JSON.stringify({ jobId: id, type: 'snapshot', state: job.state, progress: job.progress, error: job.error }));
    });
  });

  return { wss, hub };
}
