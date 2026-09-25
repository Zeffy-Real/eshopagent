/**
 * `scripts/catalog-shared.mjs` 的类型声明（纯 node 脚本用实现，TS 侧（单测）靠这份声明）。
 * 与 `lib/catalog/products.ts` 的校验语义必须一致，由 jdSource.test.ts 的等价性用例盯着。
 */

import type { Category } from '@/lib/types';

export const CATEGORIES: readonly Category[];
export const CURRENCY_TO_CNY: Record<string, number>;
export const PRICE_CNY_MIN: number;
export const PRICE_CNY_MAX: number;

export function perCategoryFromArgv(argv: string[], fallback?: number): number;
export function stripInvisible(text: string): string;
export function clean(value: unknown): string;
export function toNumber(value: unknown): number | null;
export function truncate(text: string, max: number): string;
export function stableHash(seed: string): number;
export function deriveStock(id: string): number;
export function isProductLike(value: unknown): boolean;

export function isAplusCss(text: unknown): boolean;
export function buildDerivedDescription(parts: readonly unknown[]): string;
export function describeWithoutSourceDescription(input: {
  brand?: unknown;
  category?: unknown;
  specifications?: Record<string, unknown> | null;
  rating?: unknown;
  reviews?: unknown;
}): string;

export const LOCALIZED_FIELDS: readonly string[];
export function isLocalizedProduct(product: unknown): boolean;
export function inheritLocalizedFields<T extends { id: string; name: string }>(
  freshProducts: T[],
  previousProducts: readonly unknown[],
): { products: T[]; inherited: number; pending: number };