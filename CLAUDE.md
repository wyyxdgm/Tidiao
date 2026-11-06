# Tidiao（提调）· Agent Task Orchestrator

Self-hosted task orchestrator for Claude Code agents: Web UI + Agent SDK + SQLite, auth + multi-tenant, BYOK.
Public repo (Apache-2.0), single-maintainer. Quick start → [README](README.md).

## 派发到本仓的 agent 必读

- **界面双语**（zh-CN / en-US）：所有用户可见字符串走 vue-i18n，**代码注释保持中文**。迁移模式 + 波次计划 → [`docs/i18n.md`](docs/i18n.md)，样板 = `spa/src/views/LoginView.vue`（W1）。新文案 zh/en 两份都要写，漏写会被 `spa/src/i18n/i18n.test.ts` 的 key 一致性测试拦住
- **改 UI 只改 `spa/**`**（Vue 3 SPA 是唯一对外 UI）；`src/app/**` 是历史壳，不动
- **表单控件/弹窗红线**：一律用封装组件（`ConfirmDialog` / `Toast` / `Select` / `Input` / `Button`），禁原生 `alert` / `confirm` / `<select>`
- **验证闭环**：`cd spa && npx vitest run` 相关测试 + `npm run build`。🔴 构建结果必须显式看 exit code（`ec=$?`）——管道接 `tail` 会吃掉真实失败
- **提交**：直接 main（单人项目），commit message 首行 `feat|fix|docs(scope): ...` + 尾部撤销命令；push 前 `git status` 确认不带 node_modules / `public/` 构建产物
- **并行派发纪律**：只动分派给你的视图文件 + **自己新建**的 locale 域文件（`locales/<lang>/<你的域>.json`），不改别人的域文件 → 天然无冲突
- 语言偏好持久化：localStorage `tidiao-lang`；缺 key 自动回落 zh-CN，不报错
