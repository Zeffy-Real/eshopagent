import { backoffDelay } from './codes.mjs';
import { JustOneApiError } from './errors.mjs';

/**
 * JustOneAPI HTTP 客户端（唯一入口）。
 *
 * 三条容易写错的地方，这里各占一段实现：
 *   1. **业务结果以响应体的 `code` 为准**，不能只看 HTTP 状态码。实测无效 token 返回的是
 *      HTTP 401 + `{"code":100}`，配额用尽返回 HTTP 429 + `{"code":303}`；
 *      因此本客户端在**任何 HTTP 状态下都先尝试解析响应体**，只有响应体解析不出 JSON 时才
 *      归类为传输层错误。
 *   2. **token 只从 process.env 读**，未配置时抛独立错误（不发请求）——
 *      服务端在缺失与无效两种情况下返回的都是 code 100，靠响应码无法区分。
 *   3. **超时 120 秒**（官方建议）：短超时会让少量请求被误判成失败，不代表 API 慢。
 *
 * 为什么是 .mjs：运行时（Next 服务端）与构建脚本（纯 node）必须共用同一份实现，
 * 取两条加载路径的交集 = `.mjs` 实现 + `.d.mts` 类型（见 codes.mjs 顶部说明）。
 * 不引入任何依赖：原生 fetch + AbortController。
 */

export const JUSTONEAPI_BASE_URL = 'https://api.justoneapi.com';

/** 官方建议 120 秒；低于 60 秒会开始出现「少量请求超时未拿到结果」 */
export const JUSTONEAPI_TIMEOUT_MS = 120_000;

export { backoffDelay };

/** 从环境变量取 token；空串与纯空白一律视为未配置 */
export function tokenFromEnv() {
  const token = process.env.JUSTONEAPI_TOKEN?.trim();
  return token ? token : null;
}

/**
 * 是否配置了 token。
 *
 * 图里那条条件边（enrichLiveData 是否进入）的第一条判定就是它：
 * 未配置时整条实时路径必须与改造前完全一致。
 */
export function hasJustOneApiToken() {
  return tokenFromEnv() !== null;
}

/**
 * 脱敏：写进日志或错误消息之前的最后一道关口。
 *
 * 两种形态都要挡：URL 里的 `token=<值>` 参数，以及任何把 token 原值回显出来的文本
 * （例如服务端 message 或异常堆栈里带出来的完整 URL）。
 */
export function redact(text, token = tokenFromEnv()) {
  const masked = String(text).replace(/([?&]token=)[^&\s"']*/g, '$1***');
  return token ? masked.split(token).join('***') : masked;
}

/** 拼 URL：业务参数在前，token 固定在最后（便于日志脱敏，也便于肉眼核对） */
function buildUrl(endpoint, params, token) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  search.set('token', token);
  return `${JUSTONEAPI_BASE_URL}${endpoint}?${search.toString()}`;
}

/** 响应体必须是带数字 code 的对象；其余一律算非法响应 */
function readEnvelope(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.code !== 'number' || !Number.isFinite(parsed.code)) return null;
  return {
    code: parsed.code,
    message: typeof parsed.message === 'string' ? parsed.message : '',
    data: parsed.data ?? null,
  };
}

function isAbortErrorLike(error) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function defaultLogger(line) {
  // debug 级别：这是调试信息，不是告警
  console.debug(line);
}

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发起一次请求（含超时）。
 *
 * 每次调用都会写一行日志（endpoint / http / code / attempt / durationMs）。
 * 日志规范（硬约束）：**只记路径，不记完整 URL**；任何要输出的字符串都过 `redact()`
 * （调用方包好的 logger 已带 token，见 `callJustOneApi`），日志里永远没有 token。
 */
async function requestOnce(url, context) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, context.timeoutMs);

  try {
    let response;
    try {
      response = await context.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw JustOneApiError.transport(
        timedOut ? `请求超时（${context.timeoutMs}ms）` : '网络请求失败',
        {
          endpoint: context.endpoint,
          attempt: context.attempt,
          timedOut: timedOut || isAbortErrorLike(error),
        },
      );
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      // 读流阶段被打断（超时中止时最常见）
      throw JustOneApiError.transport(
        timedOut ? `读取响应超时（${context.timeoutMs}ms）` : '读取响应失败',
        {
          endpoint: context.endpoint,
          attempt: context.attempt,
          httpStatus: response.status,
          timedOut: timedOut || isAbortErrorLike(error),
        },
      );
    }

    const envelope = readEnvelope(text);
    if (!envelope) {
      throw JustOneApiError.transport(
        `响应体不是合法 JSON 或缺少 code 字段（HTTP ${response.status}，${text.length} 字节）`,
        {
          endpoint: context.endpoint,
          attempt: context.attempt,
          httpStatus: response.status,
        },
      );
    }

    context.logger(
      `[justoneapi] endpoint=${context.endpoint} http=${response.status} code=${envelope.code} attempt=${context.attempt} durationMs=${Date.now() - startedAt}`,
    );

    if (envelope.code !== 0) {
      throw JustOneApiError.fromCode(envelope.code, {
        endpoint: context.endpoint,
        attempt: context.attempt,
        httpStatus: response.status,
        serverMessage: envelope.message,
      });
    }

    // code 0 + data null 是契约外的组合：按「没有数据」原样返回，
    // 由平台映射函数判空跳过，不在这里编造失败语义
    return envelope.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一入口：`callJustOneApi('/api/jd/get-item-detail/v1', { itemId: '100207440191' })`。
 *
 * 重试只发生在两类失败上（次数由 codes.mjs 决定，这里不重复定义）：
 * 301（采集失败，共 3 次）、500（内部错误，共 3 次）、302/202（限流，共 2 次）、
 * 503（服务暂时不可用，共 2 次）、超时（共 2 次）；
 * 100/101 / 303 / 400 / 404 / 600 / 601 / 602 与未知码一律立即抛出。
 */
export async function callJustOneApi(endpoint, params = {}, options = {}) {
  const token = tokenFromEnv();
  if (!token) throw JustOneApiError.tokenMissing(endpoint);

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const timeoutMs = options.timeoutMs ?? JUSTONEAPI_TIMEOUT_MS;
  const rawLogger = options.logger ?? defaultLogger;
  const logger = (line) => rawLogger(redact(line, token));

  const url = buildUrl(endpoint, params, token);
  let attempt = 1;

  for (;;) {
    try {
      return await requestOnce(url, { endpoint, attempt, timeoutMs, fetchImpl, logger });
    } catch (error) {
      const failure =
        error instanceof JustOneApiError
          ? error
          : JustOneApiError.transport(redact(String(error), token), { endpoint, attempt });

      if (attempt >= failure.maxAttempts) throw failure;

      const delay = backoffDelay(attempt);
      logger(
        `[justoneapi] retry endpoint=${endpoint} kind=${failure.kind} attempt=${attempt}/${failure.maxAttempts} delayMs=${delay}`,
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}