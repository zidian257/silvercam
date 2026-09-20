# actpipe — Action 5 Pro + FIT 仪表盘自动叠加流水线

相机一插电脑，素材自动拷贝到本机磁盘并 probe；在 **inbox 确认页**选好要处理的片段（套不套 LUT、用哪套皮肤）后，
自动完成「选 .fit → 仪表盘叠加 → 出片 → 系统通知」。
常驻 server（Node 22 + FeathersJS/Express + socket.io + ws，pm2 托管）+ 瘦 CLI（bun 编译单文件）+ ffmpeg 合成。

待办清单见 [TODO.md](TODO.md)（有新待办就追加一条）。

## 安装

```bash
brew install node@22 ffmpeg bun terminal-notifier   # terminal-notifier 让通知可点击（缺它则回退 osascript，无点击动作）
./scripts/setup.sh        # npm 依赖 + Playwright chromium + 编译 CLI（./actpipe）
```

## 部署（常驻 + 登录自启）

```bash
pm2 start ecosystem.config.cjs          # 已在跑的实例用 pm2 restart actpipe
pm2 save
# 登录自启（pm2 会打印一条 sudo 命令，复制执行即可）：
sudo env PATH=$PATH:/opt/homebrew/opt/node@22/bin \
  $(which pm2) startup launchd -u "$USER" --hp "$HOME"
```

server 监听 `127.0.0.1:18787`（代码默认 8787，本机经 config.json 的 `port` 字段改为 18787），日志在 `~/Library/Logs/actpipe/`。
调试期前台跑：`node --experimental-strip-types bin/actpipe.ts watch`。

## 鉴权（映射公网前必开）

默认无密码（本机回环使用零摩擦）。要把站点映射到公网，先设密码：

```bash
actpipe passwd '<你的密码>'     # 开启：全站（页面/API/静态资源/WS）都需要登录
actpipe passwd --off            # 关闭，回到无密码模式
```

开启后所有路由先过鉴权中间件，未登录访问页面跳登录页、API 返回 401（前端自动跳登录）。
登录态是无状态 HMAC 签名令牌，经 HttpOnly + SameSite=Lax 的 cookie 下发（30 天有效；签名密钥落盘数据目录 0600，server 重启不失效）。
Lax 而非 Strict 的原因：Strava OAuth 回跳是跨站顶级 GET 跳转，Strict 下回跳请求不带 cookie 会直接 401。本机 CLI 用数据目录里的 cli-token 走 `X-Actpipe-Token` 头直通，不打扰终端体验。

### 公网映射（cloudflared）

拓扑：Cloudflare 边缘 TLS 终止 → cloudflared named tunnel（pm2 常驻）→ `http://127.0.0.1:18787`。
server 已 `trust proxy`，X-Forwarded-Proto 透传后 Strava OAuth 的 redirect_uri 才能拼出 https。

上线前清单：

1. `actpipe passwd '<密码>'`——鉴权是全站唯一闸门，不设密码等于裸奔；
2. named tunnel 把域名指到 `http://127.0.0.1:18787`（`cloudflared tunnel route dns <tunnel> <域名>`）；
3. Strava 应用的 Authorization Callback Domain 只填域名即可——回跳全路径 `https://<域名>/api/strava/callback` 由 server 动态拼，不用写进配置。

## 日常使用

