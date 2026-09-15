import { fmtUp } from './format.ts';

// /api/status 响应的最小形状（只列卡片消费的字段，其余透传）
export interface DashStatus {
  uptime_s?: number;
  store?: string;
  watcher?: { active?: boolean; volumes_seen?: number } | null;
  jobs?: { total?: number; by_state?: Record<string, number | undefined>; current_id?: string | null } | null;
  [k: string]: any;
}

export interface DashCard {
  n: number | string;
  k: string;
  link: string | null;
  warn: boolean;
}

// dash 概览卡片的纯计算（与组件解耦，直接可测）
export function computeCards(status: DashStatus, inboxItems: unknown[], jobs: unknown[]): DashCard[] {
  const bs: Record<string, number | undefined> = status.jobs?.by_state ?? {};
  const running = ['ingesting', 'probing', 'rendering', 'encoding'].reduce((a, k) => a + (bs[k] ?? 0), 0);
  return [
    { n: inboxItems.length, k: '待确认素材', link: inboxItems.length ? '/inbox' : null, warn: false },
    { n: running + (bs.queued ?? 0), k: `队列（运行 ${running} / 排队 ${bs.queued ?? 0}）`, link: null, warn: false },
    { n: bs.done ?? 0, k: '已完成', link: null, warn: false },
    { n: (bs.failed ?? 0) + (bs.awaiting_fit ?? 0), k: `失败 ${bs.failed ?? 0} / 待 FIT ${bs.awaiting_fit ?? 0}`, link: null, warn: (bs.failed ?? 0) > 0 },
    { n: status.watcher?.active ? `${status.watcher.volumes_seen}` : '关', k: `卷监听 ${status.watcher?.active ? '（/Volumes）' : '未启用'}`, link: null, warn: false },
    { n: fmtUp(status.uptime_s ?? 0), k: `运行时长 · store ${status.store}`, link: null, warn: false },
  ];
}
