<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getJson, postJson, putJson, api } from '../../lib/api.ts';
  import { computeCards } from '../../lib/dash.ts';
  import { hasActive } from '../../lib/quickcut.ts';
  import type { QuickcutRecord } from '../../lib/quickcut.ts';
  import { llmConfigKey } from '../../lib/llm.ts';
  import type { LlmConfig, LlmLastTest, LlmStatus, LlmTestResult } from '../../lib/llm.ts';
  import StatCards from '../../lib/components/StatCards.svelte';
  import JobsTable from '../../lib/components/JobsTable.svelte';
  import StravaPanel from '../../lib/components/StravaPanel.svelte';
  import LlmPanel from '../../lib/components/LlmPanel.svelte';
  import AssetsPanel from '../../lib/components/AssetsPanel.svelte';
  import AppNav from '../../lib/components/AppNav.svelte';
  import type { ActpipeConfig, ProgressPayload } from '../../../../src/types.ts';

  // /api/status 概览（本页只经 computeCards 消费；非共享类型，本地定义）
  interface DashStatus {
    jobs?: { by_state?: Record<string, number> };
    watcher?: { active?: boolean; volumes_seen?: number } | null;
    uptime_s?: number;
    store?: string;
  }
  // /jobs 列表摘要（与 JobsTable 的契约一致；非共享类型，本地定义）
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
  // /api/inbox 清单项（本页用到的子集）
  interface InboxItem {
    id: string;
    src: string;
    status?: string;
    ingest?: { state?: string; percent?: number } | null;
  }
  // /luts 清单项
  interface LutInfo {
    name: string;
    label?: string | null;
    exists?: boolean;
    default?: boolean;
  }
  // /api/strava/status（athlete 为 Strava API 透传的动态数据，只用到 name）
  interface StravaStatus {
    configured?: boolean;
    connected?: boolean;
    athlete?: { name?: string } | null;
    auto_sync?: boolean;
    sync_days?: number;
  }

  let status = $state<DashStatus | null>(null);
  let jobs = $state<JobSummary[]>([]);
  let inboxItems = $state<InboxItem[]>([]);
  let skins = $state<string[]>([]);
  let luts = $state<LutInfo[]>([]);
  let config = $state<ActpipeConfig | null>(null);
  let strava = $state<StravaStatus | null>(null);
  let stravaMsg = $state('');
  let stravaSyncing = $state(false);
  let openLogs = $state<Record<string, boolean>>({});
  let logs = $state<Record<string, string>>({});
  let quickcuts = $state<QuickcutRecord[]>([]);
  let openQuickcuts = $state<Record<string, boolean>>({});
  let statusLine = $state('');
  let statusErr = $state(false);
  let llmStatus = $state<LlmStatus | null>(null);
  let llmLastTest = $state<LlmLastTest>(null);
  let llmTestResult = $state<LlmTestResult | null>(null);
  let llmTesting = $state(false);
  let llmSaving = $state(false);
  let llmMsg = $state('');
  let llmTestedKey = ''; // 最近一次测过的配置（保存内容一致时保留测试结论）

  // OAuth 回跳结果提示
  const q = new URLSearchParams(location.search);
  if (q.get('strava') === 'ok') statusLine = 'Strava 已连接';
  else if (q.get('strava') === 'denied') { statusLine = 'Strava 授权被取消'; statusErr = true; }
  else if (q.get('strava') === 'err') { statusLine = `Strava 授权失败：${q.get('msg') ?? ''}`; statusErr = true; }

  async function refresh() {
    try {
      const [st, jb, ib, qc] = await Promise.all([
        getJson('/api/status'),
        getJson('/jobs'),
        getJson('/api/inbox').catch(() => []),
        // quickcuts 服务并行开发中：未上线（404）时保持旧值，不拖垮主刷新
        getJson('/quickcuts').catch(() => quickcuts),
      ]);
      status = st;
      jobs = jb;
      inboxItems = ib;
      quickcuts = qc;
      if (hasActive(quickcuts)) ensureQcWatch();
      if (!statusErr) statusLine = `更新于 ${new Date().toLocaleTimeString()}`;
      for (const id of Object.keys(openLogs)) if (openLogs[id]) await loadLog(id);
    } catch (e) {
      statusLine = `刷新失败：${(e as Error).message}`;
      statusErr = true;
    }
  }

  async function loadQuickcuts() {
    quickcuts = await getJson('/quickcuts').catch(() => quickcuts);
  }

  // 提交快剪后的 2s 轮询：全部记录到达终态即停（主 refresh 的循环照样带历史）
  let qcTimer: ReturnType<typeof setInterval> | null = null;
  function ensureQcWatch() {
    if (qcTimer) return;
    qcTimer = setInterval(async () => {
      await loadQuickcuts();
      if (!hasActive(quickcuts)) {
        clearInterval(qcTimer!);
        qcTimer = null;
      }
    }, 2000);
  }

  function onToggleQuickcut(id: string) {
    openQuickcuts = { ...openQuickcuts, [id]: !openQuickcuts[id] };
  }

  async function onQuickcutSubmit(jobId: string, useLlm: boolean) {
    await postJson('/quickcuts', { job_id: jobId, use_llm: useLlm });
    await loadQuickcuts();
    ensureQcWatch();
  }

  async function loadAssets() {
    const [sk, lt, cfg] = await Promise.all([getJson('/skins'), getJson('/luts'), getJson('/config')]);
    skins = sk;
    luts = lt;
    config = cfg;
  }

  async function loadStrava() {
    strava = await getJson('/api/strava/status').catch(() => null);
  }

  async function loadLog(id: string) {
    const r = await api(`/jobs/${id}/log`);
    logs = { ...logs, [id]: await r.text() };
  }

  function onToggleLog(id: string) {
    openLogs = { ...openLogs, [id]: !openLogs[id] };
    if (openLogs[id]) loadLog(id);
  }

  async function onRetry(id: string) {
    const full = await getJson(`/jobs/${id}`);
    await postJson('/jobs', {
      video: full.params.video, fit: full.params.fit, skin: full.params.skin,
      lut: full.params.lut, offset_seconds: full.params.offset_seconds,
      bias_seconds: full.params.bias_seconds ?? undefined,
      segments: full.params.segments ?? undefined, // 合并任务重试必须带上全部段，否则退化成只跑首段
    });
    refresh();
  }

  async function onFit(id: string) {
    const fit = prompt('输入 .fit 文件的服务器路径：');
    if (!fit) return;
    try {
      await postJson(`/jobs/${id}/fit`, { fit });
    } catch (e) {
      alert((e as Error).message);
    }
    refresh();
  }

  async function onStravaSave(client_id: string, client_secret: string) {
    try {
      await postJson('/api/strava/config', { client_id, client_secret });
      loadStrava();
    } catch (e) {
      stravaMsg = (e as Error).message;
    }
  }

  async function onStravaSync() {
    stravaSyncing = true;
    stravaMsg = '同步中…';
    try {
      const r = await postJson('/api/strava/sync');
      stravaMsg = `完成：新入库 ${r.added.length} 个 fit（共 ${r.total} 个活动）`;
    } catch (e) {
      stravaMsg = `失败：${(e as Error).message}`;
    } finally {
      stravaSyncing = false;
    }
  }

  // llm_status 未上线（404）或失败时静默按未配置显示
  async function loadLlmStatus() {
    llmStatus = await postJson('/quickcuts/llm_status', {}).catch(() => null);
  }

  async function onLlmTest(llm: LlmConfig) {
    llmTesting = true;
    try {
      const r = await postJson<LlmTestResult>('/quickcuts/llm_test', { llm });
      llmTestResult = r;
      llmLastTest = r.ok ? 'ok' : 'fail';
    } catch (e) {
      llmTestResult = { ok: false, error: (e as Error).message };
      llmLastTest = 'fail';
    } finally {
      llmTestedKey = llmConfigKey(llm);
      llmTesting = false;
    }
  }

  async function onLlmSave(llm: LlmConfig) {
    llmSaving = true;
    llmMsg = '';
    try {
      config = await putJson<ActpipeConfig>('/config', { llm });
      // 保存的内容与测过的不同 → 旧测试结论作废，回到「已配置未验证」
      if (llmConfigKey(llm) !== llmTestedKey) {
        llmLastTest = null;
        llmTestResult = null;
      }
      llmMsg = '已保存';
      await loadLlmStatus();
    } catch (e) {
      llmMsg = `保存失败：${(e as Error).message}`;
    } finally {
      llmSaving = false;
    }
  }

  let timer: ReturnType<typeof setInterval>;
  onMount(() => {
    refresh();
    loadAssets();
    loadStrava();
    loadLlmStatus();
    timer = setInterval(refresh, 2500);
  });
  onDestroy(() => {
    clearInterval(timer);
    if (qcTimer) clearInterval(qcTimer);
  });
