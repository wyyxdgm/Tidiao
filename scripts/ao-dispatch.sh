#!/usr/bin/env bash
# ao-dispatch.sh — 通用任务派发 CLI
# 任何项目（含 agent 在执行任务时）都能通过此脚本向编排平台创建+启动任务
#
# 用法:
#   ao-dispatch.sh -p GDM -t "fix: 修复邮件发送失败" -m "修复 SMTP 连接超时问题..."
#   ao-dispatch.sh -p anflow -v v1.6 -t "feat: 添加导出功能" -m "..."
#   ao-dispatch.sh -p yidao -t "refactor: xxx" -m "..." --wait
#   ao-dispatch.sh --project-id 43b6a7f1-... -t "fix: xxx" -m "..."
#
# Goal-Driven Loop（条件完成型长跑）:
#   ao-dispatch.sh -p GDM -t "fix: 修复文档" -m "...<goal>...</goal>"
#   详见 docs/usage/18-goal-loop.md
#   - 必须 --auto-approve (脚本默认即 true, 但禁止 --no-auto-approve)
#   - prompt 必须含 <goal>...</goal> marker (作为完成条件)
#   - 可选 --goal-rounds N 覆盖 per-task max_goal_rounds（[0, 1000] 整数,
#     默认 20, 0 = 不限 sentinel; 不传则脚本默认写 body.goalRounds=20）
#   - agent 跑完后需用 goal_report 块自报告:
#       ```goal_report
#       [done|not_done|impossible]
#       [动作清单]
#       [产物清单]
#       ```
#   - grader (Haiku 4.5) 自动判 met/not_yet_met/impossible 三态
#   - met → reviewing, impossible → failed (goal_unreachable),
#     not_yet_met → 续跑直到 max_goal_rounds giveUp
#
# 依赖: curl, python3

set -euo pipefail

# --- 环境检测 + 默认值（共享 login.sh）---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"
PROJECT_NAME=""
VERSION_NAME=""
PROJECT_ID=""
VERSION_ID=""
DEFAULT_VERSION_ID=""
TITLE=""
MESSAGE=""
MESSAGE_FILE=""
CWD=""
DEPENDS_ON=""
EFFORT="medium"
# 🔴 2026-08-13 拍板：派发不限制轮次。
#   此前硬编码 80 —— 实测把 0d9d46fa（记账修复）在读完代码、正要动手时截断，
#   它 reviewing 时零 commit 零 checkpoint，形状与「干完了」完全一样。
#   空值 = 不传 maxTurns 字段 → 平台默认 200（active-session.ts:813）。
#   要限制仍可显式 --max-turns N。
MAX_TURNS=""
# Goal loop per-task 最大轮次覆盖 (--goal-rounds N). 默认 20 (跟 settings
#   DEFAULT_MAX_GOAL_ROUNDS 对齐). 范围 [0, 1000], 0 = 不限 sentinel (R143 四轮).
#   CLI 总是写 body.goalRounds (显式优于隐式, 调 API 端一目了然 + metadata 落库
#   可观测). 校验放在 CLI 早期, 不浪费 API 400 round-trip.
GOAL_ROUNDS="20"
AUTO_APPROVE=true
NO_START=false
WAIT=false
TAGS=""
DRY_RUN=false
PROJECT_FROM_ENV=false
FROM_TASK=""
NO_FROM_TASK=false
# v132 (D10): 前置门字段. dispatcher 派活时填 — 后置 LLM 反思 5 样本 0/5 命中,
#   派发那一瞬 dispatcher 知道为什么. CLI 缺 --why 时打反思提示 (不阻塞), 与
#   API 软警告同口径. 设计见 docs/plans/requirement-as-entity.md §18.
WHY=""
# 🆕 D19 (2026-09-22 拍板): --auto-fork-compress 智能分流开关. 配合
#   --from-task <id>: GET /api/tasks/<id> 拿 context_tokens + context_max,
#   ratio ≥ threshold → 调 POST /api/tasks/<id>/fork { compactFirst: true } 开
#   新 task 续跑; < threshold → 调 POST /api/tasks/<id>/refine 续旧 task. 不传
#   时行为完全向后兼容 (无 GET/fork/refine 调用, 走原 POST /api/tasks 路径).
#   设计参照 docs/plans/goal-loop.md §2 D3 + §3 阶段 4 continueGoalLoop().
AUTO_FORK_COMPRESS=false
# 阈值默认 200K 绝对 token (跟模型 200K context window 对齐, 实测 80% 已足够
#   fork); 用户可改: "0.8" (0-1 比例) / "200K" (K 后缀) / "1.5M" (M 后缀) /
#   "200000" (裸整数 > 1). 详见下方 parse_threshold_to_tokens().
CONTEXT_THRESHOLD="200K"
KIND=""
# 波 2.5 (docs/plans/auto-complete-dag.md D7.2#5): --auto-complete.
#   任务级自动验收, 仅 DAG 项目 (服务端校验, 400 AUTO_COMPLETE_REQUIRES_DAG 文案透出).
AUTO_COMPLETE=false
# Role 场景化 P2 (docs/plans/role-scoped-roles.md D2): --role NAME|UUID.
#   ROLE_ARG 存原始输入; ROLE_ID 存解析结果 (UUID 直传或按名解析, 空 = 未指定).
ROLE_ARG=""
ROLE_ID=""

# --- 帮助 ---
usage() {
  cat <<'EOF'
ao-dispatch.sh — 向编排平台派发任务

必选:
  -p, --project NAME       项目名（如 GDM、anflow）
  -t, --title TEXT         任务标题
  -m, --message TEXT       任务 prompt

可选:
  -v, --version NAME       版本名（如 v1.0），默认用项目 current_version
  -f, --message-file FILE  从文件读取 prompt（替代 -m）
      --project-id UUID    直接用项目 ID（跳过名称查询）
      --version-id UUID    直接用版本 ID（跳过名称查询）
      --cwd PATH           任务工作目录
      --depends-on UUIDS   逗号分隔依赖 task UUID 列表（POST 时一次性建）
      --effort LEVEL       low/medium/high/xhigh/max（默认 medium；原样透传给平台，
                          非 Claude 模型会静默降级，SDK sdk.d.ts:1803 max 仅
                          Fable 5 / Opus 4.6+ / Sonnet 4.6+ 生效）
      --max-turns N        最大 turn 数（空 = 不传 → 平台默认 200）
      --role NAME|UUID     角色预设（继承 system_prompt/model/effort/max_turns/allowed_tools；
                          UUID 直传；NAME 按目标项目可用集精确匹配 = 全局 + 本项目专属，
                          重名 / 跨项目专属 role 报错退出并列候选）
      --goal-rounds N      Goal loop per-task 最大轮次（[0, 1000] 整数，默认 20; 0 = 不限 sentinel）
      --auto-approve       自动审批工具调用（默认即 true；含 <goal> marker 时强制 true）
      --no-auto-approve    显式关闭自动审批（含 <goal> marker 时会被早期校验拦下）
      --auto-complete      任务级自动验收：完成后 reviewing 瞬间自动翻 completed（仅 DAG
                          项目可用，非 DAG 项目 400 AUTO_COMPLETE_REQUIRES_DAG）。
                          适用依赖链中间节点，不适用最终交付物（跳过验收门）
      --no-start           只创建不启动
      --wait               启动后等待完成（阻塞，30s 轮询）
      --tags TAGS          逗号分隔标签
      --from-task ID       派发方 task id（记录本任务由谁派发；完整 UUID 或短 hex 前缀均可）
      --no-from-task       不记录派发方（覆盖 ORCHESTRATOR_TASK_ID 自动继承）
      --auto-fork-compress 智能分流：配合 --from-task，自动判断 context 占用。ratio ≥ 阈值 → fork+compress 新 task；< 阈值 → refine 旧 task。设计参 docs/plans/goal-loop.md §2 D3
      --context-threshold N  fork 阈值（默认 200K = 200*1024 tokens）。accept: "200K" / "1.5M" / "200000"（绝对 token）/ "0.8"（0-1 比例）
      --why TEXT           v132 (D10) 派发这个任务的「为什么」. 缺失时打反思提示 (不阻塞), 详见 §18.4
      --kind K             v132 (D10) 价值枚举: unlock_capability | fix_bug | document_knowledge | advance_requirement | investigate
      --dry-run            只解析 project/version 并打印请求体，不创建任务
      --base URL           平台地址（默认 http://localhost:13000，可用 AO_BASE_URL 覆盖）
      --email EMAIL        登录邮箱（默认取 AO_EMAIL）
      --password PASS      登录密码（默认从 AO_PASSWORD 环境变量或内置）
  -h, --help               帮助

工具问题反馈:
  工具有问题 → ao-feedback "现象一句话" 派给开发项目处理

Goal-Driven Loop（条件完成型长跑，详见 docs/usage/18-goal-loop.md）:
  prompt 含 <goal>...</goal> marker + --auto-approve 才会进入 goal loop。agent 末尾
  需输出 goal_report 块自报告，grader 三态: met / not_yet_met / impossible。not_yet_met
  自动续跑直到 max_goal_rounds 翻 failed（goal_unreachable_max_rounds）。

  示例:
    # 最简 goal loop, 跑默认 20 轮
    ao-dispatch.sh -p GDM -t "fix: 文档统一" -m '把 R12-R20 文档统一格式 <goal>所有 R*.md 用同一套 frontmatter 与章节顺序</goal>'

    # 自定义轮次 + 0 sentinel（不限轮次，靠 agent 主动 impossible 早停）
    ao-dispatch.sh -p GDM -t "迁移" -m '...<goal>...</goal>' --goal-rounds 0

    # 折中 5 轮
    ao-dispatch.sh -p GDM -t "..." -m '...<goal>...</goal>' --goal-rounds 5 --wait

  早期校验（脚本本地拦, 不浪费 API 400 round-trip）:
    - prompt 含 <goal> 但 --no-auto-approve → exit 1（goal loop 强制 autoApprove=true）
    - prompt 含 <goal> 但缺 goal_report 格式说明 → 仅 stderr warning，不阻断
    - --goal-rounds 越界 [0, 1000] / 非整数 → exit 1

项目解析优先级（显式参数 > 环境变量继承）:
  1. --project-id UUID          最高，直接用
  2. -p/--project NAME          按名字查；查不到直接报错退出（不回落环境变量）
  3. ORCHESTRATOR_PROJECT_ID    仅在 1、2 都没给时继承（agent 子进程零配置派发）

派发方引用解析优先级:
  1. --no-from-task             最高，不记录
  2. --from-task ID             显式指定（完整 UUID 或短 hex 前缀, 短前缀走 API 反查）
  3. ORCHESTRATOR_TASK_ID       agent 子进程自动继承（零配置留下派发链, 同样接受短 ID）

环境变量:
  AO_TOKEN                 不过期 API token（优先于密码登录，格式 ao_...）
  AO_BASE_URL              平台地址（同 --base）
  AO_EMAIL                 登录邮箱（同 --email，AO_TOKEN 未设时用）
  AO_PASSWORD              登录密码（同 --password，优先于内置默认值）
  ORCHESTRATOR_TASK_ID     agent 子进程自动注入，作为派发方引用继承（同 --from-task）

示例:
  # 最简用法
  ao-dispatch.sh -p GDM -t "fix: 修复邮件发送" -m "修复 SMTP 连接超时"

  # 指定版本 + 等待完成
  ao-dispatch.sh -p anflow -v v1.6 -t "feat: 导出" -m "..." --wait

  # agent 自主派发子任务
  ao-dispatch.sh --project-id 43b6a7f1-... -t "子任务" -m "..."

  # agent 在任务里派子任务（自动带上本任务作为派发方，UI 可看到派发链）
  ao-dispatch.sh -p GDM -t "关联: 修邮件模板" -m "..."
EOF
  exit 0
}

# --- 参数解析 ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--project)     PROJECT_NAME="$2"; shift 2 ;;
    -t|--title)       TITLE="$2"; shift 2 ;;
    -m|--message)     MESSAGE="$2"; shift 2 ;;
    -f|--message-file) MESSAGE_FILE="$2"; shift 2 ;;
    -v|--version)     VERSION_NAME="$2"; shift 2 ;;
    --project-id)     PROJECT_ID="$2"; shift 2 ;;
    --version-id)     VERSION_ID="$2"; shift 2 ;;
    --cwd)            CWD="$2"; shift 2 ;;
    --depends-on)     DEPENDS_ON="$2"; shift 2 ;;
    --effort)         EFFORT="$2"; shift 2 ;;
    --max-turns)      MAX_TURNS="$2"; shift 2 ;;
    --goal-rounds)    GOAL_ROUNDS="$2"; shift 2 ;;
    --auto-approve)   AUTO_APPROVE=true; shift ;;
    --no-auto-approve) AUTO_APPROVE=false; shift ;;
    --auto-complete)  AUTO_COMPLETE=true; shift ;;
    --no-start)       NO_START=true; shift ;;
    --wait)           WAIT=true; shift ;;
    --tags)           TAGS="$2"; shift 2 ;;
    --from-task)      FROM_TASK="$2"; shift 2 ;;
    --no-from-task)   NO_FROM_TASK=true; shift ;;
    --auto-fork-compress) AUTO_FORK_COMPRESS=true; shift ;;
    --context-threshold) CONTEXT_THRESHOLD="$2"; shift 2 ;;
    --why)            WHY="$2"; shift 2 ;;
    --kind)           KIND="$2"; shift 2 ;;
    --role)           ROLE_ARG="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=true; shift ;;
    --base)           BASE_URL="$2"; shift 2 ;;
    --email)          EMAIL="$2"; shift 2 ;;
    --password)       PASSWORD="$2"; shift 2 ;;
    -h|--help)        usage ;;
    *) echo "未知参数: $1"; usage ;;
  esac
