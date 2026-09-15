import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { looksDlog, memoryKey, decideLut, type DecideLutConfig } from '../../src/modules/probe.ts';

const LUT_ABS = path.resolve('fixtures/out/identity.cube');

const mkProbe = (over = {}) => ({
  file: '/x/DJI_001.MP4',
  width: 3840, height: 2160, fps: 29.97,
  codec: 'hevc', bit_depth: 10,
  color: { space: 'bt709', primaries: 'bt709', trc: 'bt709' },
  ...over,
});

test('looksDlog: 仅 10bit+HEVC 进入嫌疑范围', () => {
  assert.equal(looksDlog(mkProbe()), true);
  assert.equal(looksDlog(mkProbe({ bit_depth: 8 })), false); // 不足 10bit 一定不是 D-Log
  assert.equal(looksDlog(mkProbe({ codec: 'h264' })), false);
  assert.equal(looksDlog(mkProbe({ codec: undefined, bit_depth: undefined })), false);
});

test('memoryKey: 相机序列号 + 分辨率/帧率档位', () => {
  assert.equal(memoryKey(mkProbe(), 'SN123'), 'SN123|3840x2160@30');
  assert.equal(memoryKey(mkProbe()), 'unknown|3840x2160@30');
});

test('decideLut: never_lut 策略直接不套', async () => {
  const d = await decideLut(mkProbe(), { config: { dlog_policy: 'never_lut' }, interact: {} });
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'policy');
  assert.equal(d.dlog_suspected, true); // 嫌疑判定与策略独立
});

test('decideLut: always_lut 策略直接套默认 LUT', async () => {
  const d = await decideLut(mkProbe(), {
    config: { dlog_policy: 'always_lut', default_lut: 'mylut', luts: { mylut: LUT_ABS } },
    interact: {},
  });
  assert.equal(d.apply, true);
  assert.equal(d.lut, LUT_ABS);
});

test('decideLut: ask 策略先查记忆（lut / no_lut）', async () => {
  const key = memoryKey(mkProbe());
  const base: DecideLutConfig = { dlog_policy: 'ask', default_lut: 'mylut', luts: { mylut: LUT_ABS }, camera_serial: 'unknown' };
  const yes = await decideLut(mkProbe(), { config: { ...base, dlog_memory: { [key]: 'lut' } }, interact: {} });
  assert.equal(yes.apply, true);
  assert.match(yes.reason, /^memory:/);
  const no = await decideLut(mkProbe(), { config: { ...base, dlog_memory: { [key]: 'no_lut' } }, interact: {} });
  assert.equal(no.apply, false);
  assert.match(no.reason, /^memory:/);
});

test('decideLut: ask 策略 + 非嫌疑文件 → 不问人直接不套', async () => {
  let asked = false;
  const d = await decideLut(mkProbe({ bit_depth: 8 }), {
    config: { dlog_policy: 'ask', default_lut: 'mylut', luts: { mylut: LUT_ABS } },
    interact: { confirm: async () => { asked = true; return true; } },
  });
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'heuristic:not_dlog');
  assert.equal(asked, false); // 8bit 不该弹窗烦人
});

test('decideLut: ask 策略 + 嫌疑文件 → 问人，带回 remember_key', async () => {
  const d = await decideLut(mkProbe(), {
    config: { dlog_policy: 'ask', default_lut: 'mylut', luts: { mylut: LUT_ABS }, camera_serial: 'SN1' },
    interact: { confirm: async () => true },
  });
  assert.equal(d.apply, true);
  assert.equal(d.lut, LUT_ABS);
  assert.equal(d.reason, 'user');
  assert.equal(d.remember_key, 'SN1|3840x2160@30');

  const d2 = await decideLut(mkProbe(), {
    config: { dlog_policy: 'ask', default_lut: 'mylut', luts: { mylut: LUT_ABS }, camera_serial: 'SN1' },
    interact: { confirm: async () => false },
  });
  assert.equal(d2.apply, false);
  assert.equal(d2.lut, null);
});

test('decideLut: ask 策略 + 弹窗无人应答 → 按疑似 D-Log 默认套 LUT，不写记忆', async () => {
  const d = await decideLut(mkProbe(), {
    config: { dlog_policy: 'ask', default_lut: 'mylut', luts: { mylut: LUT_ABS }, camera_serial: 'SN1' },
    interact: { confirm: async () => null }, // 超时/无 GUI 会话
  });
  assert.equal(d.apply, true);
  assert.equal(d.lut, LUT_ABS);
  assert.equal(d.reason, 'auto:no_answer');
  assert.equal(d.remember_key, undefined); // 非用户选择，不许进 dlog_memory
});
