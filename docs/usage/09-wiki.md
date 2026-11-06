# 9. 项目 Wiki

> 每个项目的工作目录（cwd）即文档源，浏览器直接浏览 Markdown 文件树。

## 概述

每个项目的 `cwd` 根目录可放置 `INDEX.md` 作为 Wiki 入口，通过 `/{projectId}/wiki` 访问。左栏自动列出 cwd 下所有 `.md` 文件（深度 5），右栏渲染 Markdown 正文。相对路径的 `.md` 链接可点击跳转，形成树状 wiki。无需数据库字段，复用项目已有的 `cwd`。

### 功能点：INDEX.md Wiki 入口

- **是什么**：项目 cwd 根目录的 `INDEX.md` 文件，作为 wiki 的默认入口页。
- **怎么用**：
  1. 在项目的 cwd 根目录创建 `INDEX.md` 文件。
  2. 文件顶部可写 YAML frontmatter 定义外链按钮：
     ```markdown
     ---
     links:
       - { label: 线上, url: https://example.com }
       - { label: 飞书, url: https://my.feishu.cn/... }
     ---
     # 项目名称

     项目描述正文，可使用完整 Markdown 语法。
     ```
  3. frontmatter 中的 `links` 会渲染为右栏顶部的外链按钮（新窗口打开）。
  4. frontmatter 还支持可选的 `title` 字段。
  5. 若 `INDEX.md` 不存在，自动回退到 `CLAUDE.md`。
- **注意**：
  - frontmatter YAML 解析失败时静默降级为无 links，不阻断页面渲染。
  - 正文中相对路径的 `.md` 链接会被拦截为内部跳转（见"文件树"功能点）。
  - 外链（http/https/mailto）在新窗口打开。

### 功能点：文件树导航

- **是什么**：左栏自动列出项目 cwd 下所有 `.md` 文件，点击即可切换浏览。
- **怎么用**：
  1. 访问 `/{projectId}/wiki`，左栏自动展示文件树。
  2. 目录用可折叠的 `<details>` 展示（默认展开），文件按名称排序。
  3. 点击文件名即可在右栏加载并渲染该 Markdown 文件。
  4. 正文中相对路径的 `.md` 链接（如 `[架构](./docs/architecture.md)`）也会触发内部跳转，点击后切换到对应文件。
- **注意**：
  - 深度限制为 5 层目录，防止过大仓库加载缓慢（飞书 AO-DEV R76：原 3 提到 5，以适配深层文档如 `docs/设计/R6/...`）。
  - 跳过以 `.` 开头的隐藏目录（如 `.git`、`.next`）。
  - 默认排除重目录：`node_modules` `dist` `build` `out` `coverage` `.cache` `target` `vendor` `.venv` `__pycache__` —— 这些目录几乎不含人工维护的 markdown, 加进左栏只会把几百个第三方依赖的 README/LICENSE 撑爆（飞书 AO-DEV R76）。
  - 只列出 `.md` 扩展名文件。
  - 文件路径为相对 cwd 的 posix 路径（如 `docs/architecture.md`）。
  - 右上角有"铺满/居中"宽度切换按钮，偏好存储在 localStorage。

### 功能点：深链接

- **是什么**：通过 URL 参数 `?path=` 直接定位到某个文档。
- **怎么用**：
  1. 在 wiki 页面浏览文档时，地址栏会自动同步 `?path=docs/architecture.md`。
  2. 复制该 URL 分享给他人，打开后直接定位到该文档。
  3. 刷新页面时保持当前文档不变（从 URL 读取 `path` 参数）。
- **注意**：
  - `path` 参数必须是相对 cwd 的路径，且以 `.md` 结尾。
  - 路径不能逃出 cwd 目录（后端 realpath 校验）。
  - 不传 `path` 参数时默认加载 `INDEX.md`（回退 `CLAUDE.md`）。
  - 中文路径支持：正文里的中文相对链接（如 `docs/playbook/总纲.md`）正常点击跳转（R231 修复双重编码）；旧版 bug 生成的双重编码 URL（`path` 里含 `%25XX` 形态）打开时会自动 decode 一次重试，历史书签/分享链接无需手工修正。

