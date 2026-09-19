import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActpipeConfig } from '../../src/types.ts';

// listFits 读写磁盘缓存（paths.cache/fitlib.json）：临时 ACTPIPE_HOME 隔离（必须在 import 前设置）
process.env.ACTPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-fitlib-'));
const { listFits, suggestFit } = await import('../../src/modules/fitlib.ts');
// @ts-expect-error -- fitsdk 的 index.d.ts 用无扩展名 re-export，nodenext 解析不到（同 src/modules/fit.ts）
const { Encoder, Profile } = await import('@garmin/fitsdk');

const FIT = path.resolve('fixtures/out/activity.fit');

const mkLib = () => fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-fitlib-dir-'));

// 室内骑行台形态的最小 FIT：有 record/心率，无 position 无 distance
function makeNoGpsFit(file: string) {
  const t0 = new Date(2026, 8, 1, 8, 0, 0);
  const enc = new Encoder();
  enc.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: 'activity', manufacturer: 'garmin', product: 0, timeCreated: t0 });
  for (let i = 0; i <= 60; i++) {
    enc.writeMesg({ mesgNum: Profile.MesgNum.RECORD, timestamp: new Date(t0.getTime() + i * 1000), heartRate: 120 });
  }
  enc.writeMesg({ mesgNum: Profile.MesgNum.SESSION, timestamp: new Date(t0.getTime() + 61_000), startTime: t0, sport: 'cycling', totalElapsedTime: 60 });
  fs.writeFileSync(file, enc.close());
}

test('listFits: 附 distance_m（最后一条 record 的 distance）与 has_gps', () => {
  const dir = mkLib();
  fs.copyFileSync(FIT, path.join(dir, 'ride.fit'));
  const fits = listFits({ fit_library_dir: dir } as ActpipeConfig);
  assert.equal(fits.length, 1);
  assert.equal(fits[0].name, 'ride.fit');
  assert.equal(fits[0].distance_m, 5400);
  assert.equal(fits[0].has_gps, true);
});

test('listFits: 无 distance/position 字段 → distance_m null、has_gps false', () => {
  const dir = mkLib();
  makeNoGpsFit(path.join(dir, 'indoor.fit'));
  const fits = listFits({ fit_library_dir: dir } as ActpipeConfig);
  assert.equal(fits.length, 1);
  assert.equal(fits[0].distance_m, null);
  assert.equal(fits[0].has_gps, false);
  assert.equal(fits[0].duration_s, 60);
});

test('listFits: 旧形态磁盘缓存（缺 distance_m/has_gps）自动重解析补全', () => {
  const dir = mkLib();
  const target = path.join(dir, 'old.fit');
  fs.copyFileSync(FIT, target);
  const st = fs.statSync(target);
  // 手工落一份旧形态缓存（只有 start_ms/end_ms/sport），应被判失效并重解析
  const cacheFile = path.join(process.env.ACTPIPE_HOME!, 'cache', 'fitlib.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ [`${target}:${st.mtimeMs}:${st.size}`]: { start_ms: 1, end_ms: 2, sport: 'cycling' } }));
  const fits = listFits({ fit_library_dir: dir } as ActpipeConfig);
  assert.equal(fits[0].distance_m, 5400);
  assert.equal(fits[0].has_gps, true);
});

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
