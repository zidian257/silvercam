<script module lang="ts">
  // 转播级浮字版：零底板、零色块，全部元素浮在视频上。
  // 左下主角速度（Anton），右侧版权页窄栏，右上小地图零背景。accent 仅军绿 #9CB84A。
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
  <Digital id="speed" class="hero" {fields} sample={f.sample} field="speed" label="SPEED" unit="km/h" decimals={1} zones={Z_SPEED} zoneTarget="value" />

  <TrackMap id="map" data={f.data} sample={f.sample} gradFrom="#9CB84A" gradTo="#FFFFFF" />

  <div id="folio">
    <Digital id="hr" {fields} sample={f.sample} field="heart_rate" label="HR" unit="bpm" decimals={0} zones={Z_HR} zoneTarget="value" />
    <Digital id="power" {fields} sample={f.sample} field="power" label="PWR" unit="W" decimals={0} />
    <Digital id="cadence" {fields} sample={f.sample} field="cadence" label="CAD" unit="rpm" decimals={0} />
    <Digital id="distance" {fields} sample={f.sample} field="distance" label="DIST" unit="km" decimals={2} />
    <Digital id="altitude" {fields} sample={f.sample} field="altitude" label="ALT" unit="m" decimals={0} />
  </div>
</div>

<style>
@font-face { font-family: 'Anton'; src: url('Anton-400.woff2') format('woff2'); font-weight: 400; }
@font-face { font-family: 'Space Grotesk'; src: url('SpaceGrotesk-500.woff2') format('woff2'); font-weight: 500; }
@font-face { font-family: 'Space Grotesk'; src: url('SpaceGrotesk-700.woff2') format('woff2'); font-weight: 700; }

:global {
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }

  #stage {
    position: absolute;
    inset: 0;
    font-family: 'Space Grotesk', 'Helvetica Neue', sans-serif;
    color: #fff;
  }

  .wg { position: absolute; }

  /* ---- 主角：左下安全边距内，Anton 大数字，zone 色上字 ---- */
  /* Digital 的 DOM 是 val→meta，旧版视觉是 lead→meta→val：flex 排序复原 */
  #speed {
    left: 60px;
    bottom: 60px;
    filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.45));
    display: flex;
    flex-direction: column;
  }

  /* 军绿引导短粗线（divider，不是底板）：旧模板 .lead 元素，以 ::before 复原 */
  #speed::before {
    content: "";
    order: 0;
    width: 120px;
    height: 8px;
    background: #9CB84A;
    margin-bottom: 20px;
  }

  #speed .meta { order: 1; display: flex; align-items: baseline; gap: 18px; margin-bottom: 2px; }
  #speed .val { order: 2; }
  #speed .label { font-size: 34px; font-weight: 700; letter-spacing: 0.45em; text-transform: uppercase; color: rgba(255, 255, 255, 0.6); }
  /* 旧模板 label/unit 间的 .sep 斜杠：以 ::after 复原，间距 = meta gap */
  #speed .label::after { content: "/"; margin-left: 18px; font-weight: 500; letter-spacing: 0; color: rgba(255, 255, 255, 0.35); }
  #speed .unit { font-size: 34px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #9CB84A; opacity: 0.65; }

  #speed .val {
    font-family: 'Anton', sans-serif;
    font-size: 264px;
    line-height: 0.92;
    letter-spacing: 0;
    color: #9CB84A; /* 无 zone 命中时的底色；有 zone 时组件内联覆盖 */
    opacity: 0.92;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ---- 右侧版权页窄栏：细分隔线 + 斜杠小字 ---- */
  #folio {
    position: absolute;
    right: 60px;
    bottom: 60px;
    width: 380px;
    display: flex;
    flex-direction: column;
  }

  /* 同 #speed：flex 排序把 meta 移到 val 之上（旧模板 vrow 的 margin-top 转给 .val） */
  #folio .wg {
    position: relative;
    border-top: 2px solid rgba(255, 255, 255, 0.35);
    padding: 16px 0 26px;
    filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.45));
    display: flex;
    flex-direction: column;
  }

  #folio .meta { order: 1; display: flex; align-items: baseline; gap: 13px; font-size: 26px; }
  #folio .label { font-weight: 500; letter-spacing: 0.42em; text-transform: uppercase; color: rgba(255, 255, 255, 0.6); }
  #folio .label::after { content: "/"; margin-left: 13px; font-weight: 500; letter-spacing: 0; color: rgba(255, 255, 255, 0.35); }
  #folio .unit { font-weight: 500; letter-spacing: 0.26em; text-transform: uppercase; color: rgba(255, 255, 255, 0.6); }

  #folio .val {
    order: 2;
    margin-top: 10px;
    font-size: 92px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
    color: #fff;
    opacity: 0.7;
  }

  /* 关键数据高层级：HR（zone 色内联覆盖）、PWR 纯白，opacity 0.9 */
  #hr .val, #power .val { opacity: 0.9; }

  /* ---- 轨迹图：右上小尺寸，无背景，单层轻投影 ---- */
  #map { right: 60px; top: 56px; width: 520px; height: 400px; }

  .mapsvg { width: 100%; height: 100%; }

  .mapsvg path, .mapsvg circle { filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35)); }

  .track-full {
    stroke: rgba(255, 255, 255, 0.55);
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

  .dot { fill: #9CB84A; stroke: #0A0A0A; stroke-width: 7; }
  .dot-halo { fill: rgba(156, 184, 74, 0.3); }
  .mark-start { fill: #fff; stroke: #0A0A0A; stroke-width: 3; }
  .mark-end { fill: #0A0A0A; stroke: #9CB84A; stroke-width: 4; }
}
</style>
