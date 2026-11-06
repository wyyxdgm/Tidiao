# 13. 习惯沉淀 (Habits, R158 A 档)

> **目的**：damo 反复强调的偏好 / 拍板 / 习惯原本埋没在每个 task 里，没有统一沉淀处。
> 这章讲怎么**一条命令写一条**、**跨项目检索**、**和 shared-standards 配合**。
>
> **当前状态**：A 档已落地（2026-09-25）。B/C 档待 damo 反馈后启动。
> 完整评估：[`../plans/R158-user-habit-extraction.md`](../plans/R158-user-habit-extraction.md)

---

## 13.1 它解决什么

damo 每次拍板 / 强调 / 反复纠正的事，本可以变成"下一次自动遵守"的规则，但缺一个统一的存处。

现在每拍一个板 / 强调一个偏好 → 当轮用一行命令写进 `docs/habits.md`，后续：
- agent 启动时按 `ao recall --source docs` 自动看到
- 跨项目复用（每个项目 cwd 都有自己的 `docs/habits.md`）
- 与现有 `docs/shared-standards/`（多项目共用）+ `L1 CLAUDE.md`（全平台准则）三层分工

## 13.2 三层放置约定（§5 草案）

| 习惯类型 | 放哪 | 例子 |
|---------|------|------|
| 全平台 agent 行为准则 | `docs/claude-config/CLAUDE.md` (L1) | "damo 派任务常是语音转写, 按发音+上下文解读" |
| 多项目共用技术规范 | `docs/shared-standards/<topic>.md` | "agent 写代码必带回归测试" |
| **项目特有习惯/技术选型** | **本项目 `docs/habits.md`** | "anflow 部署必须先 `npm run build:staging`" |
| 项目特有业务知识 | `<project>/CLAUDE.md` | "anflow 是 SaaS 后台 + 移动端" |

**判别口诀**（damo 0825 立）：
1. 这条 5 个项目都适用？→ 升 `shared-standards/`
2. 全平台 agent 都要遵守？→ 升 L1 `CLAUDE.md`
3. 只本项目？→ `docs/habits.md`
4. 涉及项目业务背景？→ 项目 `CLAUDE.md`

## 13.3 怎么写一条

```bash
# 一行命令, append 到当前项目 cwd/docs/habits.md, 按 category 自动归桶
bash scripts/record-habit.sh <category> "<habit>"

# 例
bash scripts/record-habit.sh cli "scripts/*.sh 默认走 bash 3.2 兼容"
bash scripts/record-habit.sh workflow "改 shared-standards/ 前先 grep 现有文件"
bash scripts/record-habit.sh testing "改完后跑 npm test 再 commit"
```

**已支持的 category 桶**（`scripts/record-habit.sh --init` 自动建）：

| category | 用途 |
|----------|------|
| `cli` | shell 脚本 / 命令行约定 |
| `deploy` | 部署相关 |
| `testing` | 测试相关 |
| `ui` | 前端 UI 相关 |
| `workflow` | 工作流 / 流程约定 |
| `other` | 兜底桶（任意 category 也落这里） |

自定义 category 也行 —— 脚本会自动建新桶（或落到 `other`）。

## 13.4 怎么查

```bash
# 列本项目全部习惯
bash scripts/record-habit.sh --list

# 按 category 过滤
bash scripts/record-habit.sh --list --category cli

# 跨项目 / 跨源搜索 (走 ao recall 4 源并发)
ao recall "<keyword>" --source docs
# habits.md 是 docs 源的一部分, 搜索结果会自动包含
```

## 13.5 在新项目里启用

每个项目 cwd 下跑一次 `init` 即可：

```bash
# 项目 A (anflow)
cd ~/workspace/anflow
bash /path/to/agent-orchestrator-dev/scripts/record-habit.sh --init
# → 生成 anflow/docs/habits.md (含 §5 头部 + 6 个 category 骨架)

# 项目 B (yidao)
cd ~/workspace/yidao
bash /path/to/agent-orchestrator-dev/scripts/record-habit.sh --init
# → 生成 yidao/docs/habits.md
```

**注意**：脚本默认写到 `cwd/docs/habits.md`。跨项目 init 必须 `cd` 到目标项目再跑（或用 `--file <绝对路径>`）。

## 13.6 撤销 / 回滚

| 想撤销什么 | 怎么做 |
|-----------|--------|
| 单条习惯 | 手动删 `docs/habits.md` 里的那一行 |
| 整个 habits.md | `rm docs/habits.md`（无副作用，下一条 `record-habit.sh` 会提示重建） |
| 整个功能 (A 档) | `rm scripts/record-habit.sh docs/habits.md docs/usage/13-habits.md`，commit + push |

**A 档本身不引入 DB / 不改 deploy 脚本 / 不动 sync-standards**，删干净 = 完退。

## 13.7 下一步（B/C 档预告）

- **A 档（当前）**：手动写 + 自动检索，0 工时 / 0 LLM 成本
- **B 档（damo 反馈"手动不够"后启动）**：task 完成时 LLM 摘要候选 → damo 审 → 入库。1-2 周 + LLM 成本
- **C 档（暂不做）**：全自动向量去重。LLM 幻觉风险高，damo 痛点不在自动提取

详见 [`../plans/R158-user-habit-extraction.md`](../plans/R158-user-habit-extraction.md) §2 / §3。