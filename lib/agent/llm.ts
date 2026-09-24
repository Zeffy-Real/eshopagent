import { ChatOpenAI } from '@langchain/openai';

/**
 * LLM 封装：OpenAI 兼容接口（DeepSeek / 通义千问 / OpenAI）。
 *
 * 未配置密钥时不抛错，由调用方走规则兜底路径，
 * 保证「没有 API Key 也能完整跑通全流程」。
 */
export interface LlmStatus {
  configured: boolean;
  model: string | null;
  baseUrl: string | null;
}

export function getLlmStatus(): LlmStatus {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  return {
    configured: Boolean(apiKey && baseUrl && model),
    model: model ?? null,
    baseUrl: baseUrl ?? null,
  };
}

export function isLlmEnabled(): boolean {
  if (process.env.LLM_FALLBACK_ENABLED === 'false' && !isLlmConfigured()) return false;
  return isLlmConfigured();
}

export function isLlmConfigured(): boolean {
  return getLlmStatus().configured;
}

export interface ChatModelOptions {
  temperature?: number;
  maxRetries?: number;
  timeout?: number;
}

/** 按需创建模型实例（不同节点需要不同温度，不做全局单例） */
export function createChatModel(options: ChatModelOptions = {}): ChatOpenAI {
  const status = getLlmStatus();
  if (!status.configured) {
    throw new Error('LLM 未配置：请在 .env.local 中设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  return new ChatOpenAI({
    apiKey: process.env.LLM_API_KEY,
    model: status.model ?? undefined,
    temperature: options.temperature ?? 0,
    maxRetries: options.maxRetries ?? 1,
    timeout: options.timeout ?? 20_000,
    configuration: { baseURL: status.baseUrl ?? undefined },
  });
}
