<script lang="ts">
  interface Props {
    id: string;
  }
  let { id }: Props = $props();
  let broken = $state(false);
</script>

{#if broken}
  <span class="thumb broken" title="预览不可用"></span>
{:else}
  <a class="thumb" href="/inbox/{id}/thumb.jpg" target="_blank" rel="noopener" title="点击查看原图">
    <img loading="lazy" src="/inbox/{id}/thumb.jpg" alt="预览" onerror={() => (broken = true)}>
  </a>
{/if}

<style>
  .thumb { flex: none; width: 220px; height: 50px; border-radius: 6px; overflow: hidden; background: var(--bg-0); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb.broken { color: var(--text-3); font-size: 11px; cursor: default; }
  .thumb.broken::after { content: '预览不可用'; }
</style>
