# 1. 快速上手

> 从零到第一个 Agent 任务跑起来，5 分钟。

## 概述

本章节带你在本地启动提调（Hufu，原 Agent Orchestrator），完成注册登录、配置 API Key，并创建第一个任务。适用于首次使用本平台的用户。

### 功能点：环境要求与启动

- **是什么**：在本地机器上运行编排平台开发服务
- **怎么用**：
  1. 确保已安装 Node.js（建议 18+）和 npm
  2. 克隆仓库并安装依赖：
     ```bash
     git clone <repo-url>
     cd agent-orchestrator
     npm install
     ```
  3. 启动开发服务：
     ```bash
     npm run dev
     ```
  4. 浏览器打开 http://localhost:13000
- **注意**：
  - 数据库自动初始化在 `~/.agent-orchestrator/orchestrator.db`，首次启动时 migration 自动执行，无需手动建表
  - 可通过 `ORCHESTRATOR_HOME` 环境变量自定义数据目录（默认 `~/.agent-orchestrator`）
  - 端口固定为 13000

### 功能点：注册与登录

- **是什么**：基于 JWT session cookie 的用户认证系统，支持多用户隔离
- **怎么用**：
  1. 打开 http://localhost:13000，未登录时自动跳转到登录页
  2. 点击注册链接，填写邮箱和密码完成注册
  3. 注册后自动登录，进入首页（项目列表）
  4. Session cookie 有效期 7 天，过期后需重新登录
- **注意**：
  - **首个注册用户自动成为 admin**，后续注册用户为普通 user
  - 所有数据按 `owner_id` 隔离，用户之间互不可见
  - 生产环境务必设置 `JWT_SECRET` 环境变量，否则使用不安全的默认密钥
  - admin 拥有额外能力：平台 LLM 配置、用户授权管理、用户并发上限设置
  - **登录失败次数限制**：15 分钟内 5 次失败 → 该账号会被限流 15 分钟，提示「错误次数过多，请 N 分钟后再试」（与「邮箱或密码错误」明确区分，便于 AI 自动化场景区分重试 vs 改密码）
  - 被锁定的账号只能等窗口过去，或由 admin 跑 `scripts/reset-password.js` 重置密码后自动解锁（成功登录会清空失败计数；见 [docs/reset-password.md](../reset-password.md)）

### 功能点：API Key 配置

- **是什么**：配置 Anthropic API Key，让 Agent 能调用 LLM 完成任务
- **怎么用**：

  有两种配置方式：

  **方式一：环境变量（系统级 fallback）**

  在启动服务前设置环境变量：
  ```bash
  # Anthropic 官方
  export ANTHROPIC_API_KEY=sk-ant-...

  # 第三方兼容 API（火山方舟 Ark）
  export ANTHROPIC_API_KEY=ark-...
  export ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/plan
  ```

  **方式二：设置页个人配置（推荐）**

  1. 登录后点击右上角「设置」
  2. 在「个人 LLM 配置」区域填写 API Key、Base URL（可选）、默认模型（可选）
  3. 点击「保存个人配置」

  **管理员额外能力**：admin 可在设置页配置「平台 LLM 配置」，并授权其他用户使用平台 API Key（无需每人各自配置）

- **注意**：
  - 环境变量中的 API Key 仅作系统级 fallback，**普通用户必须配置自己的 API Key 或被管理员授权才能运行任务**
  - 火山方舟 Ark 兼容 API 需同时设置 `ANTHROPIC_BASE_URL`
  - 个人配置优先级高于环境变量；任务级 model 字段优先级高于个人配置
  - API Key 在数据库中加密存储，前端仅显示掩码（如 `sk-ant-...xxxx`）

### 功能点：已验证模型

- **是什么**：平台已测试通过的 LLM 模型列表
- **怎么用**：
  1. Anthropic 官方 API 支持 `claude-sonnet-4` 等模型
  2. 火山方舟 Ark 兼容 API 支持以下模型：
     - `glm-5.2` / `glm-latest`（当前默认）
     - `MiniMax-M3` / `MiniMax-M2.7`
     - `doubao-seed-2.1-turbo`
     - `doubao-seed-2.0-pro` / `doubao-seed-2.0-lite`
  3. 完整模型列表和配置说明见 [docs/models.md](../models.md)
- **注意**：
  - `doubao-1.5-pro/lite` 不支持 agent plan，会报 `UnsupportedModel` 错误
  - 任务创建时可在「模型」字段填写任意模型名，不限于预设列表
  - 未填 model 时使用环境变量 `ANTHROPIC_MODEL` 或个人/平台配置的默认模型

### 功能点：创建第一个任务

- **是什么**：从项目到任务启动的最短路径
- **怎么用**：
  1. **创建项目**：在首页点击「新建项目」，填写项目名称和工作目录（cwd，可选）
  2. **新建任务**：点击「新建任务」进入任务创建页
  3. **快速模式**（默认）：选择项目，输入任务指令（prompt），点击「创建并启动」
  4. 任务创建后自动启动，页面跳转到任务详情页，实时展示 Agent 输出
- **注意**：
  - 项目是任务的必填归属，必须先创建项目
  - 快速模式默认配置：自动审批（auto_approve=true）、effort=high、max_turns=200
  - 工作目录（cwd）留空时自动隔离到 `$ORCHESTRATOR_HOME/projects/{projectId}/{taskId}`
  - 也可用「完整配置」模式设置更多参数（模型、工具、依赖等）

