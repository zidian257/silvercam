<script lang="ts">
  // FIT 轨迹 SVG 缩略图：onMount 懒取 /api/fits/track/:name，等比投影成 path（圆角描边 + 起终点圆点）
  import { onMount } from 'svelte';
  import { getJson } from '../api.ts';
  import { projectTrack } from '../track.ts';
  import type { TrackPath } from '../track.ts';

  interface Props {
    name: string; // 库内 FIT 文件名
    w?: number; // 投影画布（viewBox）宽
    h?: number;
  }
  let { name, w = 240, h = 72 }: Props = $props();

  let track = $state<TrackPath | null>(null);
  let failed = $state(false);

  onMount(async () => {
    try {
      const { points } = await getJson<{ points: [number, number][] }>(`/api/fits/track/${encodeURIComponent(name)}`);
      track = projectTrack(points, w, h, 6);
      if (!track) failed = true; // 点不足 2 个
    } catch {
      failed = true;
    }
  });
</script>

{#if track}
  <svg viewBox="0 0 {w} {h}" role="img" aria-label="GPS 轨迹">
    <path d={track.d} />
    <circle class="dot" cx={track.start[0]} cy={track.start[1]} r="3" />
    <circle class="dot" cx={track.end[0]} cy={track.end[1]} r="3" />
  </svg>
{:else if failed}
  <span class="empty">无轨迹</span>
{/if}

<style>
  svg { display: block; width: 100%; height: 100%; }
  path {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .dot { fill: var(--accent); stroke: var(--bg-1); stroke-width: 1.5; }
  .empty { font-size: 11px; color: var(--text-3); }
</style>
