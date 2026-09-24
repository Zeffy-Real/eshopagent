import { describe, expect, it } from 'vitest';
import {
  FAILURE_POLICY,
  JustOneApiError,
  isJustOneApiError,
  kindOfCode,
  tripsBreaker,
  type JustOneApiFailureKind,
} from '@/lib/justoneapi/errors.mjs';

/**
 * 错误分类与重试策略是**唯一实现**：客户端、图内节点、构建期源三处都只读它。
 * 这里逐项钉死「哪个码归哪类、能不能重试、要不要熔断」，任何一处被改错都会先在这里红。
 */

describe('kindOfCode：契约码 → 失败类别', () => {
  const CODE_TABLE: [number, JustOneApiFailureKind][] = [
    [100, 'token_invalid'],
    // 101 与 100 同义（官方 OpenAPI 枚举里有，早期契约漏了）
    [101, 'token_invalid'],
    // 202 与 302 同义
    [202, 'rate_limited'],
    [301, 'collect_failed'],
    [302, 'rate_limited'],
    [303, 'quota_exceeded'],
    [400, 'bad_request'],
    // 404 已实测（Resource not found），显式分类而不是丢进 unknown_code
    [404, 'not_found'],
    [500, 'server_error'],
    // 503 与 500 同类（服务暂时不可用），次数不同见下
    [503, 'server_error'],
    [600, 'permission_denied'],
    [601, 'insufficient_balance'],
    [602, 'token_limit'],
  ];

  it.each(CODE_TABLE)('code %i → %s', (code, kind) => {
    expect(kindOfCode(code)).toBe(kind);
  });

  it('契约外的码归入 unknown_code，不猜测语义（300 语义未确认，保持未知）', () => {
    for (const code of [-1, 0, 1, 99, 300, 999, 123456]) {
      expect(kindOfCode(code)).toBe('unknown_code');
    }
  });

  it('码表与策略表自洽：13 个已归类失败码归入 10 类，策略表共 13 类', () => {
    const kinds = CODE_TABLE.map(([, kind]) => kind);
    // 开放平台枚举共 14 个失败码，扣掉语义未确认的 300（归 unknown_code）后这 13 个各自归类；
    // 其中 100/101 同类、500/503 同类、202/302 同类 → 10 类
    expect(kinds.length).toBe(13);
    expect(new Set(kinds).size).toBe(10);
    for (const kind of kinds) {
      expect(FAILURE_POLICY[kind]).toBeDefined();
    }
    // 13 类策略 = 业务码的 10 类 + unknown_code + token_missing + transport
    expect(Object.keys(FAILURE_POLICY)).toHaveLength(13);
  });
});

describe('fromCode：重试次数（决定是否重试的唯一来源）', () => {
  const RETRY_TABLE: [number, boolean, number][] = [
    [100, false, 1],
    [101, false, 1],
    [202, true, 2],
    [301, true, 3],
    [302, true, 2],
    [303, false, 1],
    [400, false, 1],
    [404, false, 1],
    [500, true, 3],
    [503, true, 2],
    [600, false, 1],
    [601, false, 1],
    [602, false, 1],
    [300, false, 1],
    [999, false, 1],
  ];

  it.each(RETRY_TABLE)('code %i → 可重试=%s，最多 %i 次', (code, retryable, maxAttempts) => {
    const error = JustOneApiError.fromCode(code, {
      endpoint: '/api/jd/search-item-list/v1',
      attempt: 1,
      httpStatus: 200,
    });
    expect(error.retryable).toBe(retryable);
    expect(error.maxAttempts).toBe(maxAttempts);
  });

  it('消息带上业务码、HTTP 状态与服务端原文，便于定位', () => {
    const error = JustOneApiError.fromCode(303, {
      endpoint: '/api/jd/search-item/v1',
      attempt: 1,
      httpStatus: 429,
      serverMessage: 'DAILY LIMIT EXCEEDED',
    });
    expect(error.code).toBe(303);
    expect(error.httpStatus).toBe(429);
    expect(error.message).toContain('code 303');
    expect(error.message).toContain('HTTP 429');
    expect(error.message).toContain('DAILY LIMIT EXCEEDED');
    expect(error.message).toContain(FAILURE_POLICY.quota_exceeded.label);
    expect(error.endpoint).toBe('/api/jd/search-item/v1');
  });
});

describe('tokenMissing：本地未配置与 code 100 是两件事', () => {
  it('独立类别、无业务码、不重试', () => {
    const error = JustOneApiError.tokenMissing('/api/jd/search-item/v1');
    expect(error.kind).toBe('token_missing');
    expect(error.code).toBeNull();
    expect(error.httpStatus).toBeNull();
    expect(error.attempts).toBe(0);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('JUSTONEAPI_TOKEN');
  });
});

describe('transport：超时是唯一可重试的传输层故障', () => {
  it('网络失败 / 非法 JSON：不重试', () => {
    const error = JustOneApiError.transport('网络请求失败', { endpoint: '/x', attempt: 1 });
    expect(error.kind).toBe('transport');
    expect(error.timedOut).toBe(false);
    expect(error.retryable).toBe(false);
    expect(error.maxAttempts).toBe(1);
  });

  it('超时：重试 1 次（共 2 次尝试）', () => {
    const error = JustOneApiError.transport('请求超时', {
      endpoint: '/x',
      attempt: 1,
      timedOut: true,
    });
    expect(error.timedOut).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.maxAttempts).toBe(2);
  });

  it('不挂 cause：底层 fetch 异常可能带出含 token 的 URL', () => {
    const error = JustOneApiError.transport('网络请求失败', {
      endpoint: '/x',
      attempt: 1,
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('tripsBreaker：熔断集合只有 303 / 601 / 602', () => {
  it('配额与余额类失败触发熔断，其余不触发', () => {
    for (const code of [303, 601, 602]) {
      expect(tripsBreaker(JustOneApiError.fromCode(code, { endpoint: '/x', attempt: 1 }))).toBe(true);
    }
    for (const code of [100, 301, 302, 400, 500, 600, 999]) {
      expect(tripsBreaker(JustOneApiError.fromCode(code, { endpoint: '/x', attempt: 1 }))).toBe(false);
    }
  });

  it('非 JustOneApiError 一律不触发（节点里直接拿到普通异常时不该熔断）', () => {
    expect(tripsBreaker(new Error('boom'))).toBe(false);
    expect(tripsBreaker(null)).toBe(false);
    expect(tripsBreaker(undefined)).toBe(false);
  });
});

describe('isJustOneApiError：类型守卫', () => {
  it('自己的错误为真，普通错误为假', () => {
    expect(isJustOneApiError(JustOneApiError.tokenMissing('/x'))).toBe(true);
    expect(isJustOneApiError(new Error('boom'))).toBe(false);
    expect(isJustOneApiError('boom')).toBe(false);
  });

  it('保留 label 与 Error 语义（可被 throw / catch 正常使用）', () => {
    const error = JustOneApiError.fromCode(601, { endpoint: '/x', attempt: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('JustOneApiError');
    expect(error.label).toBe(FAILURE_POLICY.insufficient_balance.label);
  });
});