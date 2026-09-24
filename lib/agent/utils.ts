import type { BaseMessage } from '@langchain/core/messages';
import type { ToolLogEntry, ToolLogKind, ToolLogStatus } from '@/lib/types';

/** 取出消息的纯文本（content 可能是字符串或多模态数组） */
export function messageText(message: BaseMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if ('text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

/** 最近一条用户消息的文本 */
export function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.getType() === 'human') return messageText(message);
  }
  return '';
}

export interface LogEntryInput {
  kind: ToolLogKind;
  /** 节点名或工具名 */
  name: string;
  title: string;
  detail?: string;
  status?: ToolLogStatus;
  /** 节点开始时刻（毫秒时间戳）；不传则与 finishedAt 相同 */
  startedAt?: number;
  /** 已完成时刻；不传则取当前时间 */
  finishedAt?: number;
}

/** 构造推理时间线条目（右栏可视化面板数据源） */
export function createLogEntry(input: LogEntryInput): ToolLogEntry {
  const now = Date.now();
  const startedAt = input.startedAt ?? now;
  const finishedAt = input.finishedAt ?? now;
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    name: input.name,
    title: input.title,
    detail: input.detail,
    status: input.status ?? 'done',
    startedAt,
    finishedAt: Math.max(startedAt, finishedAt),
  };
}

/** 节点执行完成后的时间线条目（传入节点开始时刻即可得到真实耗时） */
export function nodeLog(
  name: string,
  title: string,
  detail?: string,
  startedAt?: number,
): ToolLogEntry {
  return createLogEntry({ kind: 'node', name, title, detail, status: 'done', startedAt });
}
