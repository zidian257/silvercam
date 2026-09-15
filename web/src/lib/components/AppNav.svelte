<script lang="ts">
  interface Props {
    current?: string;
  }
  let { current = 'dash' }: Props = $props();

  const names: Record<string, string> = { dash: '总控台', inbox: '素材库', studio: '对齐工作室' };
</script>

<nav class="appnav">
  <div class="left">
    <span class="brand">actpipe</span>
    <span class="divider"></span>
    <span class="page">{names[current] ?? current}</span>
  </div>
  <div class="tabs">
    <a class="tab" class:on={current === 'inbox'} href="/inbox">素材库</a>
    <a class="tab" class:on={current === 'dash'} href="/dash">总控台</a>
  </div>
  <div class="right"><slot /></div>
</nav>

<style>
  .appnav {
    position: sticky;
    top: 0;
    z-index: 50;
    height: 56px;
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 0 24px;
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
  }
  .left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand {
    font-family: 'Space Grotesk', -apple-system, sans-serif;
    font-weight: 700;
    font-size: 18px;
    color: var(--text-1);
    letter-spacing: .01em;
  }
  .divider { width: 1px; height: 12px; background: var(--line-strong); }
  .page { font-size: 14px; color: var(--text-3); }
  .tabs {
    display: flex;
    gap: 2px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    padding: 3px;
  }
  .tab {
    padding: 4px 14px;
    border-radius: var(--r-pill);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    transition: background 150ms, color 150ms;
  }
  .tab:hover { color: var(--text-1); filter: none; }
  .tab.on { background: var(--accent-soft); color: var(--accent); }
  .right { margin-left: auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
</style>
