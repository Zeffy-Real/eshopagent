/**
 * JustOneAPI 的码表与重试策略：**唯一实现**。
 *
 * 谁在用：
 *   1. 运行时客户端（`lib/justoneapi/client.ts`）—— 决定是否重试、退避多久；
 *   2. 图内补充节点（下一轮的 `enrichLiveData`）—— 决定是否熔断、是否静默；
 *   3. 构建期源（`scripts/sources/justoneapi.mjs`）—— 决定中止还是继续。
 *
 * **为什么是 .mjs 而不是 .ts**：构建脚本由纯 node 直接运行（`node scripts/...`），
 * 加载不了 TS；而同一份策略又必须在运行时复用——不允许「脚本一套、运行时一套」。
 * 取两条加载路径的交集就是：`.mjs` 放实现 + 同名 `.d.mts` 放类型。
 * TS 侧看到完整类型，脚本侧拿到同一份实现，改一处两边同时生效。
 *
 * 码表覆盖官方 OpenAPI 声明的全部 15 个 code：早期契约的 13 个 + 实测补充的
 * 101 / 202 / 300 / 404 / 503（其中 300 语义未确认 → unknown_code，不猜）。
 */

export const SUCCESS_CODE = 0;

/** 失败标签与基准重试次数（次数还能被 CODE_MAX_ATTEMPTS_OVERRIDE 按码覆盖） */
export const FAILURE_POLICY = {
  token_missing: { label: '未配置 JUSTONEAPI_TOKEN', maxAttempts: 1 },
  token_invalid: { label: 'Token 无效或已失效', maxAttempts: 1 },
  collect_failed: { label: '上游采集失败（可重试）', maxAttempts: 3 },
  rate_limited: { label: '超出速率限制', maxAttempts: 2 },
  quota_exceeded: { label: '超出每日配额（按 Asia/Shanghai 自然日计算）', maxAttempts: 1 },
  bad_request: { label: '请求参数错误', maxAttempts: 1 },
  not_found: { label: '资源不存在（路径或商品 ID 无效）', maxAttempts: 1 },
  server_error: { label: 'JustOneAPI 内部服务器错误', maxAttempts: 3 },
  permission_denied: { label: '该 Token 无权访问此接口', maxAttempts: 1 },
  insufficient_balance: { label: '账户余额不足', maxAttempts: 1 },
  token_limit: { label: 'Token 累计消费已达上限', maxAttempts: 1 },
  unknown_code: { label: '未在契约内的业务码', maxAttempts: 1 },
  transport: { label: '网络或响应体异常', maxAttempts: 1 },
};

/**
 * 契约内的业务码 → 失败类别（14 个失败码全在表内）。
 *
 *   - 101 与 100 同义 → token_invalid；
 *   - 202 与 302 同义 → rate_limited；
 *   - 404 显式分类到 not_found，**不丢进 unknown_code**：它是永久错误（路径或商品 ID 不存在），
 *     混进「未知码」只会让排查变慢；
 *   - 503（服务暂时不可用）与 500 同类 → server_error，次数见下方覆盖表；
 *   - 300 语义未确认 → 保持 unknown_code，不猜。
 */
export const CODE_TO_KIND = {
  100: 'token_invalid',
  101: 'token_invalid',
  202: 'rate_limited',
  301: 'collect_failed',
  302: 'rate_limited',
  303: 'quota_exceeded',
  400: 'bad_request',
  404: 'not_found',
  500: 'server_error',
  503: 'server_error',
  600: 'permission_denied',
  601: 'insufficient_balance',
  602: 'token_limit',
};

/** 按码覆盖重试次数：503 只重试 1 次（共 2 次），比 500 保守 */
const CODE_MAX_ATTEMPTS_OVERRIDE = { 503: 2 };

/** 超时（而非其它传输层故障）允许重试 1 次：官方明确「短超时会造成少量请求未拿到结果」 */
export const TIMEOUT_MAX_ATTEMPTS = 2;

/** 退避基数与上限 */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

/** 业务码 → 类别；契约外的码一律归入 unknown_code（不猜测语义） */
export function kindOfCode(code) {
  return CODE_TO_KIND[code] ?? 'unknown_code';
}

/** 业务码 → 最多尝试次数（1 = 不重试） */
export function maxAttemptsOfCode(code) {
  const override = CODE_MAX_ATTEMPTS_OVERRIDE[code];
  if (override !== undefined) return override;
  return FAILURE_POLICY[kindOfCode(code)].maxAttempts;
}

/**
 * 会触发「当日熔断」的失败类别。
 *
 * 303（当日配额用尽）显然要停；601 / 602 也一并熔断：它们同属「继续调用只会重复失败」的状态，
 * 而运行时是静默回退快照的，不熔断就会每轮都白撞一次网络。
 */
export const BREAKER_KINDS = ['quota_exceeded', 'insufficient_balance', 'token_limit'];

export function tripsBreakerKind(kind) {
  return BREAKER_KINDS.includes(kind);
}

/**
 * 退避时长：`delay = min(30s, 500ms × 2^attempt) × (0.5 + random())`。
 *
 * `attempt` 是**已失败的次数**（首次失败传 1）。抖动是必须的：两个并发调用若同步退避，
 * 恢复瞬间会再次撞在同一个限流窗口上。
 */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + random()));
}