import { END, START, StateGraph } from '@langchain/langgraph';
import { getCheckpointer } from './checkpointer';
import { AgentState, MAX_REFINE_ROUNDS, type AgentStateValue } from './state';
import { compareProductsNode } from './nodes/compareProducts';
import { confirmOrderNode } from './nodes/confirmOrder';
import { enrichLiveDataNode, shouldEnterEnrichLiveData } from './nodes/enrichLiveData';
import { generateReplyNode } from './nodes/generateReply';
import { manageCartNode } from './nodes/manageCart';
import { parseIntentNode } from './nodes/parseIntent';
import { prepareOrderNode } from './nodes/prepareOrder';
import { refineSearchNode } from './nodes/refineSearch';
import { searchProductsNode } from './nodes/searchProducts';

/* ============================================================
   条件边路由（声明式，新增能力只需加 case + 一个节点）
   ============================================================ */

/** parseIntent 之后：按意图分流 */
function routeByIntent(
  state: AgentStateValue,
): 'searchProducts' | 'refineSearch' | 'compareProducts' | 'manageCart' | 'prepareOrder' | 'generateReply' {
  switch (state.intent) {
    case 'search':
      return 'searchProducts';
    case 'refine':
      return 'refineSearch';
    case 'compare':
      return 'compareProducts';
    case 'cart':
      return 'manageCart';
    case 'checkout':
      return 'prepareOrder';
    default:
      return 'generateReply';
  }
}

/**
 * searchProducts 之后：先看要不要继续细化条件；否则判断能否做实时补充，不能就直接生成回复。
 *
 * - refineCount 上限是图的收敛保证——没有它，「检索为空 → 放宽 → 仍为空」会一直绕环，
 *   直到撞上 LangGraph 的递归上限抛错；
 * - 实时补充插在 searchProducts → generateReply 这条直线上：三个去向都是单向边，
 *   **不引入新的环**（图中唯一的环仍是 refineSearch ⇄ searchProducts）；
 * - 「是否进入实时补充」的六条判定放在条件边里（可被单测逐条覆盖，见 nodes/enrichLiveData.ts）。
 */
function routeAfterSearch(
  state: AgentStateValue,
): 'refineSearch' | 'enrichLiveData' | 'generateReply' {
  if (state.needsRefine && state.refineCount < MAX_REFINE_ROUNDS) return 'refineSearch';
  return shouldEnterEnrichLiveData(state) ? 'enrichLiveData' : 'generateReply';
}

/** prepareOrder 之后：interrupt 确认过才进入 confirmOrder */
function routeAfterPrepare(state: AgentStateValue): 'confirmOrder' | 'generateReply' {
  return state.pendingOrder ? 'confirmOrder' : 'generateReply';
}

/* ============================================================
   状态图构建
   ============================================================ */

export function buildAgentGraph() {
  return new StateGraph(AgentState)
    .addNode('parseIntent', parseIntentNode)
    .addNode('searchProducts', searchProductsNode)
    .addNode('refineSearch', refineSearchNode)
    .addNode('enrichLiveData', enrichLiveDataNode)
    .addNode('compareProducts', compareProductsNode)
    .addNode('manageCart', manageCartNode)
    .addNode('prepareOrder', prepareOrderNode)
    .addNode('confirmOrder', confirmOrderNode)
    .addNode('generateReply', generateReplyNode)
    .addEdge(START, 'parseIntent')
    .addConditionalEdges('parseIntent', routeByIntent, [
      'searchProducts',
      'refineSearch',
      'compareProducts',
      'manageCart',
      'prepareOrder',
      'generateReply',
    ])
    // 细化条件后回到检索，构成图中唯一的环
    .addEdge('refineSearch', 'searchProducts')
    .addConditionalEdges('searchProducts', routeAfterSearch, [
      'refineSearch',
      'enrichLiveData',
      'generateReply',
    ])
    // 实时补充是 searchProducts → generateReply 直线上的插入点：
    // 六条判定不通过时上一条条件边直接送往 generateReply，行为与改造前完全一致
    .addEdge('enrichLiveData', 'generateReply')
    .addEdge('compareProducts', 'generateReply')
    .addEdge('manageCart', 'generateReply')
    .addConditionalEdges('prepareOrder', routeAfterPrepare, [
      'confirmOrder',
      'generateReply',
    ])
    .addEdge('confirmOrder', 'generateReply')
    .addEdge('generateReply', END);
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;

async function createAgentApp() {
  // getCheckpointer 是异步的：sqlite 后端需要动态 import 原生模块，
  // 这样「加载失败回落内存态」才捕获得到
  return buildAgentGraph().compile({ checkpointer: await getCheckpointer() });
}

export type AgentApp = Awaited<ReturnType<typeof createAgentApp>>;

let compiledAppPromise: Promise<AgentApp> | undefined;

/**
 * 惰性编译并缓存。挂 globalThis 的 checkpointer 保证热更新后上下文不丢；
 * 图本身可以安全重建（纯声明，无状态）。
 * 缓存 Promise 而不是实例：并发的首次请求不会各自编译一遍图。
 */
export function getAgentApp(): Promise<AgentApp> {
  if (!compiledAppPromise) {
    compiledAppPromise = createAgentApp();
  }
  return compiledAppPromise;
}
