# Action 5 Pro + FIT 仪表盘自动叠加流水线 · 技术方案

> 平台：macOS ｜ 形态：常驻 server + 轻量 client ｜ 核心渲染：ffmpeg
> 目标：相机一插电脑，自动完成「D-Log M 套 LUT → 选 .fit → 仪表盘叠加 → 出片 → 系统通知」。

---

## 1. 总体架构

```
┌────────────── macOS ──────────────────────────────────────────┐
│                                                               │
│  pm2 常驻（pm2 startup → launchd 登录自启）                     │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  server (Node.js 22 LTS, Hono + ws)                  │     │
│  │                                                      │     │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │     │
│  │  │ Watcher  │─▶│ JobQueue │─▶│ Pipeline Worker   │  │     │
│  │  │(卷挂载监听)│  │(串行队列) │  │  · ffprobe 探测    │  │     │
│  │  └──────────┘  └──────────┘  │  · FIT 解析/对齐   │  │     │
│  │        │                     │  · 仪表盘帧渲染     │  │     │
│  │        ▼                     │  · ffmpeg 合成     │  │     │
│  │  原生文件选择对话框            └────────┬──────────┘  │     │
│  │  (osascript choose file)              │              │     │
│  │  macOS 通知 (osascript/terminal-notifier)│           │     │
│  └───────────────────────────────────────┼─────────────┘     │
│                                          │ HTTP / WebSocket  │
│  ┌───────────────────────────────────────┴─────────────┐     │
│  │  client：CLI 单文件二进制                            │     │
│  │  (run / status / preview / calibrate / logs)         │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                               │
│  ffmpeg (subprocess)  ◀── 预渲染仪表盘 PNG 序列                  │
└───────────────────────────────────────────────────────────────┘
```

**职责划分**
- **server**：唯一的"大脑"。监听卷挂载、管理任务队列、弹原生对话框、调度 ffmpeg、推送进度、发系统通知。由 pm2 托管常驻，登录自启（§9）。技术栈 **Node.js 22 LTS**，**全站 TypeScript**（server/CLI/web/皮肤共享件全量 .ts，见 §10）；Node 22 `--experimental-strip-types` 直接运行 .ts，无构建步骤。Bun 的职责仅两项：开发期装包/脚本加速、把 CLI 编译成单文件二进制（§9）；**渲染 worker 固定跑在 Node 上**——Playwright 官方仅支持 Node，Bun 运行时兼容属"能用但无保证"，产能核心不求新。
- **client**：无状态瘦客户端（CLI 单文件二进制），通过 HTTP/WebSocket 与 server 通信。仪表盘自定义**不做 GUI 编辑器**——直接改皮肤文件（HTML/CSS/binding.json）+ `/preview` 预览闭环，见 §5。
- **ffmpeg**：只做一件事——读原始视频 + 读预渲染的仪表盘 PNG 序列 → 滤镜合成 → 编码。所有"绘制"都在浏览器侧（HTML/CSS）完成，不碰 drawtext/drawbox 那套难维护的原生滤镜。

**为什么这样拆**
- 仪表盘绘制（圆表、地图、字体、透明度）用 ffmpeg 原生滤镜做是灾难，用 HTML/CSS 做是享受（布局引擎、字体排版、全套样式能力白送）；ffmpeg 退化为纯合成器，稳定、快、可换参数。
- server/client 分离让"触发"和"控制"解耦：以后想加菜单栏 App、Web 编辑器、远程触发，都不用动流水线核心。

### 1.5 模块划分（解耦与可调试性）

两条纪律：**模块间只通过落盘的 JSON/文件产物通信**（不互调内部 API，每段产物可肉眼检查、可单独重放）；**每个模块有独立 CLI 入口**（调哪个跑哪个，不必拉起整条流水线）。server 只是编排器 + 状态机，不含业务逻辑。

| 模块 | 职责 | 输入 → 产物（契约） | 独立调试入口 |
|---|---|---|---|
| `watch` | 卷监听、相机指纹、防抖去重 | 挂载事件 → `media_found` 事件（卷路径 + 文件清单） | `actpipe watch`（可 `--simulate` 注入假事件） |
| `ingest` | staging 拷贝 + 校验 | 卷上文件 → `staging/` 本地文件 + `ingest.json`（大小/mtime/校验结果） | `actpipe ingest <src>` |
| `probe` | ffprobe 探测 + D-Log 三态判定 | 本地视频 → `probe.json`（分辨率/帧率/时长/creation_time/色彩元数据/LUT 决策） | `actpipe probe <file>` |
| `fit` | FIT 解析、重采样平滑、坡度重算、creation_time 锚定 + 范围校验 | .fit + probe.json → `samples.json`（1 Hz 时间轴）+ `session.json`（活动时间范围、offset、可用字段清单） | `actpipe fit dump <x.fit>` |
| `render` | 皮肤 + samples → PNG 序列；缓存与 FIT 目录预生成 | 皮肤目录 + samples.json + 分辨率 → `frames/%05d.png` + `cache_index.json` | `actpipe render --fit x --skin y` |
| `compose` | ffmpeg 命令组装、执行、`-progress` 解析 | 视频 + frames + LUT 决策 → 成片 mp4 + 进度事件流 | `actpipe compose <job_dir>` |
| `interact` | osascript 对话框、系统通知（薄平台适配层，可 mock） | 事件 → 用户交互结果 | 单元测试直接 mock |

**一个任务 = 一个 `jobs/<id>/` 目录**：上述每段产物都落在里面（`ingest.json` → `probe.json` → `session.json`/`samples.json` → `frames/` → 成片），外加 `job.json` 记录状态机位置与全部参数快照。调试任何一段 = 拿上一段的产物文件喂给对应 CLI；任何一段失败 = 从该段重跑，不重做上游。模块各自的单测只对自己的产物契约负责，改皮肤渲染逻辑不会碰触发器，改 ffmpeg 参数不会碰 FIT 解析。

