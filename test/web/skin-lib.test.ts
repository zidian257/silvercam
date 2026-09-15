import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';

// jsdom 无 ResizeObserver（bind:clientWidth 依赖），打桩即可——组件有 800x600 兜底
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
import { convert, zoneColor, formatValue, projectTrack, type Zone } from '../../dashboards/_lib/fmt.ts';
import { createFrame } from '../../dashboards/_lib/frame.svelte.ts';
import Digital from '../../dashboards/_lib/Digital.svelte';
import TrackMap from '../../dashboards/_lib/TrackMap.svelte';

describe('fmt.convert', () => {
  it('单位换算：speed m/s→km/h，altitude m→ft，distance m→km', () => {
    expect(convert('speed', 10, 'km/h')).toBeCloseTo(36);
    expect(convert('altitude', 100, 'ft')).toBeCloseTo(328.084);
    expect(convert('distance', 1500, 'km')).toBeCloseTo(1.5);
  });
  it('null/未知单位原样透传', () => {
    expect(convert('speed', null, 'km/h')).toBeNull();
    expect(convert('speed', 10, 'kn')).toBe(10);
    expect(convert('speed', 10, '')).toBe(10);
  });
});

describe('fmt.zoneColor', () => {
  const zones: Zone[] = [[0, 120, 'g'], [120, 160, 'y'], [160, 250, 'r']];
  it('左闭右开命中区间色', () => {
    expect(zoneColor(zones, 0)).toBe('g');
    expect(zoneColor(zones, 119.9)).toBe('g');
    expect(zoneColor(zones, 120)).toBe('y');
    expect(zoneColor(zones, 300)).toBeNull();
  });
  it('无 zones 或 null 值返回 null', () => {
    expect(zoneColor(null, 5)).toBeNull();
    expect(zoneColor(zones, null)).toBeNull();
  });
});

describe('fmt.formatValue', () => {
  it('null → --；decimals；signed 正数加 +', () => {
    expect(formatValue(null)).toBe('--');
    expect(formatValue(11.74, { decimals: 1 })).toBe('11.7');
    expect(formatValue(4.44, { decimals: 1, signed: true })).toBe('+4.4');
    expect(formatValue(-4.44, { decimals: 1, signed: true })).toBe('-4.4');
  });
});

describe('fmt.projectTrack', () => {
  const samples = [
    { position: { lat: 31.0, lon: 121.0 }, distance: 0 },
    { position: { lat: 31.001, lon: 121.002 }, distance: 100 },
    { position: { lat: 31.002, lon: 121.001 }, distance: 200 },
  ];
  it('少于 2 个 position 点返回 null', () => {
    expect(projectTrack([], 800, 600)).toBeNull();
    expect(projectTrack([{ position: { lat: 1, lon: 2 } }], 800, 600)).toBeNull();
    expect(projectTrack([{ speed: 1 }, { speed: 2 }], 800, 600)).toBeNull();
  });
  it('生成 M/L 路径、起止点与 totalDist', () => {
    const geo = projectTrack(samples, 800, 600)!;
    expect(geo.d.startsWith('M')).toBe(true);
    expect(geo.d).toContain('L');
    expect(geo.totalDist).toBe(200);
    expect(geo.start).toHaveLength(2);
    expect(geo.end).toHaveLength(2);
  });
  it('超过 maxPts 时按 stride 抽稀且保留末点', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({
      position: { lat: 31 + i * 1e-5, lon: 121 + i * 1e-5 },
    }));
    const geo = projectTrack(many, 800, 600, { maxPts: 1200 })!;
    const pts = geo.d.split('L').length;
    expect(pts).toBeLessThan(3000);
    expect(pts).toBeLessThanOrEqual(1501); // stride=floor(3000/1200)=2 → 1500 + 末点
  });
});

describe('createFrame', () => {
  it('renderFrame 更新 t/sample；data 取自 window.ACTPIPE', () => {
    window.ACTPIPE = { data: { count: 3 } };
    const f = createFrame();
    expect(f.t).toBe(0);
    expect(f.data.count).toBe(3);
    f.renderFrame(12.5, { speed: 3 });
    expect(f.t).toBe(12.5);
    expect(f.sample.speed).toBe(3);
    f.renderFrame(13, null);
    expect(f.sample).toEqual({});
    delete window.ACTPIPE;
  });
});

