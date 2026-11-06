// vitest 最小配置: 只做 `@/` -> src 的路径别名.
// 关注点: 之前没有配置文件, 所有测试都用相对路径 import, 所以测不了 API route
//   （route.ts 自身用 `@/lib/...`）. 只加 alias, 不改 include/environment,
//   既有 14 个测试文件行为不变.
//
// 2026-09-07 加 setupFiles: 全局拦截 ORCHESTRATOR_HOME / ORCHESTRATOR_DB_PATH,
// 防止漏设 env 的测试写到生产 (2026-09-03 漏一次就污染 2037 P 项目). 见
// ./vitest.setup.ts. 既有测试因为都在 beforeEach 显式设 env, setupFile 默认值
// 被覆盖, 行为不变.
import { defineConfig, defaultExclude } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // spa/ 是独立构建单元 (自有 vite.config + vitest.config, @/ 指 spa/src),
    // 测试从 spa/ 目录入跑 (cd spa && npm test); 在这里跑会撞根 src alias.
    exclude: [...defaultExclude, "spa/**"],
  },
});
