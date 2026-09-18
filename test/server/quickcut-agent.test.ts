import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSkillInstructions,
  validateCuts,
  refineActsWithAgent,
} from '../../src/server/quickcut-agent.ts';
import type { QuickcutPlan } from '../../src/modules/quickcut.ts';

const VIDEO = path.resolve('fixtures/out/DJI_20260906100100.MP4');
if (!fs.existsSync(VIDEO)) throw new Error('fixture 视频缺失');

const fakeLlm = (over: Record<string, unknown> = {}) => ({ vision: true, describe: 'test/vlm', model: {}, ...over }) as any;

const L0_PLAN: QuickcutPlan = {
  acts: [{ key: 'speed', label: '极速', start: 4, end: 12, reason: '极速 42.3km/h' }],
  dropped: [],
  totalS: 8,
};
const EVENTS = [
  { type: 'speed_peak' as const, fitS: 1631, videoS: 1764, windowS: 8, score: 97, desc: '极速 42.3km/h' },
  { type: 'pause' as const, fitS: 1435, videoS: null, windowS: 4, score: 100, desc: '停顿 266s' },
];

// ---------- loadSkillInstructions ----------

test('loadSkillInstructions: 读出 SKILL.md 正文并剥掉 frontmatter', () => {
  const body = loadSkillInstructions();
  assert.ok(body, 'skills/quickcut/SKILL.md 应存在');
  assert.ok(!body.startsWith('---'), 'frontmatter 应被剥离');
  assert.match(body, /# 快剪/);
  assert.match(body, /宿主差异/); // 内嵌/外部双宿主适配段必须在
});

// ---------- validateCuts ----------

test('validateCuts: 合法 cuts 归一化（补默认 label、保留两位小数）', () => {
  const cuts = validateCuts([
    { start: 3, end: 7, label: '出发' },
    { start: 10.123456, end: 15.987654 },
  ], 100);
  assert.deepEqual(cuts, [
    { start: 3, end: 7, label: '出发' },
    { start: 10.12, end: 15.99, label: '片段2' },
  ]);
});

test('validateCuts: 护栏——空/超幕数/窗口非法/超时长/重叠/总时长', () => {
  assert.throws(() => validateCuts([], 100), /至少一条/);
  assert.throws(() => validateCuts(Array.from({ length: 13 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 })), 1000), /超上限/);
  assert.throws(() => validateCuts([{ start: 9, end: 3 }], 100), /cuts\[0\].*非法/);
  assert.throws(() => validateCuts([{ start: 0, end: 101 }], 100), /超出视频时长/);
  assert.throws(() => validateCuts([{ start: 0, end: 10 }, { start: 9, end: 12 }], 100), /重叠/);
  assert.throws(() => validateCuts([{ start: 0, end: 120 }, { start: 130, end: 200 }], 300), /总时长/);
});

// ---------- refineActsWithAgent ----------

test('refineActsWithAgent: 模型无视觉直接回退 L0（不创建 agent）', async () => {
  let factoryCalled = false;
  const plan = await refineActsWithAgent({
    video: VIDEO, videoDurationS: 15, events: EVENTS, plan: L0_PLAN,
    llm: fakeLlm({ vision: false }),
    agentFactory: () => { factoryCalled = true; throw new Error('不应创建'); },
  });
  assert.equal(plan, L0_PLAN);
  assert.equal(factoryCalled, false);
});

test('refineActsWithAgent: agent 调 commit_cuts → 返回 planFromCuts 计划', async () => {
  const seen: { systemPrompt?: string; userPrompt?: string } = {};
  const plan = await refineActsWithAgent({
    video: VIDEO, videoDurationS: 15, events: EVENTS, plan: L0_PLAN,
    llm: fakeLlm(),
    agentFactory: (systemPrompt, tools) => {
      seen.systemPrompt = systemPrompt;
      return {
        prompt: async (p: string) => {
          seen.userPrompt = p;
          const commit = tools.find((t: any) => t.name === 'commit_cuts');
          await commit.execute('t1', { cuts: [{ start: 2, end: 9, label: '爬坡' }] });
        },
      };
    },
  });
  assert.equal(plan.acts.length, 1);
  assert.equal(plan.acts[0].label, '爬坡');
  assert.deepEqual([plan.acts[0].start, plan.acts[0].end], [2, 9]);
  assert.equal(plan.totalS, 7);
  // system prompt = skill 指令 + 宿主适配；user prompt 带事件菜单与视频信息
  assert.match(seen.systemPrompt!, /# 快剪/);
  assert.match(seen.systemPrompt!, /宿主适配/);
  assert.match(seen.userPrompt!, /power_peak|speed_peak/);
  assert.match(seen.userPrompt!, /15\.00s/);
});

test('refineActsWithAgent: commit 非法剪辑点 → 工具抛错（报回 LLM 重试），未提交则回退 L0', async () => {
  const plan = await refineActsWithAgent({
    video: VIDEO, videoDurationS: 15, events: EVENTS, plan: L0_PLAN,
    llm: fakeLlm(),
    agentFactory: (_s, tools) => ({
      prompt: async () => {
        const commit = tools.find((t: any) => t.name === 'commit_cuts');
        await assert.rejects(() => commit.execute('t1', { cuts: [{ start: 0, end: 99 }] }), /超出视频时长/);
        // agent 放弃，不再重试
      },
    }),
  });
  assert.equal(plan, L0_PLAN);
});

test('refineActsWithAgent: agent 抛异常 → 回退 L0', async () => {
  const plan = await refineActsWithAgent({
    video: VIDEO, videoDurationS: 15, events: EVENTS, plan: L0_PLAN,
    llm: fakeLlm(),
    agentFactory: () => ({ prompt: async () => { throw new Error('LLM 网络炸了'); } }),
  });
  assert.equal(plan, L0_PLAN);
});

// ---------- ffmpeg 工具 ----------

const mkFfmpegTool = async (workdir: string) => {
  let tool: any = null;
  await refineActsWithAgent({
    video: VIDEO, videoDurationS: 15, events: EVENTS, plan: L0_PLAN,
    llm: fakeLlm(),
    workdir,
    agentFactory: (_s, tools) => {
      tool = tools.find((t: any) => t.name === 'ffmpeg');
      return { prompt: async () => {} }; // 不提交，走回退；工具已截获
    },
  });
  return tool;
};

test('ffmpeg 工具：抽帧产物自动回传为 image 内容块', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-qc-test-'));
  try {
    const tool = await mkFfmpegTool(workdir);
    const r = await tool.execute('x', { args: ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-i', VIDEO, '-frames:v', '1', '-vf', 'scale=160:-2', 'f2.jpg'] });
    assert.equal(r.details.exit, 0);
    assert.deepEqual(r.details.images, ['f2.jpg']);
    const imgs = r.content.filter((c: any) => c.type === 'image');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].mimeType, 'image/jpeg');
    assert.ok(imgs[0].data.length > 1000, 'base64 帧数据不该是空壳');
    assert.match(r.content[0].text, /exit=0/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('ffmpeg 工具：ffprobe 探测时长；非法命令不回退任务（exit 透出）', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-qc-test-'));
  try {
    const tool = await mkFfmpegTool(workdir);
    const probe = await tool.execute('x', { bin: 'ffprobe', args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', VIDEO] });
    assert.equal(probe.details.exit, 0);
    assert.match(probe.content[0].text, /15/);
    const bad = await tool.execute('x', { args: ['-i', '/nope/missing.mp4', '-f', 'null', '-'] });
    assert.notEqual(bad.details.exit, 0);
    assert.equal(bad.details.images.length, 0);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});
