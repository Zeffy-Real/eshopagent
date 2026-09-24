'use client';

import { PanelRight, Search, ShoppingCart } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { selectCartCount, useCartStore } from '@/store/use-cart-store';
import { useAgentStore } from '@/store/use-agent-store';
import { useUiStore } from '@/store/use-ui-store';
import { cn } from '@/lib/utils';

export function AppHeader() {
  const [keyword, setKeyword] = useState('');
  const cartCount = useCartStore(selectCartCount);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const thinking = useAgentStore((s) => s.thinking);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = keyword.trim();
    if (!text || thinking) return;
    setKeyword('');
    setMobileTab('chat');
    void sendMessage(text);
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-3 md:px-4">
      <div className="flex items-center gap-2">
        <Logo size={26} />
        <div className="hidden leading-tight sm:block">
          <p className="text-[14px] font-semibold text-foreground">智能购物助手</p>
          <p className="text-[11px] text-muted-foreground">对话式电商 Agent</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="hidden min-w-0 flex-1 justify-center md:flex">
        <div className="relative w-full max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="描述需求，例如：500 元以内的透气跑鞋"
            aria-label="自然语言搜索"
            className={cn(
              'h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-16 text-sm text-foreground',
              'placeholder:text-muted-foreground/80 transition-colors duration-150',
              'hover:border-border-strong focus-visible:border-primary focus-visible:outline-none',
            )}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-[var(--radius-sm)] border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] text-muted-foreground lg:block">
            Enter
          </span>
        </div>
      </form>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleRightPanel}
          aria-pressed={rightPanelOpen}
          aria-label={rightPanelOpen ? '收起 Agent 面板' : '展开 Agent 面板'}
          className={cn(rightPanelOpen && 'bg-primary-soft text-primary-ink')}
        >
          <PanelRight />
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              aria-label="购物车"
              className="relative"
              onClick={() => {
                setRightPanelOpen(true);
                setMobileTab('products');
              }}
            >
              <ShoppingCart />
              {cartCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                  {cartCount > 99 ? '99+' : cartCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>购物车 {cartCount} 件商品</TooltipContent>
        </Tooltip>

        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface py-1 pl-1 pr-2.5">
          <Avatar size={26} className="bg-primary-soft text-primary-ink">
            泽
          </Avatar>
          <div className="hidden leading-tight lg:block">
            <p className="text-[12px] font-medium text-foreground">泽飞</p>
            <p className="text-[10px] text-muted-foreground">已登录</p>
          </div>
        </div>

        <ThemeToggle />
      </div>
    </header>
  );
}
