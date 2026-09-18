import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSamples, fitToVideo, detectEvents, assembleHeuristic, planFromCuts,
  renderQuickcut, quickcutOutputPathFor, scanPauseAudio, annotatePauseAudio,
} from '../../src/modules/quickcut.ts';
import type { NormalizedSample, QuickcutEvent } from '../../src/modules/quickcut.ts';

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

test('normalizeSamples: position 合法才透传', () => {
  const s = normalizeSamples([
    { t: 0, position: { lat: 31.0, lon: 121.0 } },
    { t: 1000, position: { lat: 'bad', lon: 121.0 } },
    { t: 2000 },
  ], 0);
  assert.deepEqual(s[0].position, { lat: 31.0, lon: 121.0 });
  assert.equal(s[1].position, null);
  assert.equal(s[2].position, null);
});

// ---------- fitToVideo ----------

test('fitToVideo: 逐段覆盖映射；未覆盖返回 null', () => {
  assert.equal(fitToVideo(SEGMENTS, 542), 676.08);          // seg0: 542−(−134.08)
  assert.equal(fitToVideo(SEGMENTS, 1631), 1235.6 + 528.08); // seg1: 1235.6+(1631−1102.92)
  assert.equal(fitToVideo(SEGMENTS, -200), null);            // 首段覆盖之前（车内段）
  assert.equal(fitToVideo(SEGMENTS, 99999), null);
});

// ---------- detectEvents：真实素材事件菜单 ----------

// 锚点来自成片抽帧的人工核验（overlay 读数与 FIT 逐一比对过）
test('detectEvents: 真实骑行出全事件菜单，锚点命中人工基准', () => {
  const events = detectEvents(FIXTURE.samples, { segments: SEGMENTS, videoDurationS: VIDEO_DURATION });
  const byType = (t: string) => events.filter((e) => e.type === t);

  // 通用事件
  assert.equal(byType('head')[0]?.videoS, 0);
  assert.match(byType('head')[0]?.desc ?? '', /134s/); // 开表前 134s 车内段
  assert.ok(Math.abs((byType('head')[0]?.toVideoS ?? 0) - 134.08) < 0.5, `片头区间终点 ${byType('head')[0]?.toVideoS}`);
  const tl = byType('tail')[0];
  assert.ok(tl, '片尾');
  assert.match(tl.desc, /83s/);
  assert.ok(tl.fromVideoS != null && tl.fromVideoS > 2370 && tl.fromVideoS < 2385, `片尾起点 ${tl.fromVideoS}`);
  assert.equal(tl.toVideoS, VIDEO_DURATION);
  const fm = byType('first_move')[0];
  assert.ok(fm.videoS! > 138 && fm.videoS! < 148, `首次移动 ${fm.videoS}`); // ~141s 上路
  assert.ok(byType('cruise')[0], '最长巡航');

  // 条件事件（该素材有功率/心率/海拔，无 GPS）
  const pp = byType('power_peak')[0];
  assert.ok(pp.videoS! > 1410 && pp.videoS! < 1430, `功率峰 ${pp.videoS}`); // 1419s 帧核验 301W
  assert.match(pp.desc, /W$/);
  assert.ok(byType('sprint')[0], '有功率必有冲刺');
  const hr = byType('hr_peak')[0];
  assert.match(hr.desc, /bpm$/);
  const hi = byType('alt_high')[0];
  assert.ok(hi.videoS! > 1440 && hi.videoS! < 1458, `制高点 ${hi.videoS}`); // 1448s 帧核验 335m
  assert.match(hi.desc, /335m/);
  const sp = byType('speed_peak')[0];
  assert.ok(sp.videoS! > 1755 && sp.videoS! < 1772, `极速 ${sp.videoS}`); // 42.3km/h
  assert.match(sp.desc, /42\.3km\/h/);
  const pauses = byType('pause');
  assert.ok(pauses.length >= 1 && pauses.length <= 5, `停顿数 ${pauses.length}`);
  assert.match(pauses[0].desc, /266s/); // 山顶停车是最长停顿
  // 停顿带视频秒边界（音频扫描定位用）：266s 山顶停顿映射到视频 ~[1435, 1701]
  const p0 = pauses[0];
  assert.ok(p0.fromVideoS != null && p0.toVideoS != null, '停顿必须有视频秒边界');
  assert.ok(p0.fromVideoS! > 1425 && p0.fromVideoS! < 1445, `from ${p0.fromVideoS}`);
  assert.ok(p0.toVideoS! > 1690 && p0.toVideoS! < 1710, `to ${p0.toVideoS}`);
  assert.equal(byType('turnaround').length, 0); // fixture 无 position，不出折返点

  // 全部事件都落在视频覆盖内（该素材两段覆盖了整个 FIT）
  assert.ok(events.every((e) => e.videoS != null));
});

