// 快剪 L1 skill runner：pi 加载 skills/quickcut/SKILL.md 当导演指令，agent 按 skill 流程自由圈幕。
// 工具只有两个：
//   ffmpeg     —— 通用能力（抽帧/探测/切片，args 现场编；产物图片自动回传，ffprobe 用 bin 切换）
//   commit_cuts —— 唯一出口：校验剪辑点并终止（非法抛错报回 LLM 重试）
// 纪律：L1 永远是可降级层——模型无视觉、skill 文件缺失、agent 异常、未提交剪辑点，一律退回 L0 原计划。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { REPO_ROOT } from '../lib/paths.ts';
import type { QuickcutEvent, QuickcutPlan } from '../modules/quickcut.ts';
import { EVENT_LABELS, planFromCuts } from '../modules/quickcut.ts';
import { agentStreamFn } from './llm.ts';
import type { ResolvedLlm } from './llm.ts';

const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'quickcut');

// 安全阀：agent 最多跑的轮数（看菜单→逐幕抽帧→交叉校验→提交，20 轮足够）
const MAX_TURNS = 20;
// 单次 ffmpeg 调用限时与产出上限
const FFMPEG_TIMEOUT_MS = 120_000;
const MAX_RETURN_IMAGES = 12;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const STDIO_TAIL = 2000;
// 剪辑点护栏：幕数与总时长的 sanity 上限（时长本身不设死——skill 里的目标是默认 ~30s、弹性到 2 分钟内）
const MAX_CUTS = 12;
const MAX_TOTAL_S = 180;

export interface QuickcutCut {
  start: number;
  end: number;
  label?: string;
}

export type FrameContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

// ---------- skill 加载 ----------

let skillCache: string | null | undefined;

// 读 SKILL.md 正文（剥 frontmatter）；文件缺失返回 null（调用方回退 L0）
export function loadSkillInstructions(): string | null {
  if (skillCache !== undefined) return skillCache;
  try {
    const raw = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    skillCache = body || null;
  } catch {
    skillCache = null;
  }
  return skillCache;
}

// ---------- 剪辑点校验 ----------

// 护栏只把守「物理合法」：区间内、保序不重叠、幕数/总时长不出格。
// 圈哪段、几幕、每幕多长全是 agent 的导演判断——skill 里的 30s 目标是创作指引不是代码约束。
export function validateCuts(cuts: QuickcutCut[], videoDurationS: number): Required<QuickcutCut>[] {
  if (!Array.isArray(cuts) || !cuts.length) throw new Error('cuts 至少一条');
  if (cuts.length > MAX_CUTS) throw new Error(`幕数 ${cuts.length} 超上限（最多 ${MAX_CUTS} 幕）`);
  const out: Required<QuickcutCut>[] = [];
  let prevEnd = -1;
  let total = 0;
  cuts.forEach((c, i) => {
    const { start, end } = c ?? ({} as QuickcutCut);
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`cuts[${i}] 的 start/end 不是有限数值`);
    }
    if (start < 0 || end <= start) throw new Error(`cuts[${i}] 窗口非法：需要 0 ≤ start(${start}) < end(${end})`);
    if (end > videoDurationS) throw new Error(`cuts[${i}] 超出视频时长：end=${end}，视频共 ${videoDurationS.toFixed(2)}s`);
    if (start < prevEnd) throw new Error(`cuts[${i}] 与前一幕重叠（${start} < ${prevEnd}）：按时间序提交且幕间不得重叠`);
    total += end - start;
    prevEnd = end;
    out.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, label: c.label ?? `片段${i + 1}` });
  });
  if (total > MAX_TOTAL_S) throw new Error(`总时长 ${total.toFixed(1)}s 超上限（${MAX_TOTAL_S}s）——快剪是短片，回到 2 分钟以内的目标`);
  return out;
}

// ---------- 工具 ----------

