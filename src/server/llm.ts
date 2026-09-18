// BYOK LLM 接入：基于 pi-ai 的统一多 provider 接口。
// 两条路：① 内置 provider（openai/moonshot/anthropic/…，BYOK 配 api_key 或环境变量）；
// ② OpenAI 兼容端点（lmstudio/ollama/vLLM/自建网关，base_url 直连，本地无需 key）。
// 默认指向本机 LM Studio——帧不出机、零成本；想更强模型再换云端 BYOK。
// 任何一步失败都返回 null（调用方降级为纯 L0 确定性流程），绝不把服务打挂。

import { createModels, createProvider } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export interface LlmConfig {
  provider?: string | null;  // lmstudio（默认）| ollama | openai-compat | openai | moonshot | anthropic | google | deepseek | xai | groq | openrouter | mistral
  model?: string | null;     // 模型 id；兼容端点缺省时从 /models 自动发现第一个
  api_key?: string | null;   // BYOK；本地端点可空
  base_url?: string | null;  // 兼容端点地址（lmstudio 默认 http://127.0.0.1:1234/v1）
  vision?: boolean | null;   // 兼容端点是否支持图片输入（默认 true；云端按模型目录判断）
}

const BUILTIN_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

const COMPAT_DEFAULT_BASE: Record<string, string> = {
  lmstudio: 'http://127.0.0.1:1234/v1',
  ollama: 'http://127.0.0.1:11434/v1',
};

export interface ResolvedLlm {
  models: ReturnType<typeof createModels>;
  model: any;
  apiKey: string | null;
  vision: boolean;
  describe: string; // 人类可读：provider/model @ base
}

// 简单缓存：同一配置只解析一次（LM Studio 的 /models 发现不必每次打）
const cache = new Map<string, Promise<ResolvedLlm | null>>();

export function resolveLlm(cfg: LlmConfig | null | undefined, { fresh = false }: { fresh?: boolean } = {}): Promise<ResolvedLlm | null> {
  const key = JSON.stringify(cfg ?? {});
  if (fresh) cache.delete(key);
  if (!cache.has(key)) cache.set(key, doResolve(cfg ?? {}));
  return cache.get(key)!;
}

async function doResolve(c: LlmConfig): Promise<ResolvedLlm | null> {
  const provider = (c.provider ?? 'lmstudio').trim().toLowerCase() || 'lmstudio';
  const apiKey = c.api_key?.trim() || null;

  if (provider in BUILTIN_ENV) {
    if (!c.model) return null; // 云端必须显式给模型 id
    if (!apiKey && !process.env[BUILTIN_ENV[provider]]) return null; // 没 key 视为未配置
    try {
      const models = builtinModels();
      const model = models.getModel(provider, c.model);
      if (!model) return null;
      const input: string[] = model.input ?? [];
      return { models, model, apiKey, vision: input.includes('image'), describe: `${provider}/${c.model}` };
    } catch {
      return null;
    }
  }

  // OpenAI 兼容端点
  const baseUrl = (c.base_url?.trim() || COMPAT_DEFAULT_BASE[provider])?.replace(/\/$/, '');
  if (!baseUrl) return null;
  try {
    const modelId = c.model?.trim() || (await discoverFirstModel(baseUrl, apiKey));
    if (!modelId) return null;
    const model: any = {
      id: modelId, name: modelId, api: 'openai-completions', provider, baseUrl,
      reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 8192,
    };
    const prov = createProvider({
      id: provider,
      name: provider,
      baseUrl,
      // pi-ai 的 openai-completions 适配器强制要求 apiKey——keyless 本地端点补占位 key（真鉴权端点仍用配置的真 key）
      auth: { apiKey: { name: provider, resolve: async () => ({ auth: { apiKey: apiKey ?? 'actpipe-keyless' } }) } },
      models: [model],
      api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(prov);
    return { models, model, apiKey, vision: c.vision !== false, describe: `${provider}/${modelId} @ ${baseUrl}` };
  } catch {
    return null;
  }
}

async function discoverFirstModel(baseUrl: string, apiKey: string | null): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { id?: string }[] };
    return j.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

// 供 pi-agent-core 使用的 streamFn（注入 BYOK apiKey）
export function agentStreamFn(r: ResolvedLlm) {
  return (model: any, context: any, opts: any) => r.models.streamSimple(model, context, { ...opts, apiKey: r.apiKey ?? undefined });
}

// 一次性对话（注入 BYOK apiKey）；图片内容块由调用方组装
export async function complete(r: ResolvedLlm, context: any) {
  return r.models.complete(r.model, context, { apiKey: r.apiKey ?? undefined });
}
