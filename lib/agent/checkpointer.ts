import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Database } from 'better-sqlite3';
import { resolve } from 'node:path';

/**
 * Checkpointer：会话状态（对话历史 + 搜索/对比/购物车等图状态）的持久化层。
 *
 * 三种取值：
 * - `sqlite`（默认）：落盘到本地 SQLite 文件，进程重启后同一 sessionId 仍能恢复上下文；
 * - `memory`：与改造前一致，纯内存，进程重启即丢；
 * - 自动回落：sqlite 初始化失败（原生模块加载不到、路径不可写、文件损坏等）时
 *   打印原因并回落到内存态 —— 宁可丢持久化，也不能让整个服务起不来。
 *
 * 挂 globalThis 的原因：Next.js dev 热更新会重建模块级变量，放在模块作用域会让
 * 每次热更新都丢掉全部会话；用 Promise 而不是实例做单例，是为了让并发的首次请求
 * 不会各自建一个 checkpointer（异步初始化有竞态）。
 */

export type CheckpointBackend = 'memory' | 'sqlite';

interface AgentGlobalScope {
  __eshopCheckpointerPromise?: Promise<BaseCheckpointSaver>;
  __eshopCheckpointBackend?: CheckpointBackend;
  __eshopDb?: Database;
}

const globalScope = globalThis as typeof globalThis & AgentGlobalScope;

/** 默认落盘位置（.cache/ 已在 .gitignore 中，不随仓库分发） */
const DEFAULT_DB_PATH = '.cache/checkpoints.sqlite';

function resolveBackend(): CheckpointBackend {
  return process.env.CHECKPOINT_BACKEND?.trim() === 'memory' ? 'memory' : 'sqlite';
}

function resolveDbPath(): string {
  const configured = process.env.CHECKPOINT_DB_PATH?.trim();
  return resolve(configured && configured.length > 0 ? configured : DEFAULT_DB_PATH);
}

/**
 * 建 SqliteSaver。
 *
 * 刻意用 `new Database(path)` 自己开连接，而不是 `SqliteSaver.fromConnString()`：
 * 只有拿到连接才能设置 WAL 与 busy_timeout。dev 热更新会残留旧连接，
 * 而 better-sqlite3 是同步 API，不设 busy_timeout 时并发写会偶发 SQLITE_BUSY。
 *
 * better-sqlite3 是原生模块，所以用动态 import：加载失败要能被捕获并回落，
 * 静态 import 会在模块求值阶段直接抛出，捕获不到。
 */
async function createCheckpointer(): Promise<BaseCheckpointSaver> {
  const backend = resolveBackend();
  globalScope.__eshopCheckpointBackend = backend;
  if (backend === 'memory') return new MemorySaver();

  try {
    const [{ default: DatabaseCtor }, { SqliteSaver }] = await Promise.all([
      import('better-sqlite3'),
      import('@langchain/langgraph-checkpoint-sqlite'),
    ]);

    const db = new DatabaseCtor(resolveDbPath());
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    globalScope.__eshopDb = db;
    return new SqliteSaver(db);
  } catch (error) {
    console.error(
      '[checkpointer] SqliteSaver 初始化失败，回落到内存态（会话将在进程重启后丢失）。' +
        '如需强制使用内存态可设 CHECKPOINT_BACKEND=memory。原因：',
      error,
    );
    globalScope.__eshopDb = undefined;
    globalScope.__eshopCheckpointBackend = 'memory';
    return new MemorySaver();
  }
}

export function getCheckpointer(): Promise<BaseCheckpointSaver> {
  if (!globalScope.__eshopCheckpointerPromise) {
    globalScope.__eshopCheckpointerPromise = createCheckpointer();
  }
  return globalScope.__eshopCheckpointerPromise;
}

/** 实际生效的后端（可能因初始化失败从 sqlite 回落为 memory） */
export function getCheckpointBackend(): CheckpointBackend {
  return globalScope.__eshopCheckpointBackend ?? resolveBackend();
}

/**
 * SQLite 连接（仅 sqlite 后端下存在）。
 * `session_meta` 表用它读写；内存态下返回 null，调用方应直接跳过会话管理。
 */
export function getSqliteDatabase(): Database | null {
  return globalScope.__eshopDb ?? null;
}

/** 会话隔离：同一个 thread_id 共享上下文，不同 thread_id 互不干扰 */
export function threadConfig(sessionId: string): RunnableConfig {
  return { configurable: { thread_id: sessionId } };
}
