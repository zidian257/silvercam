<script lang="ts">
  import { fmtAgo } from '../format.ts';
  import {
    isActiveState,
    stateText,
    stateShort,
    statePill,
    fmtSec,
    fmtRange,
    recordsForJob,
    fileName,
    quickcutVideoUrl,
  } from '../quickcut.ts';
  import type { QuickcutRecord } from '../quickcut.ts';

  interface Props {
    jobId: string;
    records?: QuickcutRecord[]; // 全部快剪记录（面板内部按 jobId 归并，最新一条优先展示）
    onSubmit?: (jobId: string) => Promise<void> | void;
  }
  let { jobId, records = [], onSubmit = () => {} }: Props = $props();

  let submitting = $state(false);
  let submitErr = $state('');

  let mine = $derived(recordsForJob(records, jobId));
  let latest = $derived(mine[0] ?? null);
  let history = $derived(mine.slice(1));

  async function submit() {
    submitting = true;
    submitErr = '';
    try {
      await onSubmit(jobId);
    } catch (e) {
      submitErr = (e as Error).message;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="qc">
  <div class="head">
    <span class="ttl">快剪</span>
    <button class="btn primary" disabled={submitting} onclick={submit}>{submitting ? '提交中…' : '快剪 30s'}</button>
  </div>
  {#if submitErr}<div class="err">{submitErr}</div>{/if}

  {#if latest}
    {#if isActiveState(latest.state)}
      <div class="status">
        <span class="pill {statePill(latest.state)}"><i class="pulse"></i>{stateText(latest)}</span>
        {#if latest.state === 'rendering' && latest.percent != null}
          <div class="bar"><i style="width:{Math.round(latest.percent)}%"></i></div>
        {/if}
      </div>
    {:else if latest.state === 'done'}
      <div class="status">
        <span class="pill ok">已完成</span>
        {#if latest.out}
          <span class="fname">{fileName(latest.out)}</span>
          <a class="btn" href={quickcutVideoUrl(latest.out)} target="_blank" rel="noreferrer">打开</a>
        {/if}
      </div>
      {#if latest.out}<div class="opath" title={latest.out}>{latest.out}</div>{/if}
      {#if latest.plan}
        <table class="acts">
          <tbody>
            {#each latest.plan.acts as a (a.key)}
              <tr>
                <td class="alabel">{a.label}</td>
                <td class="arange">{fmtRange(a.start, a.end)}</td>
                <td class="areason">{a.reason}</td>
              </tr>
            {/each}
            {#each latest.plan.dropped ?? [] as d (d.key)}
              <tr class="dropped">
                <td class="alabel">{d.label}</td>
                <td class="arange">未选入</td>
                <td class="areason">{d.reason}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="total">成片共 {fmtSec(latest.plan.totalS)}</div>
      {/if}
    {:else if latest.state === 'failed'}
      <div class="status">
        <span class="pill danger">失败</span>
        <span class="err">{latest.error ?? '未知错误'}</span>
      </div>
    {/if}
  {:else}
    <div class="hint">还没有快剪记录</div>
  {/if}

  {#if history.length}
    <div class="hist">
      <span class="hl">历史</span>
      {#each history as h (h.id)}
        <span class="pill mute" title={h.created_at}>
          {h.created_at ? `${fmtAgo(h.created_at)} · ` : ''}{stateShort(h.state)}
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .qc { background: var(--bg-1); border: 1px solid var(--line); border-radius: var(--r-card); padding: 12px 14px; }
  .head { display: flex; align-items: center; justify-content: space-between; }
  .ttl { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .pulse {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--accent-soft); }
    50% { opacity: .5; box-shadow: 0 0 0 3px var(--accent-soft); }
  }
  .bar { height: 4px; background: var(--bg-2); border-radius: 2px; overflow: hidden; flex: 1; min-width: 120px; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
  .fname { font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; color: var(--text-1); }
  .opath {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-3);
    margin-top: 4px;
    word-break: break-all;
  }
  .err { color: var(--danger); font-size: 12px; margin-top: 6px; }
  .acts { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
  .acts td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  .acts tr:last-child td { border-bottom: none; }
  .alabel { font-weight: 600; color: var(--text-1); white-space: nowrap; }
  .arange { font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-2); white-space: nowrap; }
  .areason { font-size: 11px; color: var(--text-3); }
  .acts tr.dropped .alabel { font-weight: 400; color: var(--text-3); }
  .acts tr.dropped .arange { color: var(--text-3); }
  .total { margin-top: 8px; font-size: 11px; color: var(--text-3); }
  .hint { margin-top: 8px; font-size: 12px; color: var(--text-3); }
  .hist { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .hl { font-size: 11px; color: var(--text-3); letter-spacing: .08em; }
</style>