---

## 2. 触发链路（插入相机 → 任务创建）

### 2.1 连接方式前提（已查证 DJI 官方文档，2026-09）
- **USB 直连**：数据线连接后，相机屏幕弹"文件传输"选项窗，**手动选"文件传输：USB"**；不弹时去相机「系统设置 > U盘模式」再连。**macOS 首次连接必弹"允许配件连接"，需点允许**——即首次使用有两次人工操作（相机选模式 + Mac 允许配件），之后才是纯自动。线材必须支持数据传输（社区有充电线不传数据的报告）。挂载后出现相机卷，目录为 `DCIM/DJI 001`。挂载耗时无官方数据，实施首日实测。
- **UHS-II 读卡器**：速度快 3–5 倍，触发逻辑完全一样（同为卷挂载事件），仍是日常推荐。注意 DJI 官方提示"部分读卡器可能使 SD 卡文件属性变化导致设备无法识别，建议优先数据线"——如遇相机端识别异常，换数据线或换读卡器排查。

### 2.2 挂载检测
Node 栈下没有 DiskArbitration 的官方绑定（pyobjc 为 Python 独占），改用**推送式、零轮询**的等价组合：

| 方案 | 说明 | 取舍 |
|---|---|---|
| **chokidar 盯 `/Volumes`** | 底层即 macOS **FSEvents** 内核推送（Spotlight/Time Machine 同款），idle CPU 0%，`depth: 0` 只盯卷的增删 | 主用 |
| **`diskutil info -plist <卷>`** | 挂载触发后调用，补取卷 UUID / 协议 / 文件系统类型等指纹信息（替代 DADisk 对象） | 配套取证 |
| NSWorkspace 通知 | 需要 ObjC 桥（NodObjC 已荒废），不引入 | 弃用 |

实现注意：FSEvents 回调内只做"事件入队"，防抖与探测交给异步 worker；事件可能合并/重发，以"当前实际挂载的卷列表"为准做幂等处理。

判定"这是运动相机"的指纹：卷内存在 `DCIM/DJI 001`（DJI 官方文档口径），且含 `DJI_????.MP4` 文件。可配白名单（卷名/UUID），避免插个 U 盘也触发。

### 2.3 防抖与去重
- 挂载后等 1–2 s 再枚举文件（拷贝可能仍在进行）；
- 对每个文件检查"大小稳定"（连续两次 stat 间隔 1 s 不变）再入队；如需精细感知"拷贝进行中"，用同一个 chokidar 加深 `depth` 盯卷内目录即可；
- 已处理文件记入本地 SQLite（按 文件路径+大小+mtime 或相机内文件序号），重复插拔不重复出片。

### 2.4 素材落地：默认先拷本地暂存，再进流水线

管线对卡的访问是**只读**（顺序读 15 MB/s 量级，直读也能跑），但默认仍走 staging：

- **拷贝**：入队文件先 `fs.copyFile` 到 `staging/` 目录，校验大小/mtime 一致即算完成（可选 checksum）；拷完相机/读卡器即可拔，后续探测、试渲染、重跑全走本地 NVMe；
- **收益**：作业中途断线/弹卷不炸任务；重跑与换皮肤再出片无需相机在场；读卡器下 10 GB 约 35 s；
- **暂存生命周期**：出片成功后按配置 `staging_retention: keep | delete_on_success` 处理；**卡上原始文件默认绝不动**，`delete_from_card_after_success` 为默认关闭的高危开关；
- **例外**：小 clip 快速验证可用 `actpipe run --direct` 直读卡跳过拷贝。

---

## 3. 素材探测与 D-Log M 判定

用 `ffprobe -v quiet -print_format json -show_streams -show_format` 拿到：
- 分辨率、帧率、时长、码率、编码（H.264/HEVC）、位深（8/10 bit）
- 色彩元数据：`color_space / color_primaries / color_trc`
- 拍摄时间：`format.tags.creation_time`（后面 FIT 对齐要用）

**D-Log M 判定的现实情况**：DJI 不会在容器里写"D-Log M"这个字符串，元数据探测只能得到间接信号（10-bit HEVC + 色彩字段 unspecified/非常规 是典型特征，但不可靠）。所以采用**三态策略**：

1. `config` 里设置默认策略：`always_lut | never_lut | ask`
2. `ask`（默认）：检测到 10-bit 素材时弹一个原生确认对话框（列出文件名 + 探测到的元数据），用户一键确认；
3. 用户确认结果按"相机序列号 + 分辨率/帧率档位"记忆，下次同档位免问。

LUT 文件：默认指向 DJI 官方 **D-Log M to Rec.709** 的 `.cube`，路径可配，支持多 LUT 预设（如"电影感""高饱和"），client 一条命令切换。**只套一次 LUT，且仪表盘在 LUT 之后叠加**（见 §6 滤镜链），保证仪表盘颜色不受 LUT 影响。

---

## 4. FIT 解析与时间对齐

> 设计前提：**Action 5 Pro 无内置 GPS**（DJI 官方补位是 GPS 蓝牙遥控器配件 + Mimo App 贴图，样式不可定制），机身也无授时能力。因此 FIT 文件是唯一数据源（何况心率/功率/踏频本就只存在于 FIT），而相机时钟唯一可信来源是 Mimo 对时——这决定了 §4.2 的锚定策略。

### 4.1 解析
用 Garmin 官方 FIT SDK 的 JS 版（`@garmin/fitsdk`，或 `fit-file-parser`）解析 `.fit`，提取 `record` 消息流：