### 功能点：HTTP 部署注意

- **是什么**：非 HTTPS 环境部署时的 cookie 安全配置
- **怎么用**：
  - 当通过 HTTP（而非 HTTPS）访问平台时，设置环境变量 `COOKIE_SECURE=0`
  - 该变量使 session cookie 的 `secure` 属性为 false，允许浏览器在 HTTP 下发送 cookie
- **注意**：
  - 不设置 `COOKIE_SECURE=0` 时，HTTP 部署下浏览器不会发送 cookie，导致登录后仍显示未登录
  - HTTPS 部署无需此设置，cookie 默认 `secure=true`
  - 也可显式设置 `COOKIE_SECURE=1` 强制开启（用于 HTTPS 反代场景）
  - 详见 [docs/deploy.md](../deploy.md)

### 功能点：后台状态呼吸点

- **是什么**：SPA 视口右缘的常驻小圆点（R185），实时反映「服务后台是否可用」——绿色呼吸 = 正常，红色常亮 = 后台不可用，灰色 = 探测中
- **怎么用**：无需操作，登录后自动显示；鼠标悬停可看状态与最近探测时间
- **注意**：
  - 探测机制：每 30s 轮询一次 `GET /api/health`（极轻存活探针，不碰 DB）；探测失败后缩短为 5s 重试以便快速回绿
  - 页面切到后台标签页时暂停轮询，切回时立即补一次
  - 红灯常见原因：后端 pm2 进程挂了 / nginx 反代不可达 / 网络断开
- **实现参考**：`spa/src/composables/useBackendHealth.ts`（轮询单例）+ `spa/src/components/BackendBreathDot.vue`（展示）+ `src/app/api/health/route.ts`（探针端点）

### 功能点：主题切换（深色 / 浅色 / 随系统，R206）

- **是什么**：SPA 全局外观主题，三档可选 —— 浅色 / 深色 / 随系统（跟随操作系统的深色模式自动切换）
- **怎么用**：
  1. 点击顶栏右上角主题按钮（日/月图标，位于任务搜索框右侧）
  2. 弹出下拉三选一：**浅色** / **深色** / **随系统**，选中即全局生效、无需刷新
  3. 「随系统」档下，操作系统切换深色/浅色时页面自动跟随
- **注意**：
  - 偏好存浏览器 `localStorage`（键 `ao_theme`），刷新/重开保留；默认档为 **随系统**
  - 首屏无闪烁：`spa/index.html` 内联一段无阻塞脚本，在首次绘制前先按存储偏好写入 `<html data-theme>`，避免白屏跳变
  - 实现要点：`<html data-theme="light|dark">` + CSS 变量表 `spa/src/assets/theme-vars.css`（由 `spa/scripts/theme-codemod.mjs --gen-vars` 生成）驱动；`随系统` 在 JS 侧用 `matchMedia('(prefers-color-scheme: dark)')` 先解析成具体的 light/dark，故 CSS 只需两套变量块
  - 项目 Wiki 中的 Mermaid 图会随主题重渲染（深色用 `dark` 主题）
  - 实现参考：`spa/src/lib/theme.ts`（偏好状态 + 解析 + 持久化）、`spa/src/components/ThemeToggle.vue`（按钮 + 下拉）

### 功能点：实例标题标识（多环境混开区分，R193 / 2026-10-25 改版）

- **是什么**：浏览器标签页 title 按访问入口自动标识实例 —— 一份 SPA dist 服务多实例，运行时按 `location` 判定，多实例混开时一眼分清哪个标签是哪台机器
- **标题映射**：
  | 访问入口 | 标题 |
  |---|---|
  | `mac.example.com`（主 Mac 实例公网入口） | `提调（mac）` |
  | `air.example.com`（Air 实例公网入口） | `提调（air）` |
  | `dao.example.com` / `192.0.2.50:13000`（WSL ao-prod） | `提调（wsl）` |
  | `dev.example.com` / 任意 `:13001` 直连（WSL ao-dev） | `提调（dev）` |
  | `ao.example.com`（pulu 实例） | `提调（pulu）` |
  | 未识别入口（如 `localhost:13000`——mac/wsl 本机都占此端口，客户端无法区分） | `提调（Tidiao）` 默认 |
- **注意**：
  - 旧版格式为前缀（`[DEV] 提调（Tidiao）`），2026-10-25 拍板改为 `提调（env）` 整题格式
  - air 实例 checkout 在旧版（无本逻辑）期间，其公网入口的 title 由 pulu nginx `sub_filter` 兜底改写；air 升级 checkout 后可去掉该兜底
  - 实现参考：`spa/src/lib/instance-title.ts`（入口→标题映射表，新增入口在此追加）+ `spa/src/main.ts`（挂载时设置一次；SPA 运行期不再改 title）

## 常见问题

**Q: 启动后提示「ANTHROPIC_API_KEY 未配置」怎么办？**
A: 设置环境变量 `ANTHROPIC_API_KEY` 后重启服务，或在设置页配置个人 LLM。

**Q: 忘记密码怎么办？**
A: 管理员可通过密码重置脚本操作，详见 [docs/reset-password.md](../reset-password.md)。

**Q: 第一个用户注册后角色是什么？**
A: 首个注册用户自动成为 admin，拥有平台管理权限。后续注册用户为普通 user。

**Q: 非 admin 用户能做什么？**
A: 创建项目/任务、配置个人 API Key、创建 API Token、使用被授权的平台 LLM 配置。不能管理其他用户。
