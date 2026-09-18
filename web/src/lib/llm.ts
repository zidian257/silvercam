// LLM 设置前端模型：契约类型 + provider 字段规则/状态点状态机/文案组装纯函数（与组件解耦，直接可测）
// 契约（后端并行开发中）：POST /quickcuts/llm_status {} → { configured, describe, vision }（快，无网络探测）；
// POST /quickcuts/llm_test { llm? } → { ok, describe, vision, latency_ms, error }（真实 ping）；
// 配置读写走 GET/PUT /config 的 llm 字段（全字段可空）

export interface LlmConfig {
  provider?: string | null;
  model?: string | null;
  api_key?: string | null;
  base_url?: string | null;
  vision?: boolean | null;
}

export interface LlmStatus {
  configured?: boolean;
  describe?: string | null;
  vision?: boolean;
  [k: string]: any; // 契约演进中，其余键透传
}

export interface LlmTestResult {
  ok?: boolean;
  describe?: string | null;
  vision?: boolean;
  latency_ms?: number | null;
  error?: string | null;
  [k: string]: any;
}

// 面板表单状态（字符串保持用户输入原样，提交时才 trim）
export interface LlmForm {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
}

export const LLM_PROVIDERS = [
  { value: 'lmstudio', label: 'LM Studio（本地，默认）' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Moonshot Kimi' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai-compat', label: 'OpenAI 兼容端点' },
];

export const DEFAULT_PROVIDER = 'lmstudio';

export function providerLabel(value: string | null | undefined): string {
  return LLM_PROVIDERS.find((p) => p.value === value)?.label ?? (value || '未选择');
}

export type FieldMode = 'hidden' | 'optional' | 'required';

// 字段随 provider 的可见性/必填规则与占位文案（面板只按这份 spec 装配，不写死分支）
export interface LlmFieldSpec {
  baseUrl: FieldMode; // lmstudio 可空；openai-compat 必填；内置云端不显示
  baseUrlPlaceholder: string;
  apiKey: FieldMode; // 内置云端必填；本机/兼容端点可空
  apiKeyPlaceholder: string;
  model: FieldMode; // openai-compat 必填；其余可空（placeholder 给推荐值/自动发现）
  modelPlaceholder: string;
  modelHint: string; // 字段下方小字；'' = 无
  vision: boolean; // 是否显示「支持图片输入」开关（只对本机/兼容端点开放；云端由后端按模型目录判断）
  visionLabel: string;
}

const VISION_LABEL = '支持图片输入（快剪需要）';

const LMSTUDIO_SPEC: LlmFieldSpec = {
  baseUrl: 'optional',
  baseUrlPlaceholder: 'http://127.0.0.1:1234/v1',
  apiKey: 'optional',
  apiKeyPlaceholder: '本机开了鉴权才需要',
  model: 'optional',
  modelPlaceholder: '留空自动发现',
  modelHint: '',
  vision: true,
  visionLabel: VISION_LABEL,
};

export function fieldsForProvider(provider: string | null | undefined): LlmFieldSpec {
  switch (provider) {
    case 'deepseek':
      return {
        ...LMSTUDIO_SPEC,
        baseUrl: 'hidden',
        baseUrlPlaceholder: '',
        apiKey: 'required',
        apiKeyPlaceholder: '必填',
        modelPlaceholder: 'deepseek-v4-flash-vision-exp',
        modelHint: '视觉模型，快剪推荐',
        vision: false,
      };
    case 'moonshot':
      return {
        ...LMSTUDIO_SPEC,
        baseUrl: 'hidden',
        baseUrlPlaceholder: '',
        apiKey: 'required',
        apiKeyPlaceholder: '必填',
        modelPlaceholder: 'kimi-k2-0905-preview',
        vision: false,
      };
    case 'openai':
      return {
        ...LMSTUDIO_SPEC,
        baseUrl: 'hidden',
        baseUrlPlaceholder: '',
        apiKey: 'required',
        apiKeyPlaceholder: '必填',
        modelPlaceholder: 'gpt-4o',
        vision: false,
      };
    case 'openai-compat':
      return {
        ...LMSTUDIO_SPEC,
        baseUrl: 'required',
        baseUrlPlaceholder: 'https://your-endpoint/v1',
        apiKeyPlaceholder: '可空（端点无鉴权时）',
        model: 'required',
        modelPlaceholder: '模型 id',
      };
    case 'lmstudio':
    default:
      return LMSTUDIO_SPEC;
  }
}

