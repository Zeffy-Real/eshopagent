import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppHeader } from '@/components/layout/app-header';
import { StoreHydration } from '@/components/providers/store-hydration';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';

export const metadata: Metadata = {
  title: '智能购物助手 · 对话式电商 Agent',
  description:
    '以对话为核心交互的电商 Agent：自然语言搜索、商品对比、购物车管理与下单结算，Agent 的推理过程全程可视化。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f9fa' },
    { media: '(prefers-color-scheme: dark)', color: '#1e2125' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            <StoreHydration />
            <div className="flex h-dvh flex-col overflow-hidden">
              <AppHeader />
              <main className="min-h-0 flex-1">{children}</main>
            </div>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
