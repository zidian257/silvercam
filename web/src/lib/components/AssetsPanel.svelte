<script lang="ts">
  import type { ActpipeConfig } from '../../../../src/types.ts';

  // /luts 清单项（config.listLuts 的投影；非共享类型，本地定义）
  interface LutInfo {
    name: string;
    label?: string | null;
    exists?: boolean;
    default?: boolean;
  }
  interface Props {
    skins?: string[];
    luts?: LutInfo[];
    config?: ActpipeConfig | null;
  }
  let { skins = [], luts = [], config = null }: Props = $props();
</script>

{#if config}
  <div class="row">
    {#each skins as s}
      <span class="pill mute">{#if s === config.skin}<b>{s}（默认）</b>{:else}{s}{/if}</span>
    {/each}
  </div>
  <div class="row">
    {#each luts as l}
      <span class="pill mute" title={l.name}>
        {#if l.default}<b>{l.label ?? l.name}（默认）</b>{:else}{l.label ?? l.name}{/if}
        {#if !l.exists}<span class="err">缺失</span>{/if}
      </span>
    {/each}
  </div>
{/if}

<style>
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .row:last-child { margin-bottom: 0; }
  .pill b { color: var(--text-1); font-weight: 600; }
  .err { color: var(--danger); margin-left: 4px; }
</style>