// ffmpeg/ffprobe 直通：隔离工作目录执行（无 shell、限时），结束后回传 stdio 尾部 + 目录里新产生的图片
function buildFfmpegTool(video: string, workdir: string, log: (m: string) => void): AgentTool<any> {
  return {
    name: 'ffmpeg',
    label: 'ffmpeg/ffprobe',
    description:
      `在隔离工作目录里运行 ffmpeg 或 ffprobe（args 数组，无 shell）。` +
      `输入视频用绝对路径 ${video}；输出文件一律写相对文件名（落在工作目录）。` +
      `运行结束后自动回传：stdio 尾部 + 工作目录里新产生的图片（jpg/png，最多 ${MAX_RETURN_IMAGES} 张）。` +
      `抽帧示例：{bin:'ffmpeg', args:['-hide_banner','-loglevel','error','-y','-ss','141.6','-i','${video}','-frames:v','1','-vf','scale=960:-2','-q:v','3','f_141.jpg']}；` +
      `一次多帧用 %d 命名：['-ss','10','-i','${video}','-frames:v','4','-vf','scale=960:-2','f_%d.jpg']（输出名不带 %d 会报错）`,
    parameters: Type.Object({
      bin: Type.Optional(Type.Union([Type.Literal('ffmpeg'), Type.Literal('ffprobe')], { description: '默认 ffmpeg' })),
      args: Type.Array(Type.String(), { description: '命令行参数数组' }),
    }),
    execute: async (_id: string, params: unknown) => {
      const p = params as { bin?: 'ffmpeg' | 'ffprobe'; args: string[] };
      if (!Array.isArray(p.args) || !p.args.length) throw new Error('args 必填');
      const before = new Set(fs.readdirSync(workdir));
      const r = await new Promise<{ code: number; out: string }>((resolve, reject) => {
        const proc = spawn(p.bin ?? 'ffmpeg', p.args, { cwd: workdir, timeout: FFMPEG_TIMEOUT_MS });
        let out = '';
        proc.stdout.on('data', (d) => (out += d));
        proc.stderr.on('data', (d) => (out += d));
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code: code ?? 1, out }));
      });
      // 新产生的图片回传为 image 内容块（超出上限的只报名单）
      const fresh = fs.readdirSync(workdir).filter((f) => !before.has(f) && /\.(jpe?g|png)$/i.test(f)).sort();
      const picked = fresh.slice(0, MAX_RETURN_IMAGES);
      const content: FrameContentBlock[] = [
        { type: 'text', text: `exit=${r.code}\n${r.out.slice(-STDIO_TAIL)}`.trim() + (fresh.length ? `\n产出图片：${picked.join(', ')}${fresh.length > picked.length ? `（另 ${fresh.length - picked.length} 张未回传）` : ''}` : '') },
      ];
      for (const f of picked) {
        const fp = path.join(workdir, f);
        const st = fs.statSync(fp);
        if (st.size > MAX_IMAGE_BYTES) {
          content.push({ type: 'text', text: `${f} 体积 ${Math.round(st.size / 1024)}KB 超上限未回传（抽帧请加 scale=960:-2）` });
          continue;
        }
        content.push({ type: 'image', data: fs.readFileSync(fp).toString('base64'), mimeType: f.endsWith('.png') ? 'image/png' : 'image/jpeg' });
      }
      if (r.code !== 0) log(`[quickcut] agent ffmpeg 退出码 ${r.code}: ${p.args.slice(0, 6).join(' ')}…`);
      return { content, details: { exit: r.code, images: picked } };
    },
  };
}

function buildCommitTool(videoDurationS: number, onCommit: (cuts: Required<QuickcutCut>[]) => void): AgentTool<any> {
  return {
    name: 'commit_cuts',
    label: '提交剪辑点',
    description:
      `提交最终剪辑方案并结束（一次调用覆盖全部幕，按时间序）。` +
      `每条 {start,end,label}：视频秒，0 ≤ start < end ≤ ${videoDurationS.toFixed(2)}，幕间不得重叠，总时长 ≤ ${MAX_TOTAL_S}s。` +
      `提交即渲染，没有后悔药——确认每幕都抽帧看过再提交。`,
    parameters: Type.Object({
      cuts: Type.Array(
        Type.Object({
          start: Type.Number({ description: '窗口起点（视频秒）' }),
          end: Type.Number({ description: '窗口终点（视频秒）' }),
          label: Type.Optional(Type.String({ description: '幕名（中文，如 出发/爬坡/极速）' })),
        }),
      ),
    }),
    execute: async (_id: string, params: unknown) => {
      const valid = validateCuts((params as { cuts: QuickcutCut[] }).cuts, videoDurationS); // 不通过则抛错，报回 LLM 重试
      onCommit(valid);
      return { content: [{ type: 'text' as const, text: '已确认，进入渲染' }], details: { cuts: valid }, terminate: true };
    },
  };
}