| 字段 | 用途 |
|---|---|
| `timestamp` | 时间轴基准 |
| `position_lat/long`（半圆度→度） | 地图轨迹、里程 |
| `speed`（m/s） | 速度表 |
| `altitude` | 高度表、爬升 |
| `heart_rate` / `cadence` / `power` | 圆表/数字表 |
| `grade`（可由 altitude+distance 重算）、`temperature` | 坡度、温度 |

预处理：缺值插值、按 1 Hz 重采样、可配置滑动窗口平滑（默认 3 s，避免指针抖动）。

### 4.2 时间对齐：creation_time 锚定（一次性标定后全自动）

**为什么没有"通用自动方案"**：MP4 没有逐帧绝对时间戳，只有拍摄起始时刻（`creation_time`）；FIT 时间戳来自 GPS 授时。两个独立时钟之间不存在任何内嵌同步信号，业界工具（VIRB Edit / DashWare / Telemetry Overlay）清一色靠"手动拖时间轴校准"。本方案用下面的组合把校准成本压到一次性。

**前提（用户习惯，不进流程）**：开拍前连一下 Mimo App——蓝牙连接会把手机时间（NTP 校准）同步给相机，当天误差 1–2 s，对 1 Hz 仪表盘数据完全够用。

**流水线内的三步**：

1. **锚定（自动）**：`creation_time` 映射到 FIT 时间轴上最近的 record，得初始 offset。语义已查证：Action 5 Pro 按 QuickTime 规范写**规范 UTC**，且为**录制开始时刻**（与文件名内嵌的本地开拍时刻互证，误差 1 秒内）。**双锚点交叉校验**：`creation_time(UTC)` 与 `文件名 DJI_YYYYMMDDHHMMSS（本地）+ 系统时区` 换算结果相差超过几秒，说明相机未对时或固件行为变化，主动告警（比 FIT 范围校验更早暴露）；
2. **常数兜底（配置项，默认 0，通常永远不用动）**：`config.global_bias_seconds`。若 `/preview` 目检发现读数系统性偏早/偏晚（比如恒定差 2 秒），手动填一个常数即可——无需专门的标定素材或标定命令；
3. **范围校验兜底（自动）**：若锚定结果落在 FIT 活动时间范围之外（说明相机久未对时），不闷头出片，弹通知让用户在 client 里手填 `offset_seconds`。

**可选增强**：同场活动多段素材的偏移近似恒定（两时钟短期漂移极小），可只标定首段、其余按 creation_time 差值推算；手填 offset 时用 `/preview` 在不同时刻截图目检读数，即为校准的舒适版。

**精度预期**：±0.5 s 内对速度/心率读数无感；地图位置点与实景地标的对应微调两轮可压到 1 s 内。

每个任务最终落盘一份 `job.json`（含 offset、LUT、布局配置快照），保证可复现、可重跑。

---

## 5. 仪表盘渲染引擎（自定义能力核心）

### 5.1 技术选型：Chromium (HTML/CSS) 主后端 + 预渲染 PNG 序列

渲染后端做成可插拔，主后端是 **headless Chromium（Playwright 驱动）**：仪表盘就是一个本地 HTML 页面，Playwright 逐帧 `page.evaluate(renderFrame(t))` 注入时刻 → `page.screenshot(omitBackground=True)` 截透明 PNG，**全部预渲染成 PNG 序列落盘**，再交给 ffmpeg（见 §6.1）。预渲染把渲染速度与编码速度解耦，Chromium 每帧 80–200 ms 的开销不再构成瓶颈（可并行、可续渲，见 §6.1）。

选 HTML/CSS 而非 canvas/手绘的理由：
- **布局引擎白送**：flexbox/grid 直接承载"布局自定义"，表达力远超手写锚点坐标；
- **样式表达力**：圆角、渐变、阴影、描边、字重都是一行 CSS；
- **字体渲染质量**：Chromium 排版显著优于程序化绘制；
- **预览即渲染面**：`/preview` 预览与正式渲染是同一份 HTML/CSS、同一条代码路径，所见即所得零偏差，不维护两套渲染逻辑。

两条必须遵守的纪律：
1. **帧推进显式化**：页面暴露纯函数 `window.renderFrame(t, sample)`，禁止依赖墙钟/CSS animation 自走，保证帧间可复现、可并行、可续渲；
2. **backdrop-filter 不可用**（透明截图下没有"背景"可模糊），毛玻璃底衬用半透明纯色替代，确需模糊时在 ffmpeg 侧 `gblur`+`overlay` 复合。

可选轻量后端：**node-canvas / sharp**（接口相同，直接输出 PNG buffer），适合无 Chromium 环境或极端求快场景；默认只做 Chromium，配置里留 `renderer: chromium | canvas`。

### 5.2 Widget（仪表盘元素）体系

术语约定：**一个元素 = 一种显示形式（渲染器）+ 绑定一个数据字段**；一套皮肤（dashboard）摆 N 个元素。渲染器可复用——心率、功率、踏频用的是同一个 `digital` 渲染器的三个实例。

每个元素是一个 Web Component（或约定俗成的 div + 绑定声明），统一契约：由 `renderFrame(t, sample)` 驱动，按绑定字段更新自身。`sample` 是当前时刻（已按 offset 对齐、可含秒间插值）的数据点。**缺数据自动隐藏**：元素在绑定中声明依赖字段，该字段在整段 FIT 中缺失（如没带心率带、无 GPS）则不渲染，不打"--"。

渲染器清单（计划内仅两个）：

| 渲染器 | 说明 |
|---|---|
| `digital` | 大号数字读数（值 + 单位 + 标签） |
| `map` | GPS 轨迹图（见 5.4） |

**不为其它显示形式（圆环表、海拔曲线、条形等）做任何内置计划**：皮肤是开放的 HTML/JS，想要新形式时在皮肤目录里自行编写组件即可，流水线核心零改动。自定义的权力在皮肤作者，不在内置清单。

