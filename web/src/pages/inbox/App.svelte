<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { getJson, postJson, api } from '../../lib/api.ts';
  import {
    fmtDur, groupItems, gkey, sigOf, mergeGroupsNow, buildDecisions, commitSummary, lutLabel,
  } from '../../lib/inbox.ts';
  import PendingGroup from '../../lib/components/PendingGroup.svelte';
  import ResolvedItem from '../../lib/components/ResolvedItem.svelte';
  import MergeConfirm from '../../lib/components/MergeConfirm.svelte';
  import AppNav from '../../lib/components/AppNav.svelte';
  import type { ActpipeConfig, ProgressPayload } from '../../../../src/types.ts';

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
  interface Decision {
    skin?: string | null;
    lut?: string | null;
    fit?: string | null;
    bias_seconds?: number | null;
  }
  interface InboxItem {
    id: string;
    src: string;
    status?: string;
    size?: number;
    mtime_ms?: number | null;
    staged?: string | null;
    recorded_at?: string | null;
    seq?: number | null;
    src_exists?: boolean;
    ingest?: IngestState | null;
    probe?: ProbeInfo | null;
    pre_align?: PreAlign | null;
    decision?: Decision | null;
    fit_suggestion?: string | null;
    volume?: { name?: string | null } | null;
    job_id?: string | null;
  }
  // 组选择模型（selMap 的值；{ checked, skin, lut, fit, memberIds } —— 直接改字段后调 onSelChange 持久化）
  interface GroupSel {
    checked: boolean;
    skin: string;
    lut: string;
    fit: string;
    memberIds: string[];
  }
  interface SelectOption {
    value: string;
    label: string;
  }
  // /jobs 列表摘要（与 JobsTable 的契约一致）
  interface JobSummary {
    id: string;
    state: string;
    created_at: string;
    video: string;
    segments: number;
    skin?: string | null;
    fit?: boolean;
    bias_seconds?: number | null;
    progress?: ProgressPayload | null;
    error?: string | null;
    output?: string | null;
  }
  // /luts 清单项
  interface LutInfo {
    name: string;
    label?: string | null;
    exists?: boolean;
    default?: boolean;
  }
  // /api/fits 清单项
  interface FitEntry {
    name: string;
    path: string;
    start_ms: number;
    end_ms: number;
    duration_s: number;
  }
  // /api/inbox/commit 响应单项
  interface CommitResult {
    id: string;
    error?: string;
    job_id?: string;
    skipped?: boolean;
  }
  // 提交决策（buildDecisions 产物；merge 在用户选分段输出时本地补写）
  interface CommitDecision {
    id: string;
    action: string;
    skin?: string;
    lut?: string | null;
    fit?: string;
    merge?: boolean;
  }
  interface LoadFitCtx {
    item: InboxItem;
    totalDur: number;
    sel: GroupSel;
  }

  let items = $state<InboxItem[]>([]);
  let jobs = $state<JobSummary[]>([]);
  let skins = $state<string[]>([]);
  let lutOptions = $state<SelectOption[]>([]);
  let fitOptions = $state<SelectOption[]>([]);
  let lutLabels = $state<Record<string, string>>({});
  let bulkSkin = $state('');
  let bulkLut = $state('');
  let statusMsg = $state('');
  let statusErr = $state(false);
  let mergeChoice = $state<{ groups: { fit: string; n: number }[]; resolve: (choice: string) => void } | null>(null); // 合并确认弹窗

  // 选择模型跨轮询保留（key = 组内成员 id 排序拼接）
  const selMap = new Map<string, GroupSel>();
  let lastSig = '';
  let statusUntil = 0; // 操作反馈消息至少展示这么久，不被轮询状态覆盖

  function setStatus(msg: string, isErr = false, holdMs = 0) {
    statusMsg = msg;
    statusErr = isErr;
    if (holdMs) statusUntil = Date.now() + holdMs;
  }

  const pending = $derived(items.filter((i) => i.status === 'pending'));
  // groupItems 返回 lib/api 的宽 InboxItem（src 可选）；本页契约要求 src 必有，收窄断言
  const pendingGroups = $derived(groupItems(pending) as InboxItem[][]);
  const resolved = $derived(items.filter((i) => i.status !== 'pending'));
  const mergeHint = $derived.by(() => {
    void selVersion; // selMap 非响应式，用版本号触发重算
    return [...(mergeGroupsNow([...selMap.values()]) as Map<string, number>).entries()]
      .filter(([, n]) => n >= 2)
      .map(([key, n]) => `${key.split('|')[0].split('/').pop()} × ${n} 段 → 可合并为一条`)
      .join('；');
  });

  function groupSel(members: InboxItem[]): GroupSel {
    const key = gkey(members);
    if (!selMap.has(key)) {
      const f0 = members[0];
      selMap.set(key, {
        // 重新编辑拉回待处理的组默认不勾选，避免被批量操作误带进去
        checked: !members.some((m) => m.decision),
        skin: f0.decision?.skin ?? bulkSkin,
        lut: f0.decision?.lut ?? bulkLut,
        // FIT 预选取组内第一个有建议/已校准的成员（首段可能是 FIT 开始前的几秒钟废段）
        fit: members.find((m) => m.pre_align)?.pre_align?.fit
          ?? members.find((m) => m.decision?.fit)?.decision?.fit
          ?? members.find((m) => m.fit_suggestion)?.fit_suggestion
          ?? 'none',
        memberIds: members.map((m) => m.id),
      });
    }
    return selMap.get(key)!;
  }

  // selMap 是普通 Map（跨轮询保留，不驱动渲染）；合并提示需要手动触发重算
  let selVersion = $state(0);
  function touchSel() { selVersion++; }

  // 已勾选段数（跨组求和）：驱动批量条「已选 N 段」与按钮可用态
  const selCount = $derived.by(() => {
    void selVersion;
    let count = 0;
    for (const s of selMap.values()) if (s.checked) count += s.memberIds?.length ?? 0;
    return count;
  });

  async function loadStatic() {
    const [sk, luts, cfg, fits]: [string[], LutInfo[], ActpipeConfig, FitEntry[]] = await Promise.all([
      getJson('/skins'),
      getJson('/luts'),
      getJson('/config'),
      getJson('/api/fits').catch(() => []),
    ]);
    skins = sk;
    bulkSkin = cfg.skin;
    lutLabels = Object.fromEntries(luts.filter((l) => l.label).map((l) => [l.name, l.label])) as Record<string, string>;
    lutOptions = [
      { value: '', label: '自动（按 D-Log 策略）' },
      { value: 'none', label: '不套 LUT' },
      ...luts.filter((l) => l.exists).map((l) => ({ value: l.name, label: `${l.label ?? l.name}${l.default ? '（默认）' : ''}` })),
    ];
    bulkLut = '';
    setFitOptions(Array.isArray(fits) ? fits : []);
  }

  function setFitOptions(fits: FitEntry[]) {
    fitOptions = [
      { value: 'none', label: '无 FIT（仅拷贝）' },
      { value: '__load', label: '载入 .fit 文件…' },
      ...fits.map((f) => {
        const d = new Date(f.start_ms);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return { value: f.path, label: `${f.name}（${d.getMonth() + 1}月${d.getDate()}日 ${hm} 起 · ${fmtDur(f.duration_s)}）` };
      }),
    ];
  }

  async function refresh(force = false) {
    try {
      const [its, jb]: [InboxItem[], JobSummary[]] = await Promise.all([getJson('/api/inbox'), getJson('/jobs')]);
      const sig = sigOf(its, jb);
      const editing = document.activeElement?.tagName === 'SELECT' && !!document.activeElement.closest('.item');
      if (!force && (sig === lastSig || editing)) return;
      lastSig = sig;
      items = its;
      jobs = jb;
      await tick(); // 等 PendingGroup 渲染回填 selMap 后再重算派生态（合并提示/已选计数）
      touchSel(); // 组重算后合并提示刷新
      if (Date.now() >= statusUntil) {
        const copying = its.filter((i) => i.status === 'pending' && i.ingest?.state === 'copying').length;
        setStatus(pending.length ? `${its.filter((i) => i.status === 'pending').length} 段待确认${copying ? `（${copying} 段拷贝中）` : ''}` : '无待确认素材');
      }
    } catch (e) {
      setStatus(`刷新失败：${(e as Error).message}`, true);
    }
  }

  // ---- 批量条 ----
  function applyBulk() {
    for (const s of selMap.values()) {
      if (!s.checked) continue;
      s.skin = bulkSkin;
      s.lut = bulkLut;
    }
    refresh(true);
  }
  function selAll(v: boolean) {
    for (const s of selMap.values()) s.checked = v;
    refresh(true);
  }

  async function commit(action: 'process' | 'skip') {
    const decisions: CommitDecision[] = buildDecisions([...selMap.values()], action);
    if (!decisions.length) { setStatus('没有勾选的录制', true); return; }
    if (action === 'process') {
      const groups = [...(mergeGroupsNow([...selMap.values()]) as Map<string, number>).entries()]
        .filter(([, n]) => n >= 2)
        .map(([key, n]) => ({ fit: key.split('|')[0], n }));
      if (groups.length) {
        const choice = await new Promise<string>((resolve) => (mergeChoice = { groups, resolve }));
        mergeChoice = null;
        if (choice === 'cancel') return;
        if (choice === 'split') for (const d of decisions) d.merge = false; // 用户选分段：服务端不再自动合并
      }
    }
    try {
      const body = await postJson('/api/inbox/commit', { decisions });
      const doneIds = new Set(body.results.map((r: CommitResult) => r.id));
      for (const k of [...selMap.keys()]) if (selMap.get(k)!.memberIds?.some((id) => doneIds.has(id))) selMap.delete(k);
      const s = commitSummary(body);
      setStatus(s.text, s.isErr, 15000);
    } catch (e) {
      setStatus((e as Error).message || '提交失败', true);
    }
    refresh(true);
  }

  // ---- FIT 载入（隐藏文件选择器 → 上传进库 → 选中 + 时间重叠校验） ----
  let fitPicker: HTMLInputElement;
  let fitPickerCtx: LoadFitCtx | null = null;
  function onLoadFit(ctx: LoadFitCtx) {
    fitPickerCtx = ctx;
    fitPicker.click();
  }
  async function onFitPicked() {
    const file = fitPicker.files?.[0];
    fitPicker.value = '';
    const ctx = fitPickerCtx;
    fitPickerCtx = null;
    if (!file || !ctx) return;
    setStatus(`载入 ${file.name}…`);
    try {
      const r = await api(`/api/fits?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: {} });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus(`载入失败：${b.error ?? r.status}`, true, 8000); return; }
      setFitOptions(await getJson('/api/fits').catch(() => []));
      ctx.sel.fit = b.path; // 载入即选中该条
      touchSel();
      // 重叠校验：与这次录制的时间窗口无交集时提醒（仍可强行用，offset 兜底逻辑不变）
      const m = String(ctx.item.recorded_at ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      const dur = ctx.totalDur ?? ctx.item.probe?.duration;
      if (m && dur) {
        const vs = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        const overlap = Math.min(vs + dur * 1000, b.end_ms) - Math.max(vs, b.start_ms);
        if (overlap <= 0) setStatus(`已载入 ${b.name}，但与该素材拍摄时间无重叠，请确认是否选对`, true, 10000);
        else setStatus(`已载入 ${b.name} 并选中（覆盖 ${fmtDur(b.duration_s)}）`, false, 6000);
      } else {
        setStatus(`已载入 ${b.name} 并选中`, false, 6000);
      }
    } catch (e) {
      setStatus(`载入失败：${(e as Error).message}`, true, 8000);
    }
  }

  // ---- 素材库操作 ----
  async function onReopen(item: InboxItem) {
    const r = await api(`/api/inbox/${item.id}/reopen`, { method: 'POST' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { setStatus(b.error ?? '重新编辑失败', true, 8000); return; }
    for (const k of [...selMap.keys()]) if (selMap.get(k)!.memberIds?.includes(item.id)) selMap.delete(k); // 清掉所在组的选择缓存，决策按上次重新预填
    setStatus('已拉回待处理（默认不勾选，确认无误再提交）', false, 6000);
    refresh(true);
  }
  async function onDismiss(item: InboxItem, deleteStaged: boolean) {
    await api(`/api/inbox/${item.id}${deleteStaged ? '?delete_staged=1' : ''}`, { method: 'DELETE' });
    refresh(true);
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(async () => {
    await loadStatic();
    await refresh(true);
    timer = setInterval(refresh, 2500);
  });
  onDestroy(() => clearInterval(timer));
</script>

<AppNav current="inbox">
  <span class="pill info">{pending.length} 段待确认</span>
</AppNav>

<div id="bulk">
  <div class="bl">
    <span class="deflabel" title="新出现的素材默认套用这组选择；之后可以逐条修改">默认</span>
    <label class="field" title="仪表盘皮肤"><span>皮肤</span>
      <select bind:value={bulkSkin}>
        {#each skins as s}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <label class="field" title="LUT：自动=按 D-Log 策略决定；不套=显式不用 LUT；或指定一个"><span>LUT</span>
      <select bind:value={bulkLut}>
        {#each lutOptions as o}<option value={o.value}>{o.label}</option>{/each}
      </select>
    </label>
  </div>
  <div class="br">
    {#if mergeHint}<span class="mergehint" title="这些条目选择了同一个 FIT（且皮肤/LUT 一致），提交时会询问是否合并输出为一条视频">{mergeHint}</span>{/if}
    {#if statusMsg}<span class="statusmsg" class:err={statusErr}>{statusMsg}</span>{/if}
    {#if selCount > 0}<span class="selcount">已选 {selCount} 段</span>{/if}
    <button class="btn" onclick={applyBulk} disabled={selCount === 0} title="把上面的皮肤/LUT 选择覆盖到所有勾选的条目">应用到所选</button>
    <button class="btn" onclick={() => selAll(true)}>全选</button>
    <button class="btn" onclick={() => selAll(false)}>全不选</button>
    <button class="btn primary" onclick={() => commit('process')} disabled={selCount === 0} title="勾选的条目按各自的皮肤/LUT 设置进入自动化队列（ingest→probe→fit→render→compose）">开始处理所选</button>
    <button class="btn" onclick={() => commit('skip')} disabled={selCount === 0} title="勾选的条目不处理（staging 副本保留，可随时恢复或删除）">跳过所选</button>
  </div>
</div>

<main>
  <h2>待处理（新素材 / 重新编辑）</h2>
  {#if !pendingGroups.length}
    <div class="empty">暂无待确认素材。插入相机后新素材会出现在这里（默认只读信息不占磁盘，确认后才从卡复制）。</div>
  {:else}
    {#each pendingGroups as members (gkey(members))}
      <PendingGroup {members} sel={groupSel(members)} {skins} {lutOptions} {fitOptions} onSelChange={touchSel} {onLoadFit} />
    {/each}
  {/if}

  <h2>素材库（已出片 / 已跳过）</h2>
  {#if !resolved.length}
    <div class="empty">暂无</div>
  {:else}
    {#each resolved as item (item.id)}
      <ResolvedItem {item} job={item.job_id ? jobs.find((j) => j.id === item.job_id) : null} {lutLabels} {onReopen} {onDismiss} />
    {/each}
  {/if}

  <h2>出片队列</h2>
  {#if !jobs.length}
    <div class="empty">暂无任务</div>
  {:else}
    <table class="jobs">
      <thead><tr><th>任务</th><th>视频</th><th>皮肤</th><th>状态</th></tr></thead>
      <tbody>
        {#each jobs.slice(0, 20) as j (j.id)}
          <tr>
            <td class="mono jid">{j.id}</td>
            <td class="mono">
              {j.video}
              {#if j.output}<div class="dim mono vpath">{j.output}</div>{/if}
              {#if j.error}<div class="err">{j.error}</div>{/if}
            </td>
            <td class="skincell">{j.skin ?? ''}</td>
            <td><span class="st {j.state}">{j.state}{j.progress?.percent != null ? ` ${Math.round(j.progress.percent)}%` : ''}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<input type="file" accept=".fit" style="display:none" bind:this={fitPicker} onchange={onFitPicked}>

{#if mergeChoice}
  <MergeConfirm groups={mergeChoice.groups} onChoice={(c) => mergeChoice!.resolve(c)} />
{/if}

<style>
  #bulk {
    position: sticky;
    top: 56px;
    z-index: 40;
    padding: 10px 24px;
    background: color-mix(in srgb, var(--bg-0) 88%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .bl, .br { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .deflabel { font-size: 11px; color: var(--text-3); letter-spacing: .08em; }
  .mergehint, .statusmsg {
    font-size: 12px;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mergehint { color: var(--accent); }
  .statusmsg { color: var(--text-2); }
  .statusmsg.err { color: var(--danger); }
  .selcount { font-size: 12px; color: var(--text-2); white-space: nowrap; }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    margin: 28px 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  h2:first-child { margin-top: 4px; }
  .empty { color: var(--text-3); padding: 18px 4px; }
  table.jobs { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.jobs td, table.jobs th { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; }
  table.jobs th {
    color: var(--text-3);
    font-weight: 600;
    font-size: 11px;
    letter-spacing: .08em;
  }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .jid { color: var(--text-3); white-space: nowrap; }
  .vpath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 480px; }
  .dim { color: var(--text-3); }
  .err { color: var(--danger); font-size: 11px; }
  .skincell { font-size: 12px; color: var(--text-2); }
  .st { border-radius: var(--r-pill); padding: 2px 10px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .st.queued, .st.awaiting_fit { background: rgba(229, 165, 10, .12); color: var(--warn); }
  .st.ingesting, .st.probing, .st.rendering, .st.encoding, .st.copying { background: var(--accent-soft); color: var(--accent); }
  .st.done { background: rgba(63, 185, 80, .12); color: var(--ok); }
  .st.failed { background: rgba(242, 85, 90, .12); color: var(--danger); }
</style>
