import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { checkGrounding, type GroundingResult } from '@/lib/agent/grounding';
import { createChatModel, isLlmEnabled } from '@/lib/agent/llm';
import { REPLY_SYSTEM_PROMPT, buildReplyContext } from '@/lib/agent/prompts';
import { describeFilters } from '@/lib/agent/ruleParser';
import type { AgentStateUpdate, AgentStateValue } from '@/lib/agent/state';
import { summarizeCart } from '@/lib/cart-pricing';
import { messageText, nodeLog } from '@/lib/agent/utils';
import { buildCompareConclusion } from '@/lib/decision';
import { STOCK_LABEL, stockLevelOf } from '@/lib/types';
import { discountLabel, formatCount, formatPrice, hasRealSales } from '@/lib/utils';

/** 无 LLM 时的模板回复：数据全部来自状态，不做任何编造 */
function buildTemplateReply(state: AgentStateValue): string {
  switch (state.intent) {
    case 'search':
    case 'refine': {
      const items = state.searchResults;
      const condition = describeFilters(state.searchFilters);
      if (items.length === 0) {
        return [
          `没有找到符合「${condition}」的商品。`,
          '',
          '可以试试：放宽预算、换一个品类，或者去掉某个功能要求。',
        ].join('\n');
      }
      const lines = items.slice(0, 3).map((product, index) => {
        const off = discountLabel(product.price, product.originalPrice);
        const stock = STOCK_LABEL[stockLevelOf(product.stock)];
        // 没有真实销量来源的商品只报评价数，不能报「销量 0」
        const heat = hasRealSales(product.sales)
          ? `销量 ${formatCount(product.sales)}`
          : `评价 ${formatCount(product.reviews)} 条`;
        return `${index + 1}. **${product.name}** — ${formatPrice(product.price)}（原价 ${formatPrice(
          product.originalPrice,
        )}${off ? `，${off}` : ''}）· ${product.rating} 分 · ${heat} · ${stock}`;
      });
      return [
        `为你找到 **${items.length}** 件符合条件的商品（${condition}）：`,
        '',
        ...lines,
        '',
        `还有 ${Math.max(0, items.length - 3)} 件在中间商品区。要我对比前 3 件，还是把最合适的加入购物车？`,
      ].join('\n');
    }

    case 'compare': {
      const comparison = state.comparison;
      if (!comparison || comparison.products.length < 2) {
        return '还没有选中要对比的商品。你可以先搜索，然后告诉我「对比前 3 件」，我会把价格、评分和核心参数的差异列出来。';
      }
      const diffKeys = comparison.rows.filter((row) => row.diff).map((row) => row.key);
      return [
        `已对比 **${comparison.products.length}** 件商品，共 ${comparison.rows.length} 项参数，其中 ${
          diffKeys.length
        } 项存在差异${diffKeys.length > 0 ? `（${diffKeys.slice(0, 4).join('、')}）` : ''}。`,
        '',
        buildCompareConclusion(comparison),
        '',
        '完整的参数差异与各维度最优已整理在右侧对比面板。',
      ].join('\n');
    }

    case 'cart': {
      if (state.cart.length === 0) {
        return '购物车现在是空的。可以先搜索商品，再说「把第一件加入购物车」。';
      }
      const summary = summarizeCart(state.cart);
      const lines = summary.items.map(
        (item, index) =>
          `${index + 1}. **${item.product.name}** × ${item.quantity} — ${formatPrice(
            item.product.price * item.quantity,
          )}`,
      );
      return [
        `购物车当前 ${summary.count} 件商品：`,
        '',
        ...lines,
        '',
        `商品合计 ${formatPrice(summary.subtotal)}${summary.saved > 0 ? `（已直降 ${formatPrice(summary.saved)}）` : ''}${
          summary.coupon ? `，可用「${summary.coupon.title}」` : ''
        }，运费 ${summary.shippingFee === 0 ? '包邮' : formatPrice(summary.shippingFee)}，**应付 ${formatPrice(summary.total)}**。`,
        summary.nextCoupon
          ? `再买 ${formatPrice(summary.nextCoupon.gap)} 可用「${summary.nextCoupon.coupon.title}」。`
          : '',
        '',
        '要现在结算吗？',
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'checkout': {
      const order = state.pendingOrder;
      if (!order) {
        return '购物车还是空的，先把想买的商品加进来，我再帮你生成订单。';
      }
      if (order.status === 'confirmed') {
        return [
          `下单成功，订单号 **${order.id}**。`,
          '',
          `共 ${order.items.length} 种商品，实付 **${formatPrice(order.total)}**（${
            order.coupon ? `已用「${order.coupon}」，` : ''
          }${order.shippingFee === 0 ? '包邮' : `运费 ${formatPrice(order.shippingFee)}`}）。`,
          `收货地址：${order.address.province}${order.address.city}${order.address.district}${order.address.detail}。`,
          '',
          '需要我帮你继续挑别的商品吗？',
        ].join('\n');
      }
      return `订单 **${order.id}** 已生成，共 ${order.items.length} 种商品，实付 **${formatPrice(order.total)}**，等待你确认。`;
    }

    default:
      return [
        '我是购物助手，可以帮你做四件事：',
        '',
        '1. **搜索商品** — 「500 元以内、透气、适合夜跑的跑鞋」',
        '2. **对比参数** — 「帮我对比前 3 件」',
        '3. **管理购物车** — 「把第 2 件删掉」「数量改成 2」',
        '4. **下单结算** — 「结算」',
        '',
        '说说你想买什么？',
      ].join('\n');
  }
}

/**
 * 落地校验的失败项整理成一句可读说明（时间线与纠正提示共用同一份措辞）。
 */
function describeGroundingProblems(grounding: GroundingResult): string {
  return [
    grounding.unknownAmounts.length > 0
      ? `疑似编造金额 ${grounding.unknownAmounts.map((amount) => `¥${amount}`).join('、')}`
      : '',
    grounding.mismatchedCounts.length > 0
      ? `数量口径与界面不一致 ${grounding.mismatchedCounts.join('、')}`
      : '',
  ]
    .filter(Boolean)
    .join('；');
}

/**
 * 纠正提示。
 *
 * 关键是**点名**：只说「不要编造」等于把系统提示里的软约束重复一遍，
 * 模型没有可执行的修正目标。把「你写的这几个数字不在数据里」摊开，它才知道改哪里。
 */
function correctionHint(problems: string): string {
  return [
    `你上一次的回复没有通过数据校验：${problems}。`,
    '请重新生成一次回复：金额与数量只能**原样引用**上方数据里出现过的数字，',
    '不要自行换算、四舍五入或用别的商品的数字代替；数据里没有的数字就直接不提。',
  ].join('');
}

/** 收集流式输出（stream() 才会产出 on_chat_model_stream，前端打字机依赖它） */
async function collectText(stream: AsyncIterable<BaseMessage>): Promise<string> {
  let buffer = '';
  for await (const chunk of stream) buffer += messageText(chunk);
  return buffer.trim();
}

/**
 * 按纠正提示重试一次。
 *
 * 用 `invoke` 而不是 `stream`：第一次的 token 已经流到前端了，若重试也流式输出，
 * 两段候选文本会拼进同一个气泡。重试结果随终态一次性替换（前端 applySnapshot 已处理）。
 */
async function retryWithCorrection(
  prompt: string,
  candidate: string,
  problems: string,
): Promise<string> {
  try {
    // 温度 0：纠错要的是收敛，不是多样性
    const model = createChatModel({ temperature: 0 });
    const message = await model.invoke([
      { role: 'system', content: REPLY_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
      { role: 'assistant', content: candidate },
      { role: 'user', content: correctionHint(problems) },
    ]);
    return messageText(message).trim();
  } catch {
    // 重试失败等同于「重试后仍未通过」：调用方会用模板回复兜底
    return '';
  }
}

/**
 * 回复生成节点（所有分支的汇合点）。
 *
 * LLM 可用时生成自然语言回复（流式 token 由 streamEvents 透传，
 * 前端呈现打字机效果）；落地校验不过先带纠正提示重试一次，仍不过才用模板兜底
 * （模板数据 100% 来自状态）；LLM 不可用时直接用模板。
 */
export async function generateReplyNode(
  state: AgentStateValue,
): Promise<AgentStateUpdate> {
  const startedAt = Date.now();
  let reply = '';
  let source: 'llm' | 'template' = 'template';
  let guardNote = '';

  if (isLlmEnabled()) {
    const prompt = `${buildReplyContext(state)}\n\n请基于以上数据生成回复。`;
    let candidate = '';
    try {
      const model = createChatModel({ temperature: 0.4 });
      // 用 stream() 而不是 invoke()：这样 LangGraph 才会产出
      // on_chat_model_stream 事件，前端拿到真实 token 做打字机效果
      const stream = await model.stream([
        { role: 'system', content: REPLY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]);
      candidate = await collectText(stream);
    } catch {
      candidate = '';
    }

    if (candidate) {
      // LLM 输出属于不可信输入：进入状态前先核对金额与销量口径
      const grounding = checkGrounding(candidate, state);
      if (grounding.grounded) {
        reply = candidate;
        source = 'llm';
      } else {
        const problems = describeGroundingProblems(grounding);
        // 第一次没过不直接放弃：把不符的数字作为纠正提示再问一次
        const retry = await retryWithCorrection(prompt, candidate, problems);
        if (retry && checkGrounding(retry, state).grounded) {
          reply = retry;
          source = 'llm';
          guardNote = ` · 落地校验未通过（${problems}），已按纠正提示重试一次并采用重试结果`;
        } else {
          guardNote = ` · 落地校验未通过（${problems}），重试后仍未通过，已改用模板回复`;
        }
      }
    }
  }

  if (!reply) {
    reply = buildTemplateReply(state);
    // 规则路径也要**消费**画像：筛选条件以当前输入为准，但回复要体现偏好，
    // 否则「没有 Key 也能参考偏好」就是假的（不报错 ≠ 生效）。
    // 这句话由 parseIntent 判定并写入 profileHint（判据只有一处）。
    if (state.profileHint) reply = `${reply}\n\n${state.profileHint}`;
  }

  return {
    messages: [new AIMessage(reply)],
    toolCallLog: [
      nodeLog(
        'generateReply',
        '生成回复',
        `${source === 'llm' ? 'LLM 生成' : '模板兜底'}${guardNote}`,
        startedAt,
      ),
    ],
  };
}