### 功能点：绝对路径访问

- **是什么**：从终端 / 邮件 / IDE 直接复制一个绝对路径（如 `/ws/agent-orchestrator-dev/docs/foo.md`）到地址栏，平台自动识别它属于哪个用户项目，跳转到对应的 wiki 页面（相对路径形态）。
- **怎么用**：
  ```
  /{任意项目id}/wiki?path=/ws/<你某个项目 cwd>/<子路径>/<file>.md
  ```
  - 不在意 URL 里的 `{项目id}` 是哪个——平台会拿绝对路径在当前用户名下所有项目 cwd 里做最长前缀匹配，命中就跳转过去。
  - 同名匹配：命中 URL 里的 `{项目id}` 也会重定向（URL 立即规范化成相对路径形态）。
  - 精确命中某项目 `cwd` 本身（`?path=/ws/<项目 cwd>`，没跟文件名）→ 跳到 `INDEX.md`，等价于直接打开该项目的 wiki 首页。
- **例子**（假设你有两个项目：`ao-dev` cwd `/ws/agent-orchestrator-dev`、`yidao` cwd `/ws/yidao`）：
  - `/{ao-dev 项目id}/wiki?path=/ws/agent-orchestrator-dev/docs/architecture.md` → 同项目，跳到 `?path=docs/architecture.md`
  - `/{ao-dev 项目id}/wiki?path=/ws/yidao/README.md` → 跨项目，跳到 `/{yidao 项目id}/wiki?path=README.md`
  - `/{ao-dev 项目id}/wiki?path=/ws/yidao` → 精确命中，跳到 `/{yidao 项目id}/wiki?path=INDEX.md`
  - `/{ao-dev 项目id}/wiki?path=/nowhere/foo.md` → 不在任何项目 cwd 下，平台跳过后交给 API，API 返回 404
- **注意**：
  - **跨用户隔离**：只能跳到当前登录用户名下的项目。绝对路径 `/ws/别人的项目/foo.md` 不会跳（看不到别人项目 cwd）。
  - **最长前缀 cwd 匹配**：避免 `/ws/a` 截胡 `/ws/abc` 的兄弟项目 cwd。
  - **`?version=` 沿用**：URL 里带的 `?version=v1.0` 会一起带到目标项目（让目标项目自己解析；同名 version 用之，无则由目标项目默认版本兜底）。
  - **不动 `safeResolve` 安全边界**：服务端的「只接受相对路径」校验仍生效——这一层只是把 URL 规范化，API 收到 `/` 开头的路径仍 404。客户端 fetch 永远拿到规范化后的相对路径。
  - **`~/` 开头本轮不支持**：服务端的 `$HOME` 不等于用户的项目 cwd，需要额外映射层，留作下轮。

### 功能点：自定义可读文件类型（高级选项，v35）

- **是什么**：默认 wiki 只读 `.md`。可按项目额外放行别的扩展名（如 `txt` `json` `csv` `sql`），让 wiki 也能浏览这些文件。
- **怎么用**：项目列表页 → 目标项目的 wiki 高级选项 → 填扩展名（**空格分隔，不带点**，如 `txt json csv`）→ 保存。留空 = 恢复默认（只读 `.md`）。
- **注意**：
  - **未配置的项目行为零变化** —— 放行集合恰好等于 `{md}`，和这个功能上线前完全一样。
  - **不能用 `*` 全放行**，也不接受空串、含 `.` 或 `/` 的输入 —— 会报错。扩展名形状必须是 `^[a-z0-9]{1,16}$`，一个项目最多 20 个。
  - **密钥类扩展名硬拒**：`env` `pem` `key` `p12` `crt` 等一律拒绝并报错（不是静默忽略），配了也不生效。
  - **隐藏文件/目录（`.` 开头）永远排除**，不受这个配置影响。
  - 非 `.md` 文件用 `<pre>` 转义显示（不进 Markdown 渲染器），单文件上限 1 MiB。
  - 前端校验只是即时反馈，**服务端独立再校验一遍** —— 直接 curl PATCH 绕不过去。