describe('Digital', () => {
  const props = { field: 'speed', label: 'SPEED', unit: 'km/h', decimals: 1 };
  it('渲染换算后的数值与 label/unit', () => {
    const { container } = render(Digital, { props: { ...props, sample: { speed: 11.74 } } });
    expect(container.querySelector('.val')!.textContent).toBe('42.3');
    expect(container.querySelector('.label')!.textContent).toBe('SPEED');
    expect(container.querySelector('.unit')!.textContent).toBe('km/h');
  });
  it('null 值显示 --；采样缺口保持上次读数', async () => {
    const { container, rerender } = render(Digital, { props: { ...props, sample: { speed: null } } });
    expect(container.querySelector('.val')!.textContent).toBe('--');
    await rerender({ ...props, sample: { speed: 10 } });
    expect(container.querySelector('.val')!.textContent).toBe('36.0');
    await rerender({ ...props, sample: { speed: null } });
    expect(container.querySelector('.val')!.textContent).toBe('36.0');
  });
  it('signed 正数加 + 前缀', () => {
    const { container } = render(Digital, {
      props: { field: 'grade', unit: '%', decimals: 1, signed: true, sample: { grade: 4.44 } },
    });
    expect(container.querySelector('.val')!.textContent).toBe('+4.4');
  });
  it('field 不在 fields 清单时整体不渲染', () => {
    const { container } = render(Digital, { props: { ...props, fields: ['power'], sample: {} } });
    expect(container.querySelector('.wg')).toBeNull();
  });
  it('zoneTarget=both：数值上 zone 色；zoneTarget=bar：数值恒白、zbar 上色', () => {
    const zones: Zone[] = [[0, 35, '#30D158'], [35, 999, '#FF453A']];
    const both = render(Digital, { props: { ...props, sample: { speed: 5 }, zones, bar: true } });
    expect(both.container.querySelector<HTMLElement>('.val')!.style.color).toBe('rgb(48, 209, 88)');
    const barOnly = render(Digital, {
      props: { ...props, sample: { speed: 5 }, zones, zoneTarget: 'bar', bar: true },
    });
    expect(barOnly.container.querySelector<HTMLElement>('.val')!.style.color).toBe('');
    expect(barOnly.container.querySelector<HTMLElement>('.zbar')!.style.background).toBe('rgb(48, 209, 88)');
  });
  it('bar=false 不渲染 zbar；无 zone 命中时 zbar 回落默认色', () => {
    const noBar = render(Digital, { props: { ...props, sample: { speed: 5 } } });
    expect(noBar.container.querySelector('.zbar')).toBeNull();
    const withBar = render(Digital, { props: { ...props, sample: { speed: 5 }, bar: true } });
    expect(withBar.container.querySelector<HTMLElement>('.zbar')!.style.background).toBe('rgba(255, 255, 255, 0.22)');
  });
});

describe('TrackMap', () => {
  const data = {
    count: 3,
    samples: [
      { position: { lat: 31.0, lon: 121.0 }, distance: 0 },
      { position: { lat: 31.001, lon: 121.002 }, distance: 100 },
      { position: { lat: 31.002, lon: 121.001 }, distance: 200 },
    ],
  };
  it('有轨迹时渲染 svg 路径与起止点', () => {
    const { container } = render(TrackMap, { props: { data, sample: { distance: 100, i: 1 } } });
    expect(container.querySelector('.track-full')!.getAttribute('d')).toContain('M');
    expect(container.querySelector('.mark-start')).toBeTruthy();
    expect(container.querySelector('.mark-end')).toBeTruthy();
  });
  it('数据不足 2 点时不渲染 svg', () => {
    const { container } = render(TrackMap, { props: { data: { count: 2, samples: [{ speed: 1 }] }, sample: {} } });
    expect(container.querySelector('svg')).toBeNull();
  });
  it('showStartEnd=false 隐藏起止标记', () => {
    const { container } = render(TrackMap, { props: { data, sample: {}, showStartEnd: false } });
    expect(container.querySelector('.mark-start')).toBeNull();
  });
});
