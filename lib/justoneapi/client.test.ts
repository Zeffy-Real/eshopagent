import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JUSTONEAPI_BASE_URL,
  JUSTONEAPI_TIMEOUT_MS,
  backoffDelay,
  callJustOneApi,
  hasJustOneApiToken,
  redact,
  tokenFromEnv,
  type CallJustOneApiOptions,
} from '@/lib/justoneapi/client';
import { isJustOneApiError, type JustOneApiFailureKind } from '@/lib/justoneapi/errors';

/**
 * 客户端单测：**全部 mock fetch**，不发真实网络请求（项目硬约束）。
 *
 * 三组重点：
 *   1. 业务码与 HTTP 状态码并行存在（实测无效 token = HTTP 401 + code 100）→ 任何 HTTP
 *      状态下都先解析响应体；
 *   2. 重试只发生在 301 / 500 / 302 / 超时上，次数由 errors.ts 决定；
 *   3. token 绝不进入日志与错误消息。
 */

const ENDPOINT = '/api/jd/get-item-detail/v1';
const TOKEN = 'tok-secret-for-test-only';
const ORIGINAL_TOKEN = process.env.JUSTONEAPI_TOKEN;

function envelope(code: number, data: unknown = null, message = ''): string {
  // 实测响应体比官方契约多一个 recordTime 字段
  return JSON.stringify({ code, message, data, recordTime: null });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

interface Harness {
  fetchImpl: ReturnType<typeof vi.fn>;
  sleeps: number[];
  logs: string[];
  options: CallJustOneApiOptions;
}

function harness(impl: (url: string, init: RequestInit) => Promise<Response>): Harness {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const fetchImpl = vi.fn(impl);
  return {
    fetchImpl,
    sleeps,
    logs,
    options: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      logger: (line: string) => {
        logs.push(line);
      },
      timeoutMs: 50,
    },
  };
}

/** 连续返回同一响应（用于「重试若干次后放弃」） */
function always(body: string, status = 200) {
  return async () => jsonResponse(body, status);
}

/** 按顺序返回响应，用完后重复最后一个 */
function sequence(bodies: string[], status = 200) {
  let index = 0;
  return async () => {
    const body = bodies[Math.min(index, bodies.length - 1)] ?? '';
    index += 1;
    return jsonResponse(body, status);
  };
}

beforeEach(() => {
  process.env.JUSTONEAPI_TOKEN = TOKEN;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.JUSTONEAPI_TOKEN;
  else process.env.JUSTONEAPI_TOKEN = ORIGINAL_TOKEN;
});

