<script lang="ts">
  interface StatCard {
    n: number | string;
    k: string;
    link?: string | null;
    warn?: boolean;
  }
  interface Props {
    cards?: StatCard[];
  }
  let { cards = [] }: Props = $props();

  // k 形如「队列（运行 0 / 排队 0）」时拆出主标签与括号副信息，分两级灰度显示
  const splitK = (k: string) => {
    const m = String(k).match(/^(.*?)（(.*)）$/);
    return m ? { label: m[1], sub: `（${m[2]}）` } : { label: String(k), sub: '' };
  };
</script>

<div class="cards">
  {#each cards as c}
    <div class="stat">
      {#if c.link}
        <a href={c.link}>
          <div class="n" class:warn={c.warn}>{c.n}</div>
          <div class="k">{splitK(c.k).label}</div>
          {#if splitK(c.k).sub}<div class="sub">{splitK(c.k).sub}</div>{/if}
        </a>
      {:else}
        <div class="n" class:warn={c.warn}>{c.n}</div>
        <div class="k">{splitK(c.k).label}</div>
        {#if splitK(c.k).sub}<div class="sub">{splitK(c.k).sub}</div>{/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
  .stat {
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 18px 20px;
    transition: background 150ms;
  }
  .stat:hover { background: var(--bg-2); }
  .stat .n {
    font-family: 'Space Grotesk', -apple-system, sans-serif;
    font-size: 32px;
    font-weight: 700;
    line-height: 1.1;
    color: var(--text-1);
  }
  .stat .n.warn { color: var(--danger); }
  .stat .k { font-size: 12px; color: var(--text-3); margin-top: 6px; }
  .stat .sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
  .stat a { color: inherit; text-decoration: none; display: block; }
  .stat a:hover { filter: none; }
</style>
