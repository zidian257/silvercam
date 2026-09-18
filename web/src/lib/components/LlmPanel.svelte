<script lang="ts">
  import {
    LLM_PROVIDERS,
    LLM_DOT_TEXT,
    fieldsForProvider,
    formFromConfig,
    configFromForm,
    llmDot,
    llmStatusText,
    fmtTestResult,
  } from '../llm.ts';
  import type { LlmConfig, LlmForm, LlmLastTest, LlmStatus, LlmTestResult } from '../llm.ts';

  interface Props {
    st?: LlmStatus | null; // llm_status 结果；null = 没拉到（404/失败，按未配置显示）
    lastTest?: LlmLastTest; // 最近一次测试结论（驱动状态点）
    testResult?: LlmTestResult | null;
    testing?: boolean;
    saving?: boolean;
    msg?: string;
    saved?: LlmConfig | null; // /config 里已保存的 llm，用于预填表单
    onTest?: (llm: LlmConfig) => void;
    onSave?: (llm: LlmConfig) => void;
  }
  let {
    st = null,
    lastTest = null,
    testResult = null,
    testing = false,
    saving = false,
    msg = '',
    saved = null,
    onTest = () => {},
    onSave = () => {},
  }: Props = $props();

  let form = $state<LlmForm>(formFromConfig(null));
  // 挂载时按已保存配置预填一次；之后用户编辑优先（saved 变化不再覆盖）
  let prefilled = false;
  $effect.pre(() => {
    if (prefilled) return;
    prefilled = true;
    form = formFromConfig(saved);
  });

  let spec = $derived(fieldsForProvider(form.provider));
  let dot = $derived(llmDot(st?.configured ?? false, lastTest));
  let tr = $derived(testResult ? fmtTestResult(testResult) : null);
</script>

<div class="status">
  <span class="dot {dot}" title={LLM_DOT_TEXT[dot]}></span>
  <span class="describe">{llmStatusText(st)}</span>
  {#if st?.configured && st.vision != null}
    <span class="pill {st.vision ? 'ok' : 'mute'}">视觉 {st.vision ? '✓' : '✗'}</span>
  {/if}
</div>

<div class="form">
  <label class="frow">
    <span class="flab">Provider</span>
    <select bind:value={form.provider}>
      {#each LLM_PROVIDERS as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
    </select>
  </label>

  {#if spec.baseUrl !== 'hidden'}
    <label class="frow">
      <span class="flab">Base URL{#if spec.baseUrl === 'required'}<i class="req">必填</i>{/if}</span>
      <input class="in mono grow" bind:value={form.baseUrl} placeholder={spec.baseUrlPlaceholder} spellcheck="false">
    </label>
  {/if}

  {#if spec.apiKey !== 'hidden'}
    <label class="frow">
      <span class="flab">API Key{#if spec.apiKey === 'required'}<i class="req">必填</i>{/if}</span>
      <input class="in mono grow" type="password" bind:value={form.apiKey} placeholder={spec.apiKeyPlaceholder} autocomplete="off">
    </label>
  {/if}

  <label class="frow">
    <span class="flab">Model{#if spec.model === 'required'}<i class="req">必填</i>{/if}</span>
    <input class="in mono grow" bind:value={form.model} placeholder={spec.modelPlaceholder} spellcheck="false">
  </label>
  {#if spec.modelHint}<div class="fhint">{spec.modelHint}</div>{/if}

  {#if spec.vision}
    <label class="vision">
      <input type="checkbox" bind:checked={form.vision}> {spec.visionLabel}
    </label>
  {/if}

  <div class="ops">
    <button class="btn" disabled={testing || saving} onclick={() => onTest(configFromForm(form))}>
      {testing ? '测试中…' : '测试连接'}
    </button>
    <button class="btn primary" disabled={saving || testing} onclick={() => onSave(configFromForm(form))}>
      {saving ? '保存中…' : '保存'}
    </button>
    {#if msg}<span class="dim">{msg}</span>{/if}
  </div>

  {#if tr}
    <div class="tresult" class:ok={tr.ok} class:bad={!tr.ok}>{tr.text}</div>
  {/if}
</div>

<style>
  .status { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--ok); }
  .dot.unconfigured { background: var(--text-3); }
  .dot.unverified { background: var(--warn); }
  .dot.failed { background: var(--danger); }
  .describe { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-1); }
  .form { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
  .frow { display: flex; align-items: center; gap: 10px; }
  .flab {
    width: 76px;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-3);
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .req { font-style: normal; letter-spacing: 0; text-transform: none; color: var(--warn); }
  .grow { flex: 1; min-width: 0; }
  .in {
    background: var(--bg-2);
    border: 1px solid var(--line);
    color: var(--text-1);
    border-radius: var(--r-ctl);
    padding: 7px 10px;
    font: inherit;
    font-size: 12px;
  }
  .in:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .mono { font-family: ui-monospace, monospace; }
  .fhint, .vision, .ops, .tresult { padding-left: 86px; }
  .fhint { font-size: 11px; color: var(--text-3); margin-top: -6px; }
  .vision { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-1); cursor: pointer; }
  .ops { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dim { color: var(--text-2); font-size: 13px; }
  .tresult { font-size: 12px; }
  .tresult.ok { color: var(--ok); }
  .tresult.bad { color: var(--danger); }
</style>
