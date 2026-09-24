import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { Database } from 'better-sqlite3';
import { getCheckpointer, getSqliteDatabase } from '@/lib/agent/checkpointer';

/**
 * 会话元信息与过期清理。
 *
 * checkpoint 表由 LangGraph 自己维护（`checkpoints` / `checkpoint_writes` / `checkpoint_blobs`），
 * 但它没有「哪些会话、各自多久没活跃」这个维度，所以额外维护一张 `session_meta`：
 * 它只负责判定「谁该被删」，真正的删除交给官方公共 API `saver.deleteThread()`，
 * 避免依赖 LangGraph 的内部表结构。
 *
 * 触发点选「新会话首次出现」而不是「每次请求按概率」：
 * 高频对话下按概率清理会让清理频率不可控；绑在「创建新会话」这个事件上语义更准、天然低频。
 * 再加一道最小间隔闸门，避免短时间内连续开新会话时反复全表扫描。
 */

/** 两次清理之间的最小间隔 */
const MIN_CLEANUP_INTERVAL_MS = 10 * 60_000;
const DEFAULT_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

interface SessionGlobalScope {
  __eshopLastCleanupAt?: number;
}

const globalScope = globalThis as typeof globalThis & SessionGlobalScope;

function resolveTtlDays(): number {
  const parsed = Number.parseInt(process.env.SESSION_TTL_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
}

function ensureTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_meta (
       session_id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL,
       last_active_at INTEGER NOT NULL
     )`,
  );
}

/** better-sqlite3 的查询结果是 unknown，这里做一次带守卫的窄化 */
function readSessionIds(rows: unknown[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('session_id' in row)) continue;
    const value = (row as Record<string, unknown>).session_id;
    if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

/** 具备 deleteThread 的 saver 才能删除单个会话（SqliteSaver 与 MemorySaver 都有） */
function canDeleteThread(
  saver: BaseCheckpointSaver,
): saver is BaseCheckpointSaver & { deleteThread(id: string): Promise<void> } {
  return typeof (saver as { deleteThread?: unknown }).deleteThread === 'function';
}

/**
 * 记录会话活跃时间。
 * 首次出现的 sessionId 视为「新会话」，此时才触发一次过期清理。
 */
export async function touchSession(sessionId: string): Promise<void> {
  // 必须先确保 checkpointer 已初始化：SQLite 连接是在初始化时建立的，
  // 若在此之前读 getSqliteDatabase() 会拿到 null，整个会话管理会被静默跳过
  // （表现为 checkpoints 正常落盘、但 session_meta 表压根不存在）。
  const saver = await getCheckpointer();
  const db = getSqliteDatabase();
  // 内存态下没有 session_meta，直接跳过会话管理
  if (!db) return;

  try {
    ensureTable(db);
    const now = Date.now();
    const existing = readSessionIds(
      db.prepare('SELECT session_id FROM session_meta WHERE session_id = ?').all(sessionId),
    );
    if (existing.length > 0) {
      db.prepare('UPDATE session_meta SET last_active_at = ? WHERE session_id = ?').run(
        now,
        sessionId,
      );
      return;
    }

    db.prepare(
      'INSERT INTO session_meta (session_id, created_at, last_active_at) VALUES (?, ?, ?)',
    ).run(sessionId, now, now);
    await cleanupExpiredSessions(saver, db, now);
  } catch (error) {
    // 会话管理失败不能影响正常对话：只记录，不向上抛
    console.error('[session-store] 更新会话活跃时间失败：', error);
  }
}

/** 清理超过 TTL 未活跃的会话；受最小间隔闸门限流 */
async function cleanupExpiredSessions(
  saver: BaseCheckpointSaver,
  db: Database,
  now: number,
): Promise<void> {
  const lastCleanupAt = globalScope.__eshopLastCleanupAt ?? 0;
  if (now - lastCleanupAt < MIN_CLEANUP_INTERVAL_MS) return;
  globalScope.__eshopLastCleanupAt = now;

  const ttlDays = resolveTtlDays();
  const cutoff = now - ttlDays * DAY_MS;
  const expired = readSessionIds(
    db.prepare('SELECT session_id FROM session_meta WHERE last_active_at < ?').all(cutoff),
  );
  if (expired.length === 0) return;

  for (const sessionId of expired) {
    if (canDeleteThread(saver)) await saver.deleteThread(sessionId);
    db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId);
  }
  console.log(`[session-store] 已清理 ${expired.length} 个超过 ${ttlDays} 天未活跃的会话`);
}

/** 会话总数（用于诊断与单测） */
export function countSessions(): number {
  const db = getSqliteDatabase();
  if (!db) return 0;
  ensureTable(db);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM session_meta').all();
  for (const row of rows) {
    if (row && typeof row === 'object' && 'n' in row) {
      const value = (row as Record<string, unknown>).n;
      if (typeof value === 'number') return value;
    }
  }
  return 0;
}

/** 仅供单测：把某会话的活跃时间改到过去，用来验证 TTL 清理 */
export function backdateSession(sessionId: string, lastActiveAt: number): void {
  const db = getSqliteDatabase();
  if (!db) return;
  ensureTable(db);
  db.prepare('UPDATE session_meta SET last_active_at = ? WHERE session_id = ?').run(
    lastActiveAt,
    sessionId,
  );
}

/** 仅供单测：重置清理闸门，让下一次 touchSession 能真正触发清理 */
export function resetCleanupGate(): void {
  globalScope.__eshopLastCleanupAt = 0;
}
