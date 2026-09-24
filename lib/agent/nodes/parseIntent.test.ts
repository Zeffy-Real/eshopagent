import { describe, expect, it } from 'vitest';
import { resolveOrdinalTarget } from '@/lib/agent/nodes/parseIntent';
import { makeProduct } from '@/lib/test-utils/factories';

/**
 * 序数指代的落点：把「第 N 件」映射到上一轮结果里的具体商品。
 * 越界时必须返回 null（按普通细化处理），而不是抛错或取到错误的商品。
 */

const results = [
  makeProduct({ id: 'a', name: '第一件' }),
  makeProduct({ id: 'b', name: '第二件' }),
  makeProduct({ id: 'c', name: '第三件' }),
];

describe('resolveOrdinalTarget', () => {
  it('按 1 起始的序号取对应商品', () => {
    expect(resolveOrdinalTarget(results, 1)?.id).toBe('a');
    expect(resolveOrdinalTarget(results, 2)?.id).toBe('b');
    expect(resolveOrdinalTarget(results, 3)?.id).toBe('c');
  });

  it('没有序号时返回 null（不是序数指代）', () => {
    expect(resolveOrdinalTarget(results, null)).toBeNull();
  });

  it('越界时返回 null，不会取到相邻商品', () => {
    expect(resolveOrdinalTarget(results, 4)).toBeNull();
    expect(resolveOrdinalTarget(results, 0)).toBeNull();
    expect(resolveOrdinalTarget(results, -1)).toBeNull();
  });

  it('上一轮结果为空时返回 null', () => {
    expect(resolveOrdinalTarget([], 1)).toBeNull();
  });
});
