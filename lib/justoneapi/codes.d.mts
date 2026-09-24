/**
 * `codes.mjs` 的类型声明。
 *
 * .mjs 实现 + .d.mts 类型：TS 侧（errors.ts / client.ts / 节点）靠这份声明拿到类型，
 * 纯 node 脚本（scripts/sources/justoneapi.mjs）直接用实现。
 * 两者必须同步修改——单测会跑真实实现，声明写错会先在测试里暴露。
 */

export type JustOneApiFailureKind =
  | 'token_missing'
  | 'token_invalid'
  | 'collect_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'bad_request'
  | 'not_found'
  | 'server_error'
  | 'permission_denied'
  | 'insufficient_balance'
  | 'token_limit'
  | 'unknown_code'
  | 'transport';

export interface FailurePolicy {
  label: string;
  maxAttempts: number;
}

export const SUCCESS_CODE: number;
export const FAILURE_POLICY: Record<JustOneApiFailureKind, FailurePolicy>;
export const CODE_TO_KIND: Record<number, JustOneApiFailureKind>;
export const TIMEOUT_MAX_ATTEMPTS: number;
export const BACKOFF_BASE_MS: number;
export const BACKOFF_CAP_MS: number;
export const BREAKER_KINDS: readonly JustOneApiFailureKind[];

export function kindOfCode(code: number): JustOneApiFailureKind;
export function maxAttemptsOfCode(code: number): number;
export function tripsBreakerKind(kind: JustOneApiFailureKind): boolean;
export function backoffDelay(attempt: number, random?: () => number): number;