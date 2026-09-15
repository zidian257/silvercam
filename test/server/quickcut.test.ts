import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSamples, fitToVideo, analyzeQuickcut, renderQuickcut, quickcutOutputPathFor,
} from '../../src/modules/quickcut.ts';

// 真实骑行的归一化样本（fixtures/quickcut-samples.json，已剔除位置与绝对时间）
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve('fixtures/quickcut-samples.json'), 'utf8'));

// 录制该素材的任务锚定事实（merged 两段；videoT = fitElapsed − offsetSeconds）
const SEGMENTS = [
  { videoStartS: 0, durationS: 1235.6, offsetSeconds: -134.08 },
  { videoStartS: 1235.6, durationS: 1223.34, offsetSeconds: 1102.92 },
];
const VIDEO_DURATION = 2458.94;

// ---------- normalizeSamples ----------

test('normalizeSamples: 时间戳转流逝秒并排序，自动暂停的时间空洞被保留', () => {
  const raw = [
    { t: '2026-01-01T01:00:10.000Z', speed: 2 },
    { t: '2026-01-01T01:00:00.000Z', speed: 1 },
    { t: '2026-01-01T01:02:00.000Z', speed: 3 }, // 暂停 110s 的空洞
  ];
  const s = normalizeSamples(raw, Date.parse('2026-01-01T01:00:00.000Z'));
  assert.deepEqual(s.map((x) => x.tS), [0, 10, 120]);
  assert.equal(s[2].tS - s[1].tS, 110); // 下标差 1，流逝差 110 —— 空洞没有被压缩
});

// ---------- fitToVideo ----------

test('fitToVideo: 逐段覆盖映射；未覆盖返回 null', () => {
  assert.equal(fitToVideo(SEGMENTS, 542), 676.08);          // seg0: 542−(−134.08)
  assert.equal(fitToVideo(SEGMENTS, 1631), 1235.6 + 528.08); // seg1: 1235.6+(1631−1102.92)
  assert.equal(fitToVideo(SEGMENTS, -200), null);            // 首段覆盖之前（车内段）
  assert.equal(fitToVideo(SEGMENTS, 99999), null);
});

// ---------- analyzeQuickcut：真实素材六幕还原 ----------

// 基准来自成片抽帧的人工核验（overlay 读数与 FIT 逐一比对过）
test('analyzeQuickcut: 4+2 爬山六幕全部命中基准', () => {
  const plan = analyzeQuickcut({ samples: FIXTURE.samples, segments: SEGMENTS, videoDurationS: VIDEO_DURATION });
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.acts.length, 6);
  const byKey = Object.fromEntries(plan.acts.map((a) => [a.key, a]));

  assert.deepEqual([byKey.departure.start, byKey.departure.end], [3, 7]); // 开车门（视频开头车内段 134s）

  const center = (a: { start: number; end: number }) => (a.start + a.end) / 2;
  assert.ok(center(byKey.rollout) > 138 && center(byKey.rollout) < 148, `上路 ${center(byKey.rollout)}`);
  assert.ok(center(byKey.climb) > 1410 && center(byKey.climb) < 1430, `爬坡 ${center(byKey.climb)}`); // 301W/177bpm/+3.2%（1419s 帧核验）
  assert.ok(center(byKey.summit) > 1440 && center(byKey.summit) < 1458, `登顶 ${center(byKey.summit)}`); // 海拔 335m 停车（1448s 帧核验）
  assert.ok(center(byKey.descent) > 1755 && center(byKey.descent) < 1772, `放坡 ${center(byKey.descent)}`); // 42.3km/h（1760s 帧核验）

  assert.ok(Math.abs(byKey.return.start - 2453.94) < 0.5 && Math.abs(byKey.return.end - 2457.94) < 0.5, '收尾落在视频最后 4s');
  assert.ok(Math.abs(plan.totalS - 30) < 0.5, `总时长 ${plan.totalS}`);

  // 幕序即叙事序
  const keys = plan.acts.map((a) => a.key);
  assert.deepEqual(keys, ['departure', 'rollout', 'climb', 'summit', 'descent', 'return']);
});

test('analyzeQuickcut: 开头没有车内段时出发/收尾两幕降级丢弃', () => {
  // 合成一段开表即骑、骑完即停的数据：preamble/tail 都不存在
  const samples = Array.from({ length: 600 }, (_, i) => ({
    tS: i, speed: 5, altitude: 100 + i * 0.5, heart_rate: 150, power: 200, grade: 4,
  }));
  const segments = [{ videoStartS: 0, durationS: 600, offsetSeconds: 0 }]; // 视频与 FIT 同步开始、同步结束
  const plan = analyzeQuickcut({ samples, segments, videoDurationS: 600 });
  const droppedKeys = plan.dropped.map((d) => d.key);
  assert.ok(droppedKeys.includes('departure'));
  assert.ok(droppedKeys.includes('return'));
  assert.ok(plan.acts.every((a) => a.key !== 'departure' && a.key !== 'return'));
});

test('analyzeQuickcut: 空样本直接报错；未知场景报错', () => {
  assert.throws(() => analyzeQuickcut({ samples: [], segments: SEGMENTS, videoDurationS: 100 }), /FIT 样本/);
  assert.throws(() => analyzeQuickcut({ samples: FIXTURE.samples, segments: SEGMENTS, videoDurationS: 100, scenario: 'nope' }), /未知快剪场景/);
});

// ---------- renderQuickcut 冒烟 ----------

test('renderQuickcut: 两幕各 2s 合成 ≈4s 成片', { timeout: 120000 }, async () => {
  const src = path.resolve('fixtures/out/DJI_20260906100100.MP4');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-quickcut-')), 'cut.mp4');
  const r = await renderQuickcut({ video: src, acts: [{ start: 0, end: 2 }, { start: 4, end: 6 }], out });
  assert.equal(r.out, out);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.statSync(out).size > 100_000);
  // 时长 ≈4s
  const { execFileSync } = await import('node:child_process');
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim());
  assert.ok(Math.abs(dur - 4) < 0.3, `时长 ${dur}`);
});

test('quickcutOutputPathFor: 同目录、去 _dash、重名自增', () => {
  const p = quickcutOutputPathFor('/tmp/movies/2026-09-13/DJI_x_merged_dash.mp4');
  assert.match(p, /\/tmp\/movies\/2026-09-13\/DJI_x_merged_kuaijian\.mp4$/);
});
