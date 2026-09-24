/**
 * JustOneAPI 失败分类与重试策略（**唯一实现**）。
 *
 * 为什么单独一个文件：这些规则同时被三处消费 ——
 *   1. 客户端（client.ts）决定是否重试；
 *   2. 图内补充节点（enrichLiveData）决定是否熔断、是否静默；
 *   3. 构建期源（scripts/sources/justoneapi.mjs）决定是否中止并提示。
 * 规则写散在任何一处，另外两处就会分叉（例如「303 该不该重试」出现两个答案）。
 *
 * 处理项共 13 个 = 1 个成功码（0）+ 12 类失败：
 *   9 个契约错误码（100 / 301 / 302 / 303 / 400 / 500 / 600 / 601 / 602）
 *   + 未知码（契约外）
 *   + 传输层（超时 / DNS / TLS / 非法 JSON）
 *   + 本地 token 缺失（请求根本没发出去，与服务端的 code 100 是两件事）
 */

/** 失败类别；`transport` 覆盖超时与非法 JSON 等一切「没拿到合法响应」的情形 */
export type JustOneApiFailureKind =
  | 'token_missing'
  | 'token_invalid'
  | 'collect_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'bad_request'
  | 'server_error'
  | 'permission_denied'
  | 'insufficient_balance'
  | 'token_limit'
  | 'unknown_code'
  | 'transport';

export interface FailurePolicy {
  /** 中文短标签：写日志、构建期提示、右栏时间线都用它，避免各处各写一份文案 */
  label: string;
  /**
   * 最多尝试次数（1 = 不重试）。
   * 只有三处大于 1：301（采集失败重试 2 次）、500（内部错误重试 2 次）、
   * 302（限流退避后重试 1 次，共 2 次）。
   */
  maxAttempts: number;
}

/** 成功码：业务结果一律以响应体的 code 为准，HTTP 状态码只作诊断信息 */
export const SUCCESS_CODE = 0;

export const FAILURE_POLICY: Record<JustOneApiFailureKind, FailurePolicy> = {
  token_missing: { label: '未配置 JUSTONEAPI_TOKEN', maxAttempts: 1 },
  token_invalid: { label: 'Token 无效或已失效', maxAttempts: 1 },
  collect_failed: { label: '上游采集失败（可重试）', maxAttempts: 3 },
  rate_limited: { label: '超出速率限制', maxAttempts: 2 },
  quota_exceeded: { label: '超出每日配额（按 Asia/Shanghai 自然日计算）', maxAttempts: 1 },
  bad_request: { label: '请求参数错误', maxAttempts: 1 },
  server_error: { label: 'JustOneAPI 内部服务器错误', maxAttempts: 3 },
  permission_denied: { label: '该 Token 无权访问此接口', maxAttempts: 1 },
  insufficient_balance: { label: '账户余额不足', maxAttempts: 1 },
  token_limit: { label: 'Token 累计消费已达上限', maxAttempts: 1 },
  unknown_code: { label: '未在契约内的业务码', maxAttempts: 1 },
  transport: { label: '网络或响应体异常', maxAttempts: 1 },
};

/** 契约内的业务码 → 失败类别；0 不在表内（0 是成功，由调用方先判掉） */
const CODE_TO_KIND: Record<number, JustOneApiFailureKind> = {
  100: 'token_invalid',
  301: 'collect_failed',
  302: 'rate_limited',
  303: 'quota_exceeded',
  400: 'bad_request',
  500: 'server_error',
  600: 'permission_denied',
  601: 'insufficient_balance',
  602: 'token_limit',
};

/** 业务码 → 类别；契约外的码一律归入 `unknown_code`（不猜测语义） */
export function kindOfCode(code: number): JustOneApiFailureKind {
  return CODE_TO_KIND[code] ?? 'unknown_code';
}

/**
 * 是否应当触发「当日熔断」。
 *
 * 303（当日配额用尽）显然要停；601 / 602 也一并熔断：它们同属「继续调用只会重复失败」
 * 的状态，而运行时是静默回退快照的，不熔断就会每轮都白撞一次网络。
 */
const BREAKER_KINDS: readonly JustOneApiFailureKind[] = [
  'quota_exceeded',
  'insufficient_balance',
  'token_limit',
];

export function tripsBreaker(error: unknown): boolean {
  return error instanceof JustOneApiError && BREAKER_KINDS.includes(error.kind);
}

