---
name: quickcut
description: 把 actpipe 已出片的运动相机素材（带 FIT 仪表盘 overlay 的成片）剪成 ~30s 短片。当用户要求快剪、剪短片、剪骑行/运动视频，且本机 actpipe server 在运行时使用。通过 actpipe CLI 的 analyze/render 接口驱动，用抽帧看画面来做镜头判断。
---

# 快剪（actpipe quickcut）

把一条已出片任务剪成 ~30s 短片。你是导演，不是计算器：**数据负责提候选，眼睛负责定镜头**。

## 宿主差异（先看你被谁运行）

| 能力 | 内嵌 actpipe server（pi harness） | 外部 CLI 环境（pi CLI / 其他 agent） |
|---|---|---|
| 找任务 | job 已在用户消息给出 | `actpipe status` 挑 state=done 的 job |
| 事件菜单 | 用户消息已给出 analyze 结果 | `actpipe quickcut analyze <job_id>` |
| 抽帧/探测 | `ffmpeg` 工具（args 数组，输出写相对文件名，图片自动回传） | `scripts/frame.sh <video> <out_dir> <t1>...`（960px jpeg） |
| 提交渲染 | `commit_cuts` 工具（提交即渲染） | 写 cuts.json → `actpipe quickcut render <job_id> --cuts cuts.json` |
| 验片 | 服务端兜底，不需要你做 | ffprobe 时长 + 成片抽帧复查 |

## 前置（仅外部 CLI 宿主）

- actpipe server 在跑（`actpipe status` 能通就行；不通就让用户 `pm2 start actpipe` 或 `actpipe watch`）
- 抽帧脚本：`scripts/frame.sh`（本 skill 目录下，相对路径调用）

## 流程

### 0. 找任务

外部宿主：`actpipe status` 挑 state=done 且有输出成片的 job。用户没指定时列出让其挑；上下文明确（刚出完片）就直接用最新的。

### 1. 分析（只读，不渲染）

```bash
actpipe quickcut analyze <job_id>
```

返回：
- `events[]`：FIT 数据探测到的事件菜单。字段：`type`（first_move/power_peak/sprint/hr_peak/alt_high/speed_peak/pause/cruise/grade_flip/turnaround/head/tail…）、`videoS`（视频秒，**为 null 表示不在任何视频段覆盖内，不可用**）、`fitS`（FIT 流逝秒）、`windowS`（建议窗口）、`score`（活动内相对强度 0-100）、`desc`（人话+数值）。
- `plan`：服务端兜底粗剪计划，可作 baseline，也可直接改。
- `video` / `videoDurationS` / `segments`。

菜单里有什么素材就讲什么故事：平路没有登顶，场地绕圈没有折返点——缺席即信息，不要硬凑。

### 2. 圈候选

按叙事骨架从菜单挑事件，初定每幕 `[start, end]`（中心 = 事件的 videoS，宽度参考 windowS，可在 3–10s 间调）：

骨架参考（按需增删，总长目标 30s 上下）：
- 开头：head（视频开头，常为准备/出发）
- 上路：first_move
- 铺垫：cruise 或某个 pause（如出发前停顿）
- 高潮：power_peak / hr_peak / alt_high / grade_flip（哪个强用哪个，可连用）
- 释放：speed_peak
- 收尾：tail / final_stop

### 3. 抽帧验证（不可省略）

对每幕抽中心帧 + 窗口两端：

```bash
# 外部宿主
scripts/frame.sh <video> /tmp/qc-frames <t1> <t2> <t3> ...
# 内嵌宿主：ffmpeg 工具
{bin:'ffmpeg', args:['-hide_banner','-loglevel','error','-y','-ss','141.6','-i','<video>','-frames:v','1','-vf','scale=960:-2','-q:v','3','f_141.jpg']}
```

逐张看图。选帧标准：
- 路上没人、无遮挡、构图干净
- overlay 读数清晰、有速度感/张力
- 夜戏/隧道/被跟拍汽车挡住的镜头降权

不满意就微调窗口（±2–5s）再抽一批，或换相邻事件。**每幕至少看两批帧**（初剪 vs 调整后）再定。宁缺毋滥：找不到好镜头的事件宁可不进正片。

### 4. 交叉校验（防时间轴漂移）

帧上 overlay 的读数（功率/速度/心率/海拔）应与 analyze 里该事件的 `desc` 数值吻合。对不上 = FIT/视频时间轴没对齐，**停手报告用户**，不要硬剪。

### 5. 渲染

外部宿主：
```bash
cat > cuts.json <<'EOF'
[{"start":3,"end":7,"label":"出发"},{"start":141.6,"end":144.6,"label":"上路"}]
EOF
actpipe quickcut render <job_id> --cuts cuts.json   # 阻塞到完成，输出成片路径
```

内嵌宿主：`commit_cuts` 工具提交同构的 cuts 数组（服务端接管渲染）。

### 6. 验片（仅外部宿主，不可省略）

- `ffprobe -v error -show_entries format=duration -of csv=p=0 <out>` 核对时长 ≈ cuts 总长
- 对成片每幕中点 + 衔接处抽帧，确认没有夹帧/黑帧/错位
- 有问题改 cuts 重渲（输出重名自增，不覆盖旧片）

## 军规

- 永远用 analyze 返回的 `videoS`（视频秒）写 cuts，不要自己从 FIT 时间戳换算——逐段映射（videoT = fitElapsed − offsetSeconds）已经在服务端做对了
- 不要用样本数组下标当时间——码表自动暂停会留时间空洞
- 数据提候选、眼睛定镜头：跳过第 3 步的剪辑是赌博
