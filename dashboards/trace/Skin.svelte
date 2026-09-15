<script module lang="ts">
  // trace —— 轨迹为王：右上 17% 面积无背景轨迹（湖蓝 #5B9BD5 渐变 + 轻 drop-shadow），
  // 左下角海报式数字堆叠（DISTANCE 小字 + Anton 湖蓝巨数），右下指标横排。
  // 全场唯一 accent：湖蓝 #5B9BD5（轨迹渐变/游标、距离巨数）。
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
  <!-- 刊头：字标 + 粗规则 + 两个迷你读数 -->
  <div id="masthead">
    <div id="wordmark">TRACE</div>
    <div id="mast-rule"></div>
    <div id="mast-cap">DJI ACTION 5 PRO</div>
    <div id="minis">
      <Digital id="altitude" class="mini" {fields} sample={f.sample} field="altitude" label="ALTITUDE" unit="m" decimals={0} />
      <Digital id="grade" class="mini" {fields} sample={f.sample} field="grade" label="GRADE" unit="%" decimals={1} signed />
    </div>
  </div>

  <!-- 轨迹：右上 17% 面积，无背景，靠 drop-shadow 悬浮。
       #map 是自有包装层：TrackMap 自带 .wg.map 根件且不收子节点，
       竖排图注 #map-cap 仍需锚在地图盒内，故包一层。 -->
  <div id="map">
    <TrackMap data={f.data} sample={f.sample} gradFrom="#3F7CAC" gradTo="#5B9BD5" markR={12} haloR={36} dotR={16} />
    <div id="map-cap">TRACK</div>
  </div>

  <!-- 底部右侧：次要指标横排 -->
  <div id="metrics">
    <Digital id="speed" class="metric" {fields} sample={f.sample} field="speed" label="SPEED" unit="km/h" decimals={1} zones={Z_SPEED} zoneTarget="both" bar />
    <Digital id="hr" class="metric" {fields} sample={f.sample} field="heart_rate" label="HEART RATE" unit="bpm" decimals={0} zones={Z_HR} zoneTarget="both" bar />
    <Digital id="power" class="metric" {fields} sample={f.sample} field="power" label="POWER" unit="W" decimals={0} bar />
    <Digital id="cadence" class="metric" {fields} sample={f.sample} field="cadence" label="CADENCE" unit="rpm" decimals={0} bar />
  </div>

  <!-- 左下角海报堆叠：DISTANCE 小字 + 巨号 Anton 距离 -->
  <Digital id="distance" class="hero" {fields} sample={f.sample} field="distance" label="DISTANCE" unit="km" decimals={2} />
</div>

<style>
/* 字体：Anton（字标/巨数）、Barlow Condensed 900i（数据）、Space Grotesk（小字）。 */
@font-face { font-family: 'Anton'; src: url('Anton-400.woff2') format('woff2'); font-weight: 400; }
@font-face { font-family: 'Barlow Condensed'; src: url('BarlowCondensed-900i.woff2') format('woff2'); font-weight: 900; font-style: italic; }
@font-face { font-family: 'Space Grotesk'; src: url('SpaceGrotesk-500.woff2') format('woff2'); font-weight: 500; }
@font-face { font-family: 'Space Grotesk'; src: url('SpaceGrotesk-700.woff2') format('woff2'); font-weight: 700; }

