/**
 * `scripts/sources/justoneapi.mjs` 的类型声明（纯 node 脚本用实现，TS 单测靠它拿类型）。
 */

import type { Product } from '@/lib/types';

export const OUTPUT_PATH: string;

export const CATEGORY_KEYWORDS: Record<string, string[]>;

export interface JdSearchItemFixture {
  id?: string;
  title?: string;
  price?: string;
  imageUrl?: string;
  cid1?: string;
  cid2?: string;
  cid3?: string;
}

export interface NormalizeOutcome {
  product?: Product;
  skip?: string;
  brandFallback?: boolean;
  stockDerived?: boolean;
}

export function normalizeJdProduct(input: {
  search?: JdSearchItemFixture | null;
  detail?: unknown;
}): NormalizeOutcome;

export function writeJsonAtomically(outPath: string, payload: unknown): Promise<void>;

export interface SourceStats {
  quota: number;
  searches: { total: number; failed: number };
  detailCalls: { total: number; failed: number };
  candidates: number;
  detailUsed: number;
  brandFallback: number;
  stockDerived: number;
  dropped: Map<string, number>;
  byCategory: Map<string, { candidates: number; kept: number }>;
}

export interface BuildSourceOptions {
  keywords?: Record<string, string[]>;
  perCategory?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: (line: string) => void;
}

export function buildJustoneapiCatalog(
  options?: BuildSourceOptions,
): Promise<{ products: Product[]; stats: SourceStats }>;

export function buildPayload(
  products: Product[],
  stats: SourceStats,
): Record<string, unknown>;

export function runJustoneapiSource(
  options?: BuildSourceOptions & { outPath?: string },
): Promise<{ outPath: string; count: number; quota: number; stats: SourceStats }>;