**默认皮肤（6 个元素）**：速度（digital × `speed`，默认 km/h，可切 mph）、心率（digital × `heart_rate`）、功率（digital × `power`）、踏频（digital × `cadence`）、坡度（digital × `grade`，FIT 无此字段时用 altitude+distance 重算，仍无数据则自动隐藏）、轨迹图（map × `position`）。其它字段随时在 binding.json 里加一行即得。

### 5.3 布局与样式配置：HTML/CSS 模板 + JSON 数据绑定

一套仪表盘 = 一个目录（即一个"皮肤"）：

```
dashboards/
  virb_like/
    template.html     # 结构：widget 的 DOM、锚点布局（flex/grid/绝对定位随意）
    style.css         # 样式：字体、颜色、圆角、阴影、透明度——全套 CSS 能力
    binding.json      # 数据绑定与行为参数（见下）
    preview.png
```

`binding.json` 只声明"哪个 DOM 节点吃什么数据、怎么变换"，样式一律归 CSS：

```json
{
  "canvas": { "width": 3840, "height": 2160, "global_opacity": 0.92 },
  "data": { "smooth_window_s": 3, "units": { "speed": "km/h" } },
  "widgets": [
    { "id": "#speed-gauge", "type": "radial_gauge", "field": "speed",
      "range": [0, 60],
      "zones": [[0,35,"#39D353"],[35,50,"#FFB020"],[50,60,"#FF3B30"]] },
    { "id": "#hr", "type": "digital", "field": "heart_rate", "unit": "bpm" },
    { "id": "#map", "type": "map", "field": "position",
      "map_style": "track", "show_start_end": true },
    { "id": "#ele", "type": "elevation_profile", "field": "altitude" }
  ]
}
```

```css
/* style.css —— 自定义的全部火力都在这里，无需发明新配置语法 */
#speed-gauge { position: absolute; left: 48px; bottom: 48px; width: 300px;
               background: rgba(0,0,0,.4); border-radius: 18px;
               font: 600 96px "Helvetica Neue"; color: #fff; opacity: .95; }
#map { position: absolute; right: 48px; top: 48px; width: 520px; height: 390px;
       background: rgba(11,27,43,.8); border-radius: 24px; }
```

自定义维度覆盖：**布局**（CSS 全能力：绝对定位/flex/grid、px 或 %）、**字体**（`@font-face` 指向任意 ttf/otf，macOS 系统字体直接用）、**颜色**（含区间配色）、**透明度**（整层 `global_opacity` / 单 widget CSS `opacity` / 底衬 `rgba()` 三级独立）、**单位与量程**、**平滑窗口**。多场景 = 多建几个皮肤目录，CLI 一个参数切换。自定义工作流：改文件 → `actpipe preview -t ...` 看效果 → 再改，闭环秒级。

### 5.4 地图绘制（浏览器内）
- `track` 模式（默认且唯一内置，离线可用）：经纬度投影到以轨迹质心为原点的等距平面坐标，按容器尺寸自适应缩放，用 **SVG path / Canvas** 画全程轨迹（半透明描边）+ 已走过高亮段 + 当前位置圆点 + 起终点标记。Garmin VIRB 同款观感；轨迹数据预处理后作为 JSON 一次性注入页面，每帧只移动游标，零重算。
- 想要真实地图底图：纯前端事，在皮肤里自行接瓦片/静态图即可（底图透明度用 CSS `opacity` / `filter: grayscale()` 控制），流水线无感知，不进内置计划。

---

## 6. ffmpeg 合成管线

### 6.1 预渲染 PNG 序列 → 一次性合成

**阶段一：渲染（与编码解耦，可并行/可续渲）**
Playwright 驱动 headless Chromium 打开皮肤页，按 `overlay_fps`（默认 10）逐时刻 `renderFrame(t)` → 透明 PNG 落盘为 `frames/%05d.png`。FIT 数据本质 1 Hz，`overlay_fps=10` 只为指针/数字的秒间插值平滑；求快可降到 2–5。开多个标签页按时间段切片并行渲染；崩了从断点续渲；PNG 可直接翻看质检。

**阶段二：ffmpeg 一次合成（LUT + 叠加 + 编码）**

```bash
ffmpeg -hide_banner -loglevel error \
  -i "DJI_0001.MP4" \
  -framerate 10 -i "frames/%05d.png" \
  -filter_complex "\
    [0:v]lut3d='DJI_DLogM_to_Rec709.cube'[base];\
    [1:v]fps=30,format=rgba[ov];\
    [base][ov]overlay=0:0:format=auto[out]" \
  -map "[out]" -map 0:a? \
  -c:v hevc_videotoolbox -b:v 45M -tag:v hvc1 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:a copy \
  -progress pipe:1 -nostats \
  "DJI_0001_dash.mp4"
```

要点：
- **先 LUT 后 overlay**：仪表盘颜色不被 LUT 染色；
- **色彩标签必须显式打**（已查证）：LUT 输出即 Rec.709 SDR，输出端显式写 `-color_primaries/-color_trc/-colorspace bt709` 三件套——否则播放器按错误值解释，画面发白/偏色（这不是 VideoToolbox 的 bug，是 ffmpeg 默认不写标签的通病）；
- 非 D-Log 素材把 `lut3d` 段从滤镜链里剔除即可，其余不变；
- **帧率适配**：`fps=30` 让 ffmpeg 复制补帧到视频帧率，渲染量与视频帧率脱钩——4K60 素材也只需按 `overlay_fps` 渲染，这是 4K60 的主要解法（原"单管道带宽"问题随之消失）；
- 编码用 **VideoToolbox 硬件编码**（`hevc_videotoolbox` / `h264_videotoolbox`），M 系芯片 4K 出片接近甚至超过实时（社区实测 M1 Pro 4K `-q:v 50` 达 1.73×）；`-tag:v hvc1` 保证 QuickTime/相册能直接播。注意：VideoToolbox **不支持 `-crf`/`-preset`（静默忽略）**，质量控制用 `-b:v`（码率）或 `-q:v`（Apple Silicon 恒定质量，0–100，`-q:v 65` 可参考）；
- 如需保留 10-bit 输出：显式 `-pix_fmt p010le -profile:v main10`，并 ffprobe 复核 profile 真落在 main10（历史上有 main10 编成 main 的 ffmpeg bug 7581，需验证当前版本已修复）；
- `-progress pipe:1` 输出机器可读进度，server 解析后推给 client；渲染阶段进度由 Playwright 侧自报，两段进度合并展示。