done

# --- 校验必选参数 ---
if [[ -z "$TITLE" ]]; then
  echo "❌ 缺少必选参数: -t / --title" >&2; exit 1
fi

if [[ -z "$MESSAGE" && -z "$MESSAGE_FILE" ]]; then
  echo "❌ 缺少必选参数: -m / --message 或 -f / --message-file" >&2; exit 1
fi

if [[ -z "$PROJECT_NAME" && -z "$PROJECT_ID" && -z "${ORCHESTRATOR_PROJECT_ID:-}" ]]; then
  echo "❌ 缺少必选参数: -p / --project 或 --project-id（也可通过 ORCHESTRATOR_PROJECT_ID 环境变量传入）" >&2; exit 1
fi

# v132 (D10) 反思提示: --why 缺失时打 5 类模板引导, 派发前 10 秒反思「为什么派这个任务」.
#   不阻塞 (与 API 同口径), 让 dispatcher 慢慢养成习惯. agent 子进程里非交互场景
#   (STDIN 已闭) 自动跳过, 避免卡住 pipeline. 详见 docs/plans/requirement-as-entity.md §18.4.
if [[ -z "$WHY" && -z "${AO_DISPATCH_SKIP_WHY_PROMPT:-}" ]]; then
  # 仅在交互终端 (tty) 才打完整 prompt; 非交互 (agent 子进程 / cron / 脚本) 跳过
  if [[ -t 0 && -t 1 && -t 2 ]]; then
    cat >&2 <<'REFLECTION'

💭 反思提示（D10 前置门）：请花 10 秒思考「为什么派发这个任务」

  模板（5 类任选其一填 --why，或自由写）：
    • 解锁什么能力？以后什么场景不用重写？
    • 修什么 bug？没有它会出什么事？
    • 沉淀什么知识？下次谁会需要？
    • 推进哪条需求点？完成后能解锁什么？
    • 探索什么未知？找到答案后下一步是什么？

  三选一继续：
    1) --why "<你的反思>"           → 带上价值入库
    2) --why "" -y / Ctrl+C         → 放弃这次派发
    3) Enter                         → 不填价值直接派发（UI 角标 ⚠ 未填价值）
REFLECTION
    # 给用户 5 秒快速确认. set -e 下 read 返回 0; 默认 Enter = 跳过反思直接派发
    read -r -t 5 _REPLY < /dev/tty || true
    if [[ "$_REPLY" =~ ^[yY]$ ]]; then
      echo "❌ 已放弃派发 (请带 --why 重新派发)" >&2; exit 1
    fi
  else
    echo "⚠️  D10 前置门: 缺 --why 派发（API 软警告, 不阻塞; agent 子进程默认跳过）" >&2
  fi
fi

# kind 枚举校验（不阻塞, 仅提示）. 应用层 getValueKindLabel 兜底映射 (5 枚举
#   + 自由串). 这里是给 dispatcher 早期反馈, 防止拼写错静默落库.
if [[ -n "$KIND" ]]; then
  case "$KIND" in
    unlock_capability|fix_bug|document_knowledge|advance_requirement|investigate) ;;
    *) echo "⚠️  D10 --kind '$KIND' 不在 5 枚举内 (unlock_capability/fix_bug/document_knowledge/advance_requirement/investigate), 仍落库但 UI 显示兜底标签" >&2 ;;
  esac
fi

# 从文件读取 prompt
if [[ -n "$MESSAGE_FILE" ]]; then
  MESSAGE="$(cat "$MESSAGE_FILE")"
fi

# D32: goal-loop 早期校验 —— prompt 含 <goal> marker 但 autoApprove=false = API 拒收 (漏洞 #5)
#   推送 pushMessage 到非 autoApprove task 时下一轮工具调用进审批 UI = loop 死锁。
#   这里提前拦，避免 POST 失败再 retry。脚本默认 AUTO_APPROVE=true，--no-auto-approve 才走到这里。
if [[ "$AUTO_APPROVE" != "true" ]] && [[ "$MESSAGE" =~ \<goal\> ]]; then
  echo "❌ prompt 含 <goal>...</goal> marker 但 auto_approve=false" >&2
  echo "   goal loop 强制 autoApprove=true (pushMessage 注入需要无人值守工具审批)" >&2
  echo "   去掉 --no-auto-approve, 或删 <goal> marker. 详见 docs/usage/18-goal-loop.md §怎么用" >&2
  exit 1
fi
# 友好提示: prompt 含 goal marker 但 prompt 缺 goal_report 块 → 只 warning (不阻断, 仅给作者提醒)
if [[ "$MESSAGE" =~ \<goal\> ]] && ! [[ "$MESSAGE" =~ goal_report ]]; then
  echo "⚠️  prompt 含 <goal> marker 但未见 goal_report 格式说明: agent 末尾需输出 goal_report 块自报告" >&2
fi

# --goal-rounds 早期校验 (CLI 拦, 不浪费 API 400 round-trip).
#   API 端 [0, 1000] 整数, code=GOAL_ROUNDS_INVALID (src/app/api/tasks/route.ts:174).
#   0 = 不限 sentinel (R143 四轮). 默认 20 (与 settings DEFAULT_MAX_GOAL_ROUNDS 对齐,
#   总有值所以无需 [-n] 守门).
if ! [[ "$GOAL_ROUNDS" =~ ^[0-9]+$ ]]; then
  echo "❌ --goal-rounds '$GOAL_ROUNDS' 不是合法整数 (应为 [0, 1000])" >&2
  echo "   详见 docs/usage/18-goal-loop.md §3.1 per-task 最大轮次" >&2
  exit 1
