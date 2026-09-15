# actpipe 技术原理

> 本文解释支撑这个产品的每一项技术背后的「为什么」与「怎么工作」。
> 面向想读懂或改动这套系统的人；架构与目录结构见 [architecture.md](./architecture.md)。

## 1. 问题全景

DJI Action 5 Pro 拍 D-Log M 视频，码表/手表记录 FIT 运动数据。要把两者合成一条
「带仪表盘的数据视频」，需要解决四件事：

1. **数据对齐**——相机和码表是两只独立的钟，谁也对不准谁；
2. **画面调色**——D-Log 是灰片，必须套 LUT 还原；
3. **仪表盘绘制**——把 1Hz 的时间序列画成逐帧透明 PNG，叠进视频；
4. **人机协作**——机器做重的（拷贝/渲染/转码），人做判断（选哪条、对不对齐、好不好看）。

## 2. FIT 文件与数据预处理

### 2.1 FIT 协议

`.fit` 是 Garmin 定义的二进制协议（Flexible and Interoperable Data Transfer）。
码表/手表每秒写一条 `record` 消息：时间戳、GPS（semicircle 坐标，要乘
`180 / 2^31` 换成角度）、心率、功率、踏频、速度、海拔等。我们用
`@garmin/fitsdk` 解码（`src/modules/fit.js` 的 `decodeFit`）。

两个坑：

- **字段可能缺**：功率计断连、GPS 进隧道，记录里就是 null；
- **采样不严格均匀**：标称 1Hz，实际毫秒级抖动。

### 2.2 1Hz 网格重采样（`processRecords`）

渲染每一帧时要回答「t 秒时心率是多少」，所以把原始记录重采样到整秒网格：

- 网格点落在两条原始记录之间 → **线性插值**；
- 某字段连续缺失超过 **10 秒** → 不跨空洞插值，置 null（功率计掉了半小时，
  不能画一条假直线）；
- 网格点前后 10 秒内只有单侧数据 → 沿用最近值（边缘钳制）。

### 2.3 坡度重算与平滑

很多 FIT 没有 `grade` 字段。用 `altitude` 和 `distance` 差分重算：
`grade% = Δaltitude / Δdistance × 100`，窗口 ±3 秒（距离增量 < 2m 时置 0，
防停车时除出噪声）。速度/心率/功率等再做 ±1.5s 的滑动平均（`smooth_window_s`），
否则仪表盘数字跳得太神经质。

## 3. 时间轴对齐模型

这是整个产品最容易做错的部分。

### 3.1 锚定

DJI 文件名内嵌本地开拍时刻（`DJI_20260830085039_0002_D.MP4`），视频流里还有
`creation_time`（UTC）。FIT 的第一条记录是码表开表时刻。于是：

```
offset = (creation_time_utc − fit_start) / 1000
```

视频第 t 秒 ↔ FIT 第 (t + offset) 秒。offset 可以为负（先开相机后开码表）——
片头一段时间没数据，仪表盘延后入场，这是合法场景不是错误。

### 3.2 bias：人对两只钟的最终裁决

两只设备各自有秒级到分钟级的时钟偏差，文件里推不出来。所以提供**人工校准**：
在 studio 页播放视频，看到出发/起步那一帧（开表有 beep 声）暂停，按
「定格 FIT 起点」——这一刻执行 `bias = −autoOffset − currentTime`，语义是
「当前帧就是 FIT 的第 0 秒」。之后逐帧微调（±1/±10 帧），微调带着 FIT 起点走
（`bias -= Δt`）。**没有手工填数字的入口**——人看着画面才知道对不对，
这是刻意的产品决策。

### 3.3 分段录制

相机 ~20GB 切一段（4GB FAT 限制的现代版），一次骑行可能 4 段，而 FIT 只有一条。
判定同组：文件名 seq 相邻 **且** 首尾间隙 < 30s（`Inbox.recordingGroup`）。
合并出片时每段**各自**按自己的开拍时刻锚定（段间断口不累积误差），渲染后
ffmpeg concat 成一条。bias 在同组内传播——同一对设备，偏差相同。

## 4. D-Log 与 LUT

### 4.1 为什么不能全自动

D-Log M 只存在于 **10-bit HEVC** 里（8-bit 一定不是，直接排除）。但 DJI 把
D-Log 和普通色彩都标成 bt709，元数据无区分度——所以策略是「圈定嫌疑范围
（10bit + HEVC），然后问人一次并记住」（`decideLut` + `dlog_memory`，按
相机序列号+分辨率档位记忆）。

### 4.2 3D LUT 与 .cube

LUT 是一个三维查表：把 RGB 输入映射到 RGB 输出。`.cube` 文件里是
`LUT_3D_SIZE n` + n³ 个格点。套用时对非格点颜色做三线性插值。

两处独立实现同一语义：

- **成片**：ffmpeg `lut3d` 滤镜，支持链式 `a.cube+b.cube`（D-Log 还原 → 风格化）；
- **预览**：studio 页用 WebGL2 `sampler3D` 手写了一个 LUT 着色器
  （`web/src/lib/lutgl.js`），把视频帧作为纹理上传、逐帧查表。

### 4.3 色彩标签必须显式打

LUT 输出即 Rec.709 SDR。VideoToolbox 编码器不会把色彩三要素写进 HEVC VUI，
不显式打标签，播放器会按错误色彩空间解释（画面发灰/过饱和）——所以
`hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1`
外加 `-color_primaries/-color_trc/-colorspace bt709`。

## 5. 仪表盘渲染管线

### 5.1 皮肤即 Svelte 组件

