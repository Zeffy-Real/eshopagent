import { z } from 'zod';
import { createChatModel } from '@/lib/agent/llm';

/**
 * 结构化输出的分层降级策略。
 *
 * 现实约束：不同 OpenAI 兼容 provider 对结构化输出的支持差异很大。
 * 实测本项目的 provider（DeepSeek 兼容网关）：
 *   1. function calling（JSON Schema 形式的 response_format）→ 400 "This response_format type is unavailable now"
 *   2. jsonMode（response_format: json_object）→ 要求 prompt 中必须出现 "json" 字样
 *   3. 纯文本 + 手工解析 → 可用
 *
 * 因此这里按「能力从强到弱」逐级降级，任一级成功即返回，
 * 全部失败才抛错由调用方走规则兜底。这样换任何兼容 provider 都能工作，
 * 而不是把可用性赌在某一种 response_format 上。
 */

export type StructuredMethod = 'functionCalling' | 'jsonMode' | 'prompt';

export interface StructuredResult<T> {
  value: T;
  method: StructuredMethod;
}

/** 从模型自由文本里抽出第一个 JSON 对象（兼容 ```json 代码块包裹） */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('响应中未找到 JSON 对象');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface InvokeStructuredOptions<TSchema extends z.ZodType> {
  schema: TSchema;
  /** 工具名 / schema 名 */
  name: string;
  system: string;
  user: string;
  temperature?: number;
  /** 每个策略失败时是否把错误信息透出（用于时间线诊断） */
  onAttemptFail?: (method: StructuredMethod, error: Error) => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function invokeStructured<TSchema extends z.ZodType>(
  options: InvokeStructuredOptions<TSchema>,
): Promise<StructuredResult<z.infer<TSchema>>> {
  const { schema, name, system, user, temperature = 0, onAttemptFail } = options;
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
  // maxRetries=0：快速失败后立刻换下一种策略，避免 3 种策略 × 重试把延迟放大
  const model = createChatModel({ temperature, maxRetries: 0 });

  // 策略 1：function calling
  try {
    const structured = model.withStructuredOutput(schema, { name });
    const value = (await structured.invoke(messages)) as z.infer<TSchema>;
    return { value, method: 'functionCalling' };
  } catch (error) {
    onAttemptFail?.('functionCalling', toError(error));
  }

  // 策略 2：jsonMode（prompt 必须包含 "json"，否则 provider 直接 400）
  try {
    const structured = model.withStructuredOutput(schema, { name, method: 'jsonMode' });
    const value = (await structured.invoke([
      { role: 'system', content: `${system}\n\n只输出一个 json 对象，不要输出解释或 Markdown。` },
      ...messages.slice(1),
    ])) as z.infer<TSchema>;
    return { value, method: 'jsonMode' };
  } catch (error) {
    onAttemptFail?.('jsonMode', toError(error));
  }

  // 策略 3：纯文本 + 手工解析 + zod 校验
  const response = await model.invoke([
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${user}\n\n只输出一个 json 对象（字段与类型必须完全符合要求），不要输出任何解释、前后缀或 Markdown 代码块。`,
    },
  ]);
  const text =
    typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  const parsed = schema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    throw new Error(`结构化输出校验失败：${parsed.error.issues[0]?.message ?? '字段不匹配'}`);
  }
  return { value: parsed.data, method: 'prompt' };
}
