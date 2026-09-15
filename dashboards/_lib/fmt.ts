// 皮肤共享纯函数：单位换算 / zone 配色 / 数值格式化 / 轨迹投影。
// 全部无副作用、无 DOM 依赖，vitest 直测。

// 换算因子：数值倍率或换算函数（温度非线性）
type UnitScale = number | ((v: number) => number);

// zone 配色区间：[下限, 上限, 颜色]
export type Zone = [lo: number, hi: number, color: string];

// FIT 数据集中的单条采样（position/distance 为轨迹投影所用字段，其余键透传）
export interface TrackSample {
  position?: { lat: number; lon: number };
  distance?: number;
  [k: string]: unknown;
}

// 渲染帧采样：字段由录制设备决定（speed/heart_rate/...），值为数值或缺口 null
export type FrameSample = Record<string, number | null>;

export const UNITS: Record<string, Record<string, UnitScale>> = {
  speed: { 'km/h': 3.6, mph: 2.23693629, 'm/s': 1 },
  altitude: { m: 1, ft: 3.28084 },
  distance: { km: 0.001, mi: 0.000621371, m: 1 },
  temperature: { '°C': (v) => v, '°F': (v) => v * 1.8 + 32 },
};

export function convert(field: string, v: number | null | undefined, unit: string): number | null | undefined {
  if (v == null || !unit) return v;
  const f = UNITS[field]?.[unit];
  if (f == null) return v;
  return typeof f === 'function' ? f(v) : v * f;
}

// zones: [[lo, hi, color], ...]，左闭右开
export function zoneColor(zones: Zone[] | null | undefined, v: number | null | undefined): string | null {
  if (!zones || v == null) return null;
  for (const [lo, hi, color] of zones) {
    if (v >= lo && v < hi) return color;
  }
  return null;
}

export function formatValue(v: number | null | undefined, { decimals = 0, signed = false }: { decimals?: number; signed?: boolean } = {}): string {
  if (v == null) return '--';
  return (signed && v > 0 ? '+' : '') + v.toFixed(decimals);
}

// FIT position 序列 -> 平面投影 -> SVG path 数据。
// 以轨迹质心为原点的等距圆柱投影（短距离骑行畸变可忽略），等比缩放居中。
// 返回 null = 数据不足 2 点，调用方整图隐藏。
export interface TrackGeo {
  d: string;
  start: number[];
  end: number[];
  length: number;
  pointAt: (target: number) => { x: number; y: number };
  totalDist: number | null;
}
export function projectTrack(samples: TrackSample[], W: number, H: number, { pad = 52, maxPts = 1200 }: { pad?: number; maxPts?: number } = {}): TrackGeo | null {
  const pts = samples.filter((s) => s.position).map((s) => s.position!);
  if (pts.length < 2) return null;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const lon0 = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => [(p.lon - lon0) * cosLat, -(p.lat - lat0)]);
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(
    (W - pad * 2) / Math.max(1e-12, maxX - minX),
    (H - pad * 2) / Math.max(1e-12, maxY - minY)
  );
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  const px = xy.map(([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale]);

  const stride = Math.max(1, Math.floor(px.length / maxPts));
  // 与 d 字符串同源的取整坐标：折线积分的长度/游标与渲染出的 path 严格一致
  const sampled = px
    .filter((_, i) => i % stride === 0 || i === px.length - 1)
    .map(([x, y]) => [Number(x.toFixed(1)), Number(y.toFixed(1))]);
  const d = sampled.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join('');

  // 折线积分：总长 + pointAt(弧长)。dasharray/游标与 path 同源，避免依赖 DOM 几何 API
  let length = 0;
  const segLens = [0];
  for (let i = 1; i < sampled.length; i++) {
    length += Math.hypot(sampled[i][0] - sampled[i - 1][0], sampled[i][1] - sampled[i - 1][1]);
    segLens.push(length);
  }
  const pointAt = (target: number) => {
    if (target <= 0) return { x: sampled[0][0], y: sampled[0][1] };
    for (let i = 1; i < sampled.length; i++) {
      if (segLens[i] >= target) {
        const seg = segLens[i] - segLens[i - 1];
        const r = seg > 0 ? (target - segLens[i - 1]) / seg : 0;
        return { x: sampled[i - 1][0] + (sampled[i][0] - sampled[i - 1][0]) * r, y: sampled[i - 1][1] + (sampled[i][1] - sampled[i - 1][1]) * r };
      }
    }
    const last = sampled[sampled.length - 1];
    return { x: last[0], y: last[1] };
  };

  const ds = samples.map((s) => s.distance).filter((v): v is number => v != null);
  return { d, start: sampled[0], end: sampled[sampled.length - 1], length, pointAt, totalDist: ds.length ? ds[ds.length - 1] : null };
}
