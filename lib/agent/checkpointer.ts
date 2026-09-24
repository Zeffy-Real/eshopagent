import { MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';

/**
 * Checkpointer 单例。
 *
 * Next.js 开发模式的热更新会重新执行模块，模块级变量会被重建，
 * 若把 MemorySaver 放在模块作用域，每次热更新都会丢掉全部会话上下文
 * （表现为「刚聊过的内容突然不记得了」）。因此挂到 globalThis 上，
 * 让它在模块重建后依然存活。
 *
 * 生产环境替换为 SqliteSaver / PostgresSaver 时只需改这个文件，
 * graph.ts 与所有节点代码零改动。
 */
interface AgentGlobalScope {
  __eshopCheckpointer?: MemorySaver;
}

const globalScope = globalThis as typeof globalThis & AgentGlobalScope;

export function getCheckpointer(): MemorySaver {
  if (!globalScope.__eshopCheckpointer) {
    globalScope.__eshopCheckpointer = new MemorySaver();
  }
  return globalScope.__eshopCheckpointer;
}

/** 会话隔离：同一个 thread_id 共享上下文，不同 thread_id 互不干扰 */
export function threadConfig(sessionId: string): RunnableConfig {
  return { configurable: { thread_id: sessionId } };
}
