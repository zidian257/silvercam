# actpipe 架构 review 与目标架构

> 2026-09 重构基线。第一、二节是重构前的 review 记录；第三节目标架构已落地（结构以实际代码为准）。

## 一、现状盘点

```
bin/actpipe.js          CLI 入口（bun 编译成单文件 actpipe）
src/server/
  index.js   159 行   启动装配：config/queue/inbox/watcher/HTTP/WS/通知/Strava
  api.js     726 行   全部 HTTP 路由（20+ 个端点堆在一个函数里）
  queue.js   833 行   任务队列：ingest→probe→fit→render→compose 状态机
  inbox.js   330 行   素材待确认列表（JSON 持久化 + 卡上只读 IO 串行队列）
src/lib/              config/db(sqlite)/paths/util —— 纯工具，质量较好
src/modules/          ingest/probe/thumb/fit/fitlib/render/compose/watch/strava/interact
web/
  align.html 630 行   studio（视频+LUT+皮肤+时间轴定格校准，含手写 WebGL LUT 渲染器）
  inbox.html 595 行   素材库（录制分组 + 批量决策 + 合并确认）
  dash.html  268 行   总控台
dashboards/           皮肤（template.html + style.css + binding.json + 字体），6 套
fixtures/             测试素材生成器（make-fixtures.mjs），无正式测试引用它
```

技术栈：Node ≥22.5（`--experimental-sqlite`）、FeathersJS v5（HTTP service 装配 + REST，
Express 承载）、socket.io（实时通道）、ws（原生 WS 进度端点）、chokidar（卷监听）、
playwright/Chromium（皮肤帧渲染）、ffmpeg/ffprobe（视频）、@garmin/fitsdk（FIT 解码）、pm2（常驻）。

## 二、Review：不合理设计清单

### 严重（本次必须修）

1. **零鉴权**。HTTP 监听 127.0.0.1 时没问题，但要映射公网等于裸奔：
   `/api/inbox/commit` 能拉满磁盘渲染，`DELETE /api/inbox/:id` 能删 staging，
   `/api/align/video` 能读任意本地文件流出去。**所有路由（含静态资源、WS）都必须过鉴权。**
2. **前端零构建、零测试**。三个巨型 HTML 内联手写 JS（1500+ 行），改样式靠肉眼回归。
   → Svelte 5 + Vite（MPA，每页一个入口）+ Vitest TDD。
3. **后端零测试**。`util.js` 的文件名解析、`fit.js` 的采样插值、queue 的合并/bias 传播逻辑
   都是手测的。→ node:test（无新依赖）+ fixtures。

### 中等（顺手修）

4. **api.js 上帝文件**。726 行 20+ 端点，对齐/inbox/jobs/fits/skins/静态资源混在一起。
   → 按域拆 `src/server/routes/*.js`，每个文件一个域，app.js 只做装配。
5. **皮肤页面服务逻辑重复**。`/align/skin/:name` 里内联了模板改写（替换 css/js、注入
   window.ACTPIPE、注入视频层），拆出 `src/server/skin-page.js` 纯函数便于测试。
6. **仓库根目录混入构建产物**（`.bun-build`、`actpipe` 二进制）。→ 挪 dist/ 并 gitignore。

### 可接受（明确不修，避免过度设计）

- 前端轮询（2.5s）而非全量 WS 推送：量小、逻辑简单，WS 只留给任务进度。
- JSON 文件持久化 inbox + sqlite 任务库：单机单用户够用。
- 渲染进程内串行队列：保护 SD 卡 IO 和 Chromium 内存，是特性不是缺陷。

## 三、目标架构