插上相机（USB 文件传输模式或读卡器）→ 自动检测 `DCIM/DJI 001` → **读取素材信息（默认不拷贝，不占磁盘）** →
弹出通知，**点击通知直接打开确认页**（或手动开 http://127.0.0.1:18787/inbox 、`actpipe inbox --open`）→ 勾选要处理的片段，
逐条或批量指定皮肤 / LUT（自动=按 D-Log 策略，`none`=不套）→「开始处理所选」后才从卡复制并进入自动队列：
选 FIT（`fit_autopick: newest_in_dir` 可免弹窗）→ 渲染 → 编码 → 通知，点击通知在 Finder 定位成片。
注意确认前卡要保持插入（界面会实时标出「在卡上 / 卡已拔出」）；想插卡即拷盘可把 `inbox_copy_on_detect` 设为 `true`。
每条素材用拍摄时间当标题（`DJI_20250809165324_0019_D.MP4` →「8月9日 周六 下午4:53」，序号 #19；时间来源优先级：文件名 > 视频 creation_time > 文件修改时间），
标题下一行小字是分辨率/帧率/编码/码率/音频等技术参数（ffprobe 收集，含色彩信息与厂商 tag，hover 看全量；旧数据缺新字段自动省略），
旁边附 ffmpeg 抽 4 帧拼出的胶片条预览（缓存到 `~/.config/actpipe/thumbs/`，点击可放大；卡拔出时显示「预览不可用」）。
每条素材还要选 FIT：下拉列出 `fit_library_dir` 库里的 .fit（带起止时间），按素材拍摄时间窗与 FIT 活动窗口的重叠自动预选（重叠最大者），无重叠默认「无 FIT（仅拷贝）」；
库本身在 **/fits 页**集中管理：轨迹缩略图卡片流、上传、Strava 同步入口都在那里。
选了 FIT 可点「预览」看一帧真实叠加效果（POST /preview，全局串行防并发）。commit 时选「无 FIT」的条目走纯拷贝：ingest 后直接复制到 `<output_dir>/<日期>/raw/原名.MP4`，不进 fit/render/compose。
跳过的片段不入队，在 inbox 列表里可移除（Alt+点击连 staging 副本一起删）。
输出：`~/Movies/DashCam/<日期>/原名_皮肤_dash.mp4`。

```bash
actpipe inbox                                   # 终端看待确认素材；--open 打开确认页
actpipe run --video DJI_0001.MP4 --fit ride.fit          # 手动建任务（WS 实时进度）
actpipe run --video DJI_0001.MP4 --fit ride.fit --offset -3.5   # 手填时间偏移
actpipe preview --video x.MP4 --fit y.fit -t 1:23        # 单帧合成预览（调样式/校准 offset）
actpipe status / actpipe logs <job_id> / actpipe luts
actpipe config --set dlog_policy always_lut              # 改全局配置
```

## 皮肤自定义

皮肤 = 一个目录（`~/.config/actpipe/dashboards/<名字>/`）里放一个 **`Skin.svelte` 单文件**（排版 + 样式 + 数据绑定一体）
+ 平铺的 woff2 字体。改文件 → `actpipe preview -t ...` 看效果 → 再改，秒级闭环
（server 用 esbuild 运行时按需编译皮肤，内容哈希做缓存键，保存即出新版本）。多场景 = 多建皮肤目录，`--skin` 切换。
皮肤契约：`<script module>` 导出 `CANVAS = { width, height, opacity }`（设计分辨率，渲染按它等比缩放）；
实例脚本导出 `renderFrame(t, sample)`——用 `dashboards/_lib/frame.svelte.ts` 的 `createFrame()` 一行搞定，
数据由驱动注入 `window.ACTPIPE`；绑定字段在整段 FIT 缺失时元素自动隐藏。
共享件在 `dashboards/_lib/`：`Digital.svelte`（数字读数组件：值/标签/单位/zone 色条/缺失隐藏/定宽零 CLS）、
`TrackMap.svelte`（SVG 轨迹图组件：全程/已骑渐变描边/游标光晕，半径经 `markR/haloR/dotR` 定制）、
`fmt.ts`（单位换算/zone 配色/数值格式化/轨迹投影）、`frame.svelte.ts`（帧驱动）。

