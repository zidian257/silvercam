<script lang="ts">
  import { projectTrack, type TrackSample, type FrameSample } from './fmt.ts';

  // 轨迹图：FIT position 序列投影成 SVG path，走过部分渐变描边，游标带光晕。
  // 无背景，靠皮肤 CSS 的 drop-shadow 悬浮。数据不足 2 点时整图隐藏。
  // 弧长与游标用纯数学（折线积分）计算——不依赖 getTotalLength 等 DOM 几何 API，
  // 避免布局测量时机问题（jsdom 可测，逐帧渲染确定性也更强）。
  // data 为宿主注入的 FIT 数据集（window.ACTPIPE.data），键随数据管道扩展
  interface TrackData {
    count?: number;
    samples?: TrackSample[];
    [k: string]: unknown;
  }
  interface Props {
    data: TrackData | null;
    sample: FrameSample | null;
    id?: string | undefined;
    class?: string;
    showStartEnd?: boolean;
    gradFrom?: string;
    gradTo?: string;
    markR?: number;
    haloR?: number;
    dotR?: number;
  }
  let {
    data, sample,
    id = undefined, class: klass = '',
    showStartEnd = true,
    gradFrom = '#ffffff', gradTo = '#888888',
    markR = 10, haloR = 24, dotR = 12,
  }: Props = $props();

  let w = $state(0);
  let h = $state(0);
  const geo = $derived(projectTrack(data?.samples ?? [], w || 800, h || 600));
  const count = $derived(data?.count ?? 0);
  const frac = $derived.by(() => {
    if (!geo) return 0;
    let f;
    if (sample?.distance != null && geo.totalDist) f = sample.distance / geo.totalDist;
    else f = (sample?.i ?? 0) / Math.max(1, count - 1);
    return Math.min(1, Math.max(0, f));
  });
  const len = $derived((geo?.length ?? 0) * frac);
  const cursor = $derived(geo ? geo.pointAt(len) : { x: -999, y: -999 });
  const dash = $derived(geo ? `${len} ${geo.length}` : '0 1');
</script>

<div {id} class="wg map {klass}" bind:clientWidth={w} bind:clientHeight={h}>
  {#if geo}
    <svg class="mapsvg" viewBox="0 0 {w || 800} {h || 600}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="trackGrad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color={gradFrom} />
          <stop offset="1" stop-color={gradTo} />
        </linearGradient>
      </defs>
      <path class="track-full" fill="none" d={geo.d} />
      <path class="track-done" fill="none" d={geo.d} style:stroke-dasharray={dash} />
      {#if showStartEnd}
        <circle class="mark-start" r={markR} cx={geo.start[0]} cy={geo.start[1]} />
        <circle class="mark-end" r={markR} cx={geo.end[0]} cy={geo.end[1]} />
      {/if}
      <circle class="dot-halo" r={haloR} cx={cursor.x} cy={cursor.y} />
      <circle class="dot" r={dotR} cx={cursor.x} cy={cursor.y} />
    </svg>
  {/if}
</div>
