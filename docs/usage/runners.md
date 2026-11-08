# Runners（远程执行）— Operator SOP

> 给 admin / operator 的分步指南: **从 0 到能跑一次命令**。
>
> 设计 / 协议 / 安全细节见内部设计档（未随开源版发布）；本文件为使用视角说明。

---

## 0. 这篇适用什么场景

- 你手上有一台**非平台机器**（比如 mac / Windows / 备用 Linux），平台上 agent 需要在这台机器上跑**特定白名单命令**（典型: `cargo tauri build`、`npm run tauri build` 这类只能在原生 OS 跑的命令）
- 你不是工程实现者（那是 R2 / R3 的事），你是**注册 + 配 project + 验证**的运维角色
- 5 分钟跑通「注册一个 runner → 起 daemon → 平台看到 online → 配项目 → 验一条命令」

## 1. 前置 4 件事

1. 平台上你是 **admin**（`/settings` 顶部能看到「平台管理」tab）—— 否则 `/runners` 直接 redirect 到 `/`
2. 目标机能 SSH 出去（或你可以贴命令到那台机）—— daemon 自己起 HTTP server，无需 SSH
3. 目标机装了对应 go 二进制（或 `agent-orch-runner` 仓已 clone + `make build`）—— 当前 R2 还在 P1 (建仓) 阶段, 没到位前用临时冒烟路径（目标机手工跑 echo 验证连通）
4. 平台 → 目标机网络通（目标机 `:8081` 端口平台能 reach; LAN 即可, 不需要进路由器端口映射）

> 🔴 **别把 daemon 暴露到公网**。只在 LAN bind（macOS 默认就 0.0.0.0, 改 config.json 里的 `host` 字段没用 — Go HTTP 用 `addr`, 只 listen 不绑地址。所有防火墙 / 路由器层要做限制）。
> Token 是 shared secret, 一旦泄露 = 这台机器被任意执行白名单命令。

## 2. Step-by-step

### Step 1: 在平台注册 runner