### 功能点：跨项目 Wiki 链接

- **是什么**：在项目 A 的 wiki 文档里写一段链接，直接跳到项目 B 的 wiki 某篇文档。用于多仓协作时把分散的文档串起来（如 yidao 主仓报告里引用 yidao-webiste 的首页）。
- **怎么用**：markdown 里写带 `project:` 前缀的链接：
  ```markdown
  详见 [yidao-webiste 首页](project:3fa2ad29-8669-4cbb-876c-fc65c4f57a49?path=INDEX.md)

  也可指定目标版本：
  [v1.0 架构](project:3fa2ad29-8669-4cbb-876c-fc65c4f57a49?path=docs/architecture.md&version=v1.0)
  ```
  语法：`project:{projectId}?path={relpath}[&version={version}]`
  - `projectId` 必须是 UUID（项目设置页可见）
  - `relpath` 是目标项目 cwd 内的相对路径
  - `version` 可选（不传则用目标项目默认版本）
- **注意**：
  - **权限按目标项目 owner 隔离**：跳过去后由目标 wiki 服务端 `getProjectById(id, userId)` 校验；没权限的 → 目标页 404，UX 与点错链接一致（不泄漏「存在但你没权限」）。
  - **解析失败的链接不会阻塞渲染**：语法错的（如 `project:?path=...`）被解析器返回 `null`，前端 fallback 到外链新窗口。
  - **路径穿越被拒**：`path` 里出现 `..` 段或前导 `/` 一律不解析（防「目标项目里读不到」的失败请求；服务端 safeResolve 是兜底防线）。
  - **整页跳转**（不是软切换）：目标项目有完全不同的文件树与扩展名配置，软切换会留旧 state 引发错乱，整页 reload 最稳。需要新窗口请 Cmd/Ctrl+Click。
  - **🔴 不是「跨项目权限提升通道」**：跳过去看到的内容完全由目标项目的 owner 决定，与「同 owner 才能看」模型一致。

### 功能点：安全机制

- **是什么**：多层安全校验，防止目录穿越和 XSS 攻击。
- **怎么用**：无需操作，安全校验在后端自动执行。
- **注意**：
  - **realpath 锁死 cwd**：后端用 `fs.realpathSync` 解析请求路径，计算相对 cwd 的路径，若以 `..` 开头或为绝对路径则拒绝。唯一实现在 `src/lib/wiki-resolve.ts`（服务端专用），tree 与正文两个 route 都 import 它。
  - **扩展名白名单**：默认只允许 `.md`；项目可另配（见上方「自定义可读文件类型」），但 `*`/空/密钥类一律拒绝。
  - **文件必须存在**：`statSync` 校验文件存在且为普通文件（目录不会被当文件返回）。
  - **禁 raw HTML**：Markdown 渲染使用 `react-markdown`，默认不渲染原始 HTML 标签；非 `.md` 走 `<pre>` 转义。
  - **所有权隔离**：API 从 `x-user-id` 校验项目归属，只能访问自己的项目。

### 功能点：一个数据库字段（v35 前为零字段）

- **是什么**：Wiki 主要复用项目已有的 `cwd` 字段；v35 起多一个可选的 `projects.wiki_extra_extensions`（JSON 数组串，默认 `'[]'`）存放额外放行的扩展名。
- **怎么用**：只要项目配置了 `cwd`，wiki 自动可用；扩展名是可选项，不配就是默认行为。
- **注意**：
  - 若项目未设置 `cwd`，wiki 页面会提示"该项目未设置 cwd，无法浏览文档"。
  - 文档内容就是 cwd 下的实际文件，agent 用 Read 天然查阅，人看到的就是 agent 看到的同一份数据。
  - Wiki 只读，编辑文档走 git 或文件系统直接修改。

### 功能点：顶部快捷入口（飞书 R87）

