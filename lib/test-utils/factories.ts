import type { BaseMessage } from '@langchain/core/messages';
import type { AgentStateValue } from '@/lib/agent/state';
import type { CartItem, ComparisonResult, Product } from '@/lib/types';

/**
 * 单测共享的构造工厂。
 *
 * 放在 lib/test-utils/ 而不是某个测试文件里，是为了让多个测试文件共用同一份默认值；
 * vitest 的 include 只匹配测试文件后缀，因此这个文件不会被当成测试文件执行。
 */

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-test-1',
    name: '测试商品名称',
    brand: '测试品牌',
    category: '数码',
    price: 100,
    originalPrice: 150,
    rating: 4.5,
    reviews: 1000,
    sales: 0,
    stock: 50,
    image: 'https://example.com/test.jpg',
    description: '用于单测的商品描述。',
    specifications: {},
    tags: [],
    ...overrides,
  };
}

export function makeCartItem(product: Product, quantity = 1): CartItem {
  return { product, quantity };
}

/** 构造一个字段完整的 AgentStateValue（只覆盖测试关心的字段） */
export function makeState(overrides: Partial<AgentStateValue> = {}): AgentStateValue {
  const messages: BaseMessage[] = [];
  return {
    messages,
    intent: 'search',
    searchFilters: {},
    searchResults: [],
    liveOverrides: {},
    liveFetchedAt: null,
    compareTargets: [],
    comparison: null,
    cart: [],
    toolCallLog: [],
    pendingOrder: null,
    focusProductId: null,
    profilePatch: [],
    profileGeneration: 0,
    profileHint: '',
    needsRefine: false,
    refineCount: 0,
    ...overrides,
  };
}

export function makeComparison(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    products: [],
    rows: [],
    highlights: {
      lowestPriceId: '',
      highestRatingId: '',
      highestSalesId: '',
      mostStockId: '',
      bestValueId: '',
    },
    valueScores: {},
    ...overrides,
  };
}
