// inbox 页的领域逻辑（纯函数，与组件解耦直接可测）
import type { InboxItem, JobRow } from './api.ts';

// 批量条/组选择缓存里每个组的取值（memberIds 在 groupSel 构造时必给）
export interface SelValue {
  checked?: boolean;
  skin?: string;
  lut?: string;
  fit?: string | null;
  memberIds: string[];
  [k: string]: any;
}

export interface InboxDecision {
  id: string;
  action: string; // 'process' | 'skip'
  skin?: string;
  lut?: string | null;
  fit?: string;
}

export interface CommitResult {
  id?: string;
  job_id?: string | null;
  skipped?: boolean;
  error?: string;
  merged?: number;
  [k: string]: any;
}

export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return '?';
  const gb = bytes / 1073741824;
  return gb >= 0.1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function fmtDur(s: number | null | undefined): string {
  if (s == null) return '?';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}'${String(sec).padStart(2, '0')}"`;
}

// "2025-08-09 16:53:24" → "8月9日 周六 下午4:53"（跨年补年份前缀）；解析不出返回 null
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function fmtRec(s: string | null | undefined): string | null {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const dt = new Date(y, mo - 1, d, h, mi);
  const period = h < 12 ? '上午' : h < 18 ? '下午' : '晚上'; // 中午 12 点算下午
  const h12 = h % 12 || 12;
  const yy = y === new Date().getFullYear() ? '' : `${y}年`;
  return `${yy}${mo}月${d}日 周${WEEK[dt.getDay()]} ${period}${h12}:${String(mi).padStart(2, '0')}`;
}

// recorded_at "YYYY-MM-DD HH:mm:ss"（本地）→ ms
export function recMs(it: { recorded_at?: string | null }): number | null {
  const m = String(it.recorded_at ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

// 待处理按「同一次录制」分组：相机 ~20GB 切段属于同一段骑行，决策以录制为单位
export function groupItems(items: InboxItem[]): InboxItem[][] {
  const sorted = items.slice().sort((a, b) => (recMs(a) ?? 0) - (recMs(b) ?? 0));
  const groups: InboxItem[][] = [];
  for (const it of sorted) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    const start = recMs(it);
    const pStart = prev ? recMs(prev) : null;
    const pDur = prev?.probe?.duration;
    const gap = start != null && pStart != null && pDur != null ? start - (pStart + pDur * 1000) : null;
    const linked = prev && it.seq != null && prev.seq != null && it.seq === prev.seq + 1 && gap != null && gap < 30000 && gap > -60000;
    if (linked) last.push(it);
    else groups.push([it]);
  }
  return groups.reverse(); // 最新的录制在最上面
}

export const gkey = (members: { id: string }[]): string => members.map((m) => m.id).sort().join('+');

// 轮询变更指纹：状态没变就不重渲（不打断人类正在做的选择）
export function sigOf(items: InboxItem[], jobs: JobRow[]): string {
  const a = items.map((i) => [i.id, i.status, i.ingest?.state, Math.round((i.ingest?.percent ?? 0) / 5), i.job_id, i.probe ? 1 : 0, i.probe?.color ? 1 : 0, i.src_exists ? 1 : 0].join(':'));
  const b = jobs.map((j) => [j.id, j.state, Math.round(j.progress?.percent ?? 0)].join(':'));
  return a.join('|') + '#' + b.join('|');
}

// 勾选项里同一 FIT（且皮肤/LUT 一致）的分组统计：Map<key, 段数>，≥2 段的组提交时可合并为一条
export function mergeGroupsNow(selValues: SelValue[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const s of selValues) {
    if (!s.checked || !s.fit || s.fit === 'none') continue;
    const n = s.memberIds?.length ?? 1;
    if (n < 2) continue;
    const key = `${s.fit}|${s.skin}|${s.lut}`;
    groups.set(key, (groups.get(key) ?? 0) + n);
  }
  return groups;
}

export function buildDecisions(selValues: SelValue[], action: string): InboxDecision[] {
  const decisions: InboxDecision[] = [];
  for (const s of selValues) {
    if (!s.checked) continue;
    for (const id of s.memberIds) {
      decisions.push(action === 'skip' ? { id, action: 'skip' } : { id, action: 'process', skin: s.skin, lut: s.lut || null, fit: s.fit || 'none' });
    }
  }
  return decisions;
}

export function commitSummary(body: { results: CommitResult[] }): { text: string; isErr: boolean } {
  const errs = body.results.filter((r) => r.error);
  const ok = body.results.filter((r) => r.job_id);
  const skipped = body.results.filter((r) => r.skipped);
  const text =
    (ok.length ? `已入队 ${ok.length} 段 ` : '') +
    (skipped.length ? `已跳过 ${skipped.length} 段 ` : '') +
    (errs.length ? `失败 ${errs.length}：${errs[0].error}` : '');
  return { text: text.trim(), isErr: errs.length > 0 };
}

// LUT 显示名：null/''→自动，none→不套，有中文名用中文名
export function lutLabel(name: string | null | undefined, labels: Record<string, string> = {}): string {
  if (name == null || name === '') return '自动';
  if (name === 'none') return '不套';
  return labels[name] ?? name;
}
