<script lang="ts">
  // /api/strava/status 响应（athlete 为 Strava API 透传的动态数据，只用到 name）
  interface StravaStatus {
    configured?: boolean;
    connected?: boolean;
    athlete?: { name?: string } | null;
    auto_sync?: boolean;
    sync_days?: number;
  }
  interface Props {
    st?: StravaStatus | null; // null = 加载中/失败
    msg?: string;
    syncing?: boolean;
    onSave?: (clientId: string, clientSecret: string) => void;
    onSync?: () => void;
  }
  let {
    st = null,
    msg = '',
    syncing = false,
    onSave = () => {},
    onSync = () => {},
  }: Props = $props();

  let clientId = $state('');
  let clientSecret = $state('');
</script>

{#if !st}
  <div class="empty">加载中…</div>
{:else if !st.configured}
  <div class="dim" style="margin-bottom:8px">
    到 <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">strava.com/settings/api</a>
    免费建一个应用（回调域名填 <span class="mono">127.0.0.1</span>），把 client_id / client_secret 填进来：
  </div>
  <div class="form">
    <input class="mono" placeholder="client_id" style="width:120px" bind:value={clientId}>
    <input class="mono" placeholder="client_secret" style="width:240px" bind:value={clientSecret}>
    <button class="btn primary" onclick={() => onSave(clientId, clientSecret)}>保存</button>
  </div>
{:else if !st.connected}
  <span class="dim">已配置，尚未授权。</span>
  <a href="/api/strava/auth"><button class="btn primary">连接 Strava</button></a>
{:else}
  <div class="row">
    <span class="pill ok">已连接{#if st.athlete?.name}：<b>{st.athlete.name}</b>{/if}</span>
    <span class="pill mute">自动同步：{st.auto_sync ? `开（近 ${st.sync_days} 天，插入相机时触发）` : '关'}</span>
    <button class="btn" disabled={syncing} onclick={onSync}>立即同步</button>
    <span class="dim">{msg}</span>
  </div>
{/if}

<style>
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .dim { color: var(--text-2); font-size: 13px; }
  .empty { color: var(--text-3); padding: 10px 4px; }
  .form { display: flex; gap: 8px; align-items: center; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .pill b { font-weight: 600; }
  input {
    background: var(--bg-2);
    border: 1px solid var(--line);
    color: var(--text-1);
    border-radius: var(--r-ctl);
    padding: 7px 10px;
    font: inherit;
    font-size: 12px;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
