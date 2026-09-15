import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClipName, localDay, uniquePath } from '../../src/lib/util.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('parseClipName: 标准 DJI 文件名解析出拍摄时间与序号', () => {
  const r = parseClipName('/Volumes/X/DCIM/DJI_20260830085039_0002_D.MP4', null)!;
  assert.equal(r.seq, 2);
  assert.equal(r.source, 'filename');
  assert.equal(r.recorded_at, '2026-08-30 08:50:39');
  assert.equal(r.start_ms, new Date(2026, 7, 30, 8, 50, 39).getTime());
});

test('parseClipName: 无序号 14 位时间戳变体', () => {
  const r = parseClipName('DJI_20250906123000.MP4', null)!;
  assert.equal(r.seq, null);
  assert.equal(r.start_ms, new Date(2025, 8, 6, 12, 30, 0).getTime());
});

test('parseClipName: 老式 DJI_0001.MP4 用 mtime 兜底', () => {
  const mt = Date.parse('2026-01-02T03:04:05');
  const r = parseClipName('DJI_0007.MP4', mt)!;
  assert.equal(r.seq, 7);
  assert.equal(r.source, 'mtime');
  assert.equal(r.start_ms, mt);
});

test('parseClipName: 非法日期（2月31日）与不匹配名返回 null', () => {
  assert.equal(parseClipName('DJI_20260231120000_0001_D.MP4', null), null);
  assert.equal(parseClipName('random.mp4', null), null);
});

test('localDay: 本地日期分桶（UTC+8 晚间不能错一天）', () => {
  // 本地 23:30，UTC 可能还是当天早些时候——结果必须是本地日
  const d = new Date(2026, 8, 11, 23, 30);
  assert.equal(localDay(d.getTime()), '2026-09-11');
});

test('uniquePath: 已存在时追加 _2/_3 序号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-'));
  const f = path.join(dir, 'a.mp4');
  fs.writeFileSync(f, 'x');
  const r = uniquePath(f);
  assert.equal(r, path.join(dir, 'a_2.mp4'));
  fs.writeFileSync(r, 'x');
  assert.equal(uniquePath(f), path.join(dir, 'a_3.mp4'));
  fs.rmSync(dir, { recursive: true, force: true });
});