内置六套预设（inbox 确认页 / studio 调试页可直接切换预览），全部为**平面设计/海报风**的浮空排版：
零背景色块、零面板（不压视频光感），所有元素收在安全边距内不出界，占地克制不挡主体。
设计工具箱只有五件：**字体**（Anton / Barlow Condensed 900 斜体 / Space Grotesk，woff2 平铺在皮肤目录）、
**字体颜色**（每套一个荧光 accent 上字）、**区块排布**、**圆环仪表盘**、**divider 与 label/文案**（细分隔线、斜杠）。
可读性靠多层 text-shadow/drop-shadow 叠加；轨迹图一律无背景悬浮；字段在整段 FIT 缺失时该读数自动隐藏、布局自然塌缩；
数值容器定宽锚定，数据变化零 CLS。品牌/标语类文案统一用「DJI ACTION 5 PRO」。
其中 dashline（底）/ topline（顶）/ ledge（左）是「数据贴一边」的三个方向：
- **apex**：volt 荧光黄 #D8FF00——左下 Anton 大速度（zone 色上字）+ 右侧版权页式窄栏纵列，地图右上
- **trace**：荧光青 #64D2FF——TRACE 字标 + DJI ACTION 5 PRO 刊头，左下青色巨号距离，右上小面积悬浮轨迹
- **dashline**：荧光绿 #39FF14——底部 masthead 横排（topline 的底部镜像），荧光绿斜杠分隔 + 「DJI ACTION 5 PRO」铭牌
- **virb_like**：荧光品红 #FF2E88——左下角堆叠组合，Barlow 900 斜体品红 hero，细白线节奏，地图右上
- **topline**：荧光橙 #FF9F0A——顶部 masthead 横排，橙色斜杠分隔，「DJI ACTION 5 PRO」铭牌
- **ledge**：荧光电蓝 #00E5FF——左侧书脊纵列，竖排标签 + 贯穿全高电蓝规则线，地图右上

字体文件统一放在 `dashboards/_fonts/`（Anton、Archivo Black、Barlow Condensed 正/斜体各字重、Space Grotesk，
均为 Google Fonts OFL 授权的 latin 子集）；新皮肤从这里挑字拷贝（平铺、不要子目录），@font-face 相对路径引用，
**不要写 `font-display:swap`**（逐帧渲染会闪）。

### studio 对齐工作台（深链进入，不在导航）

从 dash 任务行或 inbox 素材组的「对齐」按钮深链进入（带 `?job=` / `?inbox=` 参数，无独立入口）：
- 舞台 = 皮肤 iframe：视频层注入皮肤文档最底层与仪表盘同文档叠放（透明 iframe 盖 `<video>` 会白屏），WebGL 逐帧套 LUT 实时预览；
- 播放（带声音——码表开表 beep 是对齐的重要听觉线索）/逐帧步进（←/→，Shift=±10 帧）/SeekBar 拖动，高亮区段 = 当前对齐下有 FIT 数据；
- 段 / FIT / 皮肤 / LUT 四个下拉实时切换对比，多段录制可跨段跳锚点；
- 校准只做一件事：播到出发/起步那一帧暂停 →「定格 FIT 起点」（语义 = 当前帧即 FIT 第 0 秒）→ 逐帧微调带着起点一起走。没有手填数字的入口——人看着画面才知道对不对；
- 无视频源时舞台以内置样图兜底，照样能调皮肤样式。

### dash 总控台（全部功能与任务状态）

**http://127.0.0.1:18787/dash**：概览卡片（待确认/队列/完成/失败/卷监听/运行时长）+
任务表（实时进度条、展开日志、失败重试、awaiting_fit 补 FIT、已完成任务一键快剪）+ inbox 待确认 +
皮肤/LUT 清单 + Strava 面板（填 client_id/secret、OAuth 连接、手动同步）+ LLM 面板（快剪 BYOK：provider 动态表单 + 免保存直测）+ 只读配置。
四个页面各管一段：/inbox 素材确认 · /fits FIT 库 · /dash 总控台 · /studio 对齐工作台（深链进入，不进导航）。

