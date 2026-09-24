import {
  FAILURE_POLICY,
  TIMEOUT_MAX_ATTEMPTS,
  kindOfCode,
  maxAttemptsOfCode,
  tripsBreakerKind,
} from './codes.mjs';

/**
 * 错误对象：把「业务码 / 本地故障」包装成一个可判别、可读、可重试判定的载体。
 *
 * 码表与重试次数**不在这里**（在 codes.mjs）：那一份要被纯 node 的构建脚本共用。
 * 本文件只负责：错误类型、用户可读文案、以及把码表翻译成 `JustOneApiError`。
 *
 * 处理项共 17 个 = 1 个成功码 + 16 类失败：
 *   官方 OpenAPI 的 code 枚举有 15 个（比早期契约多 5 个：101/202/300/404/503），
 *   其中 14 个是失败码；再加「本地 token 缺失」与「传输层故障」两类本地错误。
 *
 * 为什么是 .mjs：见 codes.mjs 顶部说明（构建脚本无法加载 TS，两边必须共用同一实现）。
 */

/**
 * 统一的失败载体。
 *
 * 只用一个类 + `kind` 判别，不建 14 个子类：调用方关心的是「能不能重试」（`maxAttempts`）
 * 与「要不要熔断」（`tripsBreaker`），不是类型层级；子类只会让 try/catch 变成冲击钻。
 */
export class JustOneApiError extends Error {
  constructor(init) {
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
    this.maxAttempts = init.maxAttempts ?? FAILURE_POLICY[init.kind].maxAttempts;
  }

  /** 人类可读的类别文案（不含 token、不含 server message） */
  get label() {
    return FAILURE_POLICY[this.kind].label;
  }

  get retryable() {
    return this.maxAttempts > 1;
  }

  /** 本地未配置 token：请求未发出，与服务端 code 100 必须可区分 */
  static tokenMissing(endpoint = '') {
    return new JustOneApiError({
      kind: 'token_missing',
      message: `未配置环境变量 JUSTONEAPI_TOKEN，未发起请求（endpoint=${endpoint}）`,
      endpoint,
      attempt: 0,
    });
  }

  /** 服务端返回了非 0 码（次数由码表决定，含 503 的按码覆盖） */
  static fromCode(code, context) {
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
      maxAttempts: maxAttemptsOfCode(code),
    });
  }

  /** 传输层故障：超时、DNS/TLS、超时中止、响应体不是合法 JSON */
  static transport(reason, context) {
    const timedOut = context.timedOut ?? false;
    return new JustOneApiError({
      kind: 'transport',
      message: `${FAILURE_POLICY.transport.label}（${reason}，endpoint=${context.endpoint}）`,
      endpoint: context.endpoint,
      httpStatus: context.httpStatus ?? null,
      attempt: context.attempt,
      // 超时是唯一「重试一次有意义」的传输层故障
      maxAttempts: timedOut ? TIMEOUT_MAX_ATTEMPTS : FAILURE_POLICY.transport.maxAttempts,
      timedOut,
    });
  }
}

/**
 * 是否应当触发「当日熔断」（303 / 601 / 602）。
 *
 * 判定规则在 codes.mjs（与构建脚本共用），这里只做「从错误对象取 kind」的适配。
 */
export function tripsBreaker(error) {
  return error instanceof JustOneApiError && tripsBreakerKind(error.kind);
}

export function isJustOneApiError(value) {
  return value instanceof JustOneApiError;
}

export { FAILURE_POLICY, SUCCESS_CODE, kindOfCode, maxAttemptsOfCode } from './codes.mjs';