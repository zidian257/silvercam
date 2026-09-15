// 快剪 L1 agent 抛光层：VLM 逐幕抽帧，在 L0 窗口 ±15s 内平移选出「最具观赏性」的等长子窗口。
// 纪律：L1 永远是可降级层——模型无视觉、agent 异常、未提交剪辑点，一律退回 L0 原计划，绝不炸掉任务。
// 硬约束由 commit_cuts 的 validateCuts 把守：幕时长不可改、幕序不可变、窗口不出 L0 ±15s 的界。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { QuickcutPlan } from '../modules/quickcut.ts';
import { agentStreamFn } from './llm.ts';
import type { ResolvedLlm } from './llm.ts';

// 幕窗口允许在 L0 基础上外扩的秒数（agent 只能在这个范围内平移）
export const WINDOW_SLACK_S = 15;
// 时长容差：浮点抖动不算改时长
export const DURATION_TOLERANCE_S = 0.1;
// 抽帧默认数量与上限
const DEFAULT_FRAMES = 6;
const MAX_FRAMES = 12;
// 安全阀：agent 最多跑的轮数（6 幕各看一次 + 提交一次，8 轮足够）
const MAX_TURNS = 8;

export interface QuickcutCut {
  key: string;
  start: number;
  end: number;
}

export type FrameContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface FrameSample {
  frames: { tS: number; data: string }[]; // tS 为帧在视频里的秒
  content: FrameContentBlock[]; // 直接可进 tool result / LLM context 的内容块
}

// ---------- 抽帧 ----------

function grabFrame(video: string, tS: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-ss', tS.toFixed(3), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-1', out, '-y']);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) resolve();
      else reject(new Error(`抽取 ${tS.toFixed(1)}s 处帧失败${code ? `（ffmpeg 退出码 ${code}）` : '（无帧产出，可能超出视频长度）'}：${err.trim().slice(-300)}`));
    });
  });
}

