import { describe, it, expect } from 'vitest';
import { sortFits, fmtFitDate, fmtDuration, fmtDistance, sportIcon, fitSource } from '../../web/src/lib/fits-model.ts';
import type { FitEntry } from '../../web/src/lib/fits-model.ts';

const entry = (over: Partial<FitEntry> = {}): FitEntry => ({
  name: 'a.fit',
  path: '/lib/a.fit',
  start_ms: 0,
  end_ms: 600_000,
  duration_s: 600,
  sport: 'cycling',
  distance_m: 5400,
  has_gps: true,
  ...over,
});

describe('sortFits: start_ms 倒序，最新在顶', () => {
  it('乱序输入排好；不改原数组', () => {
    const a = entry({ name: 'a.fit', start_ms: 1000 });
    const b = entry({ name: 'b.fit', start_ms: 3000 });
    const c = entry({ name: 'c.fit', start_ms: 2000 });
    const input = [a, b, c];
    const out = sortFits(input);
    expect(out.map((f) => f.name)).toEqual(['b.fit', 'c.fit', 'a.fit']);
    expect(input[0].name).toBe('a.fit'); // 原数组不动
  });
});

describe('fmtFitDate: M月D日 星期X 上午/下午 H:mm', () => {
  it('上午/下午/跨午边界', () => {
    expect(fmtFitDate(new Date(2026, 8, 6, 10, 0).getTime())).toBe('9月6日 星期日 上午 10:00');
    expect(fmtFitDate(new Date(2026, 8, 6, 21, 5).getTime())).toBe('9月6日 星期日 下午 9:05');
    expect(fmtFitDate(new Date(2026, 8, 7, 0, 30).getTime())).toBe('9月7日 星期一 上午 12:30');
    expect(fmtFitDate(new Date(2026, 8, 7, 12, 0).getTime())).toBe('9月7日 星期一 下午 12:00');
  });
});

describe('fmtDuration: 时长人性化', () => {
  it('秒/分钟/小时分档', () => {
    expect(fmtDuration(45)).toBe('45秒');
    expect(fmtDuration(600)).toBe('10分钟');
    expect(fmtDuration(90)).toBe('2分钟');
    expect(fmtDuration(3661)).toBe('1小时1分');
  });
  it('非法值 → —', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(NaN)).toBe('—');
  });
});

describe('fmtDistance: 距离展示', () => {
  it('公里两位小数 / 不足一公里用米 / 无数据 null', () => {
    expect(fmtDistance(5400)).toBe('5.40 km');
    expect(fmtDistance(800)).toBe('800 m');
    expect(fmtDistance(null)).toBeNull();
  });
});

describe('sportIcon: sport → 图标名', () => {
  it('骑行/脚步/兜底', () => {
    expect(sportIcon('cycling')).toBe('bike');
    expect(sportIcon('running')).toBe('footprints');
    expect(sportIcon('walking')).toBe('footprints');
    expect(sportIcon('hiking')).toBe('footprints');
    expect(sportIcon('swimming')).toBe('activity');
    expect(sportIcon(null)).toBe('activity');
  });
});

describe('fitSource: 来源判定（Strava 同步文件名带活动号尾巴）', () => {
  it('下划线 + 长数字串结尾 → strava', () => {
    expect(fitSource('Night Ride_20201055954.fit')).toBe('strava');
    expect(fitSource('晨骑_123456789.fit')).toBe('strava');
  });
  it('普通文件名 → local', () => {
    expect(fitSource('Morning_Ride.fit')).toBe('local');
    expect(fitSource('0830morningride.fit')).toBe('local');
    expect(fitSource('ride_2026.fit')).toBe('local'); // 4 位数字不算活动号
  });
  it('空名 → null（保守不显示）', () => {
    expect(fitSource('')).toBeNull();
  });
});
