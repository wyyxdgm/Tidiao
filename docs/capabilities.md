# agent-orchestrator 平台能力声明

## 当前能力 (capabilities)

- ✅ **多 Claude Code Agent 任务调度**: FQPF 调度 + SSE 流 + per-cwd/per-user 并发闸门 | [docs/architecture.md](docs/architecture.md) + 运行中 (13000/13001/ao.example.com)
- ✅ **飞书 sheet 同步 (requirement/customer_summary)**: 平台侧双向 write-back | [docs/feishu-integration-standards.md](docs/feishu-integration-standards.md)
- ✅ **Runner 远程 exec (R1 平台侧已上线)**: 白名单命令远程执行 + 心跳健康 + 401 结构化错误类型 | [docs/plans/runners-rollout.md](docs/plans/runners-rollout.md) §3 + commit `0b27000` / `25ae79f`
- ✅ **M 模式 (主控审查 task) 多任务编排**: R107 通知驱动波次+审查循环，runners-rollout 完整闭环验证 | [docs/shared-standards/task-dispatch-standards.md §6](docs/shared-standards/task-dispatch-standards.md)
- ✅ **能力声明规范**: 标准定稿, 待 wave 铺开 | [docs/shared-standards/capability-declaration.md](docs/shared-standards/capability-declaration.md)
- 🟡 **甲方协作入口**: 规划中 (P1/P2/P4 定), 待开发 | [docs/plans/projects/client-portal-h5.md](docs/plans/projects/client-portal-h5.md)

## 未来方向 (roadmap)

- 🚧 **Runner 真实档 (Tauri 构建)**: 0-2 周, 依赖 SDK canUseTool A 路调研结果
- 🚧 **甲方 H5 (CLI skill 优先)**: 2-6 周
- 🚧 **需求点 as 一等实体 (平台侧)**: 6-10 周, D1-D8 全定案
- 🚧 **推广负责人 (虚拟 agent)**: 概念定, 详细设计 promoter.md TBD
- 💭 **P1 外包流水线 / P2 生日提醒小程序**: 搞钱方向, 主线 1-3 后择期
- 💭 **Runner 体系扩展** (多 runner / Win 服务化 / 协议 v2): 有需求再说

## 可协助别人处理什么 (help-boundary)

- 🤝 **派发开发任务给本仓**: agent 任务代码改动 / 文档更新 / 测试 / 部署
- 🤝 **提供 M 模式编排**: 多任务计划由 M 持文档、波次推进+审查循环（任何子项目需要时）
- 🤝 **飞书 sheet 自动化**: 客户/需求/进度同步
- 🤝 **平台能力/路由集成**: 其他项目接入平台时的 onboarding
- ⛔ **业务功能实现** (CMS / 外包 / 桌面壳): 这类业务由对应业务项目做, 平台只提供调度能力

## 在平台系统中的角色 (role)

- **业务领域**: 平台自身 (调度/编排/基础设施)
- **派发路由**: damo 直接管理 (task-dispatch.md), partner agent 读取各项目 capabilities.md 辅助路由
- **上游依赖**: 无（本仓 = 调度基础设施, 不依赖业务项目）
- **下游消费者**: 所有业务项目 (weishu-chan / anflow / hermes / gaoxing / agent-platform 等) —— 派发任务给它们；通过 `docs/capabilities.md` 协同