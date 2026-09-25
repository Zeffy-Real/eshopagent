import { describe, expect, it } from 'vitest';
import {
  describeWithoutSourceDescription,
  inheritLocalizedFields,
  isAplusCss,
  isLocalizedProduct,
  isProductLike,
} from '@/scripts/catalog-shared.mjs';

/**
 * 跨产物继承（`catalog:build` 重建时保住上一轮的本地化文案）。
 *
 * 这是「build → localize 完整流程不需要手工补救」的唯一保证点，判据必须严：
 *   1. **id 相同 + 英文原文逐字一致**——只按 id 继承，会在数据源更新后把旧中文文案
 *      安到别的商品上（同一个 id 换了商品或标题）；
 *   2. 只允许覆盖本地化字段——价格 / 评分 / 评论数 / 销量 / 库存这类**真实字段必须
 *      以新构建结果为准**（用旧值覆盖新值 = 拿陈旧快照冒充新快照）；
 *   3. 描述基准变化（源描述从 A+ CSS 降级为派生文案）时不继承——旧中文描述代表的是旧依据。
 *
 * 反例都在这里锁死：不继承必须落到「新构建的英文条目」上，而不是保留半截旧值。
 */

interface RawProduct {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** 新构建出来的英文条目（源数据归一化的结果） */
function fresh(overrides: Partial<RawProduct> = {}): RawProduct {
  return {
    id: 'amz-B000TEST01',
    name: 'Wireless Noise Cancelling Headphones for Running',
    description: 'A long English description from the source dataset that is well over sixty characters.',
    tags: [],
    specifications: { 类目: 'Electronics' },
    price: 129,
    originalPrice: 159,
    rating: 4.5,
    reviews: 1200,
    sales: 300,
    stock: 88,
    image: 'https://example.com/a.jpg',
    category: '数码',
    platform: 'Amazon',
    sourceId: 'B000TEST01',
    ...overrides,
  };
}

/** 上一版产物里已本地化的同一条目 */
function localized(overrides: Partial<RawProduct> = {}): RawProduct {
  return {
    ...fresh(),
    nameOriginal: 'Wireless Noise Cancelling Headphones for Running',
    name: '无线降噪跑步耳机',
    description: '源数据英文描述的中文译文。',
    tags: ['降噪', '无线'],
    specifications: { 类目: '电子产品' },
    ...overrides,
  };
}

describe('inheritLocalizedFields：跨产物继承', () => {
  it('英文原文一致 → 继承全部本地化字段，且合并结果仍被判为「已本地化」', () => {
    const { products, inherited, pending } = inheritLocalizedFields([fresh()], [localized()]);

    expect(inherited).toBe(1);
    expect(pending).toBe(0);
    const merged = products[0]!;
    expect(merged.name).toBe('无线降噪跑步耳机');
    expect(merged.description).toBe('源数据英文描述的中文译文。');
    expect(merged.tags).toEqual(['降噪', '无线']);
    expect(merged.specifications).toEqual({ 类目: '电子产品' });
    expect(merged.nameOriginal).toBe('Wireless Noise Cancelling Headphones for Running');
    // 判据若为 false，localize 会把刚继承的条目再翻一遍——等于继承白做
    expect(isLocalizedProduct(merged)).toBe(true);
  });

  it('英文原文不一致（上游改了标题）→ 不继承，完整保留新构建的英文条目', () => {
    const old = localized({ nameOriginal: 'A Completely Different Upstream Title' });
    const { products, inherited, pending } = inheritLocalizedFields([fresh()], [old]);

    expect(inherited).toBe(0);
    expect(pending).toBe(1);
    const merged = products[0]!;
    expect(merged.name).toBe('Wireless Noise Cancelling Headphones for Running');
    expect(merged.description).not.toBe(old.description);
    expect(merged.tags).toEqual([]);
    expect(merged.nameOriginal).toBeUndefined();
  });

  it('旧产物里没有该 id → 不继承（同批已有条目照常继承）', () => {
    const { products, inherited, pending } = inheritLocalizedFields(
      [fresh(), fresh({ id: 'amz-B000TEST02', name: 'Another Product Title From Source' })],
      [localized()],
    );

    expect(inherited).toBe(1);
    expect(pending).toBe(1);
    expect(products[0]!.name).toBe('无线降噪跑步耳机');
    expect(products[1]!.name).toBe('Another Product Title From Source');
    expect(products[1]!.nameOriginal).toBeUndefined();
  });

  it('首次构建（无上一版产物）→ 全部不继承', () => {
    const freshProducts = [fresh(), fresh({ id: 'amz-B000TEST02' })];
    const { products, inherited, pending } = inheritLocalizedFields(freshProducts, []);

    expect(inherited).toBe(0);
    expect(pending).toBe(2);
    expect(products).toEqual(freshProducts);
  });

  it('继承不碰非本地化字段：价格/原价/评分/评论数/销量/库存/图片/平台/来源 id 一律以新构建为准', () => {
    // 旧值刻意与新值全部不同：若实现里有任何一条覆盖，断言就会挂
    const old = localized({
      price: 9,
      originalPrice: 9,
      rating: 1.2,
      reviews: 7,
      sales: 99999,
      stock: 3,
      image: 'https://example.com/stale.jpg',
      platform: 'Walmart',
      sourceId: 'STALE',
      category: '服饰',
    });
    const built = fresh();
    const { products, inherited } = inheritLocalizedFields([built], [old]);

    const merged = products[0]!;
    for (const field of [
      'price',
      'originalPrice',
      'rating',
      'reviews',
      'sales',
      'stock',
      'image',
      'platform',
      'sourceId',
      'category',
    ]) {
      expect(merged[field], `${field} 被旧产物的值覆盖了`).toEqual(built[field]);
    }
    // 键不能凭空增删：新建结果里没有的键只允许出现 `nameOriginal`
    // （localize 写的英文原文标记，正是「已本地化」的判据）
    expect(Object.keys(merged).filter((key) => !(key in built))).toEqual(['nameOriginal']);
    expect(Object.keys(built).filter((key) => !(key in merged))).toEqual([]);
    // 同时确认这条确实走了继承，否则上面的断言可能因为「整条没继承」而假通过
    expect(inherited).toBe(1);
    expect(merged.name).toBe('无线降噪跑步耳机');
  });

  it('描述基准变化（A+ CSS 降级为派生文案）→ 整条不继承；基准一致时照常继承', () => {
    const rebuilt = fresh({ descriptionDerived: true });
    const changed = inheritLocalizedFields([rebuilt], [localized()]);
    expect(changed.inherited).toBe(0);
    expect(changed.products[0]!.name).toBe(rebuilt.name);
    expect(changed.products[0]!.descriptionDerived).toBe(true);

    const stable = inheritLocalizedFields(
      [fresh({ descriptionDerived: true })],
      [localized({ descriptionDerived: true })],
    );
    expect(stable.inherited).toBe(1);
    expect(stable.products[0]!.name).toBe('无线降噪跑步耳机');
  });

  it('译名与英文原文逐字相同（书名 / 品牌+型号）→ 仍视为已本地化并继承，不会每次重建都重译', () => {
    // 实测 420 件里有 40 件属于这种（37 图书 + 2 Lazada + 1 Amazon）：LLM 按提示词
    // 「保留品牌名与型号」输出与原文一致的译名。旧判据（nameOriginal ≠ name）把它们
    // 当成未本地化，于是每次重建都会重译这 40 件——漂移 + 白花 token
    const built = fresh({ id: 'bk-0593105419', name: 'Where the Crawdads Sing' });
    const old = localized({
      id: 'bk-0593105419',
      name: 'Where the Crawdads Sing',
      nameOriginal: 'Where the Crawdads Sing',
    });
    const { products, inherited, pending } = inheritLocalizedFields([built], [old]);

    expect(inherited).toBe(1);
    expect(pending).toBe(0);
    expect(products[0]!.name).toBe('Where the Crawdads Sing');
    expect(products[0]!.nameOriginal).toBe('Where the Crawdads Sing');
    expect(isLocalizedProduct(products[0])).toBe(true);
    // 继承的仍是中文文案
    expect(products[0]!.description).toBe(old.description);
    expect(products[0]!.tags).toEqual(['降噪', '无线']);
  });

  it('旧产物缺 nameOriginal 标记 → 不继承（localize 从未处理过，必须留在待翻译里）', () => {
    const { products, inherited, pending } = inheritLocalizedFields([fresh()], [fresh()]);

    expect(inherited).toBe(0);
    expect(pending).toBe(1);
    expect(products[0]!.nameOriginal).toBeUndefined();
    expect(isLocalizedProduct(products[0])).toBe(false);
  });
});

describe('A+ CSS 描述降级：isAplusCss / describeWithoutSourceDescription', () => {
  /** 实测形态：源描述是整页样式代码（B0009IY8U6 的真实开头） */
  const APLUS_CSS =
    'From the brand /* * Used when device = desktop * Configured in: configuration/brand-story.cfg */ .aplus-v2 { display:block; margin-left:auto; }';

  it('命中 A+ CSS 特征（aplus-v2 / brand-story.cfg / display:block）→ 判为派生，文案由真实字段拼装', () => {
    expect(isAplusCss(APLUS_CSS)).toBe(true);

    const description = describeWithoutSourceDescription({
      brand: 'Minnetonka',
      category: '服饰',
      specifications: { 类目: '踝靴与短靴', 尺寸: '14.9 x 12.4 x 5 英寸；5.6 盎司', 型号: 'Back Zipper' },
      rating: 4.4,
      reviews: 1180,
    });

    expect(description).toBe(
      '品牌 Minnetonka；类目：踝靴与短靴；商品参数：尺寸 14.9 x 12.4 x 5 英寸；5.6 盎司、型号 Back Zipper；评分 4.4 分（1180 条评价）。',
    );
    // 派生文案里不能残留任何 CSS / A+ 结构痕迹
    expect(description).not.toMatch(/aplus|display:|\.cfg|[{}]/);
  });

  it('正常描述 → 不误判（含只在开头出现 From the brand / From the Manufacturer 的情形）', () => {
    expect(
      isAplusCss(
        'From the Manufacturer Product Description General-use binder features a clear overlay on front, spine and back.',
      ),
    ).toBe(false);
    expect(isAplusCss('From the brand: our story started in 1946 in a small Minnesota workshop.')).toBe(false);
    expect(isAplusCss('')).toBe(false);
  });

  it('派生结果能过 isProductLike，且长度落在目录不变量扫描的合法区间（10 - 200 字）', () => {
    const description = describeWithoutSourceDescription({
      brand: 'Minnetonka',
      category: '服饰',
      specifications: { 类目: '踝靴与短靴', 尺寸: '14.9 x 12.4 x 5 英寸；5.6 盎司', 型号: 'Back Zipper' },
      rating: 4.4,
      reviews: 1180,
    });

    expect(
      isProductLike({
        id: 'amz-B0009IY8U6',
        name: 'Minnetonka 女式后拉链短靴',
        brand: 'Minnetonka',
        image: 'https://example.com/boots.jpg',
        description,
        price: 399,
        rating: 4.4,
        category: '服饰',
      }),
    ).toBe(true);
    expect(description.trim().length).toBeGreaterThanOrEqual(10);
    expect(description.length).toBeLessThanOrEqual(200);

    // 退化情形（无品牌、规格只有类目一项）也必须长度合格——否则扫描会报「描述非法」
    const degenerate = describeWithoutSourceDescription({
      brand: '',
      category: '数码',
      specifications: { 类目: '数码' },
      rating: 4.1,
      reviews: 0,
    });
    expect(degenerate.trim().length).toBeGreaterThanOrEqual(10);
  });
});