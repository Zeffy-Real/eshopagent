import type { BaseMessage } from '@langchain/core/messages';
import { messageText } from '@/lib/agent/utils';

/**
 * 会话内短期记忆：把最近若干轮对话裁成一段可注入 prompt 的历史。
 *
 * 为什么需要：在本次改造之前，全链路只有「最后一条用户消息」进入 LLM
 * （`parseIntent` / `refineSearch` / `manageCart` 都只用 `lastHumanText`），
 * 所以「刚才那个再便宜点」「换成第二件」这类**纯指代**完全无法解析。
 *
 * 两条硬约束：
 * 1. **按「轮次」裁剪，不截断单条消息**：截断一条助手回复会造出半句话，
 *    比不给历史更容易误导模型。装不下就整轮丢弃。
 * 2. **排除当前输入**：调用方会把最后一条用户消息作为「当前输入」单独传入，
 *    历史里必须排除它，否则同一句话会出现两次。
 *
 * 这里没有 tokenizer，用字符数近似（中文约 2 字符 ≈ 1 token），
 * 属于刻意选择的粗粒度预算控制 —— 引入 tokenizer 会多一个依赖，
 * 而这里的目标只是「别把上下文撑爆」。
 */

/** 默认字符预算（约 1000 token） */
export const DEFAULT_HISTORY_MAX_CHARS = 2000;

export interface HistoryTurn {
  role: '用户' | '助手';
  text: string;
}

export interface HistoryConfig {
  enabled: boolean;
  maxChars: number;
}

/** 从环境变量读取历史注入配置：`HISTORY_ENABLED=false` 可一键关闭 */
export function historyConfig(): HistoryConfig {
  const enabled = process.env.HISTORY_ENABLED !== 'false';
  const parsed = Number.parseInt(process.env.HISTORY_MAX_CHARS ?? '', 10);
  const maxChars =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HISTORY_MAX_CHARS;
  return { enabled, maxChars };
}

/** 把 LangChain 消息压成「角色 + 纯文本」，并丢掉空文本 */
function toTurns(messages: BaseMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const message of messages) {
    const type = message.getType();
    if (type !== 'human' && type !== 'ai') continue;
    const text = messageText(message).trim();
    if (!text) continue;
    turns.push({ role: type === 'human' ? '用户' : '助手', text });
  }
  return turns;
}

interface TurnGroup {
  user: string;
  assistant: string;
}

/**
 * 按「用户发言 + 其后的助手回复」成组。
 * 裁剪以组为单位，保证不会留下「只有助手回复、没有对应提问」的孤儿片段。
 */
function groupTurns(turns: HistoryTurn[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const turn of turns) {
    if (turn.role === '用户') {
      groups.push({ user: turn.text, assistant: '' });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && !last.assistant) last.assistant = turn.text;
    // 没有对应提问的助手消息（理论上不会出现）直接丢弃
  }
  return groups;
}

function renderGroup(group: TurnGroup): string {
  return [`用户：${group.user}`, group.assistant ? `助手：${group.assistant}` : '']
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成可注入 prompt 的历史文本（不含当前输入）。
 *
 * 返回空串表示「没有可用历史」，调用方应能接受这种情况。
 */
export function buildHistoryContext(messages: BaseMessage[], maxChars: number): string {
  if (maxChars <= 0) return '';

  const turns = toTurns(messages);
  // 当前输入 = 最后一条用户消息，由调用方单独传入，这里必须排除
  let lastHuman = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === '用户') {
      lastHuman = i;
      break;
    }
  }
  const prior = lastHuman >= 0 ? turns.slice(0, lastHuman) : turns;
  if (prior.length === 0) return '';

  const blocks = groupTurns(prior).map(renderGroup);

  // 从最新往前取，装不下就整轮停止：保留的必须是「最近连续若干轮」，
  // 而不是跳跃的碎片（跳跃的历史比没有历史更糟）
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (used + block.length > maxChars) break;
    kept.unshift(block);
    used += block.length;
  }

  return kept.join('\n\n');
}
