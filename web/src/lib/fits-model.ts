// FIT 库页纯展示逻辑：排序 / 日期·时长·距离格式化 / sport 图标 / 来源判定。全部纯函数，vitest 直测。

// /api/fits 清单项（服务端 FitLibEntry 的投影）
export interface FitEntry {
  name: string;
  path: string;
  start_ms: number;
  end_ms: number;
  duration_s: number;
  sport: string | null;
  distance_m: number | null;
  has_gps: boolean;
}

// 列表排序：start_ms 倒序（最新在顶），不改原数组
export function sortFits(fits: FitEntry[]): FitEntry[] {
  return [...fits].sort((a, b) => b.start_ms - a.start_ms);
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 「9月6日 星期日 上午 10:00」（本地时区，12 小时制）
export function fmtFitDate(startMs: number): string {
  const d = new Date(startMs);
  const h24 = d.getHours();
  const ampm = h24 < 12 ? '上午' : '下午';
  const h12 = h24 % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]} ${ampm} ${h12}:${mm}`;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const h = Math.floor(s / 3600);
  if (h) return `${h}小时${Math.round((s % 3600) / 60)}分`;
  if (s >= 60) return `${Math.round(s / 60)}分钟`;
  return `${Math.round(s)}秒`;
}

// 无距离数据返回 null（卡片不渲染该段）
export function fmtDistance(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export type SportIcon = 'bike' | 'footprints' | 'activity';

export function sportIcon(sport: string | null | undefined): SportIcon {
  if (sport === 'cycling' || sport === 'biking') return 'bike';
  if (sport === 'running' || sport === 'walking' || sport === 'hiking') return 'footprints';
  return 'activity';
}

export type FitSource = 'strava' | 'local';

// Strava 同步入库的文件名特征：名称_活动号（长数字串）.fit（如 Night Ride_20201055954.fit）；
// 保守起见判不出 → null（卡片不显示来源 pill）
export function fitSource(name: string | null | undefined): FitSource | null {
  if (!name) return null;
  return /_\d{9,}\.fit$/i.test(name) ? 'strava' : 'local';
}
