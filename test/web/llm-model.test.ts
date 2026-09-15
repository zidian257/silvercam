import { describe, it, expect } from 'vitest';
import {
  LLM_PROVIDERS,
  DEFAULT_PROVIDER,
  providerLabel,
  fieldsForProvider,
  formFromConfig,
  configFromForm,
  llmConfigKey,
  llmDot,
  llmStatusText,
  llmHintText,
  fmtTestResult,
} from '../../web/src/lib/llm.ts';
import type { LlmForm } from '../../web/src/lib/llm.ts';

const form = (over: Partial<LlmForm> = {}): LlmForm => ({
  provider: 'lmstudio',
  baseUrl: '',
  apiKey: '',
  model: '',
  vision: true,
  ...over,
});

describe('providerLabel', () => {
  it('五个 provider 的展示名；未知值原样透出', () => {
    expect(LLM_PROVIDERS.map((p) => p.value)).toEqual(['lmstudio', 'deepseek', 'moonshot', 'openai', 'openai-compat']);
    expect(providerLabel('lmstudio')).toBe('LM Studio（本地，默认）');
    expect(providerLabel('deepseek')).toBe('DeepSeek');
    expect(providerLabel('moonshot')).toBe('Moonshot Kimi');
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('openai-compat')).toBe('OpenAI 兼容端点');
    expect(providerLabel('xai')).toBe('xai');
    expect(providerLabel(null)).toBe('未选择');
  });

  it('默认 provider 是 lmstudio', () => {
    expect(DEFAULT_PROVIDER).toBe('lmstudio');
  });
});

describe('fieldsForProvider（字段随 provider 动态）', () => {
  it('lmstudio：base_url/api_key/model 全可空 + 视觉开关（默认开文案）', () => {
    const s = fieldsForProvider('lmstudio');
    expect(s.baseUrl).toBe('optional');
    expect(s.baseUrlPlaceholder).toBe('http://127.0.0.1:1234/v1');
    expect(s.apiKey).toBe('optional');
    expect(s.apiKeyPlaceholder).toBe('本机开了鉴权才需要');
    expect(s.model).toBe('optional');
    expect(s.modelPlaceholder).toBe('留空自动发现');
    expect(s.vision).toBe(true);
    expect(s.visionLabel).toBe('支持图片输入（快剪需要）');
  });

  it('deepseek：隐藏 base_url，api_key 必填，模型 placeholder 给视觉推荐值', () => {
    const s = fieldsForProvider('deepseek');
    expect(s.baseUrl).toBe('hidden');
    expect(s.apiKey).toBe('required');
    expect(s.modelPlaceholder).toBe('deepseek-v4-flash-vision-exp');
    expect(s.modelHint).toContain('视觉');
    expect(s.vision).toBe(false);
  });

  it('moonshot / openai：隐藏 base_url，api_key 必填，模型 placeholder 给推荐值，无视觉开关', () => {
    for (const [p, ph] of [['moonshot', 'kimi-k2-0905-preview'], ['openai', 'gpt-4o']] as const) {
      const s = fieldsForProvider(p);
      expect(s.baseUrl).toBe('hidden');
      expect(s.apiKey).toBe('required');
      expect(s.modelPlaceholder).toBe(ph);
      expect(s.vision).toBe(false);
    }
  });

  it('openai-compat：base_url/model 必填，api_key 可空，有视觉开关', () => {
    const s = fieldsForProvider('openai-compat');
    expect(s.baseUrl).toBe('required');
    expect(s.model).toBe('required');
    expect(s.apiKey).toBe('optional');
    expect(s.vision).toBe(true);
  });

  it('未知/空 provider 回落到 lmstudio 规则', () => {
    expect(fieldsForProvider('whatever')).toEqual(fieldsForProvider('lmstudio'));
    expect(fieldsForProvider(null)).toEqual(fieldsForProvider('lmstudio'));
  });
});

describe('configFromForm（表单 → 提交载荷）', () => {
  it('trim 字符串，空串归一为 null', () => {
    expect(configFromForm(form({ baseUrl: '  http://a/v1 ', apiKey: '  ', model: ' m1 ' }))).toEqual({
      provider: 'lmstudio',
      base_url: 'http://a/v1',
      api_key: null,
      model: 'm1',
      vision: true,
    });
  });

  it('隐藏字段强制 null：deepseek 不带 base_url，vision 也不随表单泄漏', () => {
    expect(configFromForm(form({ provider: 'deepseek', baseUrl: 'http://leftover', apiKey: 'sk-x', model: 'm' }))).toEqual({
      provider: 'deepseek',
      base_url: null,
      api_key: 'sk-x',
      model: 'm',
      vision: null,
    });
  });

  it('openai-compat 保留 vision 开关值', () => {
    const c = configFromForm(form({ provider: 'openai-compat', baseUrl: 'http://x/v1', model: 'm', vision: false }));
    expect(c.vision).toBe(false);
    expect(c.base_url).toBe('http://x/v1');
  });
});