export function formFromConfig(c: LlmConfig | null | undefined): LlmForm {
  return {
    provider: c?.provider || DEFAULT_PROVIDER,
    baseUrl: c?.base_url ?? '',
    apiKey: c?.api_key ?? '',
    model: c?.model ?? '',
    vision: c?.vision ?? true, // 本机/兼容端点默认开（快剪需要图片输入）
  };
}

// 表单 → 提交载荷：trim + 空串归 null；隐藏字段不随表单残留泄漏（强制 null）
export function configFromForm(f: LlmForm): LlmConfig {
  const spec = fieldsForProvider(f.provider);
  const trim = (s: string) => s.trim() || null;
  return {
    provider: f.provider || null,
    base_url: spec.baseUrl === 'hidden' ? null : trim(f.baseUrl),
    api_key: spec.apiKey === 'hidden' ? null : trim(f.apiKey),
    model: trim(f.model),
    vision: spec.vision ? f.vision : null,
  };
}

// 规范化 key：比较「测过的配置」和「保存的配置」是否同一份（字段顺序固定、缺省归一为 null）
export function llmConfigKey(c: LlmConfig | null | undefined): string {
  return JSON.stringify({
    provider: c?.provider ?? null,
    model: c?.model ?? null,
    api_key: c?.api_key ?? null,
    base_url: c?.base_url ?? null,
    vision: c?.vision ?? null,
  });
}

export type LlmLastTest = 'ok' | 'fail' | null;
export type LlmDot = 'ok' | 'unconfigured' | 'unverified' | 'failed';

// 状态点状态机：红=最近测试失败（最优先）/ 灰=未配置 / 绿=已配置且最近测试通过 / 黄=已配置未验证
export function llmDot(configured: boolean, lastTest: LlmLastTest): LlmDot {
  if (lastTest === 'fail') return 'failed';
  if (!configured) return 'unconfigured';
  if (lastTest === 'ok') return 'ok';
  return 'unverified';
}

export const LLM_DOT_TEXT: Record<LlmDot, string> = {
  ok: '已配置，最近测试通过',
  unconfigured: '未配置',
  unverified: '已配置，未验证',
  failed: '最近测试失败',
};

// 状态行文案：当前生效 describe；未配置时提示快剪退化为数据优选
export function llmStatusText(st: LlmStatus | null | undefined): string {
  return st?.configured && st.describe ? st.describe : '未配置——快剪将只按数据优选';
}

// QuickcutPanel「AI 优选镜头」开关旁的小字
export function llmHintText(st: LlmStatus | null | undefined): string {
  return st?.configured && st.describe ? `将使用 ${st.describe}` : '未配置 LLM，仅按数据优选';
}

// 测试结果行：成功 → ✓ describe · 视觉 ✓/✗ · 延迟；失败 → 原因
export function fmtTestResult(r: LlmTestResult): { ok: boolean; text: string } {
  if (r.ok) {
    const parts = [`✓ ${r.describe || '连接成功'}`, `视觉 ${r.vision ? '✓' : '✗'}`];
    if (r.latency_ms != null && Number.isFinite(r.latency_ms)) parts.push(`${Math.round(r.latency_ms)}ms`);
    return { ok: true, text: parts.join(' · ') };
  }
  return { ok: false, text: r.error || '连接失败' };
}
