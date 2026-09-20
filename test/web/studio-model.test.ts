import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  mmss, sampleAt, parseCube, dataWindow, autoOffset, findDataSegment, captionFor, lutOptionValue, savePlan, pinStatusFor,
} from '../../web/src/lib/studio.ts';

describe('mmss', () => {
  it('分:秒；负数带符号；非法 → —', () => {
    expect(mmss(65)).toBe('1:05');
    expect(mmss(0)).toBe('0:00');
    expect(mmss(-9.5)).toBe('-0:09');
    expect(mmss(null)).toBe('—');
    expect(mmss(NaN)).toBe('—');
  });
});

const samples = {
  count: 3,
  t0_ms: 1000000,
  fields: ['speed', 'heart_rate', 'position'],
  samples: [
    { t: 'a', speed: 10, heart_rate: 100, position: { lat: 31, lon: 121 } },
    { t: 'b', speed: 20, heart_rate: null, position: { lat: 32, lon: 122 } },
    { t: 'c', speed: 30, heart_rate: 140, position: null },
  ],
};

describe('sampleAt: 与服务端渲染同款的 1Hz 插值', () => {
  it('整点直取；半点线性插值', () => {
    expect(sampleAt(samples, 0).speed).toBe(10);
    expect(sampleAt(samples, 0.5).speed).toBe(15);
    expect(sampleAt(samples, 0.5).position.lat).toBe(31.5);
  });
  it('缺失字段沿用最近非空；越界钳制', () => {
    expect(sampleAt(samples, 0.5).heart_rate).toBe(100); // b 为 null → 沿用 a
    expect(sampleAt(samples, 99).speed).toBe(30);
    expect(sampleAt(samples, -5).speed).toBe(10);
  });
});

describe('parseCube', () => {
  it('解析 identity fixture：size/domain/数据', () => {
    const c = parseCube(fs.readFileSync('fixtures/out/identity.cube', 'utf8'));
    expect(c.size).toBe(2);
    expect(c.dmin).toEqual([0, 0, 0]);
    expect(c.dmax).toEqual([1, 1, 1]);
    expect(c.data.length).toBe(2 * 2 * 2 * 3);
    expect(c.data[0]).toBe(0);
    expect(c.data[3]).toBe(1); // 第二个格点 R=1
  });
  it('数据点数量不符时报错', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/LUT 解析失败/);
  });
});

describe('dataWindow: 数据在视频内的出现窗口', () => {
  it('正 offset（视频晚于 FIT 起点开拍）：从 t=0 就有数据', () => {
    expect(dataWindow({ duration: 120, count: 601, offset: 60 })).toEqual([0, 120]);
  });
  it('负 offset（先开相机后开码表）：片头 -offset 秒无数据', () => {
    expect(dataWindow({ duration: 120, count: 601, offset: -30 })).toEqual([30, 120]);
  });
  it('整段被 bias 推出窗口 → null', () => {
    expect(dataWindow({ duration: 120, count: 601, offset: 700 })).toBeNull();
    expect(dataWindow({ duration: 120, count: 601, offset: -200 })).toBeNull();
  });
  it('缺参数 → null', () => {
    expect(dataWindow({ duration: null, count: 601, offset: 0 })).toBeNull();
  });
});

describe('findDataSegment: FIT 骑在另一段上时给跳转目标', () => {
  const T0 = 1000000;
  const segs = [
    { i: 0, duration: 100, creation_time_utc_ms: T0 - 200_000, name: 'seg1' }, // 数据窗口外（太早）
    { i: 1, duration: 100, creation_time_utc_ms: T0 + 30_000, name: 'seg2' },  // offset 30 → 有数据
  ];
  const smp = { t0_ms: T0, count: 601 };
  it('从 seg0 找 → seg1，该段数据起点对应 FIT t=30', () => {
    const hit = findDataSegment(segs, 0, 0, smp)!;
    expect(hit.seg.i).toBe(1);
    expect(hit.fitS).toBe(30);
  });
  it('排除当前段；都没数据 → null', () => {
    expect(findDataSegment(segs, 1, 0, smp)).toBeNull();
    expect(findDataSegment(segs, 0, 99999, smp)).toBeNull(); // bias 把数据推出所有段
  });
});

describe('captionFor', () => {
  it('字段齐全与缺失', () => {
    const s = sampleAt(samples, 0);
    const txt = captionFor(s, 0, 65);
    expect(txt).toContain('t=1:05');
    expect(txt).toContain('速度 36.0 km/h');
    expect(txt).toContain('心率 100');
    expect(txt).toContain('功率 --');
    expect(txt).toContain('里程 --');
    expect(captionFor(null, 0, 0)).toBe('');
  });
});

describe('lutOptionValue: 初始 LUT 映射回下拉选项', () => {
  const opts = ['none', 'dlogm_rec709', 'fuji'];
  it('query 优先；命中命名项直接用', () => {
    expect(lutOptionValue({ qsLut: 'fuji', optionValues: opts })).toBe('fuji');
    expect(lutOptionValue({ optionValues: opts })).toBe('none');
  });
  it('dlog 嫌疑素材默认套 default_lut', () => {
    expect(lutOptionValue({ dlogSuspected: true, defaultLut: 'dlogm_rec709', optionValues: opts })).toBe('dlogm_rec709');
  });
  it('任务存的绝对路径/链 → 按首环文件名映射回命名项', () => {
    expect(lutOptionValue({ sourceLut: '/Users/x/luts/dlogm_rec709.cube', optionValues: opts })).toBe('dlogm_rec709');
    expect(lutOptionValue({ sourceLut: '/x/fuji.cube+/x/other.cube', optionValues: opts })).toBe('fuji');
  });
  it('首环映射不回则原样返回（调用方追加自定义 option）', () => {
    expect(lutOptionValue({ sourceLut: '/x/custom.cube', optionValues: opts })).toBe('/x/custom.cube');
    expect(lutOptionValue({ sourceLut: '/x/a.cube+/x/fuji.cube', optionValues: opts })).toBe('/x/a.cube+/x/fuji.cube');
  });
});

describe('savePlan: 保存按钮形态', () => {
  it('adhoc 不显示保存', () => {
    expect(savePlan({ kind: 'adhoc' }).visible).toBe(false);
  });
  it('job：已完成任务重渲提示 + heavy；运行中禁用', () => {
    const done = savePlan({ kind: 'job', state: 'done', running: false });
    expect(done.label).toBe('保存 bias 并重渲');
    expect(done.heavy).toBe(true);
    const running = savePlan({ kind: 'job', state: 'rendering', running: true });
    expect(running.disabled).toBe(true);
  });
  it('inbox：保存对齐', () => {
    expect(savePlan({ kind: 'inbox' }).label).toBe('保存对齐');
  });
});

describe('pinStatusFor: 定格后的工具栏状态', () => {
  it('未定格 / 无 offset → 空', () => {
    expect(pinStatusFor(false, -83)).toBe('');
    expect(pinStatusFor(true, null)).toBe('');
    expect(pinStatusFor(true, undefined)).toBe('');
  });
  it('定格后显示 FIT 起点对应的视频时刻（fitS=0 ⇒ t=−offset），随微调实时更新', () => {
    expect(pinStatusFor(true, -83)).toBe('FIT 起点 @ 1:23');
    expect(pinStatusFor(true, -83.4)).toBe('FIT 起点 @ 1:23');
  });
  it('起点落在本段开拍之前（正 offset）→ 负时刻如实显示', () => {
    expect(pinStatusFor(true, 12)).toBe('FIT 起点 @ -0:12');
  });
});
