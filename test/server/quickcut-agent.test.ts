import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeQuickcut } from '../../src/modules/quickcut.ts';
import { extractFrames, validateCuts, refineActsWithAgent, WINDOW_SLACK_S } from '../../src/server/quickcut-agent.ts';
import type { ResolvedLlm } from '../../src/server/llm.ts';

// 与 test/server/quickcut.test.ts 同一份真实素材锚定（merged 两段；videoT = fitElapsed − offsetSeconds）
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve('fixtures/quickcut-samples.json'), 'utf8'));
const SEGMENTS = [
  { videoStartS: 0, durationS: 1235.6, offsetSeconds: -134.08 },
  { videoStartS: 1235.6, durationS: 1223.34, offsetSeconds: 1102.92 },
];
const VIDEO_DURATION = 2458.94;
const VIDEO = path.resolve('fixtures/out/DJI_20260906100100.MP4'); // 15s 实机素材

const PLAN = analyzeQuickcut({ samples: FIXTURE.samples, segments: SEGMENTS, videoDurationS: VIDEO_DURATION });
const byKey = Object.fromEntries(PLAN.acts.map((a) => [a.key, a]));

// 全部幕整体平移 delta 秒（合法 cuts 的快捷构造）
const shifted = (delta: number) => PLAN.acts.map((a) => ({ key: a.key, start: a.start + delta, end: a.end + delta }));

const fakeLlm = (vision: boolean) =>
  ({ models: null, model: null, apiKey: null, vision, describe: `fake/${vision ? 'vision' : 'novision'}` }) as unknown as ResolvedLlm;

// ---------- extractFrames ----------

