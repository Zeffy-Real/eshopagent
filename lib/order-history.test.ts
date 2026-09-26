import { describe, expect, it } from 'vitest';
import { MAX_ORDER_HISTORY, appendConfirmedOrder } from '@/lib/order-history';
import { makeOrder } from '@/lib/test-utils/factories';

/**
 * 订单历史只记「真实确认过」的订单：写入源是 SSE 快照里的 `pendingOrder`
 * （`confirmOrder` 节点的真实结果），因此这里锁的是**合并语义**而不是数据来源 ——
 * 幂等（同一单被推多次只有一条）、只收 confirmed、超限截断。
 */
describe('appendConfirmedOrder：订单历史的合并规则', () => {
  it('confirmed 订单入历史，最新在前', () => {
    const first = makeOrder({ id: 'ES-1', status: 'confirmed' });
    const second = makeOrder({ id: 'ES-2', status: 'confirmed' });

    const history = appendConfirmedOrder(appendConfirmedOrder([], first), second);

    expect(history.map((order) => order.id)).toEqual(['ES-2', 'ES-1']);
  });

  it('同一单重复写入只有一条（同 id upsert，不会每轮快照都新增）', () => {
    const order = makeOrder({ id: 'ES-1', status: 'confirmed' });
    let history = appendConfirmedOrder([], order);

    for (let index = 0; index < 5; index += 1) {
      history = appendConfirmedOrder(history, { ...order });
    }

    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe('ES-1');
  });

  it('同一单内容没变 → 返回原数组（recordOrder 据此跳过 setState）', () => {
    const order = makeOrder({ id: 'ES-1', status: 'confirmed' });
    const history = appendConfirmedOrder([], order);

    expect(appendConfirmedOrder(history, { ...order })).toBe(history);
  });

  it('pending / cancelled 不是下单记录 → 拒绝写入', () => {
    const pending = makeOrder({ id: 'ES-P', status: 'pending' });
    const cancelled = makeOrder({ id: 'ES-C', status: 'cancelled' });

    expect(appendConfirmedOrder([], pending)).toEqual([]);
    expect(appendConfirmedOrder([], cancelled)).toEqual([]);
    expect(appendConfirmedOrder(appendConfirmedOrder([], pending), cancelled)).toEqual([]);
  });

  it('超过上限时从尾部截断（保留最新的 MAX_ORDER_HISTORY 条）', () => {
    let history: ReturnType<typeof appendConfirmedOrder> = [];
    for (let index = 0; index < MAX_ORDER_HISTORY + 5; index += 1) {
      history = appendConfirmedOrder(
        history,
        makeOrder({ id: `ES-${index}`, status: 'confirmed' }),
      );
    }

    expect(history).toHaveLength(MAX_ORDER_HISTORY);
    expect(history[0]?.id).toBe(`ES-${MAX_ORDER_HISTORY + 4}`);
    expect(history.at(-1)?.id).toBe('ES-5');
    expect(MAX_ORDER_HISTORY).toBe(20);
  });

  it('同 id 内容变化（例如金额被修正）→ 覆盖那一条并保持最新在前', () => {
    const first = makeOrder({ id: 'ES-1', status: 'confirmed', total: 100 });
    const other = makeOrder({ id: 'ES-2', status: 'confirmed', total: 200 });
    const updated = makeOrder({ id: 'ES-1', status: 'confirmed', total: 120 });

    const history = appendConfirmedOrder(
      appendConfirmedOrder(appendConfirmedOrder([], first), other),
      updated,
    );

    expect(history.map((order) => order.id)).toEqual(['ES-1', 'ES-2']);
    expect(history[0]?.total).toBe(120);
  });
});