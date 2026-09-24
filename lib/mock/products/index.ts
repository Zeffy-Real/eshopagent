import type { Category, Product } from '@/lib/types';
import { APPAREL_PRODUCTS } from './apparel';
import { BEAUTY_PRODUCTS } from './beauty';
import { BOOK_PRODUCTS } from './books';
import { DIGITAL_PRODUCTS } from './digital';
import { FOOD_PRODUCTS } from './food';
import { HOME_PRODUCTS } from './home';
import { SPORTS_PRODUCTS } from './sports';

/** 全量 mock 商品目录（50 件，7 个品类） */
export const PRODUCTS: Product[] = [
  ...DIGITAL_PRODUCTS,
  ...APPAREL_PRODUCTS,
  ...FOOD_PRODUCTS,
  ...HOME_PRODUCTS,
  ...SPORTS_PRODUCTS,
  ...BEAUTY_PRODUCTS,
  ...BOOK_PRODUCTS,
];

const PRODUCT_INDEX = new Map(PRODUCTS.map((product) => [product.id, product]));

export function getProductById(id: string): Product | undefined {
  return PRODUCT_INDEX.get(id);
}

/** 按 id 列表取商品，忽略不存在的 id */
export function getProductsByIds(ids: string[]): Product[] {
  return ids
    .map((id) => PRODUCT_INDEX.get(id))
    .filter((product): product is Product => product !== undefined);
}

export function getProductsByCategory(category: Category): Product[] {
  return PRODUCTS.filter((product) => product.category === category);
}

/** 各品类商品数，用于首页分类入口展示 */
export const CATEGORY_COUNTS: Record<Category, number> = {
  数码: DIGITAL_PRODUCTS.length,
  服饰: APPAREL_PRODUCTS.length,
  食品: FOOD_PRODUCTS.length,
  家居: HOME_PRODUCTS.length,
  运动: SPORTS_PRODUCTS.length,
  美妆: BEAUTY_PRODUCTS.length,
  图书: BOOK_PRODUCTS.length,
};

/** 默认推荐：高评分 + 有货，按评分与销量加权排序 */
export function getFeaturedProducts(limit = 12): Product[] {
  return PRODUCTS.filter((product) => product.stock > 0)
    .slice()
    .sort(
      (a, b) =>
        b.rating * 20 + b.sales / 1000 - (a.rating * 20 + a.sales / 1000),
    )
    .slice(0, limit);
}
