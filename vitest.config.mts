import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest 配置。
 *
 * 用 .mts 扩展名而不是 .ts：package.json 没有 `"type": "module"`，
 * 而 Vite 的 native config loader 会把 .ts 当 CommonJS 解析，导致 ESM 语法告警。
 *
 * 只跑纯函数单测，因此用 node 环境（不需要 jsdom / 组件渲染）。
 * 覆盖目标是项目里那批「口径一致性的唯一实现」：它们一旦被改错，
 * 界面、对比表、决策推荐、LLM 上下文会同时出现分叉。
 */
export default defineConfig({
  resolve: {
    // 与 tsconfig.json 的 paths 对齐（@/* → 项目根）
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    exclude: ['node_modules', '.next'],
  },
});
