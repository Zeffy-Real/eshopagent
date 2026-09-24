/**
 * `errors.mjs` 的类型声明（TS 侧靠它拿到完整类型；脚本侧直接用实现）。
 * 单测会跑真实实现，声明与实现不一致会先在测试里暴露。
 */

import type { JustOneApiFailureKind } from './codes.mjs';

export { FAILURE_POLICY, SUCCESS_CODE, kindOfCode, maxAttemptsOfCode } from './codes.mjs';
export type { JustOneApiFailureKind } from './codes.mjs';

export interface JustOneApiErrorInit {
  kind: JustOneApiFailureKind;
  message: string;
  endpoint: string;
  attempt: number;
  maxAttempts?: number;
  code?: number | null;
  httpStatus?: number | null;
  timedOut?: boolean;
}

export interface FailureContext {
  /** 端点路径（不含域名与 token） */
  endpoint: string;
  /** 已尝试次数（含本次） */
  attempt: number;
  /** 服务端 HTTP 状态码；本地错误（token 缺失）没有 */
  httpStatus?: number;
  /** 服务端 message 原文 */
  serverMessage?: string;
}

export declare class JustOneApiError extends Error {
  readonly kind: JustOneApiFailureKind;
  readonly code: number | null;
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly timedOut: boolean;
  readonly label: string;
  readonly retryable: boolean;
  constructor(init: JustOneApiErrorInit);
  static tokenMissing(endpoint?: string): JustOneApiError;
  static fromCode(code: number, context: FailureContext): JustOneApiError;
  static transport(
    reason: string,
    context: FailureContext & { timedOut?: boolean },
  ): JustOneApiError;
}

export function tripsBreaker(error: unknown): boolean;
export function isJustOneApiError(value: unknown): value is JustOneApiError;