/** 超时（而不是其它传输层故障）允许重试 1 次：官方明确「短超时会造成少量请求未拿到结果」 */
const TIMEOUT_MAX_ATTEMPTS = 2;

interface FailureContext {
  /** 端点路径（不含域名与 token） */
  endpoint: string;
  /** 已尝试次数（含本次） */
  attempt: number;
  /** 服务端 HTTP 状态码；本地错误（token 缺失）没有 */
  httpStatus?: number;
  /** 服务端 message 原文 */
  serverMessage?: string;
}

/**
 * 统一的失败载体。
 *
 * 只用一个类 + `kind` 判别，不建 12 个子类：调用方关心的是「能不能重试」（`maxAttempts`）
 * 与「要不要熔断」（`tripsBreaker`），不是类型层级；子类只会让 try/catch 变成冲击钻。
 */
export class JustOneApiError extends Error {
  readonly kind: JustOneApiFailureKind;
  /** 业务码；本地错误（token 缺失）与非法响应没有业务码 */
  readonly code: number | null;
  /** 端点路径（脱敏后，不含 token） */
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** 是否因超时而失败（仅 `transport` 有意义，决定它是否可重试） */
  readonly timedOut: boolean;

  constructor(init: {
    kind: JustOneApiFailureKind;
    message: string;
    endpoint: string;
    attempt: number;
    maxAttempts?: number;
    code?: number | null;
    httpStatus?: number | null;
    timedOut?: boolean;
  }) {
    // 刻意不挂 `cause`：底层 fetch 异常里可能带出含 token 的完整 URL，
    // 而「任何输出都不含 token」是硬约束，不能指望每个渲染错误的地方都记得脱敏
    super(init.message);
    this.name = 'JustOneApiError';
    this.kind = init.kind;
    this.code = init.code ?? null;
    this.endpoint = init.endpoint;
    this.httpStatus = init.httpStatus ?? null;
    this.attempts = init.attempt;
    this.timedOut = init.timedOut ?? false;
    this.maxAttempts =
      init.maxAttempts ?? FAILURE_POLICY[init.kind].maxAttempts;
  }

  /** 人类可读的类别文案（不含 token、不含 server message） */
  get label(): string {
    return FAILURE_POLICY[this.kind].label;
  }

  get retryable(): boolean {
    return this.maxAttempts > 1;
  }

  /** 本地未配置 token：请求未发出，与服务端 code 100 必须可区分 */
  static tokenMissing(endpoint = ''): JustOneApiError {
    return new JustOneApiError({
      kind: 'token_missing',
      message: `未配置环境变量 JUSTONEAPI_TOKEN，未发起请求（endpoint=${endpoint}）`,
      endpoint,
      attempt: 0,
    });
  }

  /** 服务端返回了契约内的非 0 码 */
  static fromCode(code: number, context: FailureContext): JustOneApiError {
    const kind = kindOfCode(code);
    const label = FAILURE_POLICY[kind].label;
    const status = context.httpStatus === undefined ? '' : ` / HTTP ${context.httpStatus}`;
    const server = context.serverMessage ? `：${context.serverMessage}` : '';
    return new JustOneApiError({
      kind,
      message: `${label}（code ${code}${status}）${server}`,
      code,
      endpoint: context.endpoint,
      httpStatus: context.httpStatus ?? null,
      attempt: context.attempt,
    });
  }

  /** 传输层故障：超时、DNS/TLS、超时中止、响应体不是合法 JSON */
  static transport(
    reason: string,
    context: FailureContext & { timedOut?: boolean },
  ): JustOneApiError {
    const timedOut = context.timedOut ?? false;
    return new JustOneApiError({
      kind: 'transport',
      message: `${FAILURE_POLICY.transport.label}（${reason}，endpoint=${context.endpoint}）`,
      endpoint: context.endpoint,
      httpStatus: context.httpStatus ?? null,
      attempt: context.attempt,
      // 超时是唯一「重试一次有意义」的传输层故障
      maxAttempts: timedOut
        ? TIMEOUT_MAX_ATTEMPTS
        : FAILURE_POLICY.transport.maxAttempts,
      timedOut,
    });
  }
}

export function isJustOneApiError(value: unknown): value is JustOneApiError {
  return value instanceof JustOneApiError;
}