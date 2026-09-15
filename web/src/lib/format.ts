// 时间/时长展示格式化（dash / inbox 共用）

export function fmtAgo(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

export function fmtUp(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = floor0((totalSec % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m${Math.round(totalSec % 60)}s`;
}

function floor0(n: number): number {
  return Math.floor(n);
}