describe('token 读取：只从环境变量来', () => {
  it('已配置：tokenFromEnv 返回原值；空串与纯空白视为未配置', () => {
    expect(tokenFromEnv()).toBe(TOKEN);
    expect(hasJustOneApiToken()).toBe(true);

    process.env.JUSTONEAPI_TOKEN = '   ';
    expect(tokenFromEnv()).toBeNull();
    expect(hasJustOneApiToken()).toBe(false);
  });

  it('未配置：抛 token_missing，且**不发请求**（缺失与 code 100 是两件事）', async () => {
    delete process.env.JUSTONEAPI_TOKEN;
    const test = harness(always(envelope(0, { ok: true })));

    const error = await callJustOneApi(ENDPOINT, { itemId: '1' }, test.options).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(isJustOneApiError(error)).toBe(true);
    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.kind).toBe('token_missing');
    expect(error.attempts).toBe(0);
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('成功路径', () => {
  it('code 0：返回 data，业务参数与 token 拼进 URL，不重试不等待', async () => {
    const test = harness(
      sequence([envelope(0, { itemId: 'jd-1', price: 199 })]),
    );

    const data = await callJustOneApi<{ itemId: string; price: number }>(
      ENDPOINT,
      { itemId: 'jd-1', page: 1 },
      test.options,
    );

    expect(data).toEqual({ itemId: 'jd-1', price: 199 });
    const url = String(test.fetchImpl.mock.calls[0]?.[0] ?? '');
    expect(url.startsWith(`${JUSTONEAPI_BASE_URL}${ENDPOINT}?`)).toBe(true);
    expect(url).toContain('itemId=jd-1');
    expect(url).toContain('page=1');
    expect(url).toContain(`token=${TOKEN}`);
    expect(test.sleeps).toEqual([]);
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('code 0 但 data 为 null：原样返回，不编造失败语义', async () => {
    const test = harness(always(envelope(0, null)));
    await expect(callJustOneApi(ENDPOINT, {}, test.options)).resolves.toBeNull();
  });

  it('默认超时 120 秒（官方建议值，不低于 60）', () => {
    expect(JUSTONEAPI_TIMEOUT_MS).toBe(120_000);
  });
});

describe('业务码：HTTP 状态码不干扰判定（实测 401 + code 100 / 429 + code 303）', () => {
  const CODE_TABLE: {
    code: number;
    httpStatus: number;
    kind: JustOneApiFailureKind;
    fetchCalls: number;
    sleeps: number;
  }[] = [
    { code: 100, httpStatus: 401, kind: 'token_invalid', fetchCalls: 1, sleeps: 0 },
    { code: 301, httpStatus: 500, kind: 'collect_failed', fetchCalls: 3, sleeps: 2 },
    { code: 302, httpStatus: 429, kind: 'rate_limited', fetchCalls: 2, sleeps: 1 },
    { code: 303, httpStatus: 429, kind: 'quota_exceeded', fetchCalls: 1, sleeps: 0 },
    { code: 400, httpStatus: 400, kind: 'bad_request', fetchCalls: 1, sleeps: 0 },
    { code: 500, httpStatus: 500, kind: 'server_error', fetchCalls: 3, sleeps: 2 },
    { code: 600, httpStatus: 403, kind: 'permission_denied', fetchCalls: 1, sleeps: 0 },
    { code: 601, httpStatus: 403, kind: 'insufficient_balance', fetchCalls: 1, sleeps: 0 },
    { code: 602, httpStatus: 403, kind: 'token_limit', fetchCalls: 1, sleeps: 0 },
    { code: 999, httpStatus: 200, kind: 'unknown_code', fetchCalls: 1, sleeps: 0 },
  ];

  it.each(CODE_TABLE)(
    'code $code（HTTP $httpStatus）→ $kind，尝试 $fetchCalls 次',
    async ({ code, httpStatus, kind, fetchCalls, sleeps }) => {
      const test = harness(always(envelope(code, null, 'SERVER MESSAGE'), httpStatus));

      const error = await callJustOneApi(ENDPOINT, { itemId: '1' }, test.options).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(isJustOneApiError(error)).toBe(true);
      if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
      expect(error.kind).toBe(kind);
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(httpStatus);
      expect(error.attempts).toBe(fetchCalls);
      expect(test.fetchImpl).toHaveBeenCalledTimes(fetchCalls);
      expect(test.sleeps).toHaveLength(sleeps);
      expect(error.message).toContain(`code ${code}`);
    },
  );

  it('HTTP 200 + code 303 与 HTTP 429 + code 303 结论一致（判定只看响应体）', async () => {
    const ok200 = harness(always(envelope(303), 200));
    const err429 = harness(always(envelope(303), 429));
    const kinds = await Promise.all(
      [ok200, err429].map((test) =>
        callJustOneApi(ENDPOINT, {}, test.options).then(
          () => 'no-error',
          (reason: unknown) => (isJustOneApiError(reason) ? reason.kind : 'unknown'),
        ),
      ),
    );
    expect(kinds).toEqual(['quota_exceeded', 'quota_exceeded']);
  });
});

describe('重试：301 / 500 / 302 结束时能恢复，否则按次数放弃', () => {
  it('301 第一次失败、第二次成功：请求 2 次，退避 1 次', async () => {
    const test = harness(sequence([envelope(301, null, '采集失败'), envelope(0, { ok: true })]));

    await expect(callJustOneApi(ENDPOINT, {}, test.options)).resolves.toEqual({ ok: true });
    expect(test.fetchImpl).toHaveBeenCalledTimes(2);
    expect(test.sleeps).toHaveLength(1);
  });

  it('500 连续失败 4 次：只尝试 3 次即放弃', async () => {
    const test = harness(always(envelope(500), 500));

    const error = await callJustOneApi(ENDPOINT, {}, test.options).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(test.fetchImpl).toHaveBeenCalledTimes(3);
    expect(test.sleeps).toHaveLength(2);
    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.kind).toBe('server_error');
    expect(error.attempts).toBe(3);
  });

  it('302 限流：退避后重试 1 次（共 2 次）', async () => {
    const test = harness(sequence([envelope(302, null, 'RATE LIMITED'), envelope(0, { ok: true })]));

    await expect(callJustOneApi(ENDPOINT, {}, test.options)).resolves.toEqual({ ok: true });
    expect(test.fetchImpl).toHaveBeenCalledTimes(2);
    expect(test.sleeps).toHaveLength(1);
  });

  it('退避时长落在公式区间内：min(30s, 500ms × 2^attempt) × (0.5 + random())', () => {
    expect(backoffDelay(1, () => 0)).toBe(500);
    expect(backoffDelay(1, () => 1)).toBe(1_500);
    expect(backoffDelay(2, () => 0.5)).toBe(2_000);
    // 基数封顶 30 秒后，抖动仍在其上（最大 45 秒）
    expect(backoffDelay(30, () => 1)).toBe(45_000);
  });
});

describe('传输层：非法响应与超时', () => {
  it('响应体不是 JSON：transport 且不重试', async () => {
    const test = harness(always('<html>502 Bad Gateway</html>', 502));

    const error = await callJustOneApi(ENDPOINT, {}, test.options).then(
      () => null,
      (reason: unknown) => reason,
    );

    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.kind).toBe('transport');
    expect(error.timedOut).toBe(false);
    expect(error.httpStatus).toBe(502);
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    expect(test.sleeps).toEqual([]);
  });

  it('JSON 缺少 code 字段：同样算非法响应', async () => {
    const test = harness(always(JSON.stringify({ message: 'oops' }), 200));
    const error = await callJustOneApi(ENDPOINT, {}, test.options).then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.kind).toBe('transport');
    expect(error.code).toBeNull();
  });

  it('网络异常：transport 且不重试', async () => {
    const test = harness(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await callJustOneApi(ENDPOINT, {}, test.options).then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.kind).toBe('transport');
    expect(error.timedOut).toBe(false);
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('超时：中止请求并重试 1 次（共 2 次），错误标记 timedOut', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const sleeps: number[] = [];
    const options: CallJustOneApiOptions = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      logger: () => {},
      timeoutMs: 5,
    };

    const error = await callJustOneApi(ENDPOINT, {}, options).then(
      () => null,
      (reason: unknown) => reason,
    );

    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.kind).toBe('transport');
    expect(error.timedOut).toBe(true);
    expect(error.maxAttempts).toBe(2);
    expect(error.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe('脱敏：token 不进入日志与错误消息', () => {
  it('redact 同时挡 URL 参数与值回显两种形态', () => {
    expect(redact(`${JUSTONEAPI_BASE_URL}/x?token=${TOKEN}&page=1`, TOKEN)).toBe(
      `${JUSTONEAPI_BASE_URL}/x?token=***&page=1`,
    );
    expect(redact(`服务端回显：${TOKEN}`, TOKEN)).toBe('服务端回显：***');
    expect(redact('没有密钥', null)).toBe('没有密钥');
  });

  it('成功与失败路径的日志都不含 token，且带 endpoint / code / durationMs', async () => {
    const ok = harness(always(envelope(0, { ok: true })));
    await callJustOneApi(ENDPOINT, { itemId: '1' }, ok.options);
    const fail = harness(always(envelope(301), 500));
    await callJustOneApi(ENDPOINT, { itemId: '1' }, fail.options).catch(() => {});

    const logged = [...ok.logs, ...fail.logs].join('\n');
    expect(logged).toContain(`endpoint=${ENDPOINT}`);
    expect(logged).toContain('code=0');
    expect(logged).toContain('code=301');
    expect(logged).toContain('durationMs=');
    expect(logged).toContain('retry');
    expect(logged).not.toContain(TOKEN);
  });

  it('错误消息不含 token', async () => {
    const test = harness(always(envelope(100, null, 'TOKEN INVALID/UNACTIVATE'), 401));
    const error = await callJustOneApi(ENDPOINT, { itemId: '1' }, test.options).then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!isJustOneApiError(error)) throw new Error('应当是 JustOneApiError');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('TOKEN INVALID/UNACTIVATE');
  });
});