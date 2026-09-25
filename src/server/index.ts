import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { paths, ensureDirs } from '../lib/paths.ts';
import { loadConfig } from '../lib/config.ts';
import { getStore, storeKind } from '../lib/db.ts';
import { JobQueue } from './queue.ts';
import { Inbox } from './inbox.ts';
import { createApp } from './app.ts';
import type { AppRefs } from './app.ts';
import { attachProgressWebSocket } from './realtime.ts';
import { VolumeWatcher } from '../modules/watch.ts';
import { cleanCache } from '../modules/render.ts';
import { PregenService } from './pregen.ts';
import * as strava from '../modules/strava.ts';
import * as interact from '../modules/interact.ts';
import type { LogFn } from './services/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function installDefaultAssets(log: LogFn = console.log) {
  ensureDirs();
  const src = path.join(ROOT, 'dashboards');
  if (!fs.existsSync(src)) return;
  // 共享件是基础设施不是用户素材：每次启动都刷新，保证和皮肤编译层同版本
  const libSrc = path.join(src, '_lib');
  if (fs.existsSync(libSrc)) fs.cpSync(libSrc, path.join(paths.dashboards, '_lib'), { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith('_')) continue; // _lib 已处理，_fonts 是设计素材库不进用户目录
    const skinSrc = path.join(src, name);
    const skinDst = path.join(paths.dashboards, name);
    if (!fs.existsSync(path.join(skinSrc, 'Skin.svelte'))) continue;
    if (fs.existsSync(path.join(skinDst, 'Skin.svelte'))) continue; // 已安装（可能被用户改过），不动
    fs.rmSync(skinDst, { recursive: true, force: true }); // 旧格式（template.html）安装件：整体替换
    fs.cpSync(skinSrc, skinDst, { recursive: true });
    log(`[boot] 皮肤已安装到 ${skinDst}`);
  }
}

export async function startServer({ port = null, withWatcher = true, log = console.log }: { port?: number | null; withWatcher?: boolean; log?: LogFn } = {}) {
  installDefaultAssets(log);
  const config = loadConfig();
  const configRef = { current: config };
  const store = getStore();
  const queue = new JobQueue({ config, store });
  const inbox = new Inbox({ configRef, log });
  const listenPort = port ?? config.port ?? 8787;

  const refs: AppRefs = { watcher: null };
  const app = createApp({ queue, configRef, inbox, refs });
  const auth = app.get('auth'); // app.js 装配时挂上，upgrade 分发前的鉴权判定用

  let watcher = null;
  if (withWatcher) {
    watcher = new VolumeWatcher({ config, store, log });
    refs.watcher = watcher;
    await watcher.start();
    watcher.on('media_found', ({ volume, files }) => {
      const inboxUrl = `http://127.0.0.1:${listenPort}/inbox`;
      // 插卡即触发一次 Strava 同步：fit 入库后 inbox 的自动预选/合并分组直接可用
      const cfgNow = configRef.current;
      if (cfgNow.strava?.auto_sync) {
        if (strava.isConnected(cfgNow)) {
          strava.syncFits(cfgNow, { log }).catch((e) => log(`[strava] 同步失败：${e.message}`));
        } else if (strava.isConfigured(cfgNow)) {
          // 已配置但从未授权：引导完成首次授权，之后插卡即自动同步
          log('[strava] 已配置未授权，通知引导首次授权');
          interact
            .notify({
              title: 'actpipe：Strava 待授权',
              message: '授权后，插卡时会自动把骑行数据合成为 FIT 供选择',
              openUrl: `http://127.0.0.1:${listenPort}/dash`,
            })
            .catch(() => {});
        }
      }
      const copyOnDetect = !!configRef.current.inbox_copy_on_detect;
      log(`[watch] ${volume.name}: ${files.length} 段新素材，${copyOnDetect ? '先拷贝到磁盘' : '读取信息（暂不拷贝）'}后等待人工确认`);
      interact
        .notify({
          title: 'actpipe 检测到素材',
          message: `${volume.name}: ${files.length} 段视频${copyOnDetect ? '，正在拷贝到磁盘…' : ''}`,
          openUrl: inboxUrl,
        })
        .catch(() => {});
      inbox
        .addPending({ volume, files })
        .then((items) => {
          const ok = items.filter((i) => ['ready', 'on_card'].includes(i.ingest?.state as string)).length;
          const fail = items.length - ok;
          log(`[inbox] ${volume.name}: ${ok} 段就绪${fail ? `，${fail} 段拷贝/探测失败` : ''}，等待人工确认`);
          interact
            .notify({
              title: 'actpipe 素材待确认',
              message: `${ok} 段已就绪${fail ? `（${fail} 段失败）` : ''}，点击本通知打开确认页`,
              openUrl: inboxUrl,
            })
            .catch(() => {});
          // 检测即拷贝模式：全部拷完意味着这张卡已经可以卸载（确认与否都不再依赖卡）
          if (copyOnDetect && ok > 0 && fail === 0) {
            interact
              .notify({
                title: 'actpipe：可以卸载 SD 卡了',
                message: `${ok} 段素材已全部拷贝到本机磁盘`,
                sound: configRef.current.notify_sound,
              })
              .catch(() => {});
          }
        })
        .catch((e) => log(`[inbox] 入库失败：${e.message}`));
    });
  }

  // FIT 库即挂钩：Strava 同步/手动载入/上传的 .fit 落库后自动预生成 PNG 序列（闲时跑，生产优先）
  const pregen = new PregenService({ configRef, queue, log });
  await pregen.start();

  // Strava 同步不做定时轮询：只在检测到相机插入时拉一次（见 media_found）

  const server = await app.listen(listenPort, '127.0.0.1');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  log(`[server] actpipe listening on http://127.0.0.1:${(server.address() as AddressInfo).port} (store: ${storeKind()})`);
  // 原生 WS /jobs/:id/progress 与 socket.io 在同一 server 上按 path 分发（见 realtime.js）
  attachProgressWebSocket(server, { queue, auth });
  // 缓存清理放 listen 之后异步跑：9 万+ 帧的体积遍历不能拖住启动
  cleanCache({ ttlDays: config.cache.ttl_days, maxGb: config.cache.max_gb, log })
    .catch((e) => log(`[cache] 清理失败：${(e as Error).message}`));
  return { server, queue, configRef, watcher, inbox, pregen };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on('unhandledRejection', (e) => {
    console.error('[fatal] unhandledRejection:', e);
    process.exit(1);
  });
  process.on('uncaughtException', (e) => {
    console.error('[fatal] uncaughtException:', e);
    process.exit(1);
  });
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
