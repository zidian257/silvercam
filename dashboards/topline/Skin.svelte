<script module lang="ts">
  // 刊头 masthead（浮空版）：无任何底板/色块/色带，全部元素浮在画面上。
  // 顶部横排 Anton 大数字基线对齐，卡其纯文字「/」分隔；accent 仅卡其 #C8A96A。
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
  const Z_SPEED: Zone[] = [[0, 35, '#30D158'], [35, 50, '#FFD60A'], [50, 999, '#FF453A']];
  const Z_HR: Zone[] = [[0, 120, '#30D158'], [120, 160, '#FFD60A'], [160, 250, '#FF453A']];
</script>

<div id="stage" style:opacity={CANVAS.opacity ?? 1}>
  <TrackMap id="map" data={f.data} sample={f.sample} gradFrom="#E3CD9E" gradTo="#C8A96A" />

  <div id="strip">
    <Digital id="speed" class="hero" {fields} sample={f.sample} field="speed" label="SPEED" unit="km/h" decimals={1} zones={Z_SPEED} zoneTarget="bar" bar />
    <Digital id="hr" {fields} sample={f.sample} field="heart_rate" label="HR" unit="bpm" decimals={0} zones={Z_HR} zoneTarget="bar" bar />
    <Digital id="power" {fields} sample={f.sample} field="power" label="PWR" unit="W" decimals={0} bar />
    <Digital id="cadence" {fields} sample={f.sample} field="cadence" label="CAD" unit="rpm" decimals={0} bar />
    <Digital id="grade" {fields} sample={f.sample} field="grade" label="GRADE" unit="%" decimals={1} signed bar />
    <Digital id="distance" {fields} sample={f.sample} field="distance" label="DIST" unit="km" decimals={2} bar />
    <Digital id="altitude" {fields} sample={f.sample} field="altitude" label="ALT" unit="m" decimals={0} bar />
    <div id="plate">
      <div class="plate-title">DJI&nbsp;ACTION</div>
      <div class="plate-sub">5&nbsp;PRO</div>
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
    color: #fff;
  }

  #stage > .wg { position: absolute; }

  /* 单层轻质投影：托底可读即可，不抢画面 */
  .val {
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .meta, #plate, #strip .wg::before {
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  /* ============ 刊头横排：浮空、贴安全边距、基线对齐 ============ */
  #strip {
    position: absolute;
    top: 44px;
    left: 56px;
    right: 56px;
    display: flex;
    align-items: flex-end;        /* 数字基线跨格对齐 */
  }

  /* 每个指标格：相对定位（zbar 锚底），左侧 gutter 放斜杠。
     固定格宽 + 数字左锚定：位数变化不推邻居，斜杠位置恒定（防 CLS）。
     格宽 = Anton 实测字宽推得的最坏字符串宽 + ≥0.3em 安全间隙。
     实测字宽（em）：数字 0.4941（tabular）、小数点 0.2285、+ 0.3555、- 0.3110。 */
  #strip .wg {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-end;
    width: 330px;                 /* 默认：144px ×「8888」284.6 + 0.3em 43.2 → 330 */
    margin-left: 0;
    padding: 0 4px;
  }
  #speed { width: 404px; }        /* 200px ×「88.8」342.2 + 0.3em 60 → 404 */
  #hr, #cadence { width: 260px; } /* 144px ×「888」213.5 + 43.2 → 260 */
  #grade { width: 340px; }        /* 144px ×「+38.8」296.1 + 43.2 → 340 */
  #distance { width: 364px; }     /* 144px ×「88.88」317.5 + 43.2 → 364（<100km） */

  /* 隐藏格由组件整体不渲染。下面规则只认「可见格」：
     只有「前面存在可见兄弟」的可见格（=非首个可见格）才获得 gutter 与斜杠
     —— 与谁被隐藏无关。 */
  #strip .wg ~ .wg { margin-left: 112px; }

  /* 海报式「/」斜杠分隔符：卡其 Anton 纯文字，绝对定位于 gutter 中央 */
  #strip .wg::before {
    content: "/";
    display: none;                 /* 默认无斜杠，仅非首个可见格开启（见下） */
    position: absolute;
    left: -62px;
    bottom: 78px;
    font-family: 'Anton', sans-serif;
    font-size: 140px;
    line-height: 1;
    color: #C8A96A;
  }
  #strip .wg ~ .wg::before { display: block; }

  /* 数字：Anton、大写、紧排。透明度分层级：hero 95% 白，次级数字 75% 白 */
  .digital .val {
    font-family: 'Anton', sans-serif;
    font-size: 144px;
    line-height: 0.88;
    letter-spacing: 0.5px;
    color: rgba(255, 255, 255, 0.75);
    font-variant-numeric: tabular-nums;
  }

  .digital .meta {
    margin-top: 14px;
    display: flex;
    align-items: baseline;
    gap: 16px;
  }

  .digital .label {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 500;
    font-size: 28px;
    letter-spacing: 0.36em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.55);
  }

  .digital .unit {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 700;
    font-size: 28px;
    letter-spacing: 0.12em;
    color: rgba(255, 255, 255, 0.62);
  }

  /* 速度格：头号主角，95% 白 */
  .hero .val { font-size: 200px; color: rgba(255, 255, 255, 0.95); }
  .hero .label { font-size: 32px; }
  .hero .unit { font-size: 32px; }

  /* zone 变色只上 zbar：每项脚下 5px 细线条，一层轻投影 */
  #strip .zbar {
    position: absolute;
    bottom: -14px;
    left: 4px;
    right: 4px;
    height: 5px;
    background: rgba(255, 255, 255, 0.4);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }

  /* 刊头右端铭牌：纯文字，底对齐 */
  #plate {
    margin-left: auto;
    align-self: flex-end;
    text-align: right;
    padding-bottom: 2px;
  }
  .plate-title {
    font-family: 'Anton', sans-serif;
    font-size: 60px;
    line-height: 0.95;
    letter-spacing: 1px;
    color: rgba(255, 255, 255, 0.75);
  }
  .plate-sub {
    margin-top: 12px;
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 700;
    font-size: 32px;
    letter-spacing: 0.3em;
    color: #C8A96A;
  }

  /* ============ 轨迹：右下悬浮，零背景仅轻投影 ============ */
  #map {
    right: 44px;
    bottom: 44px;
    width: 680px;
    height: 500px;
    overflow: hidden;
  }

  .mapsvg { width: 100%; height: 100%; }

  .mapsvg path, .mapsvg circle {
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35));
  }

  .track-full {
    stroke: rgba(255, 255, 255, 0.5);
    stroke-width: 11;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track-done {
    stroke: url(#trackGrad);
    stroke-width: 11;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot { fill: #fff; stroke: #C8A96A; stroke-width: 7; }
  .dot-halo { fill: rgba(200, 169, 106, 0.32); }
  .mark-start { fill: #30d158; stroke: #fff; stroke-width: 3; }
  .mark-end { fill: #ff453a; stroke: #fff; stroke-width: 3; }
}
</style>