// 从 video 的 [start,end] 窗口均匀抽 n 帧（默认 6、上限 12、960px 宽 jpeg）
export async function extractFrames({ video, start, end, n = DEFAULT_FRAMES }: {
  video: string;
  start: number;
  end: number;
  n?: number;
}): Promise<FrameSample> {
  if (!(end > start)) throw new Error(`抽帧窗口非法：[${start}, ${end}]`);
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(n)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-qc-'));
  try {
    const times = Array.from({ length: count }, (_, i) => start + ((end - start) * (i + 0.5)) / count);
    const files = times.map((_, i) => path.join(dir, `f${String(i + 1).padStart(2, '0')}.jpg`));
    await Promise.all(times.map((t, i) => grabFrame(video, t, files[i])));
    const frames = times.map((t, i) => ({ tS: Math.round(t * 10) / 10, data: fs.readFileSync(files[i]).toString('base64') }));
    const text = [`窗口 [${start.toFixed(1)}, ${end.toFixed(1)}] 均匀抽取 ${count} 帧：`]
      .concat(frames.map((f, i) => `frame ${i + 1}: ${f.tS.toFixed(1)}s`))
      .join('\n');
    const content: FrameContentBlock[] = [{ type: 'text', text }];
    for (const f of frames) content.push({ type: 'image', data: f.data, mimeType: 'image/jpeg' });
    return { frames, content };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 剪辑点校验 ----------

const round2 = (x: number) => Math.round(x * 100) / 100;

// 校验 agent 提交的剪辑点；全部通过返回按幕序排好的归一化数组，任一违规抛错（报回 LLM 重试）
export function validateCuts(cuts: QuickcutCut[], plan: QuickcutPlan): QuickcutCut[] {
  if (!Array.isArray(cuts)) throw new Error('cuts 必须是数组');
  const acts = plan.acts;
  if (cuts.length !== acts.length) {
    throw new Error(`幕数不符：收到 ${cuts.length} 幕，应为 ${acts.length} 幕（${acts.map((a) => a.key).join(' / ')}）`);
  }
  const byKey = new Map(acts.map((a, i) => [a.key, { act: a, index: i }]));
  const seen = new Set<string>();
  const checked: (QuickcutCut & { index: number })[] = [];
  for (const c of cuts) {
    const l0 = byKey.get(c.key);
    if (!l0) throw new Error(`未知幕 key: ${c.key}（应为 ${acts.map((a) => a.key).join(' / ')}）`);
    if (seen.has(c.key)) throw new Error(`幕 ${c.key} 重复提交`);
    seen.add(c.key);
    const { start, end } = c;
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`幕 ${c.key} 的 start/end 不是有限数值`);
    if (!(start < end)) throw new Error(`幕 ${c.key} 窗口非法：start(${start}) 必须小于 end(${end})`);
    const l0Dur = l0.act.end - l0.act.start;
    const dur = end - start;
    if (Math.abs(dur - l0Dur) > DURATION_TOLERANCE_S) {
      throw new Error(`幕 ${c.key}（${l0.act.label}）时长不可改：L0 为 ${l0Dur.toFixed(2)}s，提交为 ${dur.toFixed(2)}s（只允许平移窗口）`);
    }
    const lo = l0.act.start - WINDOW_SLACK_S;
    const hi = l0.act.end + WINDOW_SLACK_S;
    if (start < lo - 1e-6 || end > hi + 1e-6) {
      throw new Error(`幕 ${c.key}（${l0.act.label}）出界：提交 [${start}, ${end}]，允许范围 [${lo.toFixed(2)}, ${hi.toFixed(2)}]（L0 窗口 ±${WINDOW_SLACK_S}s）`);
    }
    checked.push({ key: c.key, start, end, index: l0.index });
  }
  for (const a of acts) {
    if (!seen.has(a.key)) throw new Error(`缺少幕 ${a.key}（${a.label}）的剪辑点`);
  }
  // 幕顺序与 L0 一致且不重叠
  checked.sort((a, b) => a.index - b.index);
  for (let i = 1; i < checked.length; i++) {
    if (checked[i].start < checked[i - 1].end - 1e-6) {
      throw new Error(`幕 ${checked[i].key} 与前一幕 ${checked[i - 1].key} 重叠：[${checked[i].start}, ${checked[i].end}] vs [${checked[i - 1].start}, ${checked[i - 1].end}]（幕序不可变、不得重叠）`);
    }
  }
  return checked.map(({ key, start, end }) => ({ key, start: round2(start), end: round2(end) }));
}

// ---------- prompt ----------

// 六幕的叙事含义（agent 理解「为什么要这一幕」才选得准画面）
const ACT_NARRATIVE: Record<string, string> = {
  departure: '开车门、取车准备的车内画面，叙事起点',
  rollout: '起步上路的第一段骑行',
  climb: '坡度最大、最努力的爬坡段',
  summit: '海拔最高处停下的一刻',
  descent: '下坡极速段',
  return: '回到车边收车的车内画面，叙事终点',
};

function actDigest(plan: QuickcutPlan): string {
  return plan.acts
    .map((a, i) => `${i + 1}. ${a.key}「${a.label}」${a.start.toFixed(2)}–${a.end.toFixed(2)}s（时长 ${(a.end - a.start).toFixed(2)}s）— L0 依据：${a.reason || '无'}`)
    .join('\n');
}

function buildSystemPrompt(plan: QuickcutPlan): string {
  const narrative = plan.acts.map((a) => `- ${a.key}「${a.label}」：${ACT_NARRATIVE[a.key] ?? a.label}`).join('\n');
  return `你是骑行视频快剪的剪辑助理。这是一次「4+2 爬山」骑行，成片约 30s，由 ${plan.acts.length} 幕组成：
${narrative}

L0（确定性分析）已按 FIT 数据为每幕圈出窗口与依据：
${actDigest(plan)}

你的任务是做画面层面的抛光：对每幕，用 sample_frames 查看该幕 L0 窗口 ±${WINDOW_SLACK_S}s 范围内的画面，选出其中「最具观赏性」的等长连续子窗口。
- 好画面：有主体（自己/骑友）、有速度感、仪表盘读数清晰、镜头稳定
- 差画面：手挡镜头、转场模糊、低头调整装备的瞬间

硬约束（违反会被拒绝，需修正后重新提交）：
- 每幕时长必须与 L0 完全一致，只允许平移窗口，不许伸缩
- 不得改变幕的顺序，幕与幕之间不得重叠
- 每幕窗口不得超出 L0 窗口 ±${WINDOW_SLACK_S}s 的范围

全部幕都选好后，调用一次 commit_cuts 提交所有幕的剪辑点。`;
}

function buildUserPrompt(plan: QuickcutPlan): string {
  return `L0 已圈出 ${plan.acts.length} 幕（merged 视频秒）：
${actDigest(plan)}

请逐幕用 sample_frames 考察 L0 窗口 ±${WINDOW_SLACK_S}s 内的画面，为每幕选出最具观赏性的等长连续子窗口；全部选好后调用一次 commit_cuts 提交。记住：时长不可改、幕序不可变、不得出界。`;
}

// ---------- 工具 ----------

function buildTools(video: string, plan: QuickcutPlan, onCommit: (cuts: QuickcutCut[]) => void): AgentTool<any>[] {
  const sampleFrames = {
    name: 'sample_frames',
    label: '抽帧',
    description: `从视频 [start, end] 窗口（视频秒）均匀抽 n 帧（默认 ${DEFAULT_FRAMES}，上限 ${MAX_FRAMES}），返回每帧时间戳与 jpeg 图像，用于评估画面观赏性`,
    parameters: Type.Object({
      start: Type.Number({ description: '窗口起点（视频秒）' }),
      end: Type.Number({ description: '窗口终点（视频秒）' }),
      n: Type.Optional(Type.Number({ description: `帧数，默认 ${DEFAULT_FRAMES}，上限 ${MAX_FRAMES}` })),
    }),
    execute: async (_id: string, params: unknown) => {
      const p = params as { start: number; end: number; n?: number };
      const s = Math.max(0, p.start);
      if (!(p.end > s)) throw new Error(`窗口非法：start=${p.start} end=${p.end}`);
      const r = await extractFrames({ video, start: s, end: p.end, n: p.n });
      return { content: r.content, details: { frames: r.frames.map((f) => f.tS) } };
    },
  };

  const commitCuts = {
    name: 'commit_cuts',
    label: '提交剪辑点',
    description: `提交全部幕的最终剪辑窗口（一次调用覆盖所有幕）。每幕时长必须与 L0 一致，只允许在 L0 窗口 ±${WINDOW_SLACK_S}s 内平移，幕序不可变、不得重叠`,
    parameters: Type.Object({
      cuts: Type.Array(
        Type.Object({
          key: Type.String({ description: '幕 key，必须与 L0 完全一致' }),
          start: Type.Number({ description: '窗口起点（视频秒）' }),
          end: Type.Number({ description: '窗口终点（视频秒）' }),
        }),
      ),
    }),
    execute: async (_id: string, params: unknown) => {
      const valid = validateCuts((params as { cuts: QuickcutCut[] }).cuts, plan); // 不通过则抛错，报回 LLM 重试
      onCommit(valid);
      return { content: [{ type: 'text' as const, text: '已确认' }], details: { cuts: valid }, terminate: true };
    },
  };

  return [sampleFrames, commitCuts];
}

// ---------- 主入口 ----------

export interface QuickcutAgentLike {
  prompt: (p: string) => Promise<unknown>;
}

export async function refineActsWithAgent(opts: {
  video: string;            // merged dash 视频路径
  plan: QuickcutPlan;       // L0 计划
  llm: ResolvedLlm;
  log?: (msg: string) => void;
  agentFactory?: (systemPrompt: string, tools: any[]) => QuickcutAgentLike; // 测试注入口
}): Promise<QuickcutPlan> {
  const { video, plan, llm, log = () => {}, agentFactory } = opts;
  if (!llm.vision) {
    log(`[quickcut] L1 跳过：模型无视觉能力（${llm.describe}），沿用 L0 计划`);
    return plan;
  }
  if (!plan.acts.length) return plan;
  try {
    const committedRef: { cuts: QuickcutCut[] | null } = { cuts: null };
    const tools = buildTools(video, plan, (cuts) => {
      committedRef.cuts = cuts;
    });
    const systemPrompt = buildSystemPrompt(plan);
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
      agent = a;
    }
    log(`[quickcut] L1 启动（${llm.describe}）：${plan.acts.length} 幕逐幕抽帧选窗，最多 ${MAX_TURNS} 轮`);
    await agent.prompt(buildUserPrompt(plan));

    const committed = committedRef.cuts;
    if (!committed) {
      log('[quickcut] L1 未提交剪辑点（轮数用尽或 agent 放弃），沿用 L0 计划');
      return plan;
    }
    const byKey = new Map(committed.map((c) => [c.key, c]));
    const acts = plan.acts.map((a) => {
      const c = byKey.get(a.key)!;
      return { ...a, start: c.start, end: c.end };
    });
    const totalS = acts.reduce((s, a) => s + (a.end - a.start), 0);
    log(`[quickcut] L1 完成：${acts.length} 幕已按画面微调，成片 ${totalS.toFixed(1)}s`);
    return { ...plan, acts, totalS };
  } catch (e) {
    log(`[quickcut] L1 异常，沿用 L0 计划：${e instanceof Error ? e.message : String(e)}`);
    return plan;
  }
}
