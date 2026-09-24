/**
 * 实时数据的进程内缓存 + 单飞去重。
 *
 * 三条约束叠起来把「烧配额」压到最低（设计文档 §6 / §10）：
 *   - TTL 300 秒：价格的分钟级变化对演示没有意义，同一会话里反复问同一件商品不该重复计费；
 *   - 单飞：一轮对话里「先搜索再追问价格」可能触发两次同一 id 的拉取，同键并发共享同一个 Promise；
 *   - 失败不缓存：失败本来就不计费，缓存失败反而会把一次短暂抖动固化成五分钟不可用。
 *
 * 已知行为：模块级实例在 Next dev 的 HMR 下会被重建 → 缓存丢失。这里**不做** globalThis 锚定：
 * 丢的只是缓存（有 TTL，丢了顶多重拉一次），与 checkpointer 丢会话数据不是一回事。
 */

/** 5 分钟：够用又便宜 */
export const LIVE_CACHE_TTL_MS = 300_000;
/** 防止长时间运行内存无界增长；超出后按写入顺序淘汰最旧的键 */
export const LIVE_CACHE_MAX_ENTRIES = 200;

interface CacheEntry<T> {
  value: T;
  /** 绝对过期时间戳（毫秒） */
  expiresAt: number;
}

export interface SingleFlightCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** 时间源，单测注入用；默认 Date.now */
  now?: () => number;
}

export class SingleFlightCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: SingleFlightCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? LIVE_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? LIVE_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** 命中的缓存值；过期即删除并返回 undefined */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // 先删再插：保证 Map 的插入顺序始终是「最近写入顺序」，淘汰时才能取到真正最旧的键
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * 缓存优先 + 单飞：命中直接返回；未命中则调用 loader，同键并发共享同一次调用。
   *
   * 只有**成功**才写缓存（reject 不写），失败因此天然不会被缓存。
   */
  run(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const started = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        // inflight 只登记「正在进行」的调用：无论成功失败都要摘掉，
        // 否则一次失败会把同键永久钉在失败结果上（失败不缓存的前提是这里能清干净）
        if (this.inflight.get(key) === started) this.inflight.delete(key);
      });

    this.inflight.set(key, started);
    return started;
  }

  /** 仅用于测试与诊断 */
  get size(): number {
    return this.entries.size;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}