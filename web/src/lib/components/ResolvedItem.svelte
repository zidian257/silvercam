<script lang="ts">
  import Thumb from './Thumb.svelte';
  import { fmtSize, fmtRec, lutLabel } from '../inbox.ts';

  // 提交决策（服务端 approve 落库的投影；字段都可缺省）
  interface Decision {
    skin?: string | null;
    lut?: string | null;
    fit?: string | null;
    bias_seconds?: number | null;
  }
  // /api/inbox 清单项（本组件用到的子集；非共享类型，本地定义）
  interface InboxItem {
    id: string;
    src: string;
    status?: string;
    size?: number;
    recorded_at?: string | null;
    decision?: Decision | null;
  }
  // 关联任务（父级按 job_id 从 /jobs 摘要里挑出传入，本组件只读 id/state）
  interface JobRef {
    id: string;
    state: string;
  }
  interface Props {
    item: InboxItem;
    job?: JobRef | null;
    lutLabels?: Record<string, string>;
    onReopen?: (item: InboxItem) => void;
    onDismiss?: (item: InboxItem, deleteStaged: boolean) => void;
  }
  let {
    item,
    job = null,
    lutLabels = {},
    onReopen = () => {},
    onDismiss = () => {},
  }: Props = $props();

  const d: Decision = $derived(item.decision ?? {});
  const rec = $derived(fmtRec(item.recorded_at));

  const RUNNING = ['ingesting', 'probing', 'rendering', 'encoding', 'copying'];
  const pillClass = (state: string) =>
    state === 'done' ? 'ok'
    : state === 'failed' ? 'danger'
    : RUNNING.includes(state) ? 'info'
    : state === 'awaiting_fit' ? 'warn'
    : 'mute';
</script>

<div class="item" class:skipped={item.status === 'skipped'} class:done={item.status !== 'skipped'}>
  <Thumb id={item.id} />
  <div class="body">
    <div class="name">
      {rec ?? item.src.split('/').pop()}
      {#if item.status === 'skipped'}<span class="pill mute">已跳过</span>{:else}<span class="pill ok">已入队</span>{/if}
    </div>
    {#if rec}<div class="fname">{item.src.split('/').pop()}</div>{/if}
    <div class="meta">
      {fmtSize(item.size)} · 皮肤 {d.skin ?? '默认'} · LUT {lutLabel(d.lut, lutLabels)}
      · FIT {d.fit == null ? '自动' : d.fit === 'none' ? '无（纯拷贝）' : d.fit.split('/').pop()}
      {#if d.bias_seconds != null} · bias {d.bias_seconds > 0 ? '+' : ''}{d.bias_seconds}s{/if}
      {#if job} · 任务 <span class="mono">{job.id}</span> <span class="pill {pillClass(job.state)}">{job.state}</span>{/if}
    </div>
  </div>
  <div class="ops">
    {#if item.status === 'approved'}
      <button class="btn" title="拉回待处理重新决策（皮肤/LUT/FIT/对齐按上次预填）；卡已拔出时自动复用上次出片的 staging 副本" onclick={() => onReopen(item)}>重新编辑</button>
    {/if}
    <button class="btn" title="从列表移除（保留 staging 副本）；按住 Alt 点击则连同副本一起删除" onclick={(e) => onDismiss(item, e.altKey)}>移除</button>
  </div>
</div>

<style>
  .item {
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 10px 14px;
    margin-bottom: 8px;
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .item.skipped, .item.done { opacity: .6; }
  .item :global(.thumb) { width: 96px; height: 54px; border-radius: 6px; }
  .body { flex: 1; min-width: 0; }
  .name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fname { color: var(--text-3); font: 11px ui-monospace, monospace; margin-top: 1px; word-break: break-all; }
  .meta { color: var(--text-3); font-size: 12px; margin-top: 3px; }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; }
  .ops { display: flex; gap: 8px; flex: none; }
</style>
