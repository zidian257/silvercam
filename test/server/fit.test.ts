import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeFit, processRecords, computeAnchor, parseFilenameTimestamp, buildSession } from '../../src/modules/fit.ts';

const FIXTURE = path.resolve('fixtures/out/activity.fit');
// fixture：10 分钟 1Hz 骑行（601 条记录，GPS 圆轨迹 + 心率/功率/踏频/速度/海拔，无 grade 字段）
const FIT_START = Date.parse('2026-09-06T02:00:00.000Z');
const FIT_END = Date.parse('2026-09-06T02:10:00.000Z');

test('decodeFit: 解析 fixture，记录数与时间范围正确', () => {
  const { records, session } = decodeFit(fs.readFileSync(FIXTURE));
  assert.equal(records.length, 601);
  assert.equal(records[0].t, FIT_START);
  assert.equal(records.at(-1)!.t, FIT_END);
  assert.equal(session!.sport, 'cycling');
  assert.equal(session!.total_elapsed_time, 600);
});

test('decodeFit: 非 FIT 数据报错', () => {
  assert.throws(() => decodeFit(Buffer.from('definitely not a fit file')), /not a FIT/);
});

test('processRecords: 1Hz 网格、字段齐全、grade 由 altitude+distance 重算', () => {
  const { records } = decodeFit(fs.readFileSync(FIXTURE));
  const p = processRecords(records);
  assert.equal(p.count, 601);
  assert.equal(p.interval_ms, 1000);
  assert.equal(p.t0_ms, FIT_START);
  for (const f of ['speed', 'altitude', 'heart_rate', 'cadence', 'power', 'distance', 'position', 'grade']) {
    assert.ok(p.fields.includes(f), `fields 应包含 ${f}`);
  }
  assert.equal(p.grade_recomputed, true); // fixture 无 grade 字段，必须重算
  assert.equal(p.samples.length, 601);
  assert.equal(p.samples[0].t, '2026-09-06T02:00:00.000Z');
  assert.equal(typeof p.samples[0].speed, 'number');
  assert.equal(typeof p.samples[0].position!.lat, 'number');
  assert.equal(typeof p.samples[300].grade, 'number');
});

test('processRecords: 字段缺失超 10s 不跨洞插值（10s 内沿用最近值）', () => {
  // 每秒一条记录，但 speed 在 6..39s 缺失（功率计断连 34s）
  const mk = (t: number) => ({
    t: t * 1000, speed: t <= 5 || t >= 40 ? 10 : null,
    altitude: null, heart_rate: null, cadence: null, power: null, grade: null, distance: null, temperature: null, lat: null, lon: null,
  });
  const records = Array.from({ length: 46 }, (_, t) => mk(t));
  const p = processRecords(records, { smoothWindowS: 0 });
  assert.equal(p.samples[0].speed, 10);
  assert.equal(p.samples[15].speed, 10); // 断点 9s 处：沿用最近已知值
  assert.equal(p.samples[20].speed, null); // 断点 14s 处：超过 10s 阈值，置 null
  assert.equal(p.samples[40].speed, 10);
});

test('computeAnchor: creation = FIT 起点 + 60s → offset 60，无警告', () => {
  const a = computeAnchor({ creationTimeUtcMs: FIT_START + 60_000, fitStartMs: FIT_START, fitEndMs: FIT_END, videoDurationS: 120 });
  assert.equal(a.ok, true);
  assert.equal(a.offset_seconds, 60);
  assert.equal(a.warnings.length, 0);
});

test('computeAnchor: bias 整体平移（正 = 数据延后）', () => {
  const a = computeAnchor({ creationTimeUtcMs: FIT_START + 60_000, fitStartMs: FIT_START, fitEndMs: FIT_END, biasSeconds: 15, videoDurationS: 120 });
  assert.equal(a.offset_seconds, 75);
  assert.equal(a.bias_seconds, 15);
});

test('computeAnchor: 负 offset 合法（先开相机后开码表），给片头无数据警告', () => {
  const a = computeAnchor({ creationTimeUtcMs: FIT_START - 30_000, fitStartMs: FIT_START, fitEndMs: FIT_END, videoDurationS: 120 });
  assert.equal(a.ok, true);
  assert.equal(a.offset_seconds, -30);
  assert.ok(a.warnings.some((w) => w.includes('片头')));
});

test('computeAnchor: bias 把整段推出数据窗口 → 整段无仪表盘警告', () => {
  const a = computeAnchor({ creationTimeUtcMs: FIT_START + 550_000, fitStartMs: FIT_START, fitEndMs: FIT_END, biasSeconds: 100, videoDurationS: 120 });
  assert.equal(a.ok, true); // 锚定点仍在范围内
  assert.ok(a.warnings.some((w) => w.includes('整段无仪表盘')));
});

test('computeAnchor: 锚定点超出 FIT 范围 → ok=false', () => {
  const a = computeAnchor({ creationTimeUtcMs: FIT_START + 5_000_000, fitStartMs: FIT_START, fitEndMs: FIT_END, videoDurationS: 120 });
  assert.equal(a.ok, false);
  assert.ok(a.warnings.some((w) => w.includes('活动时间范围')));
});

test('computeAnchor: 无 creation_time → ok=false reason=no_creation_time', () => {
  const a = computeAnchor({ creationTimeUtcMs: null, fitStartMs: FIT_START, fitEndMs: FIT_END });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'no_creation_time');
});

test('computeAnchor: 文件名时间戳与 creation_time 差 >10s 时警告', () => {
  // 文件名是 08:50:39 本地，creation 给 FIT 起点（凌晨），差几个小时必然超阈值
  const a = computeAnchor({
    creationTimeUtcMs: FIT_START + 60_000,
    videoFile: 'DJI_20260830085039_0002_D.MP4',
    fitStartMs: FIT_START,
    fitEndMs: FIT_END,
    videoDurationS: 120,
  });
  assert.ok(a.warnings.some((w) => w.includes('文件名时间戳')));
});

test('parseFilenameTimestamp: DJI 文件名内嵌本地开拍时刻', () => {
  assert.equal(parseFilenameTimestamp('DJI_20260830085039_0002_D.MP4'), new Date(2026, 7, 30, 8, 50, 39).getTime());
  assert.equal(parseFilenameTimestamp('/DCIM/100MEDIA/DJI_20260906100100.MP4'), new Date(2026, 8, 6, 10, 1, 0).getTime());
  assert.equal(parseFilenameTimestamp('random.mp4'), null);
});

test('buildSession: 起止/时长/字段汇总', () => {
  const { records } = decodeFit(fs.readFileSync(FIXTURE));
  const p = processRecords(records);
  const s = buildSession({ fitFile: FIXTURE, processed: p, anchor: { ok: true, offset_seconds: 60, warnings: [] } });
  assert.equal(s.activity.start, '2026-09-06T02:00:00.000Z');
  assert.equal(s.activity.end, '2026-09-06T02:10:00.000Z');
  assert.equal(s.activity.duration_s, 600);
  assert.equal(s.offset_seconds, 60);
  assert.deepEqual(s.fields, p.fields);
  assert.equal(s.fit_file, path.resolve(FIXTURE));
});
