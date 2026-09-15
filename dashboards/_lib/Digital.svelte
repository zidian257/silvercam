<script lang="ts">
  import { convert, zoneColor, formatValue, type Zone, type FrameSample } from './fmt.ts';

  // 数字读数件：大数值 + label/unit 元行，可选 zone 变色（上数值或上底部细条 zbar）。
  // field 在 fields（FIT 可用字段清单）中缺席时整体不渲染（布局自然塌缩）。
  interface Props {
    sample: FrameSample | null;
    fields?: string[] | null;
    field: string;
    label?: string | null;
    unit?: string;
    decimals?: number;
    signed?: boolean;
    zones?: Zone[] | null;
    zoneTarget?: string;
    bar?: boolean;
    id?: string | undefined;
    class?: string;
  }
  let {
    sample, fields = null, field, label = null, unit = '',
    decimals = 0, signed = false, zones = null, zoneTarget = 'both',
    bar = false, id = undefined, class: klass = '',
  }: Props = $props();

  const shown = $derived(!fields || fields.includes(field));
  // 采样缺口时保持最后一次有效读数（与旧引擎一致）
  let last = $state<number | null>(null);
  $effect(() => {
    const raw = sample?.[field];
    if (raw != null) last = raw;
  });
  const v = $derived(convert(field, last, unit));
  const text = $derived(formatValue(v, { decimals, signed }));
  const color = $derived(zoneColor(zones, v));
  const valColor = $derived(zoneTarget !== 'bar' ? color : null);
  const barColor = $derived(bar && zoneTarget !== 'value' ? color ?? 'rgba(255,255,255,.22)' : null);
</script>

{#if shown}
  <div {id} class="wg digital {klass}">
    <div class="val" style:color={valColor}>{text}</div>
    <div class="meta"><span class="label">{label ?? field.toUpperCase()}</span><span class="unit">{unit}</span></div>
    {#if bar}<i class="zbar" style:background={barColor}></i>{/if}
  </div>
{/if}
