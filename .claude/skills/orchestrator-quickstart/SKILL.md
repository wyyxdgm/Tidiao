---
name: orchestrator-quickstart
description: 5 分钟跑通 agent-orchestrator 平台 demo（注册 → login → 建项目 → 派任务 → 看结果）。Use when the user wants to experience the platform end-to-end for the first time, or wants a copy-pasteable shell sequence to get a hello task running. 跨环境通用.
---

# orchestrator-quickstart

5 分钟跑通 demo。每步都给**具体命令**，出错给**修复命令**。所有命令默认打 `http://localhost:13000`——多实例时用 `AO_BASE_URL` 切换。

> 第一次接触平台？先看 [[orchestrator-onboarding]] 的「5 个核心场景」决策树。

## 何时用

- 第一次体验平台，需要 demo 验证
- 想抄一份能跑的命令清单
- 想给团队成员 onboarding

## 何时不该用本 skill

- 已熟悉平台、想查具体 API → 用 [[orchestrator-query]] / [[orchestrator-manage]]
- 卡死 / cron 失语 → 用 [[orchestrator-stuck]]
- 想派复杂任务 → 用 [[orchestrator-dispatch]] 的 7 段 prompt 模板
- 想从模板建项目 → 用 [docs/usage/19-templates.md](../../../docs/usage/19-templates.md)

## 流程总览

```
1. 注册 → 2. 登录拿 token → 3. 建项目 → 4. 派 hello 任务 → 5. 看结果
```

每步 30-60 秒，5 步合计约 5 分钟（含任务执行）。

---

## 步骤 1：注册

> 用全新邮箱（DB 已有同邮箱会报 409）。

```bash
curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo-'$RANDOM'@example.com","password":"demo123456."}'
```

**返回**：`{"user":{...},"token":"..."}` 或 `{"message":"..."}`。
- ✅ 200/201 → 进入步骤 2
- ❌ 409 → 邮箱已存在 → 换一个邮箱重试
- ❌ 400 → 密码太弱（要求 ≥ 8 位 + 数字 + 大写）

**BASE 默认值**：
- WSL 本机 → `BASE=http://localhost:13000`
- Mac 远程 WSL → `BASE=${AO_BASE_URL:-http://localhost:13000}`
- 切 dev 实例 (13001) → `BASE=http://localhost:13001`（本机起两个实例时）

> 🟡 **多实例注意**：跑着多个实例时，`localhost:13000` 只命中本机实例。操作远程/服务器实例必须显式 `export AO_BASE_URL=<实例地址>`，否则报 `Project not found` 多半是打错了库。

---

## 步骤 2：登录拿 session cookie

```bash
# 登录拿 cookie（7 天有效）
curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"<你注册的邮箱>","password":"demo123456."}' \
  -c /tmp/ao-cookies.txt
```

**验证**：
```bash
curl -s -b /tmp/ao-cookies.txt "$BASE/api/auth/me"
# 应返回你的用户信息（含 role=admin 因为是首个注册用户）
```

- ✅ 返回 user 信息 → 进入步骤 3
- ❌ 401 → 邮箱或密码错误 → 检查拼写
- ❌ 429 → 「错误次数过多，请 N 分钟后再试」 → 15 分钟内 5 次失败触发 → 等 15 分钟或 admin 跑 `~/workspace/agent-orchestrator/scripts/reset-password.sh`
- ❌ 502/503 → 服务没起 → 看 dev server / pm2 进程状态，确认平台已启动

**另一种：拿 bearer token**（不过期）：
```bash
bash ~/workspace/agent-orchestrator/scripts/user.sh token --name "my-cli"
# 输出形如: ao_abc123...   (平台发的不过期 token)
export AO_TOKEN=ao_abc123...
# 后续 curl 加: -H "Authorization: Bearer $AO_TOKEN"
```

---

## 步骤 3：建项目

```bash
# 1. 建 project
PID=$(curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello-demo","cwd":"/tmp"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
echo "project_id=$PID"

# 2. 建 version（自动绑 current，无需 PATCH）
VID=$(curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/versions" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PID\",\"name\":\"v1.0\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['id'])")
echo "version_id=$VID"
```

**验证**：
```bash
curl -s -b /tmp/ao-cookies.txt "$BASE/api/projects/$PID" | python3 -m json.tool
# 应看到 current_version_name=v1.0
```

- ✅ `current_version_name` 显示 `v1.0` → 进入步骤 4
- ❌ 401 → cookie 过期 → 回步骤 2
- ❌ 400 + `cwd is not a git repo` → cwd 留空（会自动隔离到 `$ORCHESTRATOR_HOME/projects/...`）或指向真 git 仓

---

## 步骤 4：派 hello 任务

```bash
TID=$(curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{
    \"project_id\":\"$PID\",
    \"version_id\":\"$VID\",
    \"title\":\"hello: 跑通 demo\",
    \"prompt\":\"你是 agent-orchestrator 的开发 agent。\\n\\n【任务】\\n读 README 顶部 '快速开始' 段，写一句中文总结（含：服务跑哪个端口、注册默认角色、DB 落点），写到 /tmp/hello-demo-output.md。\\n\\n【验证标准】\\n1. /tmp/hello-demo-output.md 文件存在\\n2. 文件第一行是中文总结\\n\\n【完成后】\\n输出 'hello demo 跑通' 一行。\",
    \"autoApprove\": true,
    \"effort\": \"low\",
    \"maxTurns\": 30
  }" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
echo "task_id=$TID"

# 启动
curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/tasks/$TID/start"
```

