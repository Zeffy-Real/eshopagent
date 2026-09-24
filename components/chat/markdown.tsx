'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/** 把 ¥ 金额包成行内标记，配合下方 code 样式实现「价格高亮」 */
const PRICE_PATTERN = /¥\s?(\d[\d,]*(?:\.\d+)?)/g;

function highlightPrices(content: string): string {
  return content.replace(PRICE_PATTERN, (_match, amount: string) => `\`¥${amount}\``);
}

export interface MarkdownProps {
  content: string;
  className?: string;
}

/** Agent 消息的 Markdown 渲染：只开放必要元素，避免注入 */
export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div className={cn('text-[13px] leading-6 text-foreground/95', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node: _node, ...props }) => <p className="mb-1.5 last:mb-0" {...props} />,
          strong: ({ node: _node, ...props }) => (
            <strong className="font-semibold text-foreground" {...props} />
          ),
          ol: ({ node: _node, ...props }) => (
            <ol className="mb-1.5 ml-4 list-decimal space-y-1 last:mb-0" {...props} />
          ),
          ul: ({ node: _node, ...props }) => (
            <ul className="mb-1.5 ml-4 list-disc space-y-1 last:mb-0" {...props} />
          ),
          li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
          h1: ({ node: _node, ...props }) => (
            <h1 className="mb-1 text-[14px] font-semibold text-foreground" {...props} />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 className="mb-1 text-[13.5px] font-semibold text-foreground" {...props} />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 className="mb-1 text-[13px] font-semibold text-foreground" {...props} />
          ),
          code: ({ node: _node, ...props }) => (
            <code
              className="rounded-[4px] bg-primary-soft px-1 py-0.5 text-[12.5px] font-semibold text-primary-ink"
              {...props}
            />
          ),
          pre: ({ node: _node, ...props }) => (
            <pre
              className="mb-1.5 overflow-x-auto rounded-[var(--radius-sm)] border border-border bg-surface-muted p-2 text-[12px]"
              {...props}
            />
          ),
          a: ({ node: _node, ...props }) => (
            <a
              className="text-primary-ink underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              className="mb-1.5 border-l-2 border-border-strong pl-2 text-muted-foreground"
              {...props}
            />
          ),
          table: ({ node: _node, ...props }) => (
            <div className="mb-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]" {...props} />
            </div>
          ),
          th: ({ node: _node, ...props }) => (
            <th
              className="border border-border bg-surface-muted px-2 py-1 text-left font-medium"
              {...props}
            />
          ),
          td: ({ node: _node, ...props }) => (
            <td className="border border-border px-2 py-1" {...props} />
          ),
        }}
      >
        {highlightPrices(content)}
      </ReactMarkdown>
    </div>
  );
}