// ---------- prompt ----------

function eventsDigest(events: QuickcutEvent[]): string {
  return events
    .map((e) => {
      const vs = e.videoS == null ? 'null（不在视频覆盖内，不可用）' : e.videoS.toFixed(2);
      return `- ${e.type}「${EVENT_LABELS[e.type] ?? e.type}」videoS=${vs} fitS=${e.fitS == null ? '-' : e.fitS.toFixed(1)} 窗口建议 ${e.windowS}s 强度 ${e.score} — ${e.desc}`;
    })
    .join('\n');
}

function planDigest(plan: QuickcutPlan): string {
  const acts = plan.acts.map((a) => `  ${a.label} ${a.start.toFixed(2)}–${a.end.toFixed(2)}s（${a.reason}）`).join('\n');
  const dropped = plan.dropped.length ? `\n  未选入：${plan.dropped.map((d) => `${d.label}（${d.reason}）`).join('；')}` : '';
  return `${acts}${dropped}`;
}

function buildSystemPrompt(instructions: string): string {
  return `${instructions}

---

# 宿主适配（你被嵌在 actpipe server 内运行）

- 事件菜单与兜底计划已在用户消息里给出，**不需要、也不能**跑 actpipe CLI
- 抽帧/探测用 \`ffmpeg\` 工具（与 skill 里 scripts/frame.sh 等效但更自由，命令见工具描述）
- 剪辑方案用 \`commit_cuts\` 工具提交（等效 CLI 的 actpipe quickcut render --cuts；提交即渲染）
- 验片由服务端兜底，你的工作到 commit_cuts 为止`;
}

function buildUserPrompt({ video, videoDurationS, events, plan }: { video: string; videoDurationS: number; events: QuickcutEvent[]; plan: QuickcutPlan }): string {
  return `视频：${video}（共 ${videoDurationS.toFixed(2)}s）

# 事件菜单（analyze 结果）
${eventsDigest(events)}

# 兜底粗剪计划（可作 baseline 改进）
${planDigest(plan)}
${hardStepsDigest(events)}
按 skill 流程开始：先圈候选，再逐幕抽帧验证（不满意就调窗口再看），交叉校验 overlay 读数与事件数值，最后 commit_cuts 提交。`;
}

// 把 skill 的两步硬流程换算成本片的具体数字——小模型跟得住具体秒数，跟不住抽象原则
function hardStepsDigest(events: QuickcutEvent[]): string {
  const lines: string[] = [];
  const probes = (from: number, to: number) => [0.1, 0.3, 0.6, 0.9].map((r) => Math.round(from + (to - from) * r)).join('/');
  for (const e of events) {
    if ((e.type === 'head' || e.type === 'tail') && e.fromVideoS != null && e.toVideoS != null && e.toVideoS - e.fromVideoS > 20) {
      lines.push(`- ${e.type === 'head' ? '片头' : '片尾'}区间 ${e.fromVideoS.toFixed(0)}–${e.toVideoS.toFixed(0)}s：先在 ${probes(e.fromVideoS, e.toVideoS)}s 四处抽帧探索，再定${e.type === 'head' ? '开头' : '收尾'}窗口`);
    }
    if (e.type === 'pause' && e.audio?.talk && e.audio.fromS != null && e.audio.toS != null) {
      const beatFrom = Math.max(e.audio.fromS, e.audio.toS - 6);
      lines.push(`- 停顿有人声（${e.audio.fromS.toFixed(0)}–${e.audio.toS.toFixed(0)}s）：对话 beat 取人声区收尾——在 ${beatFrom.toFixed(0)}–${e.audio.toS.toFixed(0)}s 附近抽帧微调，取 ≤6s（告别/笑声/重新上车的情绪落点；画面实在不可用才放弃，提交时写明原因）`);
    }
  }
  return lines.length ? `\n# 本片硬步骤（skill「两步硬流程」逐条落实）\n${lines.join('\n')}\n` : '';
}