test('extractFrames: 均匀抽 n 帧，产出可解码 jpeg，时间戳在窗口内递增', { timeout: 60000 }, async () => {
  const r = await extractFrames({ video: VIDEO, start: 1, end: 9, n: 4 });
  assert.equal(r.frames.length, 4);
  const images = r.content.filter((b) => b.type === 'image');
  assert.equal(images.length, 4);
  for (const img of images) {
    assert.equal(img.type === 'image' ? img.mimeType : null, 'image/jpeg');
    const buf = Buffer.from(img.type === 'image' ? img.data : '', 'base64');
    assert.ok(buf.length > 1000, `jpeg 大小 ${buf.length}`);
    assert.deepEqual([buf[0], buf[1]], [0xff, 0xd8]); // JPEG SOI
  }
  const text = r.content.find((b) => b.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.match(text.text, /frame 1: \d+\.\ds/);
  assert.match(text.text, /frame 4: \d+\.\ds/);
  for (let i = 1; i < r.frames.length; i++) assert.ok(r.frames[i].tS > r.frames[i - 1].tS, '时间戳递增');
  assert.ok(r.frames[0].tS >= 1 && r.frames[r.frames.length - 1].tS <= 9, '时间戳在窗口内');
});

test('extractFrames: n 超上限钳到 12；非法窗口抛错', { timeout: 60000 }, async () => {
  const r = await extractFrames({ video: VIDEO, start: 0.5, end: 14.5, n: 99 });
  assert.equal(r.frames.length, 12);
  await assert.rejects(extractFrames({ video: VIDEO, start: 5, end: 5 }), /窗口非法/);
});

// ---------- validateCuts ----------

test('validateCuts: 合法平移通过，返回按幕序排好的结果', () => {
  const cuts = shifted(5).reverse(); // 乱序提交也应按 L0 幕序返回
  const r = validateCuts(cuts, PLAN);
  assert.deepEqual(r.map((c) => c.key), PLAN.acts.map((a) => a.key));
  for (const c of r) {
    assert.ok(Math.abs(c.start - (byKey[c.key].start + 5)) < 0.01, `${c.key} start`);
    assert.ok(Math.abs(c.end - (byKey[c.key].end + 5)) < 0.01, `${c.key} end`);
  }
});

test('validateCuts: 时长改了被拒', () => {
  const cuts = shifted(0);
  cuts[2] = { key: cuts[2].key, start: cuts[2].start, end: cuts[2].end + 1 }; // climb 拉长 1s
  assert.throws(() => validateCuts(cuts, PLAN), /时长不可改/);
});

test('validateCuts: 超出 L0 ±15s 界被拒', () => {
  const cuts = shifted(0);
  cuts[0] = { key: 'departure', start: byKey.departure.start - WINDOW_SLACK_S - 1, end: byKey.departure.end - WINDOW_SLACK_S - 1 };
  assert.throws(() => validateCuts(cuts, PLAN), /出界/);
});

test('validateCuts: 缺 key / 重复 key / 未知 key 被拒', () => {
  assert.throws(() => validateCuts(shifted(0).slice(1), PLAN), /幕数不符/);
  const dup = shifted(0);
  dup[5] = { ...dup[4] }; // return 换成第二个 descent
  assert.throws(() => validateCuts(dup, PLAN), /重复提交/);
  const unknown = shifted(0);
  unknown[5] = { key: 'bonus', start: 1, end: 2 };
  assert.throws(() => validateCuts(unknown, PLAN), /未知幕/);
});

test('validateCuts: start>=end 与幕间重叠被拒', () => {
  const bad = shifted(0);
  bad[1] = { key: 'rollout', start: 200, end: 200 };
  assert.throws(() => validateCuts(bad, PLAN), /窗口非法/);
  // climb 平移到最靠后、summit 平移到最靠前（各自仍在 ±15s 界内）→ 两幕必然重叠
  const overlap = shifted(0);
  const climbDur = byKey.climb.end - byKey.climb.start;
  const summitDur = byKey.summit.end - byKey.summit.start;
  overlap[2] = { key: 'climb', start: byKey.climb.end + WINDOW_SLACK_S - climbDur, end: byKey.climb.end + WINDOW_SLACK_S };
  overlap[3] = { key: 'summit', start: byKey.summit.start - WINDOW_SLACK_S, end: byKey.summit.start - WINDOW_SLACK_S + summitDur };
  assert.ok(overlap[3].start < overlap[2].end, '前置：构造的两幕确实重叠');
  assert.throws(() => validateCuts(overlap, PLAN), /重叠/);
});

// ---------- refineActsWithAgent ----------

test('refineActsWithAgent: 正常路径——agent 抽帧后提交，计划被精确调整且 totalS 不变', { timeout: 60000 }, async () => {
  const logs: string[] = [];
  const r = await refineActsWithAgent({
    video: VIDEO,
    plan: PLAN,
    llm: fakeLlm(true),
    log: (m) => logs.push(m),
    agentFactory: (systemPrompt, tools) => ({
      prompt: async (userPrompt: string) => {
        assert.match(systemPrompt, /最具观赏性/);
        assert.match(systemPrompt, /时长不可改|时长必须与 L0 完全一致/);
        assert.match(userPrompt, /departure「出发」/);
        assert.match(userPrompt, /descent「放坡」/);
        // 假 agent 按剧本先 sample_frames 后 commit_cuts
        const sample = tools.find((t: any) => t.name === 'sample_frames');
        const fr = await sample.execute('x1', { start: 1, end: 9, n: 3 });
        assert.equal(fr.content.filter((b: any) => b.type === 'image').length, 3);
        const commit = tools.find((t: any) => t.name === 'commit_cuts');
        const cr = await commit.execute('x2', { cuts: shifted(5) });
        assert.equal(cr.terminate, true);
        assert.match(cr.content[0].text, /已确认/);
      },
    }),
  });
  assert.notEqual(r, PLAN); // 成功路径返回新计划
  assert.equal(r.acts.length, PLAN.acts.length);
  for (const a of r.acts) {
    const l0 = byKey[a.key];
    assert.ok(Math.abs(a.start - (l0.start + 5)) < 0.01, `${a.key} start 被平移`);
    assert.ok(Math.abs(a.end - (l0.end + 5)) < 0.01, `${a.key} end 被平移`);
    assert.equal(a.label, l0.label);
    assert.equal(a.reason, l0.reason); // key/label/reason 保留
  }
  assert.ok(Math.abs(r.totalS - PLAN.totalS) < 0.001, `totalS ${r.totalS} vs ${PLAN.totalS}`);
  assert.equal(PLAN.acts[0].start, byKey.departure.start, 'L0 原计划不被改动');
  assert.ok(logs.some((m) => /L1 完成/.test(m)));
});

test('refineActsWithAgent: commit 非法被拒后 agent 重试合法 cuts 成功', async () => {
  const r = await refineActsWithAgent({
    video: VIDEO,
    plan: PLAN,
    llm: fakeLlm(true),
    agentFactory: (_systemPrompt, tools) => ({
      prompt: async () => {
        const commit = tools.find((t: any) => t.name === 'commit_cuts');
        // ① 时长改了 → 工具抛错（真实环境下 agent 会把错误报回 LLM）
        const badDur = shifted(0);
        badDur[4] = { key: 'descent', start: byKey.descent.start, end: byKey.descent.end + 2 };
        await assert.rejects(commit.execute('y1', { cuts: badDur }), /时长不可改/);
        // ② 出界（超出 L0 ±15s）
        const oob = shifted(0);
        oob[0] = { key: 'departure', start: byKey.departure.start + WINDOW_SLACK_S + 1, end: byKey.departure.start + WINDOW_SLACK_S + 5 };
        await assert.rejects(commit.execute('y2', { cuts: oob }), /出界/);
        // ③ 缺 key
        await assert.rejects(commit.execute('y3', { cuts: shifted(0).slice(0, 5) }), /幕数不符/);
        // ④ 收到错误后重试合法 cuts → 成功
        const ok = await commit.execute('y4', { cuts: shifted(-3) });
        assert.equal(ok.terminate, true);
      },
    }),
  });
  for (const a of r.acts) {
    assert.ok(Math.abs(a.start - (byKey[a.key].start - 3)) < 0.01, `${a.key} start 被平移 −3`);
  }
  assert.ok(Math.abs(r.totalS - PLAN.totalS) < 0.001);
});

test('refineActsWithAgent: agent 跑完未提交 → 返回原 plan', async () => {
  const logs: string[] = [];
  const r = await refineActsWithAgent({
    video: VIDEO,
    plan: PLAN,
    llm: fakeLlm(true),
    log: (m) => logs.push(m),
    agentFactory: () => ({ prompt: async () => {} }), // 装死，不 commit
  });
  assert.equal(r, PLAN);
  assert.ok(logs.some((m) => /未提交/.test(m)));
});

test('refineActsWithAgent: agentFactory 抛错 → 返回原 plan', async () => {
  const logs: string[] = [];
  const r = await refineActsWithAgent({
    video: VIDEO,
    plan: PLAN,
    llm: fakeLlm(true),
    log: (m) => logs.push(m),
    agentFactory: () => {
      throw new Error('boom');
    },
  });
  assert.equal(r, PLAN);
  assert.ok(logs.some((m) => /L1 异常.*boom/.test(m)));
});

test('refineActsWithAgent: llm.vision=false → 不构造 agent 直接返回原 plan', async () => {
  let factoryCalled = false;
  const logs: string[] = [];
  const r = await refineActsWithAgent({
    video: VIDEO,
    plan: PLAN,
    llm: fakeLlm(false),
    log: (m) => logs.push(m),
    agentFactory: () => {
      factoryCalled = true;
      return { prompt: async () => {} };
    },
  });
  assert.equal(r, PLAN);
  assert.equal(factoryCalled, false);
  assert.ok(logs.some((m) => /无视觉能力/.test(m)));
});
