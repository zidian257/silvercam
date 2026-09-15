import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestFit } from '../../src/modules/fitlib.ts';

const fit = (path: string, startH: number, endH: number) => ({
  path,
  start_ms: Date.parse(`2026-08-30T0${startH}:00:00`),
  end_ms: Date.parse(`2026-08-30T0${endH}:00:00`),
});

test('suggestFit: 选重叠最大的 FIT', () => {
  const fits = [fit('/a.fit', 1, 3), fit('/b.fit', 5, 9)];
  // 视频 8:00-8:30 → 完全落在 b 内
  const r = suggestFit(fits, { startMs: Date.parse('2026-08-30T08:00:00'), durationS: 1800 });
  assert.equal(r, '/b.fit');
});

test('suggestFit: 部分重叠也能选上', () => {
  const fits = [fit('/a.fit', 1, 3), fit('/b.fit', 5, 9)];
  // 视频 2:30-3:30 → 与 a 重叠 30 分钟
  const r = suggestFit(fits, { startMs: Date.parse('2026-08-30T02:30:00'), durationS: 3600 });
  assert.equal(r, '/a.fit');
});

test('suggestFit: 无重叠返回 null（默认纯拷贝）', () => {
  const fits = [fit('/a.fit', 1, 3)];
  assert.equal(suggestFit(fits, { startMs: Date.parse('2026-08-30T05:00:00'), durationS: 600 }), null);
});

test('suggestFit: 缺拍摄时间或时长返回 null', () => {
  const fits = [fit('/a.fit', 1, 3)];
  assert.equal(suggestFit(fits, { startMs: null, durationS: 600 }), null);
  assert.equal(suggestFit(fits, { startMs: Date.parse('2026-08-30T02:00:00'), durationS: null }), null);
});