### 6.2 渲染缓存与预生成（皮肤就绪后，FIT 到即渲）

**设计前提**：皮肤编辑是独立低频步骤，流水线触发时皮肤已 ready；渲染段的输入（皮肤 + FIT + 分辨率 + overlay_fps）**不含视频画面**，因此可以提前、异步于流水线生成。预生成与缓存是一体两面：**盯 FIT 同步目录、新 .fit 到即后台渲染（预生成/触发半边）；流水线启动时先查缓存（命中半边）**。

- **预生成触发（已实现，见 `src/server/pregen.ts` PregenService）**：**盯 FIT 库目录**——Strava 同步、手动载入、API 上传的 .fit 统一落库，watcher 即「有了 FIT 就自动渲染」的唯一挂钩；启动时补扫最近 `pregen.boot_days`（默认 7）天入库的 FIT。资源纪律：**串行**（一次一个 FIT）、生产队列忙则等空闲、swap 风暴过水位门（速率制）——预生成是闲时加速，不抢生产；
- **帧序号锚定 FIT 绝对时间轴**：第 N 帧 = FIT 开始时刻 + N/overlay_fps。视频来了之后，锚定偏移换算成起始帧号，ffmpeg 以 `-start_number` 从序列中段取帧——**同场活动多段素材共用一份缓存，渲染零重复**；
- **缓存键**：`hash(FIT 文件) + hash(皮肤目录) + 分辨率 + overlay_fps`。皮肤一改（低频）哈希即变，自动重生成；
- **渲染规格即生产规格**：`pregen.fps` 默认 null = 跟随 `overlay_fps`（10 Hz），分辨率按 `pregen.resolutions`（默认 3840x2160），皮肤用 `config.skin`——任务渲染直接整段 HIT。缓存按 TTL/容量策略清理；
- **流水线行为**：触发时查缓存——命中 → **跳过渲染段，直接合成编码（端到端 ≈ 编码本身）**；未命中（新分辨率档位、换皮肤、缓存已清理）→ 退回现渲路径，不阻塞正确性。

### 6.3 性能预期（M 系 Mac 参考）
渲染与编码两段解耦，分别估算（以 3 分钟素材、overlay_fps=10 为例）：

| 规格 | 渲染段（缓存未命中，4 标签页并行） | 合成编码段（VideoToolbox） | 端到端（缓存命中） |
|---|---|---|---|
| 4K 30fps | 1800 帧 × ~150ms ÷ 4 ≈ 1 min | ≈1× 实时（~3 min） | **≈3 min（仅编码）** |
| 4K 60fps | 同上（渲染量与视频帧率无关） | ~0.7× 实时 | ≈4 min（仅编码） |
| 2.7K/1080p | 更轻 | >1.5× 实时 | ≈2 min（仅编码） |

磁盘开销：4K 透明 PNG 大面积空白，单张数百 KB。现渲路径 1800 帧约 1 GB，任务完成后清理；预生成缓存（1–2 Hz × 全程活动）数 GB 级，按 TTL 清理。极端求快时 `overlay_fps=2`（3 分钟素材仅 360 帧，渲染十几秒），代价是指针动画明显跳动。

---

## 7. 交互、状态与通知

### 7.1 .fit 选择对话框
server 由 pm2 运行在用户登录会话内，可直接调起原生对话框：
```bash
osascript -e 'POSIX path of (choose file with prompt "选择 .fit 文件" of type {"fit"})'
```
配套策略：`config` 里可设 `fit_autopick: newest_in_dir`（默认目录取最新 .fit，弹窗变成"确认/换文件"），追求全自动时直接免弹窗。

### 7.2 状态提示
- **跑之前**：通知"检测到 N 段素材，开始处理"；
- **跑之中**：client `actpipe status` 显示进度条（百分比 / 当前帧 / 预计剩余 / 编码速度），WebSocket 实时推；
- **跑完/出错**：`osascript display notification` 或 `terminal-notifier`（支持点击回调）：「DJI_0001 出片完成 3'42"」点击通知 → `open -R` 在 Finder 中定位成片；失败通知带错误摘要，`actpipe logs <job>` 看全文。

### 7.3 输出管理
- 默认输出到 `~/Movies/DashCam/<日期>/`，文件名 = 原名 + 布局profile + 后缀；
- 覆盖保护、断点续跑（job 落盘，重跑跳过已完成步骤）。

---

## 8. server / client 接口

| 接口 | 说明 |
|---|---|
| `POST /jobs` | 手动建任务（指定视频 + fit + profile + offset） |
| `GET /jobs` / `GET /jobs/{id}` | 任务列表 / 详情（状态机：queued→probing→awaiting_fit→rendering→encoding→done/failed） |
| `WS /jobs/{id}/progress` | ffmpeg 进度 + 渲染进度推送 |
| `GET /config` / `PUT /config` | 读写全局 config 与皮肤绑定（binding.json/CSS） |
| `POST /preview` | **单帧合成预览**：给定时刻 t，ffmpeg 抓视频帧 + 套 LUT 作为皮肤页面 CSS 背景，页面渲染 t 时刻读数后整页截图返回 PNG。与正式渲染同一条代码路径，所见即所得零偏差；调样式的迭代闭环，兼作 offset 校准的例外通道 |
| `GET /luts` | LUT 预设列表 |

