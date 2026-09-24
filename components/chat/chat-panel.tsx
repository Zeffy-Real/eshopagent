'use client';

import { AlertCircle, Bot, MessagesSquare, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { PanelHeader } from '@/components/common/panel-header';
import { ChatComposer, type ComposerPayload } from '@/components/chat/chat-composer';
import { MessageBubble } from '@/components/chat/message-bubble';
import { ThinkingIndicator } from '@/components/chat/thinking-indicator';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentStore } from '@/store/use-agent-store';

const EXAMPLES = [
  '500 元以内的透气跑鞋，适合夜跑',
  '帮我对比 2000 元左右的降噪耳机',
  '给新家买一套北欧风床品，预算 800',
  '把购物车里的第 2 件删掉',
];

export function ChatPanel() {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useAgentStore((s) => s.messages);
  const thinking = useAgentStore((s) => s.thinking);
  const activeNodes = useAgentStore((s) => s.activeNodes);
  const error = useAgentStore((s) => s.error);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const clearConversation = useAgentStore((s) => s.clearConversation);
  const dismissError = useAgentStore((s) => s.dismissError);

  // 新消息或流式输出时自动滚到底部
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, thinking]);

  const lastMessage = messages[messages.length - 1];
  const showThinking = thinking && !(lastMessage?.role === 'agent' && lastMessage.streaming);

  async function handleSubmit(payload: ComposerPayload) {
    await sendMessage(payload.text, { imageDataUrl: payload.imageDataUrl });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={Bot}
        title="购物助手"
        subtitle="搜索 · 对比 · 加购 · 下单"
        status={
          <span className="flex items-center gap-1 text-[11px] text-success">
            <span className="size-1.5 rounded-full bg-success" />
            在线
          </span>
        }
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="清空对话"
                disabled={messages.length === 0 && !thinking}
                onClick={clearConversation}
              >
                <RotateCcw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>清空对话（开启新会话）</TooltipContent>
          </Tooltip>
        }
      />

      <div ref={scrollRef} className="panel-scroll min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {messages.length === 0 && !thinking && (
            <>
              <EmptyState
                icon={MessagesSquare}
                title="还没有对话"
                description="用一句自然语言说出预算、品类和功能需求，Agent 会解析意图并在右栏实时展示推理过程。"
              />
              <div className="space-y-1.5">
                <p className="px-0.5 text-[11px] font-medium tracking-wide text-muted-foreground">
                  示例指令（点击填入）
                </p>
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setDraft(example)}
                    className="w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 text-left text-[13px] leading-5 text-foreground transition-colors duration-150 hover:border-primary/40 hover:bg-primary-soft"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </>
          )}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {showThinking && (
            <div className="flex items-start gap-2">
              <span className="mt-0.5 size-7 shrink-0" />
              <div className="rounded-[var(--radius-bubble)] border border-border bg-surface px-3 py-2">
                <ThinkingIndicator activeNodes={activeNodes} />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft px-3 py-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-danger" />
              <p className="min-w-0 flex-1 text-[12px] leading-5 text-danger">{error}</p>
              <button
                type="button"
                aria-label="关闭错误提示"
                onClick={dismissError}
                className="text-danger/80 transition-colors hover:text-danger"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSubmit={(payload) => void handleSubmit(payload)}
        disabled={thinking}
      />
    </div>
  );
}
