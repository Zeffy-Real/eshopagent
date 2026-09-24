'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { cn } from '@/lib/utils';

// 按需注册，避免把整个 echarts 打进客户端包
echarts.use([ScatterChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface EChartProps {
  option: echarts.EChartsCoreOption;
  height?: number;
  className?: string;
  /** 点击数据点回调（用于「点图表 → 打开商品详情」） */
  onPointClick?: (dataIndex: number) => void;
}

export function EChart({ option, height = 180, className, onPointClick }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = echarts.init(container, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.on('click', (params) => {
      if (typeof params.dataIndex === 'number') clickRef.current?.(params.dataIndex);
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className={cn('w-full', className)}
      role="img"
      aria-label="价格与评分分布图"
    />
  );
}