CLI 对应（每个子命令即对应模块的独立调试入口，§1.5）：`actpipe watch`（前台跑 server 调试用）、`actpipe run --video x --fit y [--direct] [--offset -3.5]`、`actpipe probe / ingest / fit / render / compose`（分段单跑与重放）、`actpipe preview -t 00:01:23`、`actpipe status`、`actpipe logs`。

---

## 9. 部署形态

- 依赖：Node.js 22 LTS + `npm i hono ws playwright @garmin/fitsdk chokidar` + `npx playwright install chromium`；ffmpeg 走 Homebrew；
- **server**：从源码运行（node_modules + Playwright 浏览器本机安装），由 **pm2** 托管：`pm2 start server.js --name actpipe --interpreter $(which node)`（钉死解释器路径，防 nvm 升级后复活失败）；`pm2 startup launchd` + `pm2 save` 实现登录自启（pm2 自动生成 LaunchAgent，仍在用户会话内运行，osascript 弹窗/系统通知不受影响）；崩溃自动重启、`pm2 logs/status` 现成，日志同时落 `~/Library/Logs/actpipe/`。**不编译成二进制**：Playwright 需拉起外部 driver 进程与独立浏览器二进制，且仅官方支持 Node 运行时，编译无收益。
- **client（CLI）**：用 **`bun build --compile`** 打成单文件二进制 `actpipe`（纯 HTTP/WS 瘦客户端，无原生模块，编译干净），放 PATH 随处可用。Bun 的职责边界就到此为止——打包工具，不做运行时。
- 全部配置集中在 `~/.config/actpipe/`（`config.json`（全局配置：输出目录、默认 LUT、`global_bias_seconds`、`fit_autopick` 等）、`dashboards/`（皮肤目录，HTML+CSS+binding.json）、`luts/`、`jobs.db`），可直接 git 管理、多机同步。

---

## 10. 实施计划

不分期，一次做完（合理提速手段全部内置，不做"锦上添花"项）：

| 模块 | 内容 |
|---|---|
| 触发 | chokidar 卷监听 + 相机指纹 + 防抖去重 + staging 拷贝（§2） |
| 探测 | ffprobe + D-Log M 三态确认（§3） |
| FIT | 官方 JS SDK 解析 + creation_time 锚定 + 范围校验兜底（§4） |
| 皮肤 | 默认皮肤：digital + map 两个渲染器，速度/心率/功率/踏频/坡度/轨迹图 6 个元素（§5） |
| 渲染 | Playwright 逐帧截图，**多标签页按时间段并行**；PNG 序列落盘；**渲染缓存与 FIT 目录预生成**（§6.1/§6.2） |
| 合成 | ffmpeg：lut3d → fps 补帧 → overlay → VideoToolbox（§6.1） |
| 交互 | osascript 选 fit、`/preview` 单帧合成预览（调样式闭环）、CLI（`bun build --compile` 单文件）、开始/完成/失败系统通知（§7/§8） |

预期工作量：**2.5–3 天**。

**明确移出计划的项**（均非用户需求或已被更简方案覆盖；日后真需要时均可不动流水线核心单独补）：
圆环表/海拔曲线等额外渲染器（皮肤可自写）、prores4444 中间片（PNG 序列已够）、瓦片底图（轨迹模式已够）、菜单栏进度指示（CLI + 通知已够）、Web 拖拽编辑器（自定义 = 直接改皮肤文件 + `/preview` 闭环）、多 profile 体系（多皮肤目录天然支持）。

## 已知问题（2026-09-13 记录）

1. ~~confirm 弹窗无人应答杀任务~~（已修）：`dlog_policy: ask` 时 probing 弹 osascript 确认框，无人点击 120s 超时导致整个任务 FAILED（17GB 白拷）。修复：弹窗 `giving up after 90` + confirm/chooseFile 三态返回（null=无人应答）+ `decideLut` 收到 null 时默认套 LUT 继续（`auto:no_answer`，不写记忆）。
2. ~~进度显示卡死~~（已修）：queue.js `#progress` 对 `job.progress` 整体覆盖写；compose 的 ffmpeg `-progress` 事件按字段独立触发（out_time_ms/fps/speed 各发各的），percent 刚写入就被 speed 事件冲掉。现象：分段任务 encode 阶段 percent 恒为段基底（seg2/2 卡 50%），speed 正常更新。修复：抽出 `mergeProgress(prev, payload)` 字段合并，`#progress` 改为合并写 + 单测（87 绿）。
3. render→compose 交接期资源抖动（观察项，非 bug）：render 结束（Chromium 退出 + 11 万张 4K PNG 落盘）与 compose 启动重叠时 ffmpeg 低速爬坡；叠加外部内存占用（如 LM Studio 模型常驻 6GB+）时 swap 交换会放大数倍耗时。日后做段间流水线时必须控制内存水位。
4. ~~出片慢（全链 0.25-0.3x）~~（已归因并连下两刀）：4K50 10bit 分解 benchmark（每轮 30s 片）结论——**软解 HEVC 是最大瓶颈**（裸软解+硬编天花板仅 0.53x）；lut3d 一刀 0.53→0.38；PNG overlay 一刀 0.53→0.41；两刀叠加 0.25x；纯 PNG 解码 49.6x 无辜（透明叠加层稀疏，inflate 极快）；ProRes4444 中间层无收益（F2b 0.27x≈全链），方案淘汰；hevc_videotoolbox 硬编无辜；本机 brew ffmpeg 9.0.1 无 libplacebo 滤镜，lut3d/overlay 均 CPU-only（官方邮件列表实锤），不值得为 GPU LUT 自编译。第一刀：`buildFfmpegArgs` 主输入加 `-hwaccel videotoolbox`，生产全参数冒烟实测 **0.60x**（~2.4x 提速），输出 Main10/yuv420p10le/bt709 标签全对。第二刀：合并任务段间流水线（`src/server/pipeline.js` 调度器：deps + 并发车道 + 失败 abort；ingest 串行保卡带宽、probe/fit 串行保 LUT 决策顺序、render/encode 按 `encode_concurrency`(2)/`render_concurrency`(1) 并发；重阶段启动前过 swap 水位门——**速率制：swap 超预算且仍在增长（>30MB/5s）才等待，存量占用连续 15s 稳定即放行**，防外国应用遗留 swap 造成永久卡死；`max_swap_mb`=3072 可调）。实测（2×120s 4K50 实片）：**双编码并行在 10 核/16GB 上零收益**（单实例已吃满 CPU，双跑聚合 ≈ 单跑 0.6x），真实收益是——① render/ingest 藏进 encode 影子（render MISS 的多段任务省每段 ~13min，ajf0 级 3 段任务 ≈ 3.1h→2.1h，约 1.5x）；② FIT 锚定失败从「跑完前一段 encode 才发现」变为几分钟内 fail-fast；③ 进度按段内阶段权重聚合（ingest 0.12/prep 0.02/render 0.2/encode 0.66），并发阶段文案并列展示；④ 顺带修复手动 offset 断点续跑顺推错误的老 bug（改从 artifacts 累加）。CPU 更多的机器（Pro/Max/Ultra）双编码仍有 scaling 空间。