```
actpipe/
├── bin/actpipe.js                 # CLI（不变）
├── src/
│   ├── server/
│   │   ├── index.js               # 启动装配：createApp → app.listen → upgrade 分发（基本不变）
│   │   ├── app.js                 # Feathers/Express 装配：鉴权中间件 → services + routers
│   │   ├── auth.js                # 密码登录 + 签名 session cookie + WS 鉴权（Express 签名）
│   │   ├── services/              # 四个领域资源 service 化（hooks + realtime 红利）
│   │   │   ├── jobs.js            # /jobs：find/get/create + custom methods fit/offset/bias
│   │   │   ├── inbox.js           # /api/inbox：find/remove + custom methods commit/align/reopen
│   │   │   ├── fits.js            # /api/fits：find/create（上传走 express.raw 原始字节）
│   │   │   └── config.js          # /config 单例：GET→find，PUT→update
│   │   ├── middleware/            # 其余端点保持普通 Express router（JSON 直写/流式，不强扭成 service）
│   │   │   ├── pages.js           # 页面路由（/ /inbox /dash /studio + /app /skin-build 静态）
│   │   │   └── media.js           # /api/align/* + /preview + /inbox/:id/thumb.jpg + /jobs/:id/align|log
│   │   │                          #   + /luts /skins /api/status /api/strava/*（含 Range 视频流）
│   │   ├── realtime.js            # queue event 分发：/jobs/:id/progress 原生 WS（协议不变）
│   │   │                          #   + jobs service emit('progress') → socket.io channel 广播
│   │   ├── queue.js  inbox.js     # 领域服务（逻辑不变，补测试）
│   ├── modules/skin-build.js      # 皮肤编译层：esbuild+esbuild-svelte 按需编译 Skin.svelte（内容哈希 buildId）
│   ├── lib/  modules/             # 纯工具与流水线模块（不变，补测试）
├── web/
│   ├── src/                       # Svelte 5 源码
│   │   ├── pages/dash|inbox|studio/{index.html, main.js, App.svelte}
│   │   ├── lib/api.js             # fetch 封装（401 跳登录）
│   │   ├── lib/{format,dash,inbox,studio,lutgl}.js   # 纯逻辑（vitest 直测）
│   │   └── lib/components/        # StatCards/JobsTable/PendingGroup/SeekBar/Thumb 等
│   └── dist/                      # vite 构建产物（server /app/* 静态伺服；缺失时 503 提示构建）
│   （登录页不走 Svelte：auth.js 内联 HTML，豁免路由不依赖构建产物）
├── dashboards/                    # 皮肤：每套一个目录，单个 Skin.svelte + 平铺 woff2
│   ├── _lib/                      # 共享件：frame.svelte.js / fmt.js / Digital.svelte / TrackMap.svelte
│   └── _fonts/                    # OFL 字体库（新皮肤从这里挑字拷贝）
├── test/
│   ├── server/                    # node:test：util/fit/fitlib/probe/compose/inbox/queue/api/auth/skin-build
│   └── web/                       # vitest：三页 model + 组件 + api/format + skin 共享件
└── docs/
    ├── architecture.md            # 本文
    └── principles.md              # 技术原理（FIT/渲染管线/对齐模型/鉴权）
```

关键决策：

- **Svelte MPA 而非 SPA**：三个页面功能独立，无跨页状态；MPA 入口各自打包，
  首屏只带自己的代码，server 路由逐个切换到构建产物。
- **node:test 而非 jest**：Node 22 内置，零依赖；前端组件用 Vitest（与 Vite 同生态）。
- **鉴权用「密码 + httpOnly 签名 cookie」**：单用户场景的最小充分方案；
  SameSite=Strict 天然防 CSRF；session 存 sqlite/内存，重启失效可接受。
- **HTTP 装配层是 FeathersJS v5 + Express**：jobs /api/inbox /api/fits /config 四个领域资源
  service 化（拿 hooks + realtime 红利），其余端点（页面/静态/流式/Strava）保持普通
  Express router，不过度设计。URL 契约不变：custom method 的路径段形态
  （POST /jobs/:id/fit 等）由 app.js 的 customMethodBridge 翻译成 Feathers 的
  `x-service-method` 头。错误统一出口把 FeathersError 转成 `{ error, code }`。
- **socket.io 与原生 WS 共存于同一 http.Server**：upgrade 事件按 path 分发——
  /socket.io/ 归 engine.io，/jobs/:id/progress 归 ws（noServer，CLI 消费，协议不变），
  其余销毁；engine.io 不经过 Express 中间件链，鉴权在 io.engine.use 上单独收口。
- **TDD 节奏**：每个组件/路由先写测试再实现；老行为以「现有页面截图 + e2e 断言」为准。

## 四、迁移顺序（已全部完成）

1. ✅ 脚手架（vite/vitest/svelte）+ 后端 lib 测试先行
2. ✅ 鉴权（auth.js + 内联登录页 + 全路由收口含 WS + 测试；`actpipe passwd <pw>` 开启）
3. ✅ api.js → routes/ 拆分（行为不变，测试守护）
4. ✅ Svelte：dash → inbox → studio（旧 web/*.html 已删除，无过渡残留）
5. ✅ 文档 principles.md
6. ✅ Hono → FeathersJS/Express：routes/ → services/ + middleware/，URL/JSON/状态码零变化
   （前端与 CLI 零改动），测试从 app.request 改为起真实 HTTP 端口
