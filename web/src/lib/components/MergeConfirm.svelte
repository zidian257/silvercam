<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface MergeGroup {
    fit: string;
    n: number;
  }
  type MergeChoice = 'cancel' | 'split' | 'merge';
  interface Props {
    groups?: MergeGroup[];
    onChoice?: (choice: MergeChoice) => void;
  }
  let { groups = [], onChoice = () => {} }: Props = $props();

  const total = $derived(groups.reduce((a, g) => a + g.n, 0));

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onChoice('cancel');
  }
  onMount(() => document.addEventListener('keydown', onKey));
  onDestroy(() => document.removeEventListener('keydown', onKey));
</script>

<div class="cfmodal" onclick={(e) => { if (e.target === e.currentTarget) onChoice('cancel'); }} role="dialog">
  <div class="cfbox">
    <div class="cftitle">检测到同一次录制的 {total} 个切段</div>
    <div class="cflist">
      {#each groups as g}
        <div class="cfgroup">· {g.fit.split('/').pop()} × {g.n} 段</div>
      {/each}
      <div class="cfnote">合并输出：按拍摄时间排序拼成一条成片，各段独立对齐 FIT，数据全程连续<br>分段输出：每段各出一条成片</div>
    </div>
    <div class="cfbtns">
      <button class="btn" onclick={() => onChoice('cancel')}>取消</button>
      <button class="btn" onclick={() => onChoice('split')}>分段输出</button>
      <button class="btn primary" onclick={() => onChoice('merge')}>合并输出</button>
    </div>
  </div>
</div>

<style>
  .cfmodal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, .55);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .cfbox {
    background: var(--bg-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-card);
    box-shadow: var(--shadow-pop);
    padding: 22px 24px;
    max-width: 520px;
  }
  .cftitle { font-weight: 600; font-size: 15px; color: var(--text-1); margin-bottom: 10px; }
  .cflist { color: var(--text-2); font-size: 13px; margin-bottom: 18px; line-height: 1.8; }
  .cfgroup { font-family: ui-monospace, monospace; font-size: 12px; }
  .cfnote { margin-top: 10px; color: var(--text-3); font-size: 12px; }
  .cfbtns { display: flex; gap: 10px; justify-content: flex-end; }
</style>
