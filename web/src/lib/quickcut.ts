// 快剪（quickcuts 服务）前端模型：契约类型 + 状态归约/格式化纯函数（与组件解耦，直接可测）
// 契约（后端并行开发中）：POST /quickcuts { job_id, scenario, use_llm } → 任务记录；
// GET /quickcuts 全部记录（新→旧）。state 机：queued→analyzing→refining→rendering→done/failed

export interface QuickcutAct {
  key: string;
  label: string; // 中文幕名：出发/上路/爬坡/登顶/放坡/收尾
  start: number; // merged 视频秒
  end: number;
  reason: string; // 选取依据（UI 小字展示）
}

export interface QuickcutPlan {
  scenario: string;
  acts: QuickcutAct[];
  dropped: { key: string; label: string; reason: string }[];
  totalS: number; // 成片时长（各幕求和）
}

export interface QuickcutRecord {
  id: string;
  job_id: string;
  scenario?: string;
  state: string;
  percent?: number | null;
  plan?: QuickcutPlan | null;
  out?: string | null;
  error?: string | null;
  llm_used?: boolean;
  created_at?: string;
  [k: string]: any; // 契约演进中，其余键透传
}

// 场景清单：目前只有 4+2 爬山；select 结构留着便于以后加
export const QC_SCENARIOS = [{ value: 'ride_4plus2', label: '4+2 爬山' }];

export function scenarioLabel(scenario: string | null | undefined): string {
  return QC_SCENARIOS.find((s) => s.value === scenario)?.label ?? (scenario || '未知场景');
}

// 非终态 = 还需要轮询
export function isActiveState(state: string): boolean {
  return !['done', 'failed'].includes(state);
}

export function hasActive(records: QuickcutRecord[]): boolean {
  return records.some((r) => isActiveState(r.state));
}

// 状态文案：analyzing 分析情节… / refining AI 优选镜头… / rendering 渲染中 xx%
export function stateText(r: QuickcutRecord): string {
  switch (r.state) {
    case 'queued':
      return '排队中…';
    case 'analyzing':
      return '分析情节…';
    case 'refining':
      return 'AI 优选镜头…';
    case 'rendering':
      return r.percent != null ? `渲染中 ${Math.round(r.percent)}%` : '渲染中…';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return r.state || '未知状态';
  }
}

// 历史列表用的短标签（不带进度）
export function stateShort(state: string): string {
  if (state === 'done') return '完成';
  if (state === 'failed') return '失败';
  return '进行中';
}

export function statePill(state: string): string {
  return state === 'done' ? 'ok' : state === 'failed' ? 'danger' : state === 'queued' ? 'mute' : 'info';
}

// 秒数格式化：整数不带小数，否则保留一位
export function fmtSec(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0s';
  const r = Math.round(s * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}s`;
}

export function fmtRange(start: number, end: number): string {
  return `${fmtSec(start)}–${fmtSec(end)}`;
}

// 同 job 的记录归并：过滤 + 按 created_at 新→旧（契约已保证顺序，这里防御性重排）
export function recordsForJob(records: QuickcutRecord[], jobId: string): QuickcutRecord[] {
  const ts = (r: QuickcutRecord) => {
    const t = Date.parse(r.created_at ?? '');
    return Number.isFinite(t) ? t : 0;
  };
  return records
    .filter((r) => r.job_id === jobId)
    .sort((a, b) => ts(b) - ts(a));
}

export function latestForJob(records: QuickcutRecord[], jobId: string): QuickcutRecord | null {
  return recordsForJob(records, jobId)[0] ?? null;
}

export function fileName(p: string): string {
  return p.split('/').pop() ?? p;
}

// 成片在浏览器里播放：复用对齐页的视频流路由（file:<path> token，用法见 studio 页）
export function quickcutVideoUrl(out: string): string {
  return `/api/align/video?src=${encodeURIComponent(`file:${out}`)}`;
}