- **是什么**：Wiki 页面顶部新增 `📊 Board` 和 `📋 需求` 两个快捷按钮，**项目导航侧边栏**在「其他任务」和「Wiki」之间也同步插入 `📊 Board` + `📋 需求` 两条。一站式从 wiki 跳到项目进度看板 / 需求点列表 / 反向跳转。
- **怎么用**：
  - Wiki 顶部 `📊 Board` → `/{projectId}/board?path=boards/project-progress.md`（带当前 version，无 version 不带）
  - Wiki 顶部 `📋 需求` → `/{projectId}/{currentVersionId|unversioned}/requirements`
  - 侧边栏 `📊 Board` / `📋 需求` 同上，需求跟随项目的 `current_version_id`，无 version 回退 `unversioned`
- **注意**：
  - 侧边栏条目高亮规则同 Wiki（路径包含匹配），所以从 board/需求点列表页面切回侧边栏能直接看到当前页对应高亮
  - Board 用 R66 引擎渲染 `boards/project-progress.md`（git 跟踪，与 R73 一致）

### 功能点：board 文件回落平台内置看板（飞书 R91）

- **是什么**：board 文件按「项目 cwd 优先 → 平台内置 `boards/` 回落」两级解析。项目 cwd 下没有 `boards/xxx.md` 时，自动用平台安装目录里的同名内置看板，不必往每个项目仓复制一份。
- **怎么用**：
  - 任意项目点侧边栏 `📊 Board` 都能直接看到 `boards/project-progress.md`（全局进度看板，按项目分组）和 `boards/platform-overview.md`（平台总览）
  - 项目要定制自己的看板 → 在自己 cwd 下建同名 `boards/xxx.md`，**项目文件永远优先**，覆盖平台默认
  - 数据是渲染时实时查的（api source + 只读 SQL），frontmatter `refresh: 30s` 客户端轮询 —— **没有也不需要定时任务预生成**
- **注意**：
  - 🔴 回落面**只有 `boards/` 一层**：平台安装目录的其他文件（`docs/`、`ecosystem.config.cjs` 等）不会被回落读到，否则任意登录用户都能借自己项目的 board 页读平台仓明文凭据
  - 项目 cwd 内的读取范围不变（仍是整个 cwd，与 R66 一致）
  - 回落看板的时间线（git 历史）查的是平台仓的 commit，不是项目仓
  - 两边都没有该文件时才显示「找不到 board 文件」引导页
  - 实现 `src/lib/board/resolve.ts`，测试 `src/lib/board/resolve.test.ts`（9 条，含越权/穿越/symlink 逃逸反测）

### 功能点：生成对外可点的 wiki 链接（wiki-link.sh）

- **是什么**：把一条文档路径变成带 project_id + version_id 的完整 wiki URL（贴到飞书 / 消息里，对方点开直接定位到渲染页）。
- **怎么用**：`bash scripts/wiki-link.sh <文档路径>` → 输出 `https://dao.example.com/#/<pid>/wiki?path=...&version=<vid>`（hash 路由：URL 必须带 `/#/` 前缀，缺了会落到旧 Next 壳页面）。入参支持 4 类形态：相对路径 / cwd 相对 / `~` / 绝对路径 / 项目别名+空格。
- **注意**：
  - `--env=dao`（默认）/ `wsl` / `wsl-ip` 切 host（公网 / 本机 / 内网 IP）
  - 跨项目跳转语法的实现（`project:{UUID}?path={relpath}`）在 `src/lib/wiki-links.ts`（详见上方「跨项目 Wiki 链接」功能点）
  - 详情看脚本头注释

## 常见问题

**Q: 为什么文件树是空的？**
A: 检查项目是否配置了 `cwd`，以及该目录下是否有 `.md` 文件。隐藏目录（以 `.` 开头）、深度超过 5 层的文件、以及默认排除的重目录（`node_modules`/`dist`/`build`/`coverage`/...）下的文件不会显示。

**Q: 为什么树里看不到我的 .json / .txt 文件？**
A: 默认只读 `.md`。去项目的 wiki 高级选项加上这些扩展名（空格分隔、不带点）。密钥类（`env`/`pem`/`key`…）和隐藏文件即使配了也不会放行。

**Q: 如何编辑 wiki 内容？**
A: Wiki 是只读的，直接在文件系统中修改 `.md` 文件即可（通过 git 或编辑器），刷新 wiki 页面即可看到更新。
