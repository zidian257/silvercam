# TODO

约定：有新的待办就追加一条（编号递增，标日期）；做了就从列表移除或标记完成。条目里写清动机、设计要点和已知风险，让未来的自己/协作者能直接接手。

## 待办

### 1. 车牌打码（全片，不只是快剪）（2026-09-19）

隐私刚需：成片要发出去，自己车和路人的车牌不能裸奔。

- **范围：全片**。不只快剪的几十秒——40min 4K 全片打码意味着性能是核心约束：检测只能抽样跑（如 2–5fps），中间帧靠追踪插值。
- **原理链**：检测（YOLO + [CCPD](https://github.com/detectrecog/ccpd) 系中文车牌权重，ultralytics 导出 ONNX，onnxruntime-node 本地跑，帧不出机）→ IOU/ByteTrack 追踪插值（码不能闪）→ ffmpeg 滤镜链马赛克（crop 区域 → 马赛克 → overlay 回去，`enable=between(t)` 按轨启用，与仪表盘合成同一套机制）。
- **铁律：漏检 = 隐私泄漏**。阈值偏向过杀（误糊别的矩形只是难看）；疑似打不上就亮黄牌警告，绝不静默放过。
- **已知风险**：Action 5 Pro 广角 POV 下斜角/小目标/运动模糊的 recall 未验证——开工第一步就是拿真实素材（停车场段 + 高速跟车段）实测模型选型。
- **产品形态**：默认开启（隐私功能不该要用户想起才开）；渲染后抽几帧贴出打码效果供人工确认。

### 2. /api/login 速率限制（2026-09-19，已完成 2026-09-20）

公网唯一暴露的攻击面就是登录接口，目前无防爆破措施。

- **落地**：`src/server/auth.ts` 内存滑动窗口（每 IP 60s ≤10 次尝试，超限 429「尝试过于频繁，稍后再试」；计全部尝试、成功不清窗），回环地址（127.0.0.1/::1/::ffff:127.0.0.1）豁免；`trust proxy` 下经 X-Forwarded-For 取真实访客 IP（与 CF-Connecting-IP 同源链路）。
- **未做**（一期不需要）：指数退避、连续失败系统通知。

### 3. studio「定格 FIT 起点」按钮文案与状态（2026-09-19，已完成 2026-09-20）

- **落地**：按钮固定「定格起点」（title 明示可反复定格）；定格后工具栏常驻 mono 状态 `FIT 起点 @ mm:ss`（`pinStatusFor`，随逐帧微调实时更新，段切换清空）。

### 4. studio 里选的皮肤/LUT/FIT 回写 inbox（2026-09-19，已完成 2026-09-20）

- **落地**：studio 选择变更 600ms 防抖回写——inbox 来源 `POST /api/inbox/:id/align`（pre_align 扩 skin/lut 键，setAlign 改 merge 语义只写给出的键，fit/bias 与 skin/lut 两通道互不覆盖；组传播同 patch）；job 来源 `POST /jobs/:id/prefs` → `queue.updatePrefs`（进行中拒绝，只落盘不重排队列；realign 重渲时把 params.lut 重算进各段 probe.lut_decision）。`/api/align/source` 回读 pre_align > decision > 全局默认，inbox 组选择按 pre_align 预填。
- **偏离**：realign 的 LUT 重决策无单测（路径太重），代码评审保证。

### 5. 快剪作为 inbox 的一等选项 + 快剪优先输出（2026-09-19，已完成 2026-09-20）

- **落地**：commit 决策带 `quickcut`（缺省跟随全局 `quickcut_auto: true`；inbox 批量条/组控件）→ job params 透传 → done 后 `queue.maybeAutoQuickcut` 自动建快剪记录（纯拷贝不触发、失败只记日志）→ 完成独立系统通知（点击打开成片）。dash 任务行「快剪」标记：将自动快剪显示静态 pill，有记录显示可点状态 pill。
- **偏离**：「全片+快剪 / 仅快剪」三态做了一期的布尔开关（仅快剪 = 二期研究只编码剪辑窗口）；通知未做优先级排序，快剪完成独立通知天然先于/独立于全片。

### 6. 成片音量调节（2026-09-19，已完成 2026-09-20）

- **落地**：config `audio_volume: 1.0` + commit 决策 `audio_volume` 每条覆盖（inbox 批量条/组下拉：默认/静音/25%–150%）；compose `=1` 时 `-c:a copy` 直通，否则 `-af volume=x -c:a aac -b:a 192k`。快剪吃已调过音量的成片再剪，两处天然一致。

### 7. 非爬坡素材的叙事验证（2026-09-19）

用户本次素材不是爬坡。事件菜单本身是数据驱动通用的（停顿/巡航/极速/人声停顿…与地形无关），但 SKILL.md 的导演语汇偏爬坡（登顶/放坡）。

- **行动**：用这条素材跑一次快剪看成片；叙事问题只迭代 SKILL.md，不动代码（这正是导演逻辑住在 skill 里的意义）。验证型条目，跑完即关闭。

### 8. 背景音乐床（Casey Neistat 范儿）（2026-09-19）

- **产品**：Casey 的味道 = 有品位的授权曲 + 音乐永远垫在人声/环境声下面。我们不做内置曲库（版权红线），做「用户自带曲库 + 自动混音」：用户把 Epidemic Sound / Artlist 下载的曲目丢进目录，系统负责混。
- **技术**：`config.music_dirs` 曲库目录；ffmpeg `amix` + `sidechaincompress`（原声做 ducking，讲话时音乐自动压低）；选曲入口挂 inbox/快剪面板。二期：beat 检测对齐剪辑点（aubio/onset），让快剪卡在鼓点上。
- **风险**：版权只能用户自带，产品里写明；beat 对齐是二期，一期先「能配乐、不盖人声」。

### 9. 平台自动上传：YouTube / B 站 / 视频号（2026-09-19 调研）

目标：出片后可选自动上传，全局开关 + 每条覆盖（默认关）。调研结论（2026-09）：

- **YouTube（官方 API，最顺，先做）**：Data API v3 `videos.insert` 断点续传上传，OAuth2（与 Strava 集成同构：client_id/secret → 授权 → refresh token 自动续）。配额 2025-12 起从 1600 降到 ~100 units/次（默认 10000/天 ≈ 每天 100 条，管够）。**大坑**：2020-07 后创建的未审计 API 项目，上传的视频会被强制锁 private 且不可申诉——个人用接受「传完是私享，去 Studio 手动转公开」，或给项目过 Google 审计（麻烦）。OAuth consent 处于 testing 模式时 refresh token 7 天过期，要发布到 production。
- **B 站（社区方案，次做）**：官方开放平台不对个人开放上传。事实标准是 **biliup-rs**（Rust CLI，macOS 可用）：扫码登录一次 → cookie 长效保存 → 命令行投稿。我们当外部二进制调（同 ffmpeg 的集成姿势），不自己实现 B 站签名/分片。cookie 过期后重新扫码。
- **视频号（RPA，最后做）**：无任何公开个人上传 API，只有 channels.weixin.qq.com 网页后台。可行路径 = Playwright 持久化 user-data-dir 驱动网页上传（扫码登录一次，会话保活）——技术栈我们现成（渲染引擎同款），但页面结构一变就碎，且有平台条款灰度风险。
- **产品形态**：`config.upload.{youtube,bilibili,channels}.enabled` 默认全关；inbox commit 加「上传」勾选项（默认跟随全局）；上传实现为独立任务状态机（uploading/done/failed + 平台链接落库 + 通知带链接）。**内容分野**：快剪 30s → 视频号/短视频场景；全片 → YouTube/B 站。上传失败不阻塞本地出片，只发失败通知。
- **风险**：视频号 RPA 最脆，页面改版即失效，需要维护预期；B 站 cookie 方案违反平台条款的灰度存在（个人低频使用社区工具普遍在用）。
