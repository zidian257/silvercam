<script lang="ts">
  import { SlidersHorizontal } from 'lucide-svelte';
  import Thumb from './Thumb.svelte';
  import { fmtSize, fmtDur, fmtRec, VOLUME_OPTIONS } from '../inbox.ts';

  // /api/inbox 清单项（服务端 Inbox.list 的投影；非共享类型，本地定义）
  interface IngestState {
    state?: string;
    percent?: number;
    error?: string;
  }
  interface ProbeInfo {
    duration: number;
    width: number;
    height: number;
    fps: number;
    creation_time_utc_ms?: number | null;
    dlog_suspected?: boolean | null;
  }
  interface PreAlign {
    fit: string;
    bias_seconds: number;
  }
  interface InboxItem {
    id: string;
    src: string;
    status?: string;
    size?: number;
    recorded_at?: string | null;
    src_exists?: boolean;
    ingest?: IngestState | null;
    probe?: ProbeInfo | null;
    pre_align?: PreAlign | null;
    volume?: { name?: string | null } | null;
  }
  // 组选择模型（inbox 页 selMap 的值；组件直接改字段后调 onSelChange 持久化）
  interface GroupSel {
    checked: boolean;
    skin: string;
    lut: string;
    fit: string;
    volume: string;
    quickcut: boolean;
    memberIds: string[];
  }
  interface SelectOption {
    value: string;
    label: string;
  }
  interface LoadFitCtx {
    item: InboxItem;
    totalDur: number;
    sel: GroupSel;
  }
  interface Props {
    members: InboxItem[];
    sel: GroupSel;
    skins?: string[];
    lutOptions?: SelectOption[];
    fitOptions?: SelectOption[];
    onSelChange?: () => void;
    onLoadFit?: (ctx: LoadFitCtx) => void;
  }
  let {
    members,
    sel,
    skins = [],
    lutOptions = [],
    fitOptions = [],
    onSelChange = () => {},
    onLoadFit = () => {},
  }: Props = $props();

  const stateOf = (m: InboxItem) => m.ingest?.state;
  const f0 = $derived(members[0]);
  const n = $derived(members.length);
  const totalDur = $derived(members.reduce((a, m) => a + (m.probe?.duration ?? 0), 0));
  const actionableMembers = $derived(members.filter((m) => (stateOf(m) === 'ready' || stateOf(m) === 'on_card') && m.src_exists !== false));
  const actionable = $derived(actionableMembers.length > 0);
  const allOnCard = $derived(members.every((m) => stateOf(m) === 'on_card' && m.src_exists !== false));
  const anyMissing = $derived(members.some((m) => m.src_exists === false));
  const anyFailed = $derived(members.some((m) => stateOf(m) === 'failed'));
  const anyCopying = $derived(members.some((m) => stateOf(m) === 'copying'));

  // 全组已按当前 FIT 校准（bias 一致）→ 显示已对齐徽标
  const aligned = $derived(
    members.every((m) => m.pre_align && m.pre_align.fit === sel.fit && m.pre_align.bias_seconds === members[0].pre_align?.bias_seconds)
      ? members[0].pre_align
      : null
  );

  const studioHref = $derived(
    actionable
      ? `/studio?inbox=${actionableMembers[0].id}&skin=${encodeURIComponent(sel.skin)}&lut=${encodeURIComponent(sel.lut ?? '')}`
      : null
  );

  function onFitSelect(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    if (v === '__load') {
      (e.target as HTMLSelectElement).value = sel.fit ?? 'none'; // 先回原值，选完文件再改
      onLoadFit({ item: f0, totalDur, sel });
      return;
    }
    sel.fit = v;
    onSelChange();
  }
</script>