### 快剪（30s 叙事短片）

对已出片任务一键剪 ~30s 短片：事件从数据里长出来（片头片尾/显著停顿/最长巡航/极速/功率峰/GPS 折返……不套死模板），L0 六槽兜底直接可出片；
默认再经 L1——内嵌 pi agent（BYOK，默认本机 LM Studio，可换 DeepSeek 等云端）按 `skills/quickcut/SKILL.md` 导演圈幕，工具只有 ffmpeg + commit_cuts（物理校验护栏），任何一环失败一律回退 L0。
dash 任务行发起（任务带「快剪」标记/pill），全程日志可查；inbox commit 也可勾选「出片后自动快剪」（全局默认 `quickcut_auto: true`）；CLI：`actpipe quickcut analyze|render <job_id>`。完整设计见 requirements.md「快剪」节。

## 模块独立调试（不起 server）

每段产物落盘在 `jobs/<id>/`，可肉眼检查、可单独重放：

```bash
node --experimental-strip-types bin/actpipe.ts probe <file>                  # ffprobe + D-Log 三态判定 -> probe.json
node --experimental-strip-types bin/actpipe.ts ingest <src> [--checksum]     # staging 拷贝 + 校验 -> ingest.json
node --experimental-strip-types bin/actpipe.ts fit dump <x.fit>              # FIT 解析/重采样摘要
node --experimental-strip-types bin/actpipe.ts fit align --fit x --video y   # creation_time 锚定 offset 计算
node --experimental-strip-types bin/actpipe.ts render --fit x --fps 10       # 只跑渲染段 -> frames/%05d.png
node --experimental-strip-types bin/actpipe.ts compose <job_dir>             # 只跑合成段（用 job_dir 内产物）
node --experimental-strip-types bin/actpipe.ts watch --simulate <dir>        # 注入假挂载事件
```

编译版 `./actpipe` 是纯 HTTP/WS 瘦客户端；模块调试入口需用源码 + Node 跑（Playwright 仅支持 Node）。

## 配置（`~/.config/actpipe/config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `8787` | server 监听端口（仅 127.0.0.1）；本机部署改为 18787 |
| `dlog_policy` | `ask` | `always_lut` / `never_lut` / `ask`（10-bit HEVC 弹原生确认，按档位记忆） |
| `default_lut` | `dlogm_rec709` | LUT 名（`luts/` 目录或 `luts` 映射），支持多预设；`luts` 映射值可写链式 `"a+b"`（依次套用，如 `dlogm_rec709+grading_mei` = 先 D-Log M 还原再叠大师滤镜），inbox/studio 下拉与 `/preview` 同样接受链式名 |
| `global_bias_seconds` | `0` | 读数系统性偏早/偏晚时的常数兜底 |
| `audio_volume` | `1.0` | 成片音量倍率（0 = 静音；=1 时音频直通 `-c:a copy` 不重编码，其余值 `-af volume` + aac 192k）；inbox 可按录制覆盖 |
| `quickcut_auto` | `true` | 出片后自动建快剪记录（无 FIT 纯拷贝不触发，完成有系统通知）；inbox 可按录制覆盖 |
| `fit_autopick` | `ask` | `newest_in_dir` 时从 `fit_dirs` 取最新 .fit 免弹窗 |
| `fit_library_dir` | `~/.config/actpipe/fits` | inbox 的 FIT 下拉库目录；扫描带缓存，按时间重叠给每条素材自动预选；下拉里的「载入 .fit 文件…」即上传进此目录（`POST /api/fits`），解析失败不入库 |
| `raw_subdir` | `raw` | 无 FIT 纯拷贝的输出子目录（`<output_dir>/<日期>/raw/原名.MP4`，不转码） |
| `fit_watch_dir` | null | 配置后新 .fit 到即后台预生成渲染缓存（`pregen.fps`/`pregen.resolutions`） |
| `overlay_fps` | `10` | 仪表盘帧率（数据 1 Hz，10 只为秒间插值平滑；求快用 2–5） |
| `staging_retention` | `keep` | `delete_on_success` 出片后清暂存 |
| `delete_from_card_after_success` | `false` | 高危开关，默认绝不动卡上文件 |
| `encoder` / `bitrate` | `hevc_videotoolbox` / `45M` | VideoToolbox 硬编；`-q:v` 系质量参数 VT 不支持，用码率控 |
| `volume_whitelist` | `[]` | 卷名/UUID 白名单，空 = 任何带相机指纹的卷 |
| `inbox_copy_on_detect` | `false` | `true` = 检到素材立即拷到 staging；`false` = 只 probe，确认后才拷贝 |
| `strava.*` | 未配置 | dash「Strava」面板填 client_id/secret（strava.com/settings/api 免费建应用），token 落盘自动刷新；`auto_sync` = 插卡自动同步，`sync_days` = 同步窗口天数 |
| `llm` | `null` | 快剪 L1 的 BYOK 配置（provider/model/api_key/base_url，dash「LLM」面板填）；null = 自动探测本机 LM Studio，不可达则回退 L0 兜底 |

