<script lang="ts">
  import { FileText, Scissors, SlidersHorizontal } from 'lucide-svelte';
  import { fmtAgo } from '../format.ts';
  import QuickcutPanel from './QuickcutPanel.svelte';
  import type { QuickcutRecord } from '../quickcut.ts';
  import type { ProgressPayload } from '../../../../src/types.ts';

  // /jobs 列表摘要（服务端 JobsService.find 的按任务投影；非共享类型，本地定义）
  interface JobSummary {
    id: string;
    state: string;
    created_at: string;
    video: string;
    // 服务端对单段任务发 null；模板里直接做 `> 1` 比较，按 number 标注
    segments: number;
    skin?: string | null;
    fit?: boolean;
    bias_seconds?: number | null;
    progress?: ProgressPayload | null;
    error?: string | null;
    output?: string | null;
  }
  interface Props {
    jobs?: JobSummary[];
    openLogs?: Record<string, boolean>;
    logs?: Record<string, string>;
    onToggleLog?: (id: string) => void;
    onRetry?: (id: string) => void;
    onFit?: (id: string) => void;
    quickcuts?: QuickcutRecord[];
    openQuickcuts?: Record<string, boolean>;
    onToggleQuickcut?: (id: string) => void;
    onQuickcutSubmit?: (jobId: string) => Promise<void> | void;
  }
  let {
    jobs = [],
    openLogs = {},
    logs = {},
    onToggleLog = () => {},
    onRetry = () => {},
    onFit = () => {},
    quickcuts = [],
    openQuickcuts = {},
    onToggleQuickcut = () => {},
    onQuickcutSubmit = () => {},
  }: Props = $props();

  const pctOf = (j: JobSummary) => (j.progress?.percent != null ? Math.round(j.progress.percent) : null);
  const showBar = (j: JobSummary) => pctOf(j) != null && !['done', 'failed'].includes(j.state);
  // 快剪入口：仅已完成且有输出成片的任务
  const canQuickcut = (j: JobSummary) => j.state === 'done' && !!j.output;

  const RUNNING = ['ingesting', 'probing', 'rendering', 'encoding'];
  const pillClass = (state: string) =>
    state === 'done' ? 'ok'
    : state === 'failed' ? 'danger'
    : RUNNING.includes(state) ? 'info'
    : state === 'awaiting_fit' ? 'warn'
    : 'mute';
</script>

{#if !jobs.length}
  <div class="empty">暂无任务</div>
{:else}
  <table class="jobs">
    <thead>
      <tr><th>任务</th><th>视频</th><th>皮肤</th><th>状态</th><th class="r">创建 / 操作</th></tr>
    </thead>
    <tbody>
      {#each jobs as j (j.id)}
        {@const pct = pctOf(j)}
        <tr>
          <td class="jid">{j.id}</td>
          <td class="vcell">
            <div class="vname">
              {j.video}
              {#if j.segments > 1}<span class="pill info" title="同一次录制的 {j.segments} 个切段合并输出为一条">合并×{j.segments}</span>{/if}
              {#if j.bias_seconds != null && j.bias_seconds !== 0}
                <span class="pill mute" title="时间轴整体平移（正 = 数据延后）">bias {j.bias_seconds > 0 ? '+' : ''}{j.bias_seconds}s</span>
              {/if}
            </div>
            {#if j.error}<div class="err">{j.error}</div>{/if}
            {#if j.output}<div class="vpath" title={j.output}>{j.output}</div>{/if}
          </td>
          <td class="skin">{j.skin ?? ''}</td>
          <td class="state">
            <span class="pill {pillClass(j.state)}">
              {#if RUNNING.includes(j.state)}<i class="pulse"></i>{/if}
              {j.state}{pct != null ? ` ${pct}%` : ''}
            </span>
            {#if showBar(j)}<div class="bar"><i style="width:{pct}%"></i></div>{/if}
          </td>
          <td class="ops">
            <div class="time">{fmtAgo(j.created_at)}</div>
            <div class="opbtns">
              <button class="btn icon" title="日志" onclick={() => onToggleLog(j.id)}><FileText size={16} /></button>
              {#if j.state === 'failed'}<button class="btn" onclick={() => onRetry(j.id)}>重试</button>{/if}
              {#if j.state === 'awaiting_fit'}<button class="btn" onclick={() => onFit(j.id)}>补 FIT</button>{/if}
              {#if j.fit}<a class="btn icon" href="/studio?job={j.id}" title="对齐：打开 studio 看着视频画面校准时间轴"><SlidersHorizontal size={16} /></a>{/if}
              {#if canQuickcut(j)}<button class="btn icon" title="快剪 30s" onclick={() => onToggleQuickcut(j.id)}><Scissors size={16} /></button>{/if}
            </div>
          </td>
        </tr>
        {#if openLogs[j.id]}
          <tr class="logrow"><td></td><td colspan="4"><div class="joblog">{logs[j.id] ?? '加载中…'}</div></td></tr>
        {/if}
        {#if openQuickcuts[j.id] && canQuickcut(j)}
          <tr class="qcrow"><td></td><td colspan="4"><QuickcutPanel jobId={j.id} records={quickcuts} onSubmit={onQuickcutSubmit} /></td></tr>
        {/if}
      {/each}
    </tbody>
  </table>
{/if}

<style>
  table.jobs { width: 100%; border-collapse: collapse; font-size: 13px; }
  .jobs th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .08em;
    color: var(--text-3);
    padding: 0 12px 8px;
    border-bottom: 1px solid var(--line);
  }
  .jobs th.r { text-align: right; }
  .jobs td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; height: 56px; }
  .jobs tbody tr:hover td { background: var(--bg-1); }
  .jid { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-3); white-space: nowrap; }
  .vcell { min-width: 0; max-width: 420px; }
  .vname { font-size: 14px; font-weight: 600; color: var(--text-1); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .vpath {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-3);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err { color: var(--danger); font-size: 11px; margin-top: 2px; }
  .skin { font-size: 12px; color: var(--text-2); white-space: nowrap; }
  .state { white-space: nowrap; }
  .pulse {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--accent-soft); }
    50% { opacity: .5; box-shadow: 0 0 0 3px var(--accent-soft); }
  }
  .bar { height: 4px; background: var(--bg-2); border-radius: 2px; margin-top: 6px; overflow: hidden; min-width: 90px; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
  .ops { text-align: right; }
  .time { font-size: 12px; color: var(--text-3); margin-bottom: 5px; }
  .opbtns { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
  .opbtns a:hover { filter: none; border-color: var(--line-strong); }
  .joblog {
    background: var(--bg-0);
    border: 1px solid var(--line);
    border-radius: var(--r-ctl);
    padding: 10px 12px;
    font: 11px/1.6 ui-monospace, monospace;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 260px;
    overflow: auto;
    color: var(--text-2);
  }
  .logrow td, .qcrow td { border-bottom: 1px solid var(--line); }
  .empty { color: var(--text-3); padding: 18px 4px; }
</style>
