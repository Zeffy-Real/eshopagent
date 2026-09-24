import { describe, expect, it, vi } from 'vitest';
import { LIVE_CACHE_MAX_ENTRIES, LIVE_CACHE_TTL_MS, SingleFlightCache } from '@/lib/justoneapi/cache';

/**
 * 缓存的三个要点各占一组用例：TTL、单飞、失败不缓存。
 * 时间通过注入的 `now` 控制，不 sleep —— 单测不等待真实时间。
 */

describe('SingleFlightCache：TTL', () => {
  it('默认 TTL 是 300 秒、上限 200 条', () => {
    expect(LIVE_CACHE_TTL_MS).toBe(300_000);
    expect(LIVE_CACHE_MAX_ENTRIES).toBe(200);
  });

  it('TTL 内命中，到期即失效并删除', () => {
    let now = 1_000;
    const cache = new SingleFlightCache<string>({ ttlMs: 300, now: () => now });
    cache.set('jd:1', 'v');

    now += 299;
    expect(cache.get('jd:1')).toBe('v');
    now += 1;
    expect(cache.get('jd:1')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('未写过的键返回 undefined（不抛错）', () => {
    const cache = new SingleFlightCache<string>();
    expect(cache.get('nobody')).toBeUndefined();
  });

  it('重写同一个键会同时刷新值与写入顺序', () => {
    const cache = new SingleFlightCache<number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // a 变成最近写入
    cache.set('c', 3); // 淘汰最旧的 b
    expect(cache.get('a')).toBe(11);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('SingleFlightCache：单飞去重', () => {
  it('同键并发只调用一次 loader，两个调用方拿到同一个结果', async () => {
    let release: (value: string) => void = () => {};
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new SingleFlightCache<string>();

    const first = cache.run('jd:1', loader);
    const second = cache.run('jd:1', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.inflightCount).toBe(1);

    release('v');
    await expect(first).resolves.toBe('v');
    await expect(second).resolves.toBe('v');
    expect(cache.inflightCount).toBe(0);
    expect(cache.get('jd:1')).toBe('v');
  });

  it('命中缓存后不再调用 loader', async () => {
    const loader = vi.fn(async () => 'v');
    const cache = new SingleFlightCache<string>();
    await cache.run('jd:1', loader);
    await cache.run('jd:1', loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('不同键互不干扰（键含平台前缀，跨平台同 id 不会撞车）', async () => {
    const loader = vi.fn(async (key: string) => `value:${key}`);
    const cache = new SingleFlightCache<string>();
    await expect(cache.run('jd:1', () => loader('jd:1'))).resolves.toBe('value:jd:1');
    await expect(cache.run('tb:1', () => loader('tb:1'))).resolves.toBe('value:tb:1');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });
});

describe('SingleFlightCache：失败不缓存', () => {
  it('loader 失败：不写缓存、摘掉 inflight，下一次调用重新执行', async () => {
    let attempt = 0;
    const loader = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return 'ok';
    });
    const cache = new SingleFlightCache<string>();

    await expect(cache.run('jd:1', loader)).rejects.toThrow('boom');
    expect(cache.get('jd:1')).toBeUndefined();
    expect(cache.inflightCount).toBe(0);

    // 失败不计费，缓存失败反而会把一次抖动固化成 5 分钟不可用
    await expect(cache.run('jd:1', loader)).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('同键并发失败：两个调用方都收到同一个拒绝', async () => {
    const loader = vi.fn(async () => {
      throw new Error('boom');
    });
    const cache = new SingleFlightCache<string>();
    const first = cache.run('jd:1', loader);
    const second = cache.run('jd:1', loader);
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('SingleFlightCache：容量上限', () => {
  it('超出上限按写入顺序淘汰最旧的键', () => {
    const cache = new SingleFlightCache<number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('clear 会同时清掉缓存与在途登记', async () => {
    const cache = new SingleFlightCache<string>();
    const pending = cache.run('jd:1', () => new Promise<string>(() => {}));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.inflightCount).toBe(0);
    pending.catch(() => {});
  });
});