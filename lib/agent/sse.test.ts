import { describe, expect, it } from 'vitest';
import { REPLY_INLINE_LIMIT, selectReplyProductIds, toSnapshot } from '@/lib/agent/sse';
import { makeProduct, makeState } from '@/lib/test-utils/factories';

/**
 * 「本轮回复挂哪几张内联卡」的唯一实现与它的载荷落点。
 *
 * 背景：这条规则原先只写在 store 的模板路径里（`searchResults.slice(0, 3)`），
 * LLM 流式路径的气泡由首个 token 建好、收尾时没人补这个字段 —— 于是 LLM 路径下
 * 根本没有内联卡。现在规则收敛到 `selectReplyProductIds`，两条路径都读快照里的
 * `replyProductIds`，因此这里锁三件事：
 *   1. 取值与历史行为一致（前 3 件）；
 *   2. 空 / 不足时不出错（不足取全部、空则空数组）；
 *   3. `toSnapshot` 下发的就是该函数的输出（前端不需要也不允许再算一遍）。
 */

const products = [
  makeProduct({ id: 'p-1', name: '第一件' }),
  makeProduct({ id: 'p-2', name: '第二件' }),
  makeProduct({ id: 'p-3', name: '第三件' }),
  makeProduct({ id: 'p-4', name: '第四件' }),
];

describe('selectReplyProductIds：本轮该展示哪几件', () => {
  it('有商品 → 取前 3 件的 id，顺序与检索结果一致', () => {
    expect(selectReplyProductIds(products)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(REPLY_INLINE_LIMIT).toBe(3);
  });

  it('不足 3 件 → 全部取（不补齐、不报错）', () => {
    expect(selectReplyProductIds(products.slice(0, 2))).toEqual(['p-1', 'p-2']);
    expect(selectReplyProductIds([])).toEqual([]);
  });

  it('本轮没有商品（闲聊 / 加购下单 / 对比轮）→ 空数组，气泡不挂卡片', () => {
    expect(selectReplyProductIds([])).toHaveLength(0);
  });
});

describe('toSnapshot：把内联卡商品随快照下发', () => {
  it('replyProductIds 就是 selectReplyProductIds(searchResults)（唯一实现，前端不再算）', () => {
    const state = makeState({ searchResults: products, intent: 'search' });
    const snapshot = toSnapshot(state, Date.now(), 0);

    expect(snapshot.searchResults).toHaveLength(4);
    expect(snapshot.replyProductIds).toEqual(selectReplyProductIds(products));
    expect(snapshot.replyProductIds).toEqual(['p-1', 'p-2', 'p-3']);
  });

  it('本轮无检索结果 → 空数组（闲聊轮不带卡片）', () => {
    const snapshot = toSnapshot(makeState({ searchResults: [] }), Date.now(), 0);
    expect(snapshot.replyProductIds).toEqual([]);
  });
});