fi
if (( GOAL_ROUNDS < 0 || GOAL_ROUNDS > 1000 )); then
  echo "❌ --goal-rounds $GOAL_ROUNDS 越界 (合法 [0, 1000], 0 = 不限)" >&2
  echo "   详见 docs/usage/18-goal-loop.md §3.1 per-task 最大轮次" >&2
  exit 1
fi

# --- 鉴权（共享 login.sh：AO_TOKEN 优先，否则密码换 session） ---
ao_resolve_auth   # 设 AO_AUTH / AO_AUTH_MODE
AUTH="$AO_AUTH"   # 兼容下方既有 $AUTH 引用
API_CURL="curl -sf -H '$AUTH' -H 'Content-Type: application/json'"

# --- 查询 project_id（顺便取 current_version_id 作为默认版本）---
# 优先级: --project-id > -p/--project NAME > ORCHESTRATOR_PROJECT_ID 继承
# 关注点: 显式参数必须先于环境变量, 否则 agent 子进程里 -p 会被静默吃掉派错项目;
#         -p 查不到项目直接 exit 1, 不回落环境变量（回落会重新引入该 bug）。
if [[ -n "$PROJECT_ID" && -n "$PROJECT_NAME" ]]; then
  echo "⚠️  同时给了 --project-id 和 -p/--project，按优先级使用 --project-id，忽略 -p $PROJECT_NAME" >&2
fi

