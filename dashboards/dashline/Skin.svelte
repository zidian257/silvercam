<script module lang="ts">
  // dashline —— topline 刊头语言的底部镜像版：无任何底板/色块/色带，全部浮空。
  // 底部横排 Anton 数字基线对齐，苔原绿纯文字「/」分隔；accent 苔原绿 #8FBCA0。
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
  const Z_SPEED: Zone[] = [[0, 35, '#8FBCA0'], [35, 50, '#FFD60A'], [50, 999, '#FF453A']];
  const Z_HR: Zone[] = [[0, 120, '#8FBCA0'], [120, 160, '#FFD60A'], [160, 250, '#FF453A']];
</script>

<div id="stage" style:opacity={CANVAS.opacity ?? 1}>
  <TrackMap id="map" data={f.data} sample={f.sample} gradFrom="#8FBCA0" gradTo="#5E8A70" markR={12} haloR={30} dotR={14} />

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

  /* 单层轻质投影 */
  .val {
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .meta, #plate, #strip .wg::before {
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }

  /* ============ 底部横排：浮空、贴安全边距、基线对齐 ============ */
  #strip {
    position: absolute;
    bottom: 56px;
    left: 56px;
    right: 56px;
    display: flex;
    align-items: flex-end;        /* 数字基线跨格对齐 */
  }

  /* 每个指标格：相对定位（zbar 锚底），左侧 gutter 放斜杠。
     固定格宽 + 数字左锚定：位数变化不推邻居，斜杠位置恒定（防 CLS）。
     格宽按 Anton 实测字宽预留：数字 0.4941em/字符，小数点 0.2285em，正负号按数字计。 */
  #strip .wg {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-end;
    width: 270px;                 /* 144px × 4 字符（如 1888）= 284px 略收，常规 3–4 字符 */
    margin-left: 0;
    padding: 0 4px;
  }
  #speed { width: 380px; }        /* hero 200px × 4 字符（88.8）= 342px + 余量 */
  #hr, #cadence { width: 240px; } /* 144px × 3 字符（188）= 213px + 余量，不溢出吃 gutter */
  #grade { width: 330px; }        /* 144px × 5 字符（-12.3）= 318px + 余量 */
  #distance { width: 340px; }     /* 144px × 5 字符（88.88）= 318px + 余量 */

  /* 隐藏格由组件整体不渲染。下面规则只认「可见格」：
     只有「前面存在可见兄弟」的可见格（=非首个可见格）才获得 gutter 与斜杠
     —— 与谁被隐藏无关。 */
  #strip .wg ~ .wg { margin-left: 128px; }

  /* 海报式「/」斜杠分隔符：苔原绿 Anton 纯文字，绝对定位于 gutter 中央 */
  #strip .wg::before {
    content: "/";
    display: none;                 /* 默认无斜杠，仅非首个可见格开启（见下） */
    position: absolute;
    left: -86px;
    bottom: 78px;
    font-family: 'Anton', sans-serif;
    font-size: 140px;
    line-height: 1;
    color: #8FBCA0;
  }
  #strip .wg ~ .wg::before { display: block; }

  /* 主角数字：Anton 特大、大写、紧排，近白 .92 */
  .digital .val {
    font-family: 'Anton', sans-serif;
    font-size: 144px;
    line-height: 0.88;
    letter-spacing: 0.5px;
    color: rgba(255, 255, 255, 0.92);
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

  /* 速度格：头号主角 */
  .hero .val { font-size: 200px; color: rgba(255, 255, 255, 0.95); }
  .hero .label { font-size: 32px; }
  .hero .unit { font-size: 32px; }

  /* zone 变色只上 zbar：每项脚下 5px 细线条（距画布底缘 46px，在安全区内） */
  #strip .zbar {
    position: absolute;
    bottom: -10px;
    left: 4px;
    right: 4px;
    height: 5px;
    background: rgba(255, 255, 255, 0.45);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  }

  /* 右端铭牌：纯文字，底对齐，次级 .75 / accent .85 */
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
    color: #8FBCA0;
    opacity: 0.85;
  }

  /* ============ 轨迹：右上悬浮，零背景，单层轻投影 ============ */
  #map {
    right: 44px;
    top: 44px;
    width: 880px;
    height: 640px;
    overflow: hidden;
  }

  .mapsvg { width: 100%; height: 100%; }

  .mapsvg path, .mapsvg circle {
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35));
  }

  .track-full {
    stroke: rgba(255, 255, 255, 0.6);
    stroke-width: 15;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track-done {
    stroke: url(#trackGrad);
    stroke-width: 15;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot { fill: #fff; stroke: #8FBCA0; stroke-width: 8; }
  .dot-halo { fill: rgba(143, 188, 160, 0.32); }
  .mark-start { fill: #8FBCA0; stroke: #fff; stroke-width: 4; }
  .mark-end { fill: #ff453a; stroke: #fff; stroke-width: 4; }
}
</style>
