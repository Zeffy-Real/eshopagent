import { END, START, StateGraph } from '@langchain/langgraph';
import { getCheckpointer } from './checkpointer';
import { AgentState, MAX_REFINE_ROUNDS, type AgentStateValue } from './state';
import { compareProductsNode } from './nodes/compareProducts';
import { confirmOrderNode } from './nodes/confirmOrder';
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
 * searchProducts 之后：是否需要继续细化条件。
 * refineCount 上限是图的收敛保证——没有它，「检索为空 → 放宽 → 仍为空」会
 * 一直绕环，直到撞上 LangGraph 的递归上限抛错。
 */
function routeAfterSearch(state: AgentStateValue): 'refineSearch' | 'generateReply' {
  if (state.needsRefine && state.refineCount < MAX_REFINE_ROUNDS) return 'refineSearch';
  return 'generateReply';
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
      'generateReply',
    ])
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

function createAgentApp() {
  return buildAgentGraph().compile({ checkpointer: getCheckpointer() });
}

export type AgentApp = ReturnType<typeof createAgentApp>;

let compiledApp: AgentApp | undefined;

/**
 * 惰性编译并缓存。挂 globalThis 的 checkpointer 保证热更新后上下文不丢；
 * 图本身可以安全重建（纯声明，无状态）。
 */
export function getAgentApp(): AgentApp {
  if (!compiledApp) {
    compiledApp = createAgentApp();
  }
  return compiledApp;
}
