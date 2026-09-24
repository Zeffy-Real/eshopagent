'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { CircleAlert, Loader2, ListTree } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { iconForEntry } from '@/components/visualization/log-icons';
import { useAgentStore } from '@/store/use-agent-store';
import { NODE_LABEL } from '@/lib/agent/events';
import { cn } from '@/lib/utils';

/** 推理时间线：Agent 每一步「思考 - 行动 - 观察」按顺序记录 */
export function TimelineSection() {
  const timeline = useAgentStore((s) => s.timeline);
  const activeNodes = useAgentStore((s) => s.activeNodes);
  const current = activeNodes[activeNodes.length - 1];

  if (timeline.length === 0 && !current) {
    return (
      <EmptyState
        compact
        icon={ListTree}
        title="等待 Agent 行动"
        description="每一步解析、检索、对比、加购都会按时间顺序记录在此。"
      />
    );
  }

  return (
    <ol className="space-y-0">
      <AnimatePresence initial={false}>
        {timeline.map((entry, index) => {
          const Icon = iconForEntry(entry);
          const isLast = index === timeline.length - 1 && !current;
          return (
            <motion.li
              key={entry.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="relative flex gap-2.5 pb-3 last:pb-0"
            >
              {!isLast && (
                <span
                  aria-hidden
                  className="absolute left-[11px] top-6 h-[calc(100%-1rem)] w-px bg-border"
                />
              )}
              <span
                className={cn(
                  'z-[1] flex size-[23px] shrink-0 items-center justify-center rounded-full border bg-surface',
                  entry.status === 'error'
                    ? 'border-danger/40 text-danger'
                    : 'border-border text-muted-foreground',
                )}
              >
                {entry.status === 'error' ? (
                  <CircleAlert className="size-3" />
                ) : (
                  <Icon className="size-3" />
                )}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-[12.5px] font-medium leading-5 text-foreground">
                    {entry.title}
                  </p>
                  {typeof entry.finishedAt === 'number' && (
                    <span className="shrink-0 pt-0.5 text-[10px] tabular-nums text-muted-foreground/80">
                      {Math.max(1, entry.finishedAt - entry.startedAt)}ms
                    </span>
                  )}
                </div>
                {entry.detail && (
                  <p className="mt-0.5 text-[11.5px] leading-5 text-muted-foreground">
                    {entry.detail}
                  </p>
                )}
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>

      {current && (
        <motion.li
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative flex gap-2.5"
        >
          <span className="z-[1] flex size-[23px] shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary-soft text-primary-ink">
            <Loader2 className="size-3 animate-spin" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-[12.5px] font-medium leading-5 text-primary-ink">
              {NODE_LABEL[current] ?? current}…
            </p>
          </div>
        </motion.li>
      )}
    </ol>
  );
}