test('detectEvents: 无 segments 时 videoS=null；无 videoDurationS 时无片头片尾', () => {
  const events = detectEvents(FIXTURE.samples);
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.videoS === null));
  assert.equal(events.filter((e) => e.type === 'head' || e.type === 'tail').length, 0);
});

test('detectEvents: 同类型相距 <60s 的停顿合并留长者', () => {
  // 移动 → 停 40s → 移动 5s → 停 60s（两停顿中点相距 47.5s < 60s）→ 再移动
  const mk = (tS: number, speed: number): NormalizedSample => ({ tS, speed });
  const samples: NormalizedSample[] = [];
  for (let t = 0; t <= 100; t++) samples.push(mk(t, 5));
  for (let t = 101; t <= 140; t++) samples.push(mk(t, 0)); // 停 39s（中点 ~120.5）
  for (let t = 141; t <= 145; t++) samples.push(mk(t, 5));
  for (let t = 146; t <= 205; t++) samples.push(mk(t, 0)); // 停 59s（中点 ~175.5）
  for (let t = 206; t <= 300; t++) samples.push(mk(t, 5)); // 末尾移动，避免被认成 final_stop
  const pauses = detectEvents(samples).filter((e) => e.type === 'pause');
  assert.equal(pauses.length, 1);
  assert.match(pauses[0].desc, /59s|60s/); // 留长者
});

test('detectEvents: GPS 折返点（距起点最远）', () => {
  const mk = (tS: number, lat: number, lon: number): NormalizedSample => ({ tS, speed: 5, position: { lat, lon } });
  const samples: NormalizedSample[] = [];
  for (let t = 0; t <= 600; t++) {
    const leg = t <= 300 ? t / 300 : (600 - t) / 300; // 0 → 1 → 0 折返
    samples.push(mk(t, 31.0 + leg * 0.1, 121.0)); // 0.1° ≈ 11km
  }
  const ta = detectEvents(samples).find((e) => e.type === 'turnaround');
  assert.ok(ta, '应有折返点');
  assert.ok(Math.abs(ta.fitS! - 300) <= 2, `折返点 fitS=${ta.fitS}`);
  assert.match(ta.desc, /km/);
});

test('detectEvents: 坡度翻转（持续爬坡接持续放坡）', () => {
  const samples: NormalizedSample[] = [];
  for (let t = 0; t < 100; t++) samples.push({ tS: t, speed: 4, grade: 5 });
  for (let t = 100; t < 200; t++) samples.push({ tS: t, speed: 12, grade: -5 });
  const gf = detectEvents(samples).find((e) => e.type === 'grade_flip');
  assert.ok(gf, '应有坡度翻转');
  assert.ok(Math.abs(gf.fitS! - 100) <= 5, `翻转点 fitS=${gf.fitS}`);
});

test('detectEvents: 平路无海拔量程不出极值事件', () => {
  const samples: NormalizedSample[] = [];
  for (let t = 0; t <= 600; t++) samples.push({ tS: t, speed: 8, altitude: 100 + Math.sin(t / 100) * 5 });
  const events = detectEvents(samples);
  assert.equal(events.filter((e) => e.type === 'alt_high' || e.type === 'alt_low').length, 0);
});

// ---------- assembleHeuristic：兜底粗剪 ----------

test('assembleHeuristic: 真实素材六幕命中人工基准（总时长 30s）', () => {
  const plan = assembleHeuristic({ samples: FIXTURE.samples, segments: SEGMENTS, videoDurationS: VIDEO_DURATION });
  assert.equal(plan.dropped.length, 0);
  assert.equal(plan.acts.length, 6);
  const byKey = Object.fromEntries(plan.acts.map((a) => [a.key, a]));

  assert.deepEqual([byKey.departure.start, byKey.departure.end], [3, 7]); // 开车门（视频开头车内段 134s）

  const center = (a: { start: number; end: number }) => (a.start + a.end) / 2;
  assert.ok(center(byKey.rollout) > 138 && center(byKey.rollout) < 148, `上路 ${center(byKey.rollout)}`);
  assert.ok(center(byKey.effort) > 1410 && center(byKey.effort) < 1430, `发力 ${center(byKey.effort)}`); // 功率峰（爬坡）
  assert.ok(center(byKey.high) > 1440 && center(byKey.high) < 1458, `制高点 ${center(byKey.high)}`);
  assert.ok(center(byKey.speed) > 1755 && center(byKey.speed) < 1772, `极速 ${center(byKey.speed)}`);

  assert.ok(Math.abs(byKey.finish.start - 2453.94) < 0.5 && Math.abs(byKey.finish.end - 2457.94) < 0.5, '收尾落在视频最后 4s');
  assert.ok(Math.abs(plan.totalS - 30) < 0.5, `总时长 ${plan.totalS}`);

  // 幕序即叙事序
  assert.deepEqual(plan.acts.map((a) => a.key), ['departure', 'rollout', 'effort', 'high', 'speed', 'finish']);
});

