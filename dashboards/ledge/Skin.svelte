<script module lang="ts">
  // 书脊 spine（浮空版）：无底板/色块，左缘 48px 安全边距起纵列，竖排标签，右上零背景地图。
  // 层级靠透明度：关键大数字 92% 白，次级数据 75% 白；accent 仅落日橙 #E8823C。
  export const CANVAS = { width: 3840, height: 2160, opacity: 1 };
</script>

<script lang="ts">
  import { createFrame } from '../_lib/frame.svelte.ts';
  import Digital from '../_lib/Digital.svelte';
  import TrackMap from '../_lib/TrackMap.svelte';

  const f = createFrame();
  export const renderFrame = f.renderFrame;
  const fields = $derived(f.data?.fields ?? null);

  type Zone = [number, number, string]; // [下限, 上限, 颜色]
  const Z_HR: Zone[] = [[0, 120, '#30D158'], [120, 160, '#FFD60A'], [160, 250, '#FF453A']];
  const Z_POWER: Zone[] = [[0, 9999, '#E8823C']];
</script>

<div id="stage" style:opacity={CANVAS.opacity ?? 1}>
  <TrackMap id="map" data={f.data} sample={f.sample} gradFrom="#E8823C" gradTo="#FFFFFF" />

  <div id="spine">
    <div id="band">
      <span class="b-word">RIDE//</span>
    </div>

    <div id="readings">
      <Digital id="speed" class="hero" {fields} sample={f.sample} field="speed" label="SPEED" unit="km/h" decimals={1} />
      <Digital id="hr" {fields} sample={f.sample} field="heart_rate" label="HR" unit="bpm" decimals={0} zones={Z_HR} zoneTarget="bar" bar />
      <Digital id="power" {fields} sample={f.sample} field="power" label="PWR" unit="W" decimals={0} zones={Z_POWER} zoneTarget="bar" bar />
      <Digital id="cadence" {fields} sample={f.sample} field="cadence" label="CAD" unit="rpm" decimals={0} />
      <Digital id="grade" {fields} sample={f.sample} field="grade" label="GRADE" unit="%" decimals={1} signed />
      <Digital id="distance" {fields} sample={f.sample} field="distance" label="DIST" unit="km" decimals={2} />
      <Digital id="altitude" {fields} sample={f.sample} field="altitude" label="ALT" unit="m" decimals={0} />
    </div>

    <div id="foot">
      <span>DJI ACTION 5 PRO</span>
    </div>
  </div>
</div>

<style>
@font-face {
  font-family: 'Anton';
  src: url('Anton-400.woff2') format('woff2');
  font-weight: 400;
}
@font-face {
  font-family: 'Barlow Condensed';
  src: url('BarlowCondensed-900i.woff2') format('woff2');
  font-weight: 900;
  font-style: italic;
}
@font-face {
  font-family: 'Space Grotesk';
  src: url('SpaceGrotesk-500.woff2') format('woff2');
  font-weight: 500;
}
@font-face {
  font-family: 'Space Grotesk';
  src: url('SpaceGrotesk-700.woff2') format('woff2');
  font-weight: 700;
}

:global {
  html, body { margin: 0; padding: 0; background: transparent; }

  #stage {
    position: absolute;
    inset: 0;
    font-family: 'Space Grotesk', 'Helvetica Neue', sans-serif;
    color: #fff;
  }

  .wg { position: absolute; }

  /* 轻质单层投影 */
  .val, #band .b-word {
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .meta, #foot {
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }

  /* ================= 书脊骨架（浮空） ================= */
  #spine {
    position: absolute;
    left: 48px;                 /* 左缘安全边距 */
    top: 0;
    bottom: 0;
    width: 460px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 40px 0;
  }
  #spine .wg { position: static; }

  /* ---- 顶部书眉：落日橙斜体标题 ---- */
  #band {
    display: flex;
    align-items: baseline;
    padding-bottom: 8px;
  }
  #band .b-word {
    font-family: 'Barlow Condensed';
    font-weight: 900;
    font-style: italic;
    font-size: 96px;
    line-height: 0.9;
    color: #E8823C;
    letter-spacing: 0.01em;
    text-transform: uppercase;
  }

  /* ---- 读数纵向堆叠 ---- */
  #readings {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-evenly;
  }

  #spine .digital {
    position: relative;
    padding: 14px 0;
  }
  /* 块间细分隔线 */
  #readings .digital + .digital::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: rgba(255, 255, 255, 0.35);
  }

  /* 次级数据：75% 白 */
  .digital .val {
    font-family: 'Anton';
    font-weight: 400;
    font-size: 120px;
    line-height: 0.95;
    color: rgba(255, 255, 255, 0.75);
    letter-spacing: -1px;
    text-transform: uppercase;
  }
  /* 关键数据：92% 白 */
  #speed .val, #hr .val, #power .val {
    color: rgba(255, 255, 255, 0.92);
  }

  /* 竖排标签：60% 白，单位 50% */
  .digital .meta {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    writing-mode: vertical-rl;
    font-family: 'Space Grotesk';
    font-weight: 700;
    font-size: 26px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.65);
    white-space: nowrap;
  }
  .digital .meta .unit {
    color: rgba(255, 255, 255, 0.55);
    margin-top: 16px;
    letter-spacing: 0.18em;
  }

  /* zone 变色细线：数字恒白，zone 只上线
     （组件渲染 <i class="zbar"> 行内元素，需 display:block 才吃宽高） */
  .zbar {
    display: block;
    width: 200px;
    height: 6px;
    margin-top: 12px;
    background: rgba(255, 255, 255, 0.3);
  }

  /* ---- 主读数：速度 ---- */
  .hero .val {
    font-size: 240px;
    letter-spacing: -3px;
  }
  .hero .meta { font-size: 30px; }

  /* ---- 底部品牌行 ---- */
  #foot {
    border-top: 2px solid rgba(255, 255, 255, 0.35);
    padding-top: 18px;
    display: flex;
    justify-content: flex-start;
    font-family: 'Space Grotesk';
    font-weight: 700;
    font-size: 22px;
    letter-spacing: 0.2em;
    white-space: nowrap;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
  }

  /* ================= 轨迹图：右上悬浮，零背景 ================= */
  #map {
    right: 0;
    top: 0;
    width: 1000px;
    height: 700px;
    overflow: hidden;
  }

  .mapsvg { width: 100%; height: 100%; }

  .mapsvg path, .mapsvg circle {
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35));
  }

  .track-full {
    stroke: rgba(255, 255, 255, 0.5);
    stroke-width: 16;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track-done {
    stroke: url(#trackGrad);
    stroke-width: 16;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot { fill: #fff; stroke: #E8823C; stroke-width: 9; }
  .dot-halo { fill: rgba(232, 130, 60, 0.35); }
  .mark-start { fill: #E8823C; stroke: #fff; stroke-width: 4; }
  .mark-end { fill: #fff; stroke: #E8823C; stroke-width: 5; }
}
</style>
