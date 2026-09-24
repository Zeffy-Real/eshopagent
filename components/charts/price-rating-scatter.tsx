'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart } from '@/components/charts/echart';
import type { Product } from '@/lib/types';
import { formatCount, hasRealSales } from '@/lib/utils';

/** 读取设计令牌里的颜色，保证图表与全局主题一致（含暗色模式） */
function useTokenColors(names: readonly string[]): string[] {
  const { resolvedTheme } = useTheme();
  const key = names.join('|');
  const [colors, setColors] = useState<string[]>(() => names.map(() => ''));

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setColors(names.map((name) => styles.getPropertyValue(name).trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, resolvedTheme]);

  return colors;
}

export interface PriceRatingScatterProps {
  products: Product[];
  /** 高亮的商品（例如推荐商品） */
  highlightIds?: string[];
  onSelect?: (productId: string) => void;
  height?: number;
}

/**
 * 价格 × 评分分布图。
 * 气泡大小映射销量、颜色区分是否被推荐，用来一眼看出「哪件在预算内性价比最好」。
 */
export function PriceRatingScatter({
  products,
  highlightIds = [],
  onSelect,
  height = 196,
}: PriceRatingScatterProps) {
  const [brand, brandSoft, border, muted, surface] = useTokenColors([
    '--brand',
    '--brand-soft',
    '--border',
    '--n600',
    '--surface',
  ]);

  const highlighted = useMemo(() => new Set(highlightIds), [highlightIds]);

  const option = useMemo<EChartsCoreOption>(() => {
    // 气泡大小的度量：优先用真实销量；整组都没有销量数据时退回真实评价数。
    // 不能直接拿 sales 当度量——没有销量来源的商品 sales 恒为 0，
    // 会让气泡全都缩到最小，还会在 tooltip 里显示「销量 0」。
    const hasSales = products.some((product) => hasRealSales(product.sales));
    const heatOf = (product: Product): number =>
      hasSales ? product.sales : product.reviews;
    const maxHeat = Math.max(1, ...products.map(heatOf));
    const prices = products.map((product) => product.price);
    const ratings = products.map((product) => product.rating);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    return {
      animationDuration: 320,
      grid: { left: 32, right: 14, top: 14, bottom: 24 },
      tooltip: {
        trigger: 'item',
        backgroundColor: surface,
        borderColor: border,
        textStyle: { color: muted, fontSize: 11 },
        formatter: (params: { data: { name: string; value: number[]; heatLabel: string } }) => {
          const [price, rating] = params.data.value;
          return `${params.data.name}<br/>价格 ¥${price} · 评分 ${rating} 分 · ${params.data.heatLabel}`;
        },
      },
      // 轴名不用 name 而直接写进刻度标签：面板只有 300px 宽，轴名会压住刻度数字
      xAxis: {
        type: 'value',
        min: Math.max(0, Math.floor(minPrice * 0.9)),
        max: Math.ceil(maxPrice * 1.05),
        splitNumber: 4,
        axisLabel: {
          fontSize: 10,
          color: muted,
          hideOverlap: true,
          formatter: (value: number) => `¥${value}`,
        },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, type: 'dashed' } },
      },
      yAxis: {
        type: 'value',
        min: Math.max(0, Math.floor(Math.min(...ratings) * 10) / 10 - 0.2),
        max: 5,
        splitNumber: 4,
        axisLabel: { fontSize: 10, color: muted, hideOverlap: true },
        axisLine: { lineStyle: { color: border } },
        splitLine: { lineStyle: { color: border, type: 'dashed' } },
      },
      series: [
        {
          type: 'scatter',
          data: products.map((product) => ({
            name: product.name,
            value: [product.price, product.rating, heatOf(product)],
            symbolSize: 10 + (heatOf(product) / maxHeat) * 22,
            // 展示口径随商品而定：有真实销量报销量，否则报真实评价数（避免「销量 0」）
            heatLabel: hasRealSales(product.sales)
              ? `销量 ${formatCount(product.sales)}`
              : `评价 ${formatCount(product.reviews)} 条`,
            itemStyle: {
              color: highlighted.has(product.id) ? brand : brandSoft,
              borderColor: brand,
              borderWidth: highlighted.has(product.id) ? 2 : 1,
              opacity: 0.92,
            },
          })),
          emphasis: { scale: 1.15 },
        },
      ],
    };
  }, [products, highlighted, brand, brandSoft, border, muted, surface]);

  if (products.length === 0) return null;

  return (
    <EChart
      option={option}
      height={height}
      onPointClick={(index) => {
        const product = products[index];
        if (product) onSelect?.(product.id);
      }}
    />
  );
}
