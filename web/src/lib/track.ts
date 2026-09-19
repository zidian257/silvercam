// FIT 轨迹点列 → SVG path（fits 库卡片缩略图用）。
// 以轨迹质心为原点的等距圆柱投影（短距离骑行畸变可忽略）+ 等比 fit-to-box 居中。
// 与皮肤侧 dashboards/_lib/fmt.ts 的 projectTrack 算法同源但独立实现——皮肤构建链不反向依赖 web/src。

export interface TrackPath {
  d: string; // SVG path 数据（M/L 折线，坐标取整到 0.1）
  start: [number, number]; // 起点（画布坐标）
  end: [number, number]; // 终点
}

export function projectTrack(points: [number, number][], W: number, H: number, pad = 6): TrackPath | null {
  if (points.length < 2) return null;
  const lat0 = points.reduce((a, p) => a + p[0], 0) / points.length;
  const lon0 = points.reduce((a, p) => a + p[1], 0) / points.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map(([lat, lon]): [number, number] => [(lon - lon0) * cosLat, -(lat - lat0)]);
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
  const px = xy.map(([x, y]): [number, number] => [
    Number((offX + (x - minX) * scale).toFixed(1)),
    Number((offY + (y - minY) * scale).toFixed(1)),
  ]);
  const d = px.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join('');
  return { d, start: px[0], end: px[px.length - 1] };
}
