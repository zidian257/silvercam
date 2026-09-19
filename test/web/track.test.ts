import { describe, it, expect } from 'vitest';
import { projectTrack } from '../../web/src/lib/track.ts';

// 解析 d 字符串里的全部坐标
const coordsOf = (d: string) => [...d.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe('projectTrack: [lat,lon] 点列 → SVG path', () => {
  it('少于 2 点返回 null', () => {
    expect(projectTrack([], 240, 72)).toBeNull();
    expect(projectTrack([[31.2, 121.4]], 240, 72)).toBeNull();
  });

  it('等比缩放居中：全部坐标落在画布内（含 pad），首尾点保留', () => {
    // 方框轨迹（起终点重合）
    const pts: [number, number][] = [[31.0, 121.0], [31.0, 121.01], [31.01, 121.01], [31.01, 121.0], [31.0, 121.0]];
    const t = projectTrack(pts, 240, 72, 6)!;
    expect(t.d.startsWith('M')).toBe(true);
    const coords = coordsOf(t.d);
    expect(coords.length).toBe(pts.length);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(6 - 1e-6);
      expect(x).toBeLessThanOrEqual(240 - 6 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(6 - 1e-6);
      expect(y).toBeLessThanOrEqual(72 - 6 + 1e-6);
    }
    expect(t.start).toEqual(coords[0]);
    expect(t.end).toEqual(coords[coords.length - 1]);
  });

  it('长边吃满：南北向主导的轨迹高度顶到 pad 边界', () => {
    const pts: [number, number][] = [[31.0, 121.0], [31.1, 121.001]];
    const t = projectTrack(pts, 240, 72, 6)!;
    const ys = coordsOf(t.d).map(([, y]) => y);
    expect(Math.max(...ys)).toBeCloseTo(72 - 6, 1);
    expect(Math.min(...ys)).toBeCloseTo(6, 1);
  });

  it('等距圆柱投影：同度数方块在高纬度投影更高（东西向按 cos(lat) 压缩）', () => {
    const aspect = (lat: number) => {
      const d = 0.01;
      const t = projectTrack([[lat, 121], [lat, 121 + d], [lat + d, 121 + d], [lat + d, 121]], 240, 72, 0)!;
      const m = coordsOf(t.d);
      const xs = m.map(([x]) => x);
      const ys = m.map(([, y]) => y);
      return (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs));
    };
    // cos(60°)=0.5 → 60°N 的度数方块投影高宽比约为赤道的 2 倍
    expect(aspect(60)).toBeGreaterThan(aspect(0) * 1.8);
  });

  it('退化轨迹（原地不动）也能出 path（不崩）', () => {
    const t = projectTrack([[31.0, 121.0], [31.0, 121.0]], 240, 72, 6);
    expect(t).not.toBeNull();
  });
});