## 工程基线（2026-09-14 记录）

**全站 TypeScript（无构建步骤）**：server（FeathersJS）/ CLI / web（Svelte 5）/ 皮肤共享件（dashboards/_lib）/ 全部测试，64 个文件 .js→.ts 迁移完成。运行时 = Node 22 `--experimental-strip-types` 类型擦除直跑 .ts（pm2 `node_args: --experimental-sqlite --experimental-strip-types`，入口 `src/server/pm2-entry.cjs → index.ts`）；`tsc --noEmit` 纯检查不输出。约束：`erasableSyntaxOnly`（禁 enum/namespace/参数属性）+ `verbatimModuleSyntax`（类型导入必须 `import type`）+ 相对导入带 .ts 扩展名。共享领域类型在 `src/types.ts`（ActpipeConfig/Job/ProbeResult/SessionInfo/FramesArtifact 等）；外部动态数据（ffprobe/FIT/osascript/ws 负载）约定 any/unknown + 注释。

**质量门（当前全绿）**：`npm test`（node:test 后端 105）· `npx vitest run`（web 84）· `npm run typecheck`（tsc 后端 0 错误）· `npm run typecheck:web`（svelte-check 0 错误，4 个历史 a11y/slot 警告保留）· `npm run build:web`。注意 svelte-check 与 TypeScript 7 不兼容，钉 `typescript@~6`。

**Strava→pregen 自动渲染**：FIT 库（`fit_library_dir` 默认 `~/.config/actpipe/fits`）是唯一挂钩——Strava 同步/手动载入/上传的 .fit 落库即触发 `PregenService`（`src/server/pregen.ts`）串行预生成 PNG 序列（生产规格：`pregen.fps` null = 跟随 `overlay_fps`、`pregen.resolutions`、当前皮肤），任务渲染直接整段 cache HIT。纪律：一次一个、任务队列忙等空闲、swap 风暴过速率制水位门；`pregen.enabled: false` 可整体关闭。

**公网映射前必做**：`node --experimental-strip-types bin/actpipe.ts passwd <密码>`（auth.password_hash 当前为 null，鉴权未启用；设了才开启全站拦截）。

## 快剪（2026-09-15 落地，2026-09-18 重构为 pi skill runner）

**一句话**：对已完成的 merged dash 任务剪 ~30s 短片。产品内嵌 pi（`@earendil-works/pi-agent-core` + `pi-ai`，BYOK）作为 harness；**快剪的导演逻辑不写死在代码里，而是 `skills/quickcut/SKILL.md`（Agent Skills 标准）——pi 加载它来圈幕**。同一份 SKILL.md，内嵌 harness 和外部 pi CLI 都能跑（skill 里有宿主差异表）。