<div class="item">
  <input
    type="checkbox"
    checked={sel.checked && actionable}
    disabled={!actionable}
    title={actionable ? `选择这次录制（${n} 段一并处理）` : '组内素材拷贝中或文件不可用'}
    onchange={(e) => { sel.checked = (e.target as HTMLInputElement).checked; onSelChange(); }}
  >
  <div class="body">
    <div class="head">
      <div class="name">
        {fmtRec(f0.recorded_at) ?? f0.src.split('/').pop()}
        {#if n > 1}<span class="pill info" title="相机分段录制：这 {n} 段属于同一次录制，一次决策全部生效；提交时可合并输出">同次录制 {n} 段</span>{/if}
        {#if allOnCard}<span class="pill info" title="还在相机卡上，未占本机磁盘；确认后才复制">在卡上</span>{/if}
        {#if anyMissing}<span class="pill warn" title="组内有文件已不在原位置">有段已拔出</span>{/if}
        {#if anyFailed}<span class="pill danger">有段拷贝失败</span>{/if}
        {#if anyCopying}<span class="pill info">拷贝中</span>{/if}
      </div>
      <div class="meta">总时长 {fmtDur(totalDur)} · 来自 {f0.volume?.name ?? '?'}</div>
    </div>

    <div class="segs">
      {#each members as m (m.id)}
        <div class="seg">
          {#if stateOf(m) !== 'copying' && m.probe}<Thumb id={m.id} />{/if}
          <div class="seginfo">
            <div class="segname">
              {m.src.split('/').pop()}
              {#if m.src_exists === false}<span class="pill warn">卡已拔出</span>
              {:else if stateOf(m) === 'copying'}<span class="pill info">拷贝中 {m.ingest?.percent ?? 0}%</span>
              {:else if stateOf(m) === 'failed'}<span class="pill danger" title={m.ingest?.error ?? ''}>拷贝失败</span>
              {:else if stateOf(m) === 'on_card'}<span class="pill mute">在卡上</span>{/if}
            </div>
            <div class="segmeta">{fmtDur(m.probe?.duration)} · {fmtSize(m.size)}{m.probe ? ` · ${m.probe.width}×${m.probe.height} ${Math.round(m.probe.fps)}fps` : ''}</div>
          </div>
        </div>
      {/each}
    </div>

    {#if actionable}
      <div class="controls">
        <label class="field" title="这次录制用的仪表盘皮肤"><span>皮肤</span>
          <select value={sel.skin} onchange={(e) => { sel.skin = (e.target as HTMLSelectElement).value; onSelChange(); }}>
            {#each skins as s}<option value={s} selected={s === sel.skin}>{s}</option>{/each}
          </select>
        </label>
        <label class="field" title="这次录制是否套 LUT"><span>LUT</span>
          <select value={sel.lut} onchange={(e) => { sel.lut = (e.target as HTMLSelectElement).value; onSelChange(); }}>
            {#each lutOptions as o}<option value={o.value} selected={o.value === sel.lut}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="field" title="这次录制用的 FIT（同一次录制共享一条 FIT；无 FIT = 纯拷贝不上 overlay）"><span>FIT</span>
          <select value={sel.fit} onchange={onFitSelect}>
            {#each fitOptions as o}<option value={o.value} selected={o.value === sel.fit}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="field" title="成片音量：默认=跟随全局设置；静音=去掉原声"><span>音量</span>
          <select value={sel.volume} onchange={(e) => { sel.volume = (e.target as HTMLSelectElement).value; onSelChange(); }}>
            {#each VOLUME_OPTIONS as o}<option value={o.value} selected={o.value === sel.volume}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="field" title="出片后自动用成片跑一次快剪（可在「快剪」页继续微调）"><span>快剪</span>
          <input type="checkbox" checked={sel.quickcut} onchange={(e) => { sel.quickcut = (e.target as HTMLInputElement).checked; onSelChange(); }}>
        </label>
        <a class="btn icon" href={studioHref} title="studio 对齐/预览：看视频、套 LUT/皮肤实时预览、定格校准时间轴（内部可切换各段）"><SlidersHorizontal size={16} /></a>
        {#if aligned}
          <span class="pill ok" title="已在 studio 校准（与当前 FIT 选择一致，提交时随任务生效）">已对齐 bias {aligned.bias_seconds > 0 ? '+' : ''}{Math.round(aligned.bias_seconds * 100) / 100}s</span>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .item {
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 14px 18px;
    margin-bottom: 14px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .item input[type=checkbox] { margin-top: 3px; width: 15px; height: 15px; flex: none; }
  .body { flex: 1; min-width: 0; }
  .name {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .meta { color: var(--text-3); font-size: 12px; margin-top: 3px; }
  .segs { display: flex; flex-direction: column; margin-top: 12px; border-top: 1px solid var(--line); }
  .seg {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 6px;
    border-radius: 6px;
    transition: background 150ms;
  }
  .seg:hover { background: var(--bg-2); }
  .seg :global(.thumb) { width: 96px; height: 54px; border-radius: 6px; }
  .seginfo { flex: 1; min-width: 0; }
  .segname {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    font-family: ui-monospace, monospace;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .segmeta { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .controls {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .controls a:hover { filter: none; border-color: var(--line-strong); }
</style>