// ---------- 事件日志 ----------

// 助手消息 → 纯文本（content 可能是 string 或 block 数组）
function extractText(msg: any): string {
  if (!msg || msg.role !== 'assistant') return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
  return '';
}

// Agent 事件 → 一行日志（null = 不记）：只记工具调用与助手文字输出，流式增量事件太吵不记
export function formatAgentEvent(ev: any): string | null {
  if (ev?.type === 'tool_execution_start') {
    if (ev.toolName === 'ffmpeg') {
      const bin = ev.args?.bin ?? 'ffmpeg';
      const args = Array.isArray(ev.args?.args) ? ev.args.args.join(' ') : '';
      return `→ ${bin} ${args}`.slice(0, 300);
    }
    if (ev.toolName === 'commit_cuts') return `→ commit_cuts ${JSON.stringify(ev.args?.cuts ?? [])}`;
    return `→ ${String(ev.toolName)}`;
  }
  if (ev?.type === 'message_end') {
    const text = extractText(ev.message);
    return text ? `agent: ${text.slice(0, 500)}` : null;
  }
  return null;
}

// ---------- 主入口 ----------

export interface QuickcutAgentLike {
  prompt: (p: string) => Promise<unknown>;
}

export async function refineActsWithAgent(opts: {
  video: string;              // merged dash 视频路径
  videoDurationS: number;
  events: QuickcutEvent[];    // analyze 的事件菜单
  plan: QuickcutPlan;         // L0 兜底计划（失败回退对象）
  llm: ResolvedLlm;
  log?: (msg: string) => void;
  agentFactory?: (systemPrompt: string, tools: any[]) => QuickcutAgentLike; // 测试注入口
  workdir?: string;           // 测试注入口（默认 mkdtemp）
}): Promise<QuickcutPlan> {
  const { video, videoDurationS, events, plan, llm, log = () => {}, agentFactory } = opts;
  if (!llm.vision) {
    log(`[quickcut] L1 跳过：模型无视觉能力（${llm.describe}），沿用 L0 计划`);
    return plan;
  }
  const instructions = loadSkillInstructions();
  if (!instructions) {
    log('[quickcut] L1 跳过：skills/quickcut/SKILL.md 缺失，沿用 L0 计划');
    return plan;
  }
  const workdir = opts.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-qc-'));
  try {
    const committedRef: { cuts: Required<QuickcutCut>[] | null } = { cuts: null };
    const tools = [
      buildFfmpegTool(video, workdir, log),
      buildCommitTool(videoDurationS, (cuts) => {
        committedRef.cuts = cuts;
      }),
    ];
    const systemPrompt = buildSystemPrompt(instructions);
    let turns = 0;
    let agent: QuickcutAgentLike;
    if (agentFactory) {
      agent = agentFactory(systemPrompt, tools);
    } else {
      const a = new Agent({
        initialState: { systemPrompt, model: llm.model },
        streamFn: agentStreamFn(llm),
        // 安全阀：提交完成或达到轮数上限即停
        shouldStopAfterTurn: () => committedRef.cuts != null || ++turns >= MAX_TURNS,
      });
      a.state.tools = tools;
      // 事件流记日志：工具调用（ffmpeg 命令/commit_cuts 剪辑点）与助手文字输出
      a.subscribe((ev) => {
        const line = formatAgentEvent(ev);
        if (line) log(`[quickcut] ${line}`);
      });
      agent = a;
    }
    log(`[quickcut] L1 启动（${llm.describe}）：skill 驱动自由圈幕，最多 ${MAX_TURNS} 轮`);
    await agent.prompt(buildUserPrompt({ video, videoDurationS, events, plan }));

    if (!committedRef.cuts) {
      log('[quickcut] L1 未提交剪辑点（轮数用尽或 agent 放弃），沿用 L0 计划');
      return plan;
    }
    const refined = planFromCuts(committedRef.cuts);
    log(`[quickcut] L1 完成：${refined.acts.length} 幕共 ${refined.totalS.toFixed(1)}s`);
    return refined;
  } catch (e) {
    log(`[quickcut] L1 异常，沿用 L0 计划：${e instanceof Error ? e.message : String(e)}`);
    return plan;
  } finally {
    if (!opts.workdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}