1. **事件菜单**（`src/modules/quickcut.ts` `detectEvents()`）：数据里有什么就出什么事件，叙事不写死。通用：片头/片尾（数据开始前/后相机多录的段）、首次移动、显著停顿×N（≥20s，最多 5 个，同类相距 <60s 合并留长者）、最长巡航（连续 ≥3m/s 的最长段）、最终停止、极速窗（10s 均速）；条件：功率峰（20s 窗）/冲刺（5s 爆发）/心率峰（10s 窗）/海拔极值（量程 >30m）/坡度翻转（持续爬坡接持续放坡）/GPS 折返点（距起点最远 >500m）。每事件带 `{type, fitS, videoS, windowS, score, desc}`；`videoS=null` = 不在任何视频段覆盖内，不可剪辑。区间型事件（片头/片尾/停顿）另带 `fromVideoS/toVideoS` 视频秒边界；`annotatePauseAudio()`（analyze/run 管线内）对 ≥15s 且在覆盖内的停顿做单次 ffmpeg astats 响度扫描（`-vn` 只解音频，5s 能量桶 >-25dB 且 ≥3 桶 = 有人声，单停顿最多扫 600s，多停顿并发），desc 追加人声区间或「安静」——对话 beat 取人声区收尾（告别/笑声/重新上车的情绪落点），`hardStepsDigest` 直接把建议窗口（收尾 6s）算好塞进 prompt。**纪律：FIT 定位全走流逝秒（时间戳），绝不用样本下标——码表自动暂停会留时间空洞；FIT→视频映射逐段 `videoT = fitElapsed − offsetSeconds`。**基准固化在 `test/server/quickcut.test.ts`（真实骑行归一化样本 fixture，锚点全部经成片抽帧人工核验：功率峰 1420s/登顶 335m@1449s/极速 42.3km/h@1764s）。
2. **兜底组装**（`assembleHeuristic()`）：六槽骨架（出发/上路/发力[功率峰>心率峰]/制高点/极速/收尾），槽内按类型序+score 挑事件，窗口重叠（2s 余量）让位、无候选丢弃给原因。dash 的「快剪 30s」关掉 AI 优选就是这个纯 L0 粗剪。
3. **L1 skill runner**（`src/server/quickcut-agent.ts`）：`loadSkillInstructions()` 读 SKILL.md 正文（剥 frontmatter）+ 宿主适配段当 system prompt，事件菜单/兜底计划/视频信息当 user prompt。工具只有两个：**`ffmpeg`**（bin=ffmpeg/ffprobe，隔离工作目录执行，产物图片自动回传为 image 内容块——抽帧/探测让 agent 现场编，不预烘焙单用途工具）与 **`commit_cuts`**（唯一出口：`validateCuts` 把守物理合法——区间内/保序不重叠/幕数≤12/总时长≤180s，非法抛错报回 LLM 重试）。20 轮安全阀；**任何一环不可用（模型无视觉/skill 缺失/agent 异常/未提交）一律回退 L0 原 plan**（llm_used 记实际）。user prompt 末附 `hardStepsDigest`——把 skill 的「两步硬流程」换算成本片具体秒数（长头尾 >20s 给 10/30/60/90% 四个探测点、有人声停顿给 beat 区间）：小模型跟得住具体数字、跟不住抽象原则（实测 9B 本地模型只写原则不执行，给数字后三步全中）。
4. **BYOK**（`src/server/llm.ts`）：`config.llm = { provider, model, api_key, base_url, vision }`；默认 `lmstudio`（本机 `http://127.0.0.1:1234/v1`，帧不出机）；云端支持 openai/moonshot/anthropic/google/deepseek 等。不可达 → `resolveLlm` null → 跳过 L1。dash 有 LLM 设置面板（融合在 Strava 旁）：provider 动态表单 + 免保存直测 + 状态四态点。DeepSeek 推荐 `deepseek-v4-flash-vision-exp`（多模态，pi-ai 目录内置）。

**接口**：Feathers service `quickcuts`（find/get/create/analyze/llm_status/llm_test，后三者走 customMethodBridge）。`POST /quickcuts { job_id, cuts?, use_llm? }`：cuts 缺省 → L0 兜底（use_llm 默认开则进 refining）；cuts 给了（`[{start,end,label?}]`，planFromCuts 干跑校验）→ 外部精剪，跳过 L1。串行通道：`queued→analyzing→[refining]→rendering→done/failed`，记录落 `quickcuts.json`（重启中间态标 failed）。`POST /quickcuts/analyze { job_id }`：只读——事件菜单+兜底计划+video/segments/videoDurationS，不落记录（外部 agent 的入口）。CLI：`actpipe quickcut analyze <job_id>` / `actpipe quickcut render <job_id> [--cuts cuts.json]`（2s 轮询到终态）。**全程日志**：每条记录落 `<home>/quickcuts/<id>.log`（`[HH:MM:SS]` 前缀，开始/L0/L1/渲染/done 全链；L1 经 `Agent.subscribe` 事件流记工具调用与助手文本——`formatAgentEvent`：ffmpeg 命令截 300、commit_cuts 全量、助手文本截 500），出口三个：`GET /quickcuts/:id/log`、CLI `actpipe quickcut logs <id>`、dash 面板「日志」按钮（进行态 2s 轮询跟进）。

**Skill**（`skills/quickcut/`，Agent Skills 标准，pi/Claude Code/Kimi Code 通用）：SKILL.md 固化导演流程——analyze 提候选 → 抽帧逐幕验证（路上没人/无遮挡/读数清晰/有速度感，每幕至少看两批）→ overlay 读数与事件 desc 数值交叉校验（对不上 = 时间轴没对齐，停手报告）→ 提交剪辑点 → 验片。两条导演纪律：长无数据头尾（>20s）在区内多点抽帧找交代镜头（取装备/出发/收场），不盲用位置窗口；有人声的停顿全片最多取一处 ≤6s（点到为止，隐私）。时长默认 ~30s、叙事撑得起可到 2 分钟内（代码护栏 MAX_TOTAL_S=180s 不变）。宿主差异表覆盖两种运行方式；`scripts/frame.sh` 供 CLI 宿主抽帧。原则：判断留给 LLM，机械留给代码——产品只暴露 analyze（算不了）、render（要进任务系统）和 ffmpeg（通用能力）三类能力。

**踩坑记录**：① Feathers service 内部禁用 ES `#` 私有方法（`wrapService` 用 `Object.create` 包装后私有品牌丢失，500）——用 TS `private`；② pi `AgentTool.execute` 返回值 `details` 必填；③ pi-ai `models.complete` 失败不 reject（查 `stopReason:'error'/'aborted'` + errorMessage），llm_test 必须检查；④ openai-completions 适配器强制 apiKey——keyless 本地端点由 llm.ts 补占位 key `actpipe-keyless`。

~~（2026-09-15 初版 L1 是写死六幕叙事的硬编码 agent：sample_frames/commit_cuts 工具 + 时长锁定只许平移。本次重构把叙事挪进 SKILL.md——lesson：agent 的工作流应该住在 skill 文件里可迭代，代码里只留工具与护栏。）~~