打开 [/runners](http://localhost:13000/runners)（admin only），填：

- **name**: 自由文本，标识这台机器在平台上的代号（例: `mac-build`、`win-tauri`）
- **host**: 目标机的 IP（或 LAN hostname, 例: `192.168.3.243`）
- **port**: daemon HTTP 监听端口，默认 `8081`
- **os_type**: `macos` / `windows` / `linux` 三选一

点「注册」。

### Step 2: 复制一次性 token（关掉就再也看不到了）

注册成功后弹窗会显示一条 **64 字符的 hex 字符串**（256-bit token），格式:

```
a]b3c4d5e6f7...
```

立刻：
1. 点「复制 token」按钮（或手动整段复制）
2. 把它粘进你的本地密码管理器（**这是明文，不入库**）
3. 点「关闭」—— 关掉就再也看不到了，要重新走 Step 1 注册新 token，旧的同时失效

### Step 3: 在目标机起 daemon

TODO: 待 R2 (P1+ P2) 落地后补具体 daemon 命令。当前 P1 (建仓) 已派发但未交付，所以**此步当前不可执行**，等 R2 完成回填。

```bash
# R2 落地后:
git clone git@localhost:repos/agent-orch-runner.git   # 或 GitHub mirror
cd agent-orch-runner
make build           # or: make build-all (4 二进制)

mkdir -p ~/.agent-orch-runner
cat > ~/.agent-orch-runner/config.json <<EOF
{
  "runner_id": "<uuid from /runners list>",
  "name": "mac-build",
  "host": "192.168.3.243",
  "port": 8081,
  "platform_url": "http://localhost:13000",
  "auth_token": "<token from Step 2>",
  "max_concurrent": 4,
  "log_level": "info"
}
EOF
chmod 0600 ~/.agent-orch-runner/config.json

./runner --daemon   # 或 nohup ./runner --daemon &
```

### Step 4: 在平台确认 runner online

回到 [/runners](http://localhost:13000/runners) 列表：
- 状态 badge: 🟢 **在线** = 通了
- ⚫ **离线** / 🔴 **失联**: 看「健康检查」按钮 → 通常是 token 抄错 / 防火墙挡 / config.json 权限
- `last_heartbeat_at` 应在 10 秒内刷一次

### Step 5: 把项目接上 runner（高级选项面板）

回到首页 [/](http://localhost:13000/) → 找到目标项目 → 点「高级选项」→ 滚到 **🛰️ Runners（远程执行白名单）** 子块：

1. 点「+ 加入列表」（草稿态）
2. **runner**: 下拉选刚注册的 `mac-build`
3. **purpose**: 自由文本，解释为什么配这条（例: `mac-tauri-build`）
4. **cwd_mapping**: **必填**，daemon 上的物理路径，不是平台 WSL 的 `/home/user/...`
   - 例: 平台 cwd `/home/user/workspace/agent-orchestrator-dev` ↔ runner `/Users/user/workspace/agent-orch-runner`
5. **command_patterns**: 一行一条白名单命令
   - 例: `cargo tauri build` / `npm run tauri build`
   - 子串匹配（转义后 `.*`），不支持引号变体 / 路径前缀 —— （关键风险：子串匹配可能过宽，白名单条目要带足够上下文）
6. 点「+ 加入列表」 → 列表里多一条 entry
7. 面板底部「保存」

🔴 **「保存」一次 PATCH 整个高级选项**，所以并行保存会冲掉别人刚改的 ports / timeout_minutes / wiki_extra_extensions。多人同时改一处时, 先各自收起面板再保存。

### Step 6: 跑一条命令验证

R3 落地后, 派一个测试任务, agent Bash 跑白名单里的命令（如 `echo hello-from-mac`）:

- 正常: tool_result 以 `[runner:mac-build (192.168.3.243:8081) req=xxxxxxxx]` 开头, 含 `hello-from-mac`
- runner offline: tool_result body = "runner offline", deny（**不**静默本地执行）
- 命令不在白名单: 走本地 SDK bash, 跟以前一样

## 3. 故障排查

| 现象 | 诊断 |
|------|------|
| 平台列表显示 ⚫ 离线 | 检查 daemon 是否在跑（`ps aux \| grep runner`）；看 daemon 日志；点「健康检查」看 5s 内的失败原因 |
| 心跳报 401 + `decrypt_failed` | `ENCRYPTION_KEY` 轮换过 → 重 register runner + 重新配所有 llm_configs（一次性事故） |
| 心跳报 401 + `token_mismatch` | token 抄错 / daemon 配错 / 重 register 过没同步 → 拿 `/runners` 列表复制新 token 重写 config.json |
| 心跳报 401 + `token_missing` / `header_malformed` | daemon 没按规范传 `Authorization: Bearer <token>` → 看 daemon 实现 |
| daemon 起来但 exec 一直 deny "runner offline" | 平台 runner.status 还没翻到 online（30s 心跳窗口）；等 1 分钟或点「健康检查」手动触发 |
| 命令命中但 tool_result 一直 timeout | 看 runner 端 stdout 有无 stderr panic；通常是大输出 + tail 截断没起作用 —— 看 [format.test.ts](../../src/lib/runners/format.test.ts) |
| Bash tool_result 整个 `[runner:...]` 块被模型当成本地输出 | 模型指引没生效 —— 看 `docs/claude-config/docs/model-guidance/runner-tool-result.md`（R3 注入）|

## 4. 撤销 / 清理

- **临时停用**: `kill <daemon pid>` —— 心跳 30s 后 platform 自动标 offline, 白名单命中会被 deny
- **永久撤销**: `DELETE /api/runners/:id`（UI 「删除」按钮）—— token 立刻失效, daemon 下次心跳 401
- **项目不再用 runner**: PATCH `runners: null`（清空高级选项 Runners 子块）—— 下次保存后, 平台该项目的 Bash 全部回本地 SDK

## 5. API（直接 curl 时用）

| Method | Path | body / 说明 |
|--------|------|------|
| GET | `/api/runners` | 列表（admin） |
| POST | `/api/runners` | `{name, host, port, os_type}` 返 `{runner, token}`（**token 仅此一次**）|
| GET | `/api/runners/:id` | 单个 |
| DELETE | `/api/runners/:id` | 撤销注册 |
| POST | `/api/runners/:id/health` | 手动探针（5s 超时） |
| POST | `/api/runners/:id/heartbeat` | runner daemon 用, `Authorization: Bearer <token>` |
| PATCH | `/api/projects/:id` | body 加 `runners: [{runner_id, purpose, cwd_mapping, command_patterns[]}]` 字段; null = 清空 |

**curl 例**:
```bash
# admin 拿到 token, 走 JWT 鉴权
TOKEN="ao_xxx"
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"mac-build","host":"192.168.3.243","port":8081,"os_type":"macos"}' \
  http://localhost:13000/api/runners
# 把 token 字段粘回 config.json
```