**监控**（可选）：
```bash
# 实时 SSE 流
curl -N -b /tmp/ao-cookies.txt "$BASE/api/tasks/$TID/stream"
# Ctrl+C 退出

# 或轮询状态
watch -n 5 "curl -s -b /tmp/ao-cookies.txt $BASE/api/tasks/$TID | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[\"task\"][\"status\"])'
```

- ✅ status=running → 等待 agent 执行
- ❌ 500 + `ANTHROPIC_API_KEY not configured` → 设置页配置 API Key（[01-快速上手 §API Key 配置](../../../docs/usage/01-getting-started.md)）

---

## 步骤 5：看结果

```bash
# 等任务完成（status=completed / reviewing）
sleep 60

# 看任务详情
curl -s -b /tmp/ao-cookies.txt "$BASE/api/tasks/$TID" | python3 -m json.tool

# 看 transcript（agent 的对话记录）
curl -s -b /tmp/ao-cookies.txt "$BASE/api/tasks/$TID/transcript?format=markdown" | tail -50

# 看 agent 写的文件
cat /tmp/hello-demo-output.md  # 第一行应该是中文总结

# 审批（如果 autoApprove=false）
curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/tasks/$TID/approve"
```

- ✅ /tmp/hello-demo-output.md 存在 + 第一行是中文 → **demo 跑通**
- ❌ status=failed → 看 `result` 字段，按错误码决策
- ❌ 卡在 running > 30 分钟 → 用 [[orchestrator-stuck]] 诊断

---

## 一键脚本（懒人版）

```bash
# 复制以下整段运行（替换 EMAIL 和 PASSWORD）
export BASE=http://localhost:13000
EMAIL="demo-$(date +%s)@example.com"
PASSWORD="demo123456."

# 1. 注册
curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"

# 2. 登录
curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  -c /tmp/ao-cookies.txt > /dev/null

# 3. 建项目 + version
PID=$(curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello-demo","cwd":"/tmp"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
VID=$(curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/versions" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PID\",\"name\":\"v1.0\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['id'])")

# 4. 派任务
TID=$(curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PID\",\"version_id\":\"$VID\",\"title\":\"hello: demo\",\"prompt\":\"你是 agent-orchestrator 的开发 agent。读 README 顶部 '快速开始' 段，写一句中文总结到 /tmp/hello-demo-output.md。验证：1. 文件存在 2. 第一行是中文。完成后输出 'hello demo 跑通'。\",\"autoApprove\":true,\"effort\":\"low\",\"maxTurns\":30}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
curl -s -b /tmp/ao-cookies.txt -X POST "$BASE/api/tasks/$TID/start" > /dev/null

echo "✅ 项目: $PID"
echo "✅ 版本: $VID"
echo "✅ 任务: $TID"
echo "✅ 监控: curl -N -b /tmp/ao-cookies.txt $BASE/api/tasks/$TID/stream"
```

---

## 故障速查

| 现象 | 原因 | 修复 |
|------|------|------|
| `curl: (7) Failed to connect` | 服务没起 / BASE 错 | `pm2 list` / 改 `BASE` |
| 401 | cookie 过期 | 重跑步骤 2 |
| 409 邮箱已存在 | DB 已注册过 | 换邮箱或换 `$RANDOM` |
| 429 错误次数过多 | 15 分钟内 5 次失败 | 等 15 分钟 |
| `ANTHROPIC_API_KEY not configured` | 没配 LLM key | 设置页配置 |
| `cwd is not a git repo` | cwd 不是 git 仓 | cwd 留空或指 git 仓 |
| `Project not found` | Mac 上 BASE 走 localhost | 改 `BASE=${AO_BASE_URL:-http://localhost:13000}` |
| 任务卡 running > 30min | agent 卡死 | 用 [[orchestrator-stuck]] |
| `UnsupportedModel` | 模型不支持 plan | 换 claude-sonnet-4 / glm-5.2 / MiniMax-M3 |

---

## 完成后的下一步

| 你想做的事 | 跳到哪 |
|-----------|--------|
| 派一个真实开发任务 | [[orchestrator-dispatch]]（7 段 prompt 模板） |
| 查任务状态 / 看 transcript | [[orchestrator-query]] |
| 改任务 / 暂停 / 取消 / 审批 | [[orchestrator-manage]] |
| 集成飞书 / webhook | [[orchestrator-advanced]] |
| 卡死排查 | [[orchestrator-stuck]] |
| 部署 / 备份 / cron | [[orchestrator-ops]] |
| 从模板建项目 | [docs/usage/19-templates.md](../../../docs/usage/19-templates.md) |

## 注意

- 本 skill 维护在仓内 `.claude/skills/orchestrator-quickstart/SKILL.md`
- 不依赖环境变量；跨环境可读
- session cookie 7 天过期；bearer token 不过期（推荐 CLI 长期用）
- 首个注册用户自动 admin；后续注册是普通 user
- API Key 在设置页配置（不是 quickstart 步骤里）
