<script module lang="ts">
  // virb_like —— 角落情报站（浮空版）：左下角无底板堆叠排版，细白分隔线；
  // 层级靠透明度（关键数字 .9 / 次级 .7 / 标签单位 .55–.6）；
  // 唯一 accent：赭石岩红 #C4553B（hero 巨数 + 地图）；右上小地图零背景。
  // 全部元素内收 48px 安全边距，单层轻投影。
  export const CANVAS = { width: 3840, height: 2160, opacity: 0.95 };
</script>

<script lang="ts">
  import { createFrame } from '../_lib/frame.svelte.ts';
  import Digital from '../_lib/Digital.svelte';
  import TrackMap from '../_lib/TrackMap.svelte';

  const f = createFrame();
  export const renderFrame = f.renderFrame;
  const fields = $derived(f.data?.fields ?? null);

  type Zone = [number, number, string]; // [下限, 上限, 颜色]
  const Z_HR: Zone[] = [[0, 120, '#34C759'], [120, 160, '#FFD60A'], [160, 250, '#FF453A']];
  const Z_POWER: Zone[] = [[0, 200, '#34C759'], [200, 300, '#FFD60A'], [300, 9999, '#FF453A']];
</script>

<div id="stage" style:opacity={CANVAS.opacity ?? 1}>
  <!-- 角落情报站：左下角色块拼贴堆叠，贴死左/下边缘 -->
  <div id="corner">

    <div id="row-secondary">
      <Digital id="distance" class="inv" {fields} sample={f.sample} field="distance" label="DIST" unit="km" decimals={2} />
      <Digital id="altitude" class="inv" {fields} sample={f.sample} field="altitude" label="ALT" unit="m" decimals={0} />
    </div>

    <div id="row-metrics">
      <Digital id="hr" {fields} sample={f.sample} field="heart_rate" label="HR" unit="bpm" decimals={0} zones={Z_HR} zoneTarget="bar" bar />
      <Digital id="power" {fields} sample={f.sample} field="power" label="POWER" unit="W" decimals={0} zones={Z_POWER} zoneTarget="bar" bar />
      <Digital id="cadence" class="fixed" {fields} sample={f.sample} field="cadence" label="CAD" unit="rpm" decimals={0} />
      <Digital id="grade" class="fixed" {fields} sample={f.sample} field="grade" label="GRADE" unit="%" decimals={1} signed />
    </div>

    <div id="hero">
      <Digital id="speed" {fields} sample={f.sample} field="speed" label="SPEED" unit="km/h" decimals={1} />
    </div>

  </div>

  <!-- 右上角小地图：无背景，仅 drop-shadow -->
  <TrackMap id="map" data={f.data} sample={f.sample} gradFrom="#E19A80" gradTo="#C4553B" markR={12} haloR={30} dotR={15} />
  <div id="maptag"><span class="t">COURSE</span></div>
</div>

<style>
@font-face {
  font-family: 'Barlow Condensed';
  src: url('BarlowCondensed-900i.woff2') format('woff2');
  font-weight: 900;
  font-style: italic;
}
@font-face {
  font-family: 'Barlow Condensed';
  src: url('BarlowCondensed-700.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
}

:global {
  html, body { margin: 0; padding: 0; background: transparent; }

  #stage {
    position: absolute;
    inset: 0;
    font-family: 'Barlow Condensed', "Helvetica Neue", sans-serif;
    color: #fff;
  }

  .wg { position: absolute; }

  /* ============ 左下角浮空堆叠（48px 安全边距）============ */
  #corner {
    position: absolute;
    left: 48px;
    bottom: 48px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 22px;
  }

  #row-secondary, #row-metrics {
    display: flex;
    align-items: flex-end;
    /* 行下细白分隔线 */
    border-bottom: 1px solid rgba(255, 255, 255, 0.35);
    padding-bottom: 14px;
    filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.35));
  }

  #corner .wg { position: relative; }

  /* 关键数字：白 90% */
  .digital .val {
    font-weight: 900;
    font-style: italic;
    line-height: 0.82;
    letter-spacing: -0.015em;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.9);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  .digital .meta {
    margin-top: 10px;
    display: flex;
    align-items: baseline;
    gap: 14px;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  /* 标签 55% 白 / 单位 60% 白 */
  .digital .label {
    font-size: 26px;
    font-weight: 700;
    font-style: normal;
    letter-spacing: 0.36em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.55);
  }

  .digital .unit {
    font-size: 32px;
    font-weight: 900;
    font-style: italic;
    color: rgba(255, 255, 255, 0.6);
  }

  /* 块间竖向细白分隔线（每块左缘，首块除外）。
     隐藏格由组件整体不渲染，相邻兄弟选择器只认「可见格」。 */
  #row-metrics .digital + .digital,
  #row-secondary .digital + .digital {
    border-left: 1px solid rgba(255, 255, 255, 0.35);
    margin-left: 30px;
    padding-left: 30px;
  }

  /* ---- 主角 SPEED：赭石岩红 #C4553B 900i，唯一 accent 数字 ---- */
  #hero {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  #hero .wg { position: static; }

  #speed .val {
    font-size: 240px;
    color: rgba(196, 85, 59, 0.92);
  }

  #speed .meta { margin-top: 12px; gap: 20px; }
  #speed .label { font-size: 34px; }
  #speed .unit { font-size: 46px; }

  /* ---- 中间排：HR / POWER / CAD / GRADE（关键数字）---- */
  #row-metrics .val { font-size: 120px; }

  /* zone 变色细线：板顶 6px 线条，组件着色；数字恒白 */
  .zbar {
    position: absolute;
    top: -10px;
    left: 2px;
    width: 64px;
    height: 6px;
    margin: 0;
    background: rgba(255, 255, 255, 0.4);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }

  /* 无 zone 的块：固定白色细线（CSS 静态） */
  .digital.fixed::before {
    content: '';
    position: absolute;
    top: -10px;
    left: 2px;
    width: 64px;
    height: 6px;
    background: rgba(255, 255, 255, 0.4);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }

  /* ---- 顶排：DIST / ALT 次级数字，70% 白 ---- */
  #row-secondary .val { font-size: 92px; color: rgba(255, 255, 255, 0.7); }
  #row-secondary .label { font-size: 22px; }
  #row-secondary .unit { font-size: 26px; }

  /* ============ 右上角小地图（零背景，轻投影，48px 内收）============ */
  #map {
    right: 48px;
    top: 48px;
    width: 940px;
    height: 620px;
    overflow: hidden;
  }

  .mapsvg { width: 100%; height: 100%; }

  .mapsvg path, .mapsvg circle {
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35));
  }

  .track-full {
    stroke: rgba(255, 255, 255, 0.55);
    stroke-width: 13;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track-done {
    stroke: url(#trackGrad);
    stroke-width: 13;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot { fill: #C4553B; stroke: #fff; stroke-width: 8; }
  .dot-halo { fill: rgba(196, 85, 59, 0.35); }
  .mark-start { fill: #fff; stroke: #C4553B; stroke-width: 5; }
  .mark-end { fill: #C4553B; stroke: #fff; stroke-width: 5; }

  /* 地图图注：COURSE，纯文字轻投影 */
  #maptag {
    position: absolute;
    right: 48px;
    top: 700px;
    display: flex;
    align-items: center;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  #maptag .t {
    font-size: 34px;
    font-weight: 700;
    letter-spacing: 0.42em;
    color: rgba(255, 255, 255, 0.6);
  }
}
</style>