test('assembleHeuristic: 视频与 FIT 同步起止时片头片尾两幕降级丢弃', () => {
  // 合成一段开表即骑、骑完即停的数据：preamble/tail 都不存在
  const samples = Array.from({ length: 600 }, (_, i) => ({
    tS: i, speed: 5, altitude: 100 + i * 0.5, heart_rate: 150, power: 200, grade: 4,
  }));
  const segments = [{ videoStartS: 0, durationS: 600, offsetSeconds: 0 }];
  const plan = assembleHeuristic({ samples, segments, videoDurationS: 600 });
  const droppedKeys = plan.dropped.map((d) => d.key);
  assert.ok(droppedKeys.includes('departure'));
  assert.ok(droppedKeys.includes('finish'));
  assert.ok(plan.acts.every((a) => a.key !== 'departure' && a.key !== 'finish'));
});

test('assembleHeuristic: 空样本直接报错', () => {
  assert.throws(() => assembleHeuristic({ samples: [], segments: SEGMENTS, videoDurationS: 100 }), /FIT 样本/);
});

// ---------- planFromCuts：外部精确剪辑点 ----------

test('planFromCuts: 合法 cuts 原样采纳；非法逐个报下标', () => {
  const plan = planFromCuts([
    { start: 3, end: 7, label: '开车门' },
    { start: 100, end: 108 },
  ]);
  assert.equal(plan.acts.length, 2);
  assert.equal(plan.acts[0].label, '开车门');
  assert.equal(plan.acts[1].label, '片段2');
  assert.equal(plan.totalS, 12);
  assert.equal(plan.dropped.length, 0);

  assert.throws(() => planFromCuts([]), /至少一条/);
  assert.throws(() => planFromCuts([{ start: 9, end: 3 }]), /cuts\[0\]/);
  assert.throws(() => planFromCuts([{ start: 0, end: 5 }, { start: -1, end: 3 }]), /cuts\[1\]/);
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

// ---------- 停顿音频扫描 ----------

const AUDIO_VIDEO = path.resolve('fixtures/out/DJI_20260906100100.MP4'); // 15s，含 AAC 音轨

test('scanPauseAudio: 真实 ffmpeg astats 扫描返回合法结构', { timeout: 60000 }, async () => {
  const a = await scanPauseAudio(AUDIO_VIDEO, 0, 15);
  assert.equal(typeof a.talk, 'boolean');
  if (a.talk) {
    assert.ok(a.fromS != null && a.toS != null && a.toS > a.fromS, `人声区 ${a.fromS}–${a.toS}`);
    assert.ok(a.peakDb != null && a.peakDb > -25, `峰值 ${a.peakDb}`);
  } else {
    assert.equal(a.fromS, null);
    assert.equal(a.toS, null);
  }
});

test('annotatePauseAudio: 可扫的停顿附标记与 desc；不可扫的原样不动', { timeout: 60000 }, async () => {
  const events: QuickcutEvent[] = [
    { type: 'pause', fitS: 7, videoS: 7, windowS: 4, score: 100, desc: '停顿 15s', fromVideoS: 0, toVideoS: 15 },
    { type: 'pause', fitS: 30, videoS: null, windowS: 4, score: 80, desc: '停顿 40s', fromVideoS: null, toVideoS: null }, // 不在覆盖内
    { type: 'pause', fitS: 50, videoS: 5, windowS: 4, score: 60, desc: '停顿 10s', fromVideoS: 0, toVideoS: 10 },        // <15s 不值得扫
    { type: 'speed_peak', fitS: 1, videoS: 1, windowS: 8, score: 90, desc: '极速 40km/h' },
  ];
  await annotatePauseAudio(events, AUDIO_VIDEO);
  assert.ok(events[0].audio, '可扫停顿应有 audio 标记');
  assert.match(events[0].desc, /停顿 15s（.*(有人声|安静)）/, `desc=${events[0].desc}`);
  assert.equal(events[1].audio, undefined);
  assert.equal(events[1].desc, '停顿 40s');
  assert.equal(events[2].audio, undefined);
  assert.equal(events[2].desc, '停顿 10s');
  assert.equal(events[3].desc, '极速 40km/h');
});