describe('formFromConfig（已保存配置预填表单）', () => {
  it('null → 默认 lmstudio 空表单，vision 默认开', () => {
    expect(formFromConfig(null)).toEqual({ provider: 'lmstudio', baseUrl: '', apiKey: '', model: '', vision: true });
  });

  it('字段映射回去；vision 缺省按开处理', () => {
    expect(formFromConfig({ provider: 'openai-compat', base_url: 'http://x/v1', model: 'm1', api_key: 'k', vision: false }))
      .toEqual({ provider: 'openai-compat', baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k', vision: false });
    expect(formFromConfig({ provider: 'deepseek', model: 'm1' }).vision).toBe(true);
  });

  it('表单 ⇄ 载荷往返一致（已 trim 的可见字段）', () => {
    const f = form({ provider: 'openai-compat', baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k', vision: false });
    expect(formFromConfig(configFromForm(f))).toEqual(f);
  });
});

describe('llmConfigKey（测过的 vs 保存的）', () => {
  it('缺省字段归一为 null、与 key 顺序无关', () => {
    expect(llmConfigKey({ provider: 'openai', model: 'gpt-4o' })).toBe(
      llmConfigKey({ vision: null, api_key: null, base_url: null, model: 'gpt-4o', provider: 'openai' }),
    );
    expect(llmConfigKey(null)).toBe(llmConfigKey({}));
  });

  it('任一字段不同即不同 key', () => {
    expect(llmConfigKey({ provider: 'openai', model: 'gpt-4o' })).not.toBe(
      llmConfigKey({ provider: 'openai', model: 'gpt-4o-mini' }),
    );
  });
});

describe('llmDot（状态点状态机）', () => {
  it('灰=未配置 / 黄=已配置未验证 / 绿=已配置且最近测试通过 / 红=最近测试失败', () => {
    expect(llmDot(false, null)).toBe('unconfigured');
    expect(llmDot(true, null)).toBe('unverified');
    expect(llmDot(true, 'ok')).toBe('ok');
    expect(llmDot(true, 'fail')).toBe('failed');
  });

  it('测试失败最优先：未配置但刚测失败也亮红', () => {
    expect(llmDot(false, 'fail')).toBe('failed');
  });
});

describe('llmStatusText / llmHintText（文案组装）', () => {
  it('状态行：生效 describe；未配置/缺 describe 时给退化提示', () => {
    expect(llmStatusText({ configured: true, describe: 'lmstudio/qwen2.5-vl-7b' })).toBe('lmstudio/qwen2.5-vl-7b');
    expect(llmStatusText({ configured: true, describe: null })).toBe('未配置——快剪将只按数据优选');
    expect(llmStatusText({ configured: false })).toBe('未配置——快剪将只按数据优选');
    expect(llmStatusText(null)).toBe('未配置——快剪将只按数据优选');
  });

  it('快剪面板小字：configured → 将使用 xx；否则提示仅按数据优选', () => {
    expect(llmHintText({ configured: true, describe: 'deepseek/deepseek-v4' })).toBe('将使用 deepseek/deepseek-v4');
    expect(llmHintText(null)).toBe('未配置 LLM，仅按数据优选');
  });
});

describe('fmtTestResult（测试结果行）', () => {
  it('成功：✓ describe · 视觉 ✓/✗ · 延迟（取整 ms）', () => {
    expect(fmtTestResult({ ok: true, describe: 'lmstudio/qwen', vision: true, latency_ms: 87.6 }))
      .toEqual({ ok: true, text: '✓ lmstudio/qwen · 视觉 ✓ · 88ms' });
    expect(fmtTestResult({ ok: true, describe: 'openai/gpt-4o', vision: false, latency_ms: 120 }).text)
      .toBe('✓ openai/gpt-4o · 视觉 ✗ · 120ms');
  });

  it('延迟缺失时省略；describe 缺失给兜底', () => {
    expect(fmtTestResult({ ok: true, describe: null, vision: true }).text).toBe('✓ 连接成功 · 视觉 ✓');
  });

  it('失败：展示原因；无原因给兜底', () => {
    expect(fmtTestResult({ ok: false, error: '连接被拒（ECONNREFUSED）' }))
      .toEqual({ ok: false, text: '连接被拒（ECONNREFUSED）' });
    expect(fmtTestResult({ ok: false }).text).toBe('连接失败');
  });
});
