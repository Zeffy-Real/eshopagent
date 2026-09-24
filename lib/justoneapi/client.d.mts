/**
 * `client.mjs` 的类型声明（TS 侧靠它拿到完整类型；纯 node 脚本直接用实现）。
 */

export const JUSTONEAPI_BASE_URL: string;
export const JUSTONEAPI_TIMEOUT_MS: number;

export interface CallJustOneApiOptions {
  /** 单测注入的假 fetch；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 单测注入的假等待；默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 单测可缩短；默认 120 秒 */
  timeoutMs?: number;
  /** 日志出口，默认 console.debug；日志行一定已经过 redact */
  logger?: (line: string) => void;
}

export function tokenFromEnv(): string | null;
export function hasJustOneApiToken(): boolean;
export function redact(text: string, token?: string | null): string;
export function backoffDelay(attempt: number, random?: () => number): number;
export function callJustOneApi<T = unknown>(
  endpoint: string,
  params?: Record<string, string | number>,
  options?: CallJustOneApiOptions,
): Promise<T>;