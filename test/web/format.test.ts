import { describe, it, expect } from 'vitest';
import { fmtAgo, fmtUp } from '../../web/src/lib/format.ts';

describe('fmtAgo', () => {
  const now = Date.parse('2026-09-06T12:00:00Z');
  it('秒/分钟/小时分档', () => {
    expect(fmtAgo('2026-09-06T11:59:30Z', now)).toBe('30s 前');
    expect(fmtAgo('2026-09-06T11:55:00Z', now)).toBe('5 分钟前');
    expect(fmtAgo('2026-09-06T09:30:00Z', now)).toBe('2 小时前');
  });
  it('未来时间归零不负数', () => {
    expect(fmtAgo('2026-09-06T13:00:00Z', now)).toBe('0s 前');
  });
});

describe('fmtUp', () => {
  it('不足一小时 m+s', () => {
    expect(fmtUp(125)).toBe('2m5s');
    expect(fmtUp(0)).toBe('0m0s');
  });
  it('超过一小时 h+m', () => {
    expect(fmtUp(3700)).toBe('1h1m');
  });
});