## 实现要点（与方案对应）

- **触发**：chokidar 盯 `/Volumes`（FSEvents 推送，零轮询）+ `diskutil info -plist` 取证 + 大小稳定检查 + SQLite 去重（`node:sqlite`，无原生依赖）。
- **人工确认（inbox）**：检到素材先入 `inbox.json` 待确认列表并 probe（默认直接在卡上读元信息、不落盘；`inbox_copy_on_detect: true` 则立即串行拷贝到 staging）；`/inbox` 页面勾选片段、逐条指定皮肤/LUT，commit 后才建 job。job 以 `origin`（卡上原始路径）记账，去重指纹和「出片后删卡」都按原始来源算，重启后待确认列表仍在。
- **对齐**：`creation_time`(UTC) 锚定 FIT 时间轴 + 文件名本地时间双锚点交叉校验（差 >10s 告警）+ 范围校验失败转 `awaiting_fit` 等手填 offset。
- **渲染**：Playwright headless Chromium 逐帧截图（多标签页并行、断点续渲），PNG 帧号锚定 FIT 绝对时间轴；缓存键 = `hash(FIT)+hash(皮肤)+分辨率+overlay_fps`，同场活动多段素材共用。
- **合成**：`lut3d（可链式叠加）→ fps 补帧 → overlay`；hevc 时追加 `-bsf:v hevc_metadata`——VideoToolbox 不把 `-color_*` 写进 HEVC VUI，不显式打 bt709 播放器会偏色。
- **状态机**：`queued→ingesting→probing→awaiting_fit→rendering→encoding→done/failed`，job 落盘、重启续跑、已完成步骤自动跳过。commit 决策 `fit: 'none'` 的走纯拷贝分支：`ingesting→copying→done`，跳过 probe/fit/render/compose。

## 验证素材

`npm run fixtures` 生成合成 FIT（10 分钟骑行）+ 合成视频（creation_time 与文件名互证）+
identity LUT + 假相机卷到 `fixtures/out/`，供无相机/无码表时调试全链路。

## 开发

```bash
npm test              # 后端：node:test（test/server/，156 例）
npx vitest run        # 前端：vitest（test/web/，149 例）
npm run build:web     # Svelte 四页构建到 web/dist/（server 挂 /app/* 伺服）
```

前端是 Svelte 5 + Vite MPA：`web/src/pages/{dash,inbox,studio,fits}/` 各自一个入口，
共享逻辑在 `web/src/lib/`（纯函数）与 `web/src/lib/components/`（组件）。
架构决策与目录约定见 `docs/architecture.md`，技术原理见 `docs/principles.md`。