每套皮肤是一个目录里的单个 **`Skin.svelte`**：排版、样式、数据绑定都在一个文件里，
`<script module>` 导出 `CANVAS`（设计分辨率），实例导出 `renderFrame(fitSeconds, sample)`
（由 `dashboards/_lib/frame.svelte.js` 的 `createFrame()` 提供）。公共读数/轨迹/格式化
收在 `dashboards/_lib/`（Digital/TrackMap 组件 + fmt.js），六套皮肤复用同一份。

皮肤不是静态资源——server 用 **esbuild + esbuild-svelte 在运行时按需编译**成 IIFE bundle
（`src/modules/skin-build.js`），内容哈希作 buildId：渲染管线与 studio 预览都按 buildId
引用编译产物，改一行 CSS 保存即出新版本，预览闭环仍是秒级。

渲染时用 Playwright 开无头 Chromium，逐帧调 `renderFrame` +
`page.screenshot({ omitBackground: true })` 截出**透明 PNG 序列**（`src/modules/render.js`）。

为什么是 Svelte 而不是手写 HTML + binding DSL：皮肤迭代到后来，每套的 DOM 结构和
动效逻辑差异越来越大，DSL 表达能力成了瓶颈；组件化后排版就是写 Svelte，共享件就是
import，没有第二套 DSL 要维护。为什么仍用浏览器而不是 Canvas API/Skia：皮肤设计本质
是排版工作，CSS 是最强的排版工具，设计迭代成本最低。

### 5.2 合成

ffmpeg `overlay` 滤镜把 PNG 序列叠在（套过 LUT 的）视频上，`start_number`
对齐渲染窗口首帧；负 offset 场景用 `setpts=PTS+delay/TB` 让仪表盘延后入场。

### 5.3 渲染缓存

渲染键 = `sha1(FIT 内容) + hash(皮肤 + _lib) + 分辨率 + overlay_fps`。同一次骑行
换皮肤重渲、或同皮肤重跑，命中缓存直接跳过最贵的逐帧截图。

### 5.4 studio 的舞台：为什么视频在皮肤文档里

一个真坑：透明的仪表盘 iframe 盖在 `<video>` 上，Chrome 的硬件视频层合成会
失败，画面全白。解法是把视频元素**注入皮肤文档的最底层**（`<video id="vsrc">`
+ 隐藏 WebGL canvas `#glc`），同文档内叠放，合成路径就正常了
（`src/modules/skin-build.js` 的 `buildSkinHtml` 按场景注入；纯渲染管线不传
视频时绝不注入 video 层，否则黑底会毁掉透明 PNG）。

## 6. 流水线与状态机

`JobQueue`（`src/server/queue.js`）：`queued → ingesting → probing →
(awaiting_fit) → rendering → encoding → done/failed`。每个步骤完成即落盘
`job.json`，进程重启后从磁盘恢复、已完成步骤跳过（断点续跑）。

刻意**串行**：同时只跑一个任务。SD 卡随机读会掉速，Chromium 多开会爆内存，
ffmpeg 会抢满 CPU——串行在这里是特性。

拷贝用 UUID 分目录 staging，可选 sha1 校验（卡接触不良真能拷坏）。

## 7. 相机检测与人机分界

`chokidar` 监听 `/Volumes`，按相机指纹（DCIM 目录结构）识别。检测到素材后
**不自动处理**：进 inbox，人确认（选哪条、什么皮肤、套不套 LUT、哪条 FIT）后
才入队。默认只 probe 不拷贝（`inbox_copy_on_detect=false`），确认后才占磁盘；
队列里依赖卡上文件的任务全部拷完后，发系统通知「可以卸载 SD 卡了」
（卡依赖计数从 >0 掉到 0 的瞬间）。

通知走 `terminal-notifier`（支持点击打开 URL/文件），没有就回退 osascript。

## 8. Strava 集成

FIT 从 Strava 导：OAuth 授权码流程（`client_id/secret` 存本地配置，
token 自动刷新），拉活动 streams（time/latlng/watts/heartrate…）**合成**成标准
FIT 文件入库。触发点是插卡（不轮询）——插卡时活动一般刚好同步到 Strava。

## 9. 鉴权

单用户场景的最小充分方案（`src/server/auth.js`）：

- 密码只存 **scrypt 哈希**（随机盐，永不落明文）；
- 会话令牌 = `base64url(exp).hmac(secret)`，无状态；secret 存数据目录 0600；
- cookie `HttpOnly + SameSite=Strict`：JS 读不到（防 XSS 窃取），跨站不携带
  （天然防 CSRF，不需要 CSRF token）；
- 本机 CLI 用数据目录里的 `cli-token`（0600）走 `X-Actpipe-Token` 头直通，
  不打扰终端体验；
- 未设密码 = 鉴权关闭（本地默认体验）；`actpipe passwd <pw>` 开启。

**所有路由**（页面、API、静态资源、WS upgrade）都过同一个中间件——映射到
公网时没有漏网的入口。

## 10. 前端工程

- **Svelte 5 MPA**（不是 SPA）：dash/inbox/studio 三个页面功能完全独立，无跨页
  状态；各自打包，首屏只带自己的代码（`vite.config.js` 多入口，产物在
  `web/dist`，server 以 `/app/` 前缀伺服）。
- **TDD**：领域逻辑全部抽成纯函数（`web/src/lib/*.js`）用 Vitest 测；
  组件用 `@testing-library/svelte` 测渲染与交互。后端用 Node 内置
  `node:test`（零新依赖），fixture 由 `fixtures/make-fixtures.mjs` 生成。
