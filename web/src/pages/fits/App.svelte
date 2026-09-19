<script lang="ts">
  import { onMount } from 'svelte';
  import { Bike, Footprints, Activity, Download, Upload, RefreshCw } from 'lucide-svelte';
  import { getJson, postJson, api } from '../../lib/api.ts';
  import { sortFits, fmtFitDate, fmtDuration, fmtDistance, sportIcon, fitSource } from '../../lib/fits-model.ts';
  import type { FitEntry } from '../../lib/fits-model.ts';
  import FitTrack from '../../lib/components/FitTrack.svelte';
  import AppNav from '../../lib/components/AppNav.svelte';

  // /api/strava/status（athlete 为 Strava API 透传的动态数据，只用到 name）
  interface StravaStatus {
    configured?: boolean;
    connected?: boolean;
    athlete?: { name?: string } | null;
  }

  const sportIcons = { bike: Bike, footprints: Footprints, activity: Activity };

  let fits = $state<FitEntry[] | null>(null); // null = 加载中
  let strava = $state<StravaStatus | null>(null);
  let stravaMsg = $state('');
  let syncing = $state(false);
  let statusLine = $state('');
  let statusErr = $state(false);

  const sorted = $derived(fits ? sortFits(fits) : []);
  const baseName = (name: string) => name.replace(/\.fit$/i, '');

  async function load() {
    try {
      fits = await getJson('/api/fits');
    } catch (e) {
      statusLine = `加载失败：${(e as Error).message}`;
      statusErr = true;
    }
  }

  async function loadStrava() {
    strava = await getJson('/api/strava/status').catch(() => null);
  }

  // ---- 上传 .fit 入库（raw body，同 inbox 的载入路径） ----
  let picker: HTMLInputElement;
  async function onPicked() {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    statusLine = `上传 ${file.name}…`;
    statusErr = false;
    try {
      const r = await api(`/api/fits?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: {} });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { statusLine = `上传失败：${b.error ?? r.status}`; statusErr = true; return; }
      statusLine = `已入库 ${b.name}`;
      await load();
    } catch (e) {
      statusLine = `上传失败：${(e as Error).message}`;
      statusErr = true;
    }
  }

  async function onSync() {
    syncing = true;
    stravaMsg = '同步中…';
    try {
      const r = await postJson<{ added: unknown[] }>('/api/strava/sync');
      stravaMsg = `完成：新入库 ${r.added.length} 个 fit`;
      await load();
    } catch (e) {
      stravaMsg = `失败：${(e as Error).message}`;
    } finally {
      syncing = false;
    }
  }

  onMount(() => {
    load();
    loadStrava();
  });
</script>

<AppNav current="fits">
  <span class="statusline" class:err={statusErr}>{statusLine}</span>
</AppNav>

<main>
  <div class="bar">
    <div class="bl">
      {#if strava}
        {#if strava.connected}
          <span class="pill ok">Strava 已连接{#if strava.athlete?.name}：<b>{strava.athlete.name}</b>{/if}</span>
          <button class="btn" disabled={syncing} onclick={onSync}>
            <RefreshCw size={13} />{syncing ? '同步中…' : '立即同步'}
          </button>
        {:else}
          <span class="pill mute">Strava 未连接</span>
          <a class="dim" href="/dash">去总控台配置 →</a>
        {/if}
      {/if}
      {#if stravaMsg}<span class="dim">{stravaMsg}</span>{/if}
    </div>
    <div class="br">
      <button class="btn primary" onclick={() => picker.click()}><Upload size={13} />上传 .fit</button>
    </div>
  </div>

  {#if !fits}
    <div class="empty">加载中…</div>
  {:else if !sorted.length}
    <div class="empty hero">
      <p class="t">还没有 FIT 记录</p>
      <p>连接 Strava 自动同步运动记录，或点右上角「上传 .fit」手动入库。入库后每条活动的轨迹、时长、距离都会显示在这里。</p>
    </div>
  {:else}
    <div class="cards">
      {#each sorted as f (f.path)}
        {@const Icon = sportIcons[sportIcon(f.sport)]}
        {@const src = fitSource(f.name)}
        <div class="card">
          <div class="viz" class:nogps={!f.has_gps}>
            {#if f.has_gps}
              <FitTrack name={f.name} />
            {:else}
              <Icon size={22} />
            {/if}
          </div>
          <div class="meta">
            <div class="name" title={f.name}>{baseName(f.name)}</div>
            <div class="date">{fmtFitDate(f.start_ms)}</div>
            <div class="stats"><Icon size={13} />{fmtDuration(f.duration_s)}{#if fmtDistance(f.distance_m)} · {fmtDistance(f.distance_m)}{/if}</div>
          </div>
          <div class="side">
            {#if src}
              <span class="pill" class:info={src === 'strava'} class:mute={src === 'local'}>{src === 'strava' ? 'Strava' : '本地'}</span>
            {/if}
            <a class="btn icon" href="/api/fits/file/{encodeURIComponent(f.name)}" title="下载原始 .fit"><Download size={15} /></a>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</main>

<input type="file" accept=".fit" style="display:none" bind:this={picker} onchange={onPicked}>

<style>
  main { padding: 24px; max-width: 960px; margin: 0 auto; }
  .statusline { font-size: 12px; color: var(--text-3); }
  .statusline.err { color: var(--danger); }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .bl, .br { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dim { color: var(--text-2); font-size: 12px; }
  .empty { color: var(--text-3); padding: 18px 4px; }
  .empty.hero { text-align: center; padding: 80px 24px; line-height: 1.8; }
  .empty.hero .t { font-size: 15px; font-weight: 600; color: var(--text-2); margin: 0; }
  .empty.hero p { margin: 0; }
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .card {
    display: flex;
    align-items: center;
    gap: 16px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 12px 16px;
  }
  .viz {
    flex: none;
    width: 220px;
    height: 66px;
    border-radius: 6px;
    background: var(--bg-2);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .viz.nogps { color: var(--text-3); }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .date { font-size: 12px; color: var(--text-3); }
  .stats { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); margin-top: 2px; }
  .side { flex: none; display: flex; align-items: center; gap: 8px; }
</style>