</script>

<AppNav current="dash">
  <span class="updated" class:err={statusErr}>{statusLine}</span>
</AppNav>

<main>
  <section>
    <h2>概览</h2>
    {#if status}<StatCards cards={computeCards(status, inboxItems.filter((i) => i.status === 'pending'), jobs)} />{/if}
  </section>

  <section>
    <h2>出片任务</h2>
    <JobsTable {jobs} {openLogs} {logs} {onToggleLog} {onRetry} {onFit} {quickcuts} {openQuickcuts} {onToggleQuickcut} {onQuickcutSubmit} {llmStatus} />
  </section>

  <section>
    <h2>待确认素材（inbox）</h2>
    {#if !inboxItems.filter((i) => i.status === 'pending').length}
      <div class="empty">无待确认素材</div>
    {:else}
      <div class="pendings">
        {#each inboxItems.filter((i) => i.status === 'pending') as i (i.id)}
          <span class="itempill" title={i.src}>
            <b>{i.src.split('/').pop()}</b>
            {i.ingest?.state === 'copying' ? `拷贝中 ${i.ingest.percent}%` : (i.ingest?.state ?? '')}
          </span>
        {/each}
        <a class="go" href="/inbox">去确认 →</a>
      </div>
    {/if}
  </section>

  <section>
    <h2>皮肤 / LUT</h2>
    <AssetsPanel {skins} {luts} {config} />
  </section>

  <section>
    <h2>Strava</h2>
    <StravaPanel st={strava} msg={stravaMsg} syncing={stravaSyncing} onSave={onStravaSave} onSync={onStravaSync} />
  </section>

  <section>
    <h2>LLM</h2>
    {#if config}
      <LlmPanel
        st={llmStatus}
        lastTest={llmLastTest}
        testResult={llmTestResult}
        testing={llmTesting}
        saving={llmSaving}
        msg={llmMsg}
        saved={config.llm ?? null}
        onTest={onLlmTest}
        onSave={onLlmSave}
      />
    {:else}
      <div class="empty">加载中…</div>
    {/if}
  </section>

  <section>
    <h2>配置</h2>
    {#if config}
      <details>
        <summary>当前配置（只读，改动用 actpipe config --set）</summary>
        <pre class="cfg">{JSON.stringify(config, null, 2)}</pre>
      </details>
    {/if}
  </section>
</main>

<style>
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .updated { font-size: 12px; color: var(--text-3); }
  .updated.err { color: var(--danger); }
  section { margin-top: 28px; }
  section:first-child { margin-top: 4px; }
  h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  .empty { color: var(--text-3); padding: 10px 4px; }
  .pendings { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .itempill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    padding: 3px 12px;
    font-size: 12px;
    color: var(--text-2);
  }
  .itempill b { color: var(--text-1); font-weight: 600; font-family: ui-monospace, monospace; font-size: 11px; }
  .go { font-size: 13px; }
  details { background: var(--bg-1); border: 1px solid var(--line); border-radius: var(--r-card); padding: 12px 14px; }
  summary { cursor: pointer; color: var(--text-2); font-size: 13px; }
  pre.cfg { font: 11px/1.6 ui-monospace, monospace; max-height: 320px; overflow: auto; color: var(--text-2); }
</style>