if [[ -z "$PROJECT_ID" ]]; then
  if [[ -n "$PROJECT_NAME" ]]; then
    # 同时取 project id 和 current_version_id（空格分隔）
    # 名称解析四级: 精确 > 别名表 > 大小写不敏感 > 子串唯一匹配。
    # 关注点: 口语别名（如团队惯用简称 → DB 显示名）可配在 ALIASES 表，
    #         不配则走精确/大小写不敏感/唯一子串匹配。
    #         查不到时把可用项目名打到 stderr, 别让调用方靠猜。
    READ_RESULT=$(eval "$API_CURL '$BASE_URL/api/projects'" \
      | PROJECT_NAME="$PROJECT_NAME" python3 -c "
import sys, os, json
name = os.environ['PROJECT_NAME']
ALIASES = {
}
projects = json.load(sys.stdin).get('projects', [])
by_name = {p['name']: p for p in projects}

def dup_err(ms):
    print('⚠️  项目名重名 %d 个（跨 owner）:' % len(ms), file=sys.stderr)
    for m in ms:
        print('   %s  owner=%s  created=%s' % (m['id'], (m.get('owner_id') or '?')[:8], m.get('created_at','?')), file=sys.stderr)
    print('   用 --project-id <UUID> 显式指定，不做猜测（跨 owner 重名会撞 404）', file=sys.stderr)

def pick(n):
    a = ALIASES.get(n.lower())
    if a:
        n = a  # 别名先还原成显示名，走同一套精确匹配 + 重名守卫
    ms = [p for p in projects if p['name'] == n]
    if len(ms) > 1:
        dup_err(ms)
        return None
    if ms:
        return ms[0]
    ci = [p for p in projects if p['name'].lower() == n.lower()]
    if len(ci) == 1:
        return ci[0]
    sub = [p for p in projects if n.lower() in p['name'].lower()]
    if len(sub) == 1:
        return sub[0]
    return None

p = pick(name)
if p is None:
    print('   可用项目: ' + ', '.join(sorted(by_name)), file=sys.stderr)
    print(' ', end='')
else:
    if p['name'] != name:
        print('📋 项目名解析: %s → %s' % (name, p['name']), file=sys.stderr)
    print(p['id'] + ' ' + (p.get('current_version_id') or ''), end='')
" || echo " ")
    PROJECT_ID="${READ_RESULT%% *}"
    DEFAULT_VERSION_ID="${READ_RESULT#* }"
    if [[ -z "$PROJECT_ID" ]]; then
      echo "❌ 找不到项目: $PROJECT_NAME" >&2; exit 1
    fi
  elif [[ -n "${ORCHESTRATOR_PROJECT_ID:-}" ]]; then
    # 既没给 --project-id 也没给 -p 时才继承（agent 子进程零配置派发）
    PROJECT_ID="$ORCHESTRATOR_PROJECT_ID"
    PROJECT_FROM_ENV=true
    echo "📋 从环境变量继承 project_id: $PROJECT_ID" >&2
  fi
fi

# 如果用 --project-id 直接传入，也查一次取 current_version_id
if [[ -z "$DEFAULT_VERSION_ID" && -n "$PROJECT_ID" ]]; then
  DEFAULT_VERSION_ID=$(eval "$API_CURL '$BASE_URL/api/projects'" \
    | python3 -c "
import sys, json
pid = '$PROJECT_ID'
for p in json.load(sys.stdin).get('projects', []):
    if p['id'] == pid:
        print(p.get('current_version_id') or '')
        break
else:
    print('', end='')
" 2>/dev/null || echo "")
fi

# --- 查询 version_id（显式指定 -v 时） ---
if [[ -n "$VERSION_NAME" && -z "$VERSION_ID" ]]; then
  VERSION_ID=$(eval "$API_CURL '$BASE_URL/api/versions?project=$PROJECT_ID'" \
    | python3 -c "
import sys, json
name = '$VERSION_NAME'
for v in json.load(sys.stdin).get('versions', []):
    if v['name'] == name:
        print(v['id'])
        break
else:
    print('', end='')
" 2>/dev/null || echo "")
  if [[ -z "$VERSION_ID" ]]; then
    echo "⚠️  找不到版本: ${VERSION_NAME}，将使用项目默认版本" >&2
  fi
fi

# 如果仍未指定 version，尝试从环境变量继承（agent 子进程自动注入）
# 关注点: 只在 project 也来自同一组环境变量时才继承, 否则会把本会话的 version
#         泼到另一个项目的任务上（version 属于 project, 跨项目无意义）。
if [[ -z "$VERSION_ID" && -z "$VERSION_NAME" && -n "${ORCHESTRATOR_VERSION_ID:-}" ]]; then
  if [[ "$PROJECT_FROM_ENV" == "true" ]]; then
    VERSION_ID="$ORCHESTRATOR_VERSION_ID"
    echo "📋 从环境变量继承 version_id: $VERSION_ID" >&2
  else
    echo "ℹ️  已显式指定项目，忽略环境变量 ORCHESTRATOR_VERSION_ID（跨项目版本无效）" >&2
  fi
fi

# 仍未指定 version -> 用项目 current_version_id（不传 -v 时自动选当前版本）
if [[ -z "$VERSION_ID" && -n "$DEFAULT_VERSION_ID" ]]; then
  VERSION_ID="$DEFAULT_VERSION_ID"
  echo "📋 自动使用项目当前版本: $VERSION_ID" >&2
fi

# --- 解析派发方引用 ---
# 优先级: --no-from-task > --from-task > ORCHESTRATOR_TASK_ID 继承
# 关注点: 与 project 不同, task 引用跨项目也合法（子任务常落在另一个仓库的
#         project 上）, 所以显式指定项目时不需要放弃继承——派发链本身就是跨项目的。
#
# 接受三种格式: 完整 UUID / 短 ID (1-35 位 hex 前缀, 走 API 反查) / 显式置空 (--no-from-task).
# 短 ID 路径走 GET /api/tasks/<prefix>, 与前端 / 9-char URL 同口径 (src/lib/db/tasks.ts:370).
# 0826 P1 (撞同根第 3 次 = charter §预设 1 强制修): 不合法的值 (如老 sheetwatch 字符串
# fallback "sheetwatch") 不再透传到 platform. Platform 层 src/lib/db/tasks.ts:222-230
# 也有同款降级 (warn + 不注入 block), wrapper 提前止损可省一次 HTTP round-trip.
resolve_task_ref() {
  local ref="$1"
  local source_label="$2"   # "--from-task" 或 "环境变量 ORCHESTRATOR_TASK_ID"
  local full_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  local short_re='^[0-9a-fA-F-]+$'

  # 完整 UUID: 直接返回
  if [[ "$ref" =~ $full_re ]]; then
    echo "$ref"
    return 0
  fi

  # 短 ID 路径: length 1-35 且全 hex/- (mirrors API 短 ID 解析)
  if [[ ${#ref} -lt 36 && "$ref" =~ $short_re ]]; then
    local resp result rc
    # --fail-with-body (curl ≥7.83): HTTP 4xx/5xx 时 exit != 0 但 body 仍在 stdout.
    # 不用 $API_CURL 的 -sf 因为 -f 会吞掉 body → 无法区分 404/409.
    resp=$(curl -s --fail-with-body -H "$AUTH" "$BASE_URL/api/tasks/$ref" 2>/dev/null) || true
    if [[ -n "$resp" ]]; then
      result=$(printf '%s' "$resp" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("FAIL"); sys.exit(1)
if d.get("error") == "Ambiguous short ID":
    print("AMBIGUOUS"); sys.exit(0)
rid = d.get("id", "")
if rid:
    print(rid); sys.exit(0)
print("FAIL"); sys.exit(1)
')
      rc=$?
      if [[ $rc -eq 0 && -n "$result" && "$result" != "AMBIGUOUS" && "$result" != "FAIL" ]]; then
        echo "📋 短 ID 解析: $ref → $result (${source_label})" >&2
        echo "$result"
        return 0
      fi
      if [[ "$result" == "AMBIGUOUS" ]]; then
        echo "⚠️  ${source_label} '$ref' 短 ID 匹配到多个 task, 降级为不记录派发方 (用更长前缀)" >&2
        return 1
      fi
    fi
    echo "⚠️  ${source_label} '$ref' 短 ID 查不到, 降级为不记录派发方" >&2
    return 1
  fi

  # 既不是完整 UUID 也不是合法短 ID 格式 (含非 hex 字符 / 长度 ≥ 36 但不像 UUID)
  echo "⚠️  ${source_label} '$ref' 不是合法 UUID 格式, 降级为不记录派发方 (撞同根第 3 次)" >&2
  return 1
}

if [[ "$NO_FROM_TASK" == "true" ]]; then
  FROM_TASK=""
elif [[ -n "$FROM_TASK" ]]; then
  # || true: 函数返回 1 (resolve 失败) 时不让 set -e 触发脚本退出, stderr 警告仍可见
  FROM_TASK=$(resolve_task_ref "$FROM_TASK" "--from-task" || true)
elif [[ -n "${ORCHESTRATOR_TASK_ID:-}" ]]; then
  FROM_TASK=$(resolve_task_ref "$ORCHESTRATOR_TASK_ID" "环境变量 ORCHESTRATOR_TASK_ID" || true)
fi

# --- --role 解析 (Role 场景化 P2, docs/plans/role-scoped-roles.md D2) ---
#   UUID 直传; NAME 按目标项目可用集精确匹配 (P1 语义: 全局 + 本项目专属,
#   GET /api/roles owner 隔离, CLI 侧再按 project_id 过滤).
#   守卫惯例 (docs/fixes/2026-10-12-project-name-collision.md): 全局 + 项目专属
#   可同名 (唯一约束 = owner + COALESCE(project_id,'')) → 重名 = 歧义 = 显式失败
#   列候选, 不猜; 名字存在但属别的项目 → 明示作用域不符, 不静默丢弃
#   (role 是行为预设, 静默丢 = 派发行为悄悄变).
if [[ -n "$ROLE_ARG" ]]; then
  ROLE_UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  if [[ "$ROLE_ARG" =~ $ROLE_UUID_RE ]]; then
    ROLE_ID="$ROLE_ARG"
    echo "📋 role: UUID 直传 $ROLE_ID" >&2
  else
    ROLES_JSON=$(curl -sf -H "$AUTH" "$BASE_URL/api/roles" 2>/dev/null) || \
      { echo "❌ GET /api/roles 失败 (auth? 网络?) --role 无法按名解析" >&2; exit 1; }
    ROLE_ID=$(ROLES_JSON="$ROLES_JSON" PROJECT_ID="$PROJECT_ID" ROLE_ARG="$ROLE_ARG" python3 -c "
import sys, os, json
try:
    roles = json.loads(os.environ['ROLES_JSON'])
except Exception:
    roles = []
pid, name = os.environ['PROJECT_ID'], os.environ['ROLE_ARG']
avail = [r for r in roles if not r.get('project_id') or r['project_id'] == pid]
ms = [r for r in avail if r['name'] == name]
if len(ms) == 1:
    print(ms[0]['id']); sys.exit(0)
if len(ms) > 1:
    print('⚠️  role 名重名 %d 个（全局 + 项目专属可同名）:' % len(ms), file=sys.stderr)
    for m in ms:
        print('   %s  project=%s' % (m['id'], m.get('project_id') or '(global)'), file=sys.stderr)
    print('   用 --role <UUID> 显式指定', file=sys.stderr)
    sys.exit(3)
oos = [r for r in roles if r['name'] == name]
if oos:
    print('⚠️  role「%s」存在但不适用于本项目（项目专属 role 跨项目不可用, 用了会 400 ROLE_SCOPE_MISMATCH）:' % name, file=sys.stderr)
    for m in oos:
        print('   %s  project=%s' % (m['id'], m.get('project_id') or '(global)'), file=sys.stderr)
    sys.exit(3)
names = sorted(set(r['name'] for r in avail))
print('   可用 role: ' + (', '.join(names) or '(无)'), file=sys.stderr)
sys.exit(3)
") || ROLE_ID=""
    if [[ -z "$ROLE_ID" ]]; then
      echo "❌ --role '$ROLE_ARG' 解析失败 (project=$PROJECT_ID)" >&2
      exit 1
    fi
    echo "📋 role 解析: $ROLE_ARG → $ROLE_ID" >&2
  fi
fi

# --- 🆕 D19: --auto-fork-compress 智能分流 ---
#   触发条件: --auto-fork-compress + --from-task 都传了 → 调 GET 父 task,
#     按 context_tokens / context_max 比例决策切走 fork 路径或 refine 路径.
#   不传 → 走原 POST /api/tasks 路径 (向后兼容).
#   关注点:
#   - --auto-fork-compress 必须配 --from-task; 反之 --from-task 可独立使用 (派发链溯源).
#   - threshold 双语义: "200K" / "1.5M" / "200000" = 绝对 token; "0.8" = 0-1 比例.
#     解析规则封装在 parse_threshold_to_tokens() 下面.
#   - refine 路径要求父 task 处于 reviewing/running (refine API 设计). 若父 task
#     不在该状态, API 返 400 → 脚本透传错误, 不 fallback 到 fork (避免掩盖用户意图).
#   - 成功路径 stdout 末行输出 `mode=fork|resume task_id=<id>`, 方便上层 agent
#     解析拿 task id 继续派下游. 设计参 docs/usage/18-goal-loop.md §D3.

# 解析 --context-threshold 到绝对 token 数. 失败 → exit 1.
# 接受格式:
#   - "<num>K" / "<num>k" → num * 1024
#   - "<num>M" / "<num>m" → num * 1024 * 1024
#   - "<num>" 且 num > 1 → 直接当绝对 token
#   - "<num>" 且 0 < num <= 1 → 当比例, 调用方需自行 * context_max 转 token
parse_threshold_to_tokens() {
  local raw="$1"
  # K / M 后缀
  if [[ "$raw" =~ ^([0-9]*\.?[0-9]+)[Kk]$ ]]; then
    echo "$(python3 -c "print(int(float('${BASH_REMATCH[1]}') * 1024))")"
    return 0
  fi
  if [[ "$raw" =~ ^([0-9]*\.?[0-9]+)[Mm]$ ]]; then
    echo "$(python3 -c "print(int(float('${BASH_REMATCH[1]}') * 1024 * 1024))")"
    return 0
  fi
  # 裸数字
  if [[ "$raw" =~ ^[0-9]*\.?[0-9]+$ ]]; then
    # 0-1 视为比例 → 哨兵 -1 让 caller 自己处理 (不能跟 token 同语义, 必须分开)
    # 但 CLI 想要"单值表达", 这里约定: <= 1.0 一律按比例解析 (含 1.0 = 100%)
    # 调用方拿到比例后会用 * context_max 转 token.
    # > 1.0 → 当绝对 token.
    local val="${BASH_REMATCH[0]}"
    # 用 python 比较避免 bc 不在路径上的问题
    local is_ratio
    is_ratio=$(python3 -c "print('1' if float('$val') <= 1.0 else '0')")
    if [[ "$is_ratio" == "1" ]]; then
      echo "RATIO:$val"   # 哨兵前缀让 caller 区分
    else
      echo "$(python3 -c "print(int(float('$val')))")"
    fi
    return 0
  fi
  echo "❌ --context-threshold '$raw' 不是合法格式 (期望: 200K / 1.5M / 0.8 / 200000)" >&2
  return 1
}

if [[ "$AUTO_FORK_COMPRESS" == "true" ]]; then
  # 1. --auto-fork-compress 必须配 --from-task
  if [[ -z "$FROM_TASK" ]]; then
    echo "❌ --auto-fork-compress 必须配 --from-task <id> (要查询哪个父 task 的 context)" >&2
    echo "   设计见 docs/plans/goal-loop.md §2 D3" >&2
    exit 1
  fi

  # 2. 解析阈值 (CLI 早期校验, 不浪费 HTTP round-trip)
  THRESHOLD_RAW=$(parse_threshold_to_tokens "$CONTEXT_THRESHOLD") || exit 1
  IS_RATIO="false"
  THRESHOLD_TOKENS=""
  THRESHOLD_RATIO="0"  # 占位, set -u 防止未绑定 (下面 python 按 IS_RATIO 决定读不读)
  if [[ "$THRESHOLD_RAW" =~ ^RATIO: ]]; then
    IS_RATIO="true"
    THRESHOLD_RATIO="${THRESHOLD_RAW#RATIO:}"
  else
    THRESHOLD_TOKENS="$THRESHOLD_RAW"
  fi

  # 3. GET 父 task 拿 context_tokens + context_max
  PARENT_TASK_JSON=$(curl -sf -H "$AUTH" "$BASE_URL/api/tasks/$FROM_TASK" 2>/dev/null) || {
    echo "❌ GET /api/tasks/$FROM_TASK 失败 (auth? 网络? id 不存在?)" >&2
    exit 1
  }
  # python 解析 context_tokens / context_max (snake_case, 见 src/app/api/tasks/[id]/route.ts:62)
  read -r CTX_TOKENS CTX_MAX < <(echo "$PARENT_TASK_JSON" | CONTEXT_MAX_OUT="" python3 -c "
import sys, json
t = json.load(sys.stdin)
ct = t.get('context_tokens')
cm = t.get('context_max')
print('' if ct is None else int(ct), '' if cm is None else int(cm))
")
  if [[ -z "$CTX_TOKENS" || -z "$CTX_MAX" ]]; then
    echo "❌ 父 task $FROM_TASK 缺 context_tokens / context_max 快照 (任务未跑完/未上报?)" >&2
    echo "   字段语义: tasks.context_tokens (实测 token 数) / tasks.context_max (模型窗口)" >&2
    exit 1
  fi

  # 4. 决策: fork vs resume (用 python 一次算清 + 输出决策原因)
  read -r SHOULD_FORK DECISION_REASON < <(CTX_TOKENS="$CTX_TOKENS" CTX_MAX="$CTX_MAX" \
    THRESHOLD_TOKENS="$THRESHOLD_TOKENS" THRESHOLD_RATIO="$THRESHOLD_RATIO" \
    IS_RATIO="$IS_RATIO" python3 -c "
import os, sys
ct = int(os.environ['CTX_TOKENS'])
cm = int(os.environ['CTX_MAX'])
is_ratio = os.environ['IS_RATIO'] == 'true'

if is_ratio:
    tr = float(os.environ['THRESHOLD_RATIO'])
    ratio = ct / cm if cm > 0 else 0
    fork = (cm > 0) and (ratio >= tr)
    reason = f'ratio={ct}/{cm}={ratio:.3f} threshold={tr}'
else:
    tt = int(os.environ['THRESHOLD_TOKENS'])
    fork = ct >= tt
    reason = f'tokens={ct} threshold={tt}'
print('true' if fork else 'false', reason)
")

  if [[ "$SHOULD_FORK" == "true" ]]; then
    # === fork 路径: POST /api/tasks/<id>/fork { compactFirst: true, prompt: MESSAGE } ===
    echo "🔀 [auto-fork-compress] 触发 fork+compress: $DECISION_REASON" >&2
    FORK_BODY_FILE=$(mktemp -t ao-dispatch-fork.XXXXXX.json)
    # trap 兜底在末尾统一注册 (含 ${VAR:-} 防 set -u 未绑定)
    python3 - "$MESSAGE" "$FORK_BODY_FILE" <<'PYEOF'
import sys, json
prompt, body_file = sys.argv[1], sys.argv[2]
with open(body_file, "w", encoding="utf-8") as fh:
    json.dump({"prompt": prompt, "compactFirst": True}, fh, ensure_ascii=False)
PYEOF
    FORK_RESULT=$(curl -s -X POST "$BASE_URL/api/tasks/$FROM_TASK/fork" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      --data-binary "@$FORK_BODY_FILE")
    NEW_TASK_ID=$(echo "$FORK_RESULT" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
except Exception:
    print('ERROR'); sys.exit(0)
if r.get('error'):
    print('ERROR: ' + r['error']); sys.exit(0)
print(r.get('new_task_id', ''))
" 2>/dev/null || echo "")
    if [[ -z "$NEW_TASK_ID" || "$NEW_TASK_ID" == ERROR* ]]; then
      echo "❌ fork 失败: $NEW_TASK_ID" >&2
      echo "   响应: $FORK_RESULT" >&2
      exit 1
    fi
    rm -f "$FORK_BODY_FILE"
    echo "✅ fork+compress 成功: 新 task $NEW_TASK_ID (从 $FROM_TASK fork)"
    echo "   平台: $BASE_URL/#/tasks/$NEW_TASK_ID"
    # stdout 末行 = 上层 agent 解析用 (mode + task_id)
    echo "mode=fork task_id=$NEW_TASK_ID"
    exit 0
  else
    # === resume 路径: POST /api/tasks/<id>/refine { message: MESSAGE } ===
    echo "🔁 [auto-fork-compress] 走 resume (refine): $DECISION_REASON" >&2
    REFINE_BODY_FILE=$(mktemp -t ao-dispatch-refine.XXXXXX.json)
    python3 - "$MESSAGE" "$REFINE_BODY_FILE" <<'PYEOF'
import sys, json
prompt, body_file = sys.argv[1], sys.argv[2]
with open(body_file, "w", encoding="utf-8") as fh:
    json.dump({"message": prompt}, fh, ensure_ascii=False)
PYEOF
    REFINE_RESULT=$(curl -s -X POST "$BASE_URL/api/tasks/$FROM_TASK/refine" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      --data-binary "@$REFINE_BODY_FILE")
    REFINE_STATUS=$(echo "$REFINE_RESULT" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
except Exception:
    print('ERROR'); sys.exit(0)
if r.get('error'):
    print('ERROR: ' + r['error']); sys.exit(0)
print(r.get('status', ''))
" 2>/dev/null || echo "")
    if [[ -z "$REFINE_STATUS" || "$REFINE_STATUS" == ERROR* ]]; then
      echo "❌ refine 失败: $REFINE_STATUS" >&2
      echo "   响应: $REFINE_RESULT" >&2
      echo "   提示: refine 仅在 reviewing/running 状态可用 (R131, 取代旧 /reject)" >&2
      exit 1
    fi
    rm -f "$REFINE_BODY_FILE"
    echo "✅ refine 成功: task $FROM_TASK 状态 → $REFINE_STATUS, prompt 已注入"
    echo "   平台: $BASE_URL/#/tasks/$FROM_TASK"
    echo "mode=resume task_id=$FROM_TASK"
    exit 0
  fi
fi

# --- 构建请求体（tmpfile 路径）---
#   关注点: 之所以放弃旧版 shell 变量插值到 python heredoc 的写法，是因为
#   prompt 含 ' ''' 或 \$ 时 python triple-quote 会提前闭合 → 整段派发静默
#   走样（旧坑）。新方案：prompt 走文件 + 其它字段走 python argv → python source
#   完全静态，不受任何字符影响。详见 docs/fixes/2026-08-24-dispatch-pitfalls.md。
PROMPT_FILE=$(mktemp -t ao-dispatch-prompt.XXXXXX)
BODY_FILE=$(mktemp -t ao-dispatch-body.XXXXXX.json)
# D19 trap 修复: --auto-fork-compress 早退 (未到达此处) 路径下 PROMPT_FILE /
#   BODY_FILE 未定义, set -u 下 `${PROMPT_FILE}` 直接 unbound error → exit 1.
#   兜底: 先 guard 再 rm -f (-f 让"文件不存在"也 exit 0, 不影响).
trap 'rm -f "${PROMPT_FILE:-}" "${BODY_FILE:-}" "${FORK_BODY_FILE:-}" "${REFINE_BODY_FILE:-}"' EXIT

# prompt 内容原样落入文件（printf %s 不加换行, UTF-8 不动）
printf '%s' "$MESSAGE" > "$PROMPT_FILE"

# python argv order (固定, 见注释 + docs/fixes):
#   1=TITLE 2=PROMPT_FILE 3=BODY_FILE 4=PROJECT_ID 5=VERSION_ID 6=CWD
#   7=TAGS 8=FROM_TASK 9=EFFORT 10=MAX_TURNS 11=AUTO_APPROVE 12=DEPENDS_ON
#   13=WHY 14=KIND 15=GOAL_ROUNDS 16=ROLE_ID 17=AUTO_COMPLETE
python3 - "$TITLE" "$PROMPT_FILE" "$BODY_FILE" \
  "$PROJECT_ID" "$VERSION_ID" "$CWD" "$TAGS" "$FROM_TASK" \
  "$EFFORT" "$MAX_TURNS" "$AUTO_APPROVE" "$DEPENDS_ON" \
  "$WHY" "$KIND" "$GOAL_ROUNDS" "$ROLE_ID" "$AUTO_COMPLETE" <<'PYEOF'
import sys, json
title, prompt_file, body_file, project_id, version_id, cwd, tags, from_task, effort, max_turns, auto_approve, depends_on, why, kind, goal_rounds, role_id, auto_complete = sys.argv[1:]
with open(prompt_file, encoding="utf-8") as f:
    prompt = f.read()
body = {
    "title": title,
    "prompt": prompt,
    "project_id": project_id,
    "effort": effort,
    # server 端读 body.autoApprove (camelCase), 字段别名 auto_approve 不识别 (2026-09-14
    # D25 验证: snake 触发 goal-marker autoApprove=false 路径, 误返 GOAL_REQUIRES_AUTO_APPROVE)
    "autoApprove": auto_approve.lower() == "true",
}
if max_turns:
    body["maxTurns"] = int(max_turns)
# Goal loop per-task 最大轮次 (R143 二轮). API 端 [0, 1000] 整数校验
#   (src/app/api/tasks/route.ts:174). 0 = 不限 sentinel. CLI 默认 20 总是写 body.goalRounds
#   (显式优于隐式, 调 API 端一目了然 + metadata 落库可观测). CLI 早期已拦越界/非整数,
#   这里 int() 不会失败但留作 defense-in-depth.
body["goalRounds"] = int(goal_rounds)
if version_id:
    body["version_id"] = version_id
if cwd:
    body["cwd"] = cwd
if tags:
    body["tags"] = tags.split(",")
if from_task:
    body["dispatched_by_task_id"] = from_task
if depends_on:
    body["depends_on_ids"] = [x.strip() for x in depends_on.split(",") if x.strip()]
# v132 (D10): 前置门字段透传 body. 空串判 None 与 API 兜底一致
#   (避免传 "" 触发 API trim 后变 null, 但仍被 API console.warn).
if why:
    body["value_significance"] = why
if kind:
    body["value_kind"] = kind
# Role 场景化 P2 (D2): role_id 透传 (校验在服务端 createTask: 存在+owner+作用域).
if role_id:
    body["role_id"] = role_id
# 波 2.5 (D7): auto_complete 透传. server 读 body.autoComplete (camelCase, 同
#   autoApprove 口径). 非 DAG 项目服务端 400 AUTO_COMPLETE_REQUIRES_DAG, 由下方
#   创建失败的通用错误出口透出文案.
if auto_complete == "true":
    body["autoComplete"] = True
with open(body_file, "w", encoding="utf-8") as fh:
    json.dump(body, fh, ensure_ascii=False)
PYEOF

# --- dry-run: 只打印解析结果, 不创建任务 ---
if [[ "$DRY_RUN" == "true" ]]; then
  echo "🧪 dry-run（未创建任务）"
  echo "   project_id: $PROJECT_ID"
  echo "   version_id: ${VERSION_ID:-<none>}"
  echo "   from_task:  ${FROM_TASK:-<none>}"
  echo "   role_id:    ${ROLE_ID:-<none>}"
  echo "   auto_complete: $AUTO_COMPLETE"
  echo "   depends_on: ${DEPENDS_ON:-<none>}"
  echo "   body_file:  $BODY_FILE"
  echo "   ---"
  cat "$BODY_FILE"
  exit 0
fi

# --- 创建任务 ---
RESULT=$(curl -s -X POST "$BASE_URL/api/tasks" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  --data-binary "@$BODY_FILE")

TASK_ID=$(echo "$RESULT" | python3 -c "
import sys, json
t = json.load(sys.stdin)
if t.get('error'):
    print(f\"ERROR: {t['error']}\", end='')
else:
    tid = t.get('id', '')
    print(tid)
" 2>/dev/null || echo "")

if [[ -z "$TASK_ID" || "$TASK_ID" == ERROR* ]]; then
  echo "❌ 创建任务失败: $TASK_ID" >&2
  echo "   响应: $RESULT" >&2
  exit 1
fi

TASK_STATUS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
echo "✅ 任务已创建: $TASK_ID (状态: $TASK_STATUS)"
echo "   平台: $BASE_URL/#/tasks/$TASK_ID"

# --- 启动任务 ---
if [[ "$NO_START" != "true" ]]; then
  START_RESULT=$(curl -s -X POST "$BASE_URL/api/tasks/$TASK_ID/start" \
    -H "$AUTH" \
    -H "Content-Type: application/json" 2>/dev/null)

  START_STATUS=$(echo "$START_RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('error'):
    print(f\"ERROR: {r['error']}\")
else:
    print(r.get('status', 'running'))
" 2>/dev/null || echo "ERROR: 无法解析启动响应: $START_RESULT")

  if [[ "$START_STATUS" == ERROR* ]]; then
    echo "❌ 启动失败: $START_STATUS" >&2; exit 1
  fi
  echo "🚀 任务已启动 (状态: $START_STATUS)"

  # --- 等待完成 ---
  if [[ "$WAIT" == "true" ]]; then
    echo "⏳ 等待任务完成（30s 轮询）..."
    PREV_ST=""
    while true; do
      TASK_DATA=$(curl -sf "$BASE_URL/api/tasks/$TASK_ID" \
        -H "$AUTH" 2>/dev/null) || { sleep 30; continue; }

      CUR_ST=$(echo "$TASK_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")

      if [[ "$CUR_ST" != "$PREV_ST" ]]; then
        echo "   状态: $PREV_ST → $CUR_ST"
        PREV_ST="$CUR_ST"
      fi

      case "$CUR_ST" in
        completed|failed|rejected|cancelled)
          echo "🏁 任务结束: $CUR_ST"
          # 输出 agent 最终总结
          RESULT_TEXT=$(echo "$TASK_DATA" | python3 -c "
import sys, json
t = json.load(sys.stdin)
r = t.get('result', '')
if r:
    print(r[:500])
" 2>/dev/null || echo "")
          if [[ -n "$RESULT_TEXT" ]]; then
            echo "   结果: $RESULT_TEXT"
          fi
          break
          ;;
      esac
      sleep 30
    done
  fi
fi