:global {
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }

  #stage {
    position: absolute;
    inset: 0;
    font-family: 'Space Grotesk', sans-serif;
    color: #fff;
  }

  .wg { position: absolute; }

  /* ================= 刊头 ================= */
  #masthead { position: absolute; left: 56px; top: 48px; }

  #wordmark {
    font-family: 'Anton';
    font-weight: 400;
    font-size: 108px;
    line-height: 0.9;
    letter-spacing: 3px;
    color: rgba(255, 255, 255, 0.92);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  #mast-rule {
    width: 360px;
    height: 2px;
    background: rgba(255, 255, 255, 0.55);
    margin: 20px 0 16px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }

  #mast-cap {
    font-size: 28px;
    font-weight: 500;
    letter-spacing: 12px;
    color: rgba(255, 255, 255, 0.58);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  #minis { display: flex; gap: 72px; margin-top: 48px; }
  #minis .wg { position: static; }

  /* 次级数字：92px / 透明度 .7 */
  .mini .val {
    font-family: 'Barlow Condensed';
    font-weight: 900;
    font-style: italic;
    font-size: 92px;
    line-height: 0.9;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .mini .meta { margin-top: 12px; display: flex; gap: 13px; align-items: baseline; }
  .mini .label {
    font-size: 22px; font-weight: 700; letter-spacing: 8px;
    color: rgba(255, 255, 255, 0.55); text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .mini .unit {
    font-size: 25px; font-weight: 500;
    color: rgba(255, 255, 255, 0.65); text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  /* ================= 左下海报堆叠：DISTANCE 小字 / 湖蓝巨数 ================= */
  .hero {
    left: 56px;
    bottom: 56px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .hero .meta {
    order: 1;
    display: flex;
    gap: 20px;
    align-items: baseline;
  }
  .hero .meta .label {
    font-size: 40px; font-weight: 700; letter-spacing: 14px;
    color: rgba(255, 255, 255, 0.55); text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .hero .meta .unit {
    font-size: 36px; font-weight: 500; letter-spacing: 5px;
    color: rgba(255, 255, 255, 0.65); text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  /* 关键数字：256px / 湖蓝 .92 */
  .hero .val {
    order: 2;
    margin-top: 6px;
    font-family: 'Anton';
    font-weight: 400;
    font-size: 256px;
    line-height: 0.9;
    letter-spacing: -2px;
    font-variant-numeric: tabular-nums;
    color: rgba(91, 155, 213, 0.92);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  /* ================= 右下指标横排 ================= */
  #metrics {
    position: absolute;
    right: 56px;
    bottom: 56px;
    display: flex;
    align-items: flex-end;
  }
  #metrics .wg { position: relative; }
  /* Digital 把 zbar 渲染在 meta 之后；旧 markup 里 zbar 在 val 之前（在流内、
     靠 margin-bottom 顶开数字）。改 flex 列 + order 把 zbar 排回最前，布局不变。 */
  #metrics .metric { padding: 0 52px; display: flex; flex-direction: column; }
  #metrics .metric:first-child { padding-left: 0; }
  #metrics .metric:last-child { padding-right: 0; }
  /* 细分隔线 */
  #metrics .metric + .metric { border-left: 2px solid rgba(255, 255, 255, 0.3); }

  /* zbar：8px 细线，zone 变色；数字随 zone 变色（zoneTarget: both） */
  .metric .zbar {
    order: -1;
    display: block;
    width: 88px;
    height: 8px;
    margin-bottom: 20px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }

  /* 关键数字：116px / 透明度 .9（zone 着色时 opacity 仍生效） */
  .metric .val {
    font-family: 'Barlow Condensed';
    font-weight: 900;
    font-style: italic;
    font-size: 116px;
    line-height: 0.9;
    font-variant-numeric: tabular-nums;
    opacity: 0.9;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .metric .meta { margin-top: 14px; display: flex; gap: 12px; align-items: baseline; }
  .metric .label {
    font-size: 23px; font-weight: 700; letter-spacing: 8px;
    color: rgba(255, 255, 255, 0.55); text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
  .metric .unit {
    font-size: 26px; font-weight: 500;
    color: rgba(255, 255, 255, 0.65); text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }

  /* ================= 轨迹：右上 17% 面积（1400×1000 ≈ 3840×2160×0.169） ================= */
  /* #map 是包装层（见模板注释）：定位与尺寸在这里，TrackMap 根件充满它 */
  #map {
    position: absolute;
    right: 0;
    top: 0;
    width: 1400px;
    height: 1000px;
    overflow: visible;
  }
  #map .map { width: 100%; height: 100%; }

  .mapsvg { width: 100%; height: 100%; }

  .mapsvg path, .mapsvg circle {
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35));
  }

  .track-full {
    stroke: rgba(255, 255, 255, 0.32);
    stroke-width: 9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track-done {
    stroke: url(#trackGrad);
    stroke-width: 17;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dot { fill: #5b9bd5; stroke: #fff; stroke-width: 8; }
  .dot-halo { fill: rgba(91, 155, 213, 0.3); }
  .mark-start { fill: #fff; stroke: rgba(0, 0, 0, 0.6); stroke-width: 4; }
  .mark-end { fill: #111; stroke: #fff; stroke-width: 4; }

  /* 竖排图注，挂在地图右下角下沿（仍在画布内） */
  #map-cap {
    position: absolute;
    right: 28px;
    bottom: -84px;
    writing-mode: vertical-rl;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 10px;
    color: rgba(255, 255, 255, 0.58);
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  }
}
</style>
