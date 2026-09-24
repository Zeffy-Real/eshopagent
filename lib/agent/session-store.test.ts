import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCheckpointBackend, getCheckpointer, getSqliteDatabase } from '@/lib/agent/checkpointer';
import {
  backdateSession,
  countSessions,
  resetCleanupGate,
  touchSession,
} from '@/lib/agent/session-store';

/**
 * 会话持久化与过期清理的集成测试（跑在真实的 SQLite 文件上）。
 *
 * 注意：这两个模块的环境变量都是**惰性读取**的（只在初始化/清理时读，不在模块求值时读），
 * 所以可以在 import 之后、首次调用之前设置 env。
 */
const DB_PATH = `.cache/test-session-${Date.now()}.sqlite`;
process.env.CHECKPOINT_BACKEND = 'sqlite';
process.env.CHECKPOINT_DB_PATH = DB_PATH;
process.env.SESSION_TTL_DAYS = '7';

const DAY_MS = 86_400_000;

/** 每次运行用独立文件，避免上一次运行残留的行影响 countSessions 断言 */
function removeDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_PATH}${suffix}`, { force: true });
    } catch {
      // 文件被占用时忽略：临时文件在 .cache/ 下，不影响测试结论
    }
  }
}

beforeAll(async () => {
  // 先初始化 checkpointer，session-store 才有可用的 SQLite 连接
  await getCheckpointer();
});

afterAll(() => {
  removeDbFiles();
});

describe('checkpointer：sqlite 后端', () => {
  it('默认使用 sqlite 且没有回落到内存态', () => {
    expect(getCheckpointBackend()).toBe('sqlite');
  });

  it('暴露了 SQLite 连接（session_meta 依赖它）', () => {
    expect(getSqliteDatabase()).not.toBeNull();
  });

  it('WAL 与 busy_timeout 已生效', () => {
    const db = getSqliteDatabase();
    expect(db?.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db?.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});

describe('touchSession：会话登记', () => {
  it('首次出现的 sessionId 会被登记', async () => {
    resetCleanupGate();
    await touchSession('s-alpha');
    expect(countSessions()).toBe(1);
  });

  it('回归：touchSession 自己会确保 checkpointer 已初始化（不依赖调用顺序）', async () => {
    // 曾经 route.ts 里先调 touchSession、后 await getAgentApp()，于是 SQLite 连接
    // 还没建立、getSqliteDatabase() 返回 null，整个会话管理被静默跳过
    // （checkpoints 正常落盘，但 session_meta 表压根不存在）。
    // 现在 touchSession 内部先 await getCheckpointer()，单测里不预先初始化也能建表。
    const db = getSqliteDatabase();
    expect(db).not.toBeNull();
    const tables = db
      ?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_meta'")
      .all();
    expect(tables?.length).toBe(1);
  });

  it('同一 sessionId 重复 touch 不会重复插入', async () => {
    await touchSession('s-alpha');
    await touchSession('s-alpha');
    expect(countSessions()).toBe(1);
  });

  it('不同 sessionId 各占一行', async () => {
    await touchSession('s-beta');
    expect(countSessions()).toBe(2);
  });
});

describe('过期清理：TTL 与最小间隔闸门', () => {
  it('超过 TTL 的会话在新会话创建时被清理，且 checkpoint 一并删除', async () => {
    const saver = await getCheckpointer();
    const config = { configurable: { thread_id: 's-alpha' } };
    await saver.put(
      config,
      {
        v: 1,
        id: 'ckpt-alpha',
        ts: new Date().toISOString(),
        channel_values: { probe: 'alpha' },
        channel_versions: { probe: 1 },
        versions_seen: {},
      },
      { source: 'input', step: 0, parents: {} },
      {},
    );
    expect(await saver.getTuple(config)).toBeDefined();

    // 把 s-alpha 的活跃时间改到 8 天前（TTL 是 7 天）
    backdateSession('s-alpha', Date.now() - 8 * DAY_MS);
    resetCleanupGate();

    // 新会话出现时才触发清理
    await touchSession('s-gamma');

    expect(countSessions()).toBe(2); // s-beta + s-gamma，s-alpha 已被清掉
    // checkpoint 也必须删掉，否则只是删了索引、状态仍占着磁盘
    expect(await saver.getTuple(config)).toBeUndefined();
  });

  it('最小间隔闸门生效：闸门内的新会话不会触发第二次清理', async () => {
    await touchSession('s-delta');
    backdateSession('s-delta', Date.now() - 8 * DAY_MS);

    // 不重置闸门：距上次清理不足 10 分钟，本次不应清理
    await touchSession('s-epsilon');
    expect(countSessions()).toBe(4); // s-beta + s-gamma + s-delta + s-epsilon

    // 放行闸门后再来一个新会话，才会被清掉
    resetCleanupGate();
    await touchSession('s-zeta');
    expect(countSessions()).toBe(4); // s-delta 被清，s-zeta 加入
  });
});
