// spa 独立测试配置: `@/` -> spa/src.
// 关注点: 根 vitest.config.ts 的 `@` alias 指向根 src (Next.js 历史壳), spa 测试
// 在根 vitest 下跑时引 @/api/http 会 Cannot find package (2026-10-26 实证
// useTaskResources.test.ts 整组挂). 根 config 已把 spa/** 排除, spa 测试统一
// 从本目录跑: cd spa && npx vitest run (vitest 沿 node_modules 向上找到根的).
// 不挂根的 setupFiles (拦截 ORCHESTRATOR env 防 DB 写穿) — spa 测试不连 DB,
// browser API 由各测试自行 stub (如 theme.test.ts).
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
  },
});
