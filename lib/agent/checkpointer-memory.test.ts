import { afterAll, describe, expect, it } from 'vitest';
import { getCheckpointBackend, getCheckpointer, getSqliteDatabase } from '@/lib/agent/checkpointer';
import { countSessions, touchSession } from '@/lib/agent/session-store';
import { existsSync } from 'node:fs';

/**
 * 内存态回落分支。
 *
 * 单独一个文件是因为 checkpointer 的 backend 取决于环境变量，而它一旦初始化就缓存在
 * globalThis 上。vitest 默认按文件隔离进程，所以这里设 CHECKPOINT_BACKEND=memory
 * 不会污染 sqlite 那份用例。
 *
 * 这一项是「无 Key 也能跑」之外的第二条可用性底线：原生模块装不上时，
 * 服务必须还能起来（只是丢掉持久化），而不是直接崩。
 */
const DB_PATH = `.cache/test-memory-mode-${Date.now()}.sqlite`;
process.env.CHECKPOINT_BACKEND = 'memory';
process.env.CHECKPOINT_DB_PATH = DB_PATH;

afterAll(() => {
  // 内存态下不该产生任何文件；真产生了就说明 backend 判定错了
  for (const suffix of ['', '-wal', '-shm']) {
    expect(existsSync(`${DB_PATH}${suffix}`)).toBe(false);
  }
});

describe('CHECKPOINT_BACKEND=memory', () => {
  it('生效的后端是 memory', () => {
    expect(getCheckpointBackend()).toBe('memory');
  });

  it('不建立 SQLite 连接', async () => {
    await getCheckpointer();
    expect(getSqliteDatabase()).toBeNull();
  });

  it('会话管理被安全跳过（不抛错、不计数）', async () => {
    await expect(touchSession('s-memory')).resolves.toBeUndefined();
    expect(countSessions()).toBe(0);
  });

  it('checkpointer 仍可用（图能正常编译与运行）', async () => {
    const saver = await getCheckpointer();
    expect(typeof saver.getTuple).toBe('function');
  });
});