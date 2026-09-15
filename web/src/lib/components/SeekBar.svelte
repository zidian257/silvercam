<script lang="ts">
  // 自绘全宽进度条：数据窗口蓝带嵌在轨道里，整条可点可拖
  interface Props {
    frac?: number; // 播放头位置 0..1
    dataWin?: [number, number] | null; // [loPct, hiPct] 0..1，null = 本段无数据
    label?: string;
    onSeek?: (frac: number) => void; // (frac 0..1)
  }
  let {
    frac = 0,
    dataWin = null,
    label = '',
    onSeek = () => {},
  }: Props = $props();

  let bar: HTMLDivElement;
  function seekTo(e: PointerEvent) {
    const r = bar.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  }
</script>

<div class="seekBar" bind:this={bar} title="点击/拖动跳转；蓝色区段 = 当前对齐下有 FIT 数据（仪表盘出现）"
  onpointerdown={(e) => { try { bar.setPointerCapture(e.pointerId); } catch {} seekTo(e); }}
  onpointermove={(e) => { if (e.buttons) seekTo(e); }}>
  {#if dataWin}
    <div class="seekData" style="left:{dataWin[0] * 100}%;width:{(dataWin[1] - dataWin[0]) * 100}%"></div>
  {/if}
  <div class="seekFill" style="width:{frac * 100}%"></div>
  <div class="seekHead" style="left:{frac * 100}%"></div>
</div>
<span class="mono">{label}</span>

<style>
  .seekBar { position: relative; flex: 1; min-width: 200px; height: 20px; cursor: pointer; touch-action: none; }
  .seekBar::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 7px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-2);
  }
  .seekData {
    position: absolute;
    top: 7px;
    height: 6px;
    border-radius: 3px;
    background: rgba(76, 141, 255, .35);
  }
  .seekFill {
    position: absolute;
    left: 0;
    top: 7px;
    height: 6px;
    border-radius: 3px;
    background: var(--accent);
  }
  .seekHead {
    position: absolute;
    top: 4px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .6);
    transform: translateX(-6px);
    opacity: 0;
    transition: opacity 120ms;
    pointer-events: none;
  }
  .seekBar:hover .seekHead, .seekBar:active .seekHead { opacity: 1; }
  .mono {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--text-2);
    white-space: nowrap;
    flex: none;
  }
</style>
