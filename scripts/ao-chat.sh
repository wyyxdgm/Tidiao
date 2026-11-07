#!/usr/bin/env bash
# ao-chat.sh — 与编排平台任务交互式聊天
# 支持两种模式:
#   1. 指定已有 taskId 直接聊天
#   2. 新建任务（需指定项目）后聊天
#
# 用法:
#   # 与已有任务聊天
#   ao-chat.sh <task-id>
#
#   # 新建任务并聊天
#   ao-chat.sh -p GDM -t "修复邮件发送" -m "修复 SMTP 超时..."
#   ao-chat.sh --project-id 43b6a7f1-... -t "fix: xxx" -m "..."
#
#   # 指定版本
#   ao-chat.sh -p anflow -v v1.6 -t "feat: 导出" -m "..."
#
# 依赖: curl, python3

set -euo pipefail

# --- 环境检测 + 默认值（共享 login.sh）---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
CURRENT_ENV="$AO_CUR_ENV"   # 兼容下方 usage/echo 既有引用
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
EFFORT="medium"
# 🔴 2026-08-13 拍板：派发不限制轮次。空 = 不传 → 平台默认 200。
MAX_TURNS=""
AUTO_APPROVE=true
TAGS=""
TASK_ID=""
# Role 场景化 P2 (docs/plans/role-scoped-roles.md D2): --role 只在建新任务时生效
#   (role 随 task 定型, 已有 task 忽略并警告).
ROLE_ARG=""
ROLE_ID=""
# 波 2.5 (docs/plans/auto-complete-dag.md D7.2#5): --auto-complete 只在建新任务时生效
#   (auto_complete 随 task 定型, 已有 task 忽略并警告).
AUTO_COMPLETE=false

# --- 颜色 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

# --- 帮助 ---
usage() {
  cat <<EOF
ao-chat.sh — 与编排平台任务交互式聊天

当前环境: ${CURRENT_ENV} → ${BASE_URL}

模式 1 — 与已有任务聊天:
  ao-chat.sh <task-id>

模式 2 — 新建任务并聊天:
  ao-chat.sh -p GDM -t "修复邮件发送" -m "修复 SMTP 超时..."
  ao-chat.sh --project-id UUID -t "fix: xxx" -m "..."

新建任务参数:
  -p, --project NAME       项目名（如 GDM、anflow）
  -t, --title TEXT         任务标题
  -m, --message TEXT       任务 prompt（首条消息）
  -v, --version NAME       版本名（如 v1.0），默认用项目 current_version
  -f, --message-file FILE  从文件读取 prompt（替代 -m）
      --project-id UUID    直接用项目 ID（跳过名称查询）
      --version-id UUID    直接用版本 ID（跳过名称查询）
      --cwd PATH           任务工作目录
      --effort LEVEL       low/medium/high/xhigh/max（默认 medium）
      --max-turns N        最大 turn 数（默认 80）
      --auto-approve       自动审批工具调用
      --auto-complete      任务级自动验收：完成后 reviewing 瞬间自动翻 completed（仅 DAG
                          项目可用，非 DAG 项目 400 AUTO_COMPLETE_REQUIRES_DAG）
      --tags TAGS          逗号分隔标签
      --role NAME|UUID     角色预设（继承 system_prompt/model/effort/max_turns/allowed_tools；
                          仅建新任务时生效；UUID 直传，NAME 按目标项目可用集精确匹配，
                          重名 / 跨项目专属 role 报错退出并列候选）

通用参数:
      --base URL           平台地址（默认按环境自动检测）
      --email EMAIL        登录邮箱（默认按环境自动检测）
      --password PASS      登录密码
  -h, --help               帮助

环境变量覆盖:
  AO_TOKEN                  不过期 API token（优先于密码登录，格式 ao_...）
  AO_BASE_URL               平台地址（最高优先级，默认 http://localhost:13000）
  AO_EMAIL                  登录邮箱
  AO_PASSWORD               登录密码

示例:
  # 与已有任务聊天
  ao-chat.sh 15fbc267-4dfa-4ed3-b492-7cbb78a70744

  # 新建任务并聊天
  ao-chat.sh -p my-project -t "fix: 修复邮件发送" -m "修复 SMTP 连接超时"

  # 指定版本 + 自动审批
  ao-chat.sh -p my-project -v v1.6 -t "feat: 导出" -m "..." --auto-approve

  # 连接远程自托管实例
  AO_BASE_URL=https://your-host AO_EMAIL=you@example.com AO_PASSWORD=xxx ao-chat.sh <task-id>
EOF
  exit 0
}

# --- 参数解析 ---
# 第一个参数如果是 UUID 格式且不以 - 开头，视为 task-id
if [[ $# -gt 0 && "$1" != -* ]]; then
  # 简单 UUID 检测: 8-4-4-4-12 hex 格式
  if [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    TASK_ID="$1"
    shift
  fi
fi

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
    --effort)         EFFORT="$2"; shift 2 ;;
    --max-turns)      MAX_TURNS="$2"; shift 2 ;;
    --auto-approve)   AUTO_APPROVE=true; shift ;;
    --auto-complete)  AUTO_COMPLETE=true; shift ;;
    --tags)           TAGS="$2"; shift 2 ;;
    --role)           ROLE_ARG="$2"; shift 2 ;;
    --base)           BASE_URL="$2"; shift 2 ;;
    --email)          EMAIL="$2"; shift 2 ;;
    --password)       PASSWORD="$2"; shift 2 ;;
    -h|--help)        usage ;;
    *) echo "未知参数: $1"; usage ;;
  esac
done

# --- 鉴权（共享 login.sh：AO_TOKEN 优先，否则密码换 session） ---
ao_resolve_auth   # 设 AO_AUTH / AO_AUTH_MODE
AUTH="$AO_AUTH"   # 兼容下方既有 $AUTH 引用

echo -e "${GRAY}环境: $CURRENT_ENV | 平台: $BASE_URL | 用户: $EMAIL${RESET}"

# --- 模式 1: 已有 task-id ---
if [[ -n "$TASK_ID" ]]; then
  # Role 场景化 P2: role 随 task 定型, 已有 task 传 --role 无挂载点 → 明示忽略
  if [[ -n "$ROLE_ARG" ]]; then
    echo -e "${YELLOW}⚠️  --role '$ROLE_ARG' 只在建新任务时生效，与已有 task 聊天忽略该参数${RESET}" >&2
  fi
  # 波 2.5: auto_complete 随 task 定型, 已有 task 传 --auto-complete 无挂载点 → 明示忽略
  if [[ "$AUTO_COMPLETE" == "true" ]]; then
    echo -e "${YELLOW}⚠️  --auto-complete 只在建新任务时生效，与已有 task 聊天忽略该参数${RESET}" >&2
  fi
  # 验证任务存在
  TASK_DATA=$(curl -sf "$BASE_URL/api/tasks/$TASK_ID" \
    -H "$AUTH" 2>/dev/null) || {
    echo -e "${RED}❌ 找不到任务: $TASK_ID${RESET}" >&2; exit 1
  }
  TASK_TITLE=$(echo "$TASK_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title','?'))" 2>/dev/null || echo "?")
  TASK_STATUS=$(echo "$TASK_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
  echo -e "${CYAN}📋 任务: ${BOLD}$TASK_TITLE${RESET} ${GRAY}($TASK_STATUS)${RESET}"
  echo -e "${GRAY}   ID: $TASK_ID${RESET}"
  echo -e "${GRAY}   平台: $BASE_URL/#/tasks/$TASK_ID${RESET}"

  # 如果任务未运行，尝试启动
  case "$TASK_STATUS" in
    pending|paused|failed|cancelled|rejected|completed|reviewing)
      echo -e "${YELLOW}⚡ 任务状态为 ${TASK_STATUS}，尝试启动...${RESET}"
      START_RESULT=$(curl -s -X POST "$BASE_URL/api/tasks/$TASK_ID/start" \
        -H "$AUTH" \
        -H "Content-Type: application/json" 2>/dev/null)
      START_STATUS=$(echo "$START_RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('error'): print(f'ERROR: {r[\"error\"]}')
else: print(r.get('status', 'running'))
" 2>/dev/null || echo "ERROR: 无法解析启动响应: $START_RESULT")
      if [[ "$START_STATUS" == ERROR* ]]; then
        echo -e "${RED}❌ 启动失败: $START_STATUS${RESET}" >&2
      else
        echo -e "${GREEN}🚀 已启动 (状态: $START_STATUS)${RESET}"
      fi
      ;;
    running)
      echo -e "${GREEN}✅ 任务正在运行${RESET}"
      ;;
    queued)
      echo -e "${YELLOW}⏳ 任务排队中${RESET}"
      ;;
  esac
fi

# --- 模式 2: 新建任务 ---
if [[ -z "$TASK_ID" ]]; then
  if [[ -z "$PROJECT_NAME" && -z "$PROJECT_ID" ]]; then
    echo -e "${RED}❌ 需要指定 task-id 或提供 -p/--project 来新建任务${RESET}" >&2; exit 1
  fi
  if [[ -z "$TITLE" ]]; then
    echo -e "${RED}❌ 新建任务需要 -t/--title${RESET}" >&2; exit 1
  fi
  if [[ -z "$MESSAGE" && -z "$MESSAGE_FILE" ]]; then
    echo -e "${RED}❌ 新建任务需要 -m/--message 或 -f/--message-file${RESET}" >&2; exit 1
  fi

  # 从文件读取 prompt
  if [[ -n "$MESSAGE_FILE" ]]; then
    MESSAGE="$(cat "$MESSAGE_FILE")"
  fi

  # 查询 project_id（顺便取 current_version_id 作为默认版本）
  if [[ -z "$PROJECT_ID" ]]; then
    READ_RESULT=$(curl -sf "$BASE_URL/api/projects" \
      -H "$AUTH" \
      | python3 -c "
import sys, json
name = '$PROJECT_NAME'
ms = [p for p in json.load(sys.stdin).get('projects', []) if p['name'] == name]
if len(ms) > 1:  # 跨 owner 重名 = 歧义, 显式失败不做猜测
    print('⚠️  项目名重名 %d 个:' % len(ms), file=sys.stderr)
    for m in ms:
        print('   %s  owner=%s' % (m['id'], (m.get('owner_id') or '?')[:8]), file=sys.stderr)
    print('   用 --project-id <UUID> 显式指定', file=sys.stderr)
    print(' ', end='')
elif ms:
    cvid = ms[0].get('current_version_id') or ''
    print(ms[0]['id'] + ' ' + cvid, end='')
else:
    print(' ', end='')
")
    PROJECT_ID="${READ_RESULT%% *}"
    DEFAULT_VERSION_ID="${READ_RESULT#* }"
    if [[ -z "$PROJECT_ID" ]]; then
      echo -e "${RED}❌ 找不到项目: $PROJECT_NAME${RESET}" >&2; exit 1
    fi
  fi

  # 如果用 --project-id 直接传入，也查一次取 current_version_id
  if [[ -z "$DEFAULT_VERSION_ID" && -n "$PROJECT_ID" ]]; then
    DEFAULT_VERSION_ID=$(curl -sf "$BASE_URL/api/projects" \
      -H "$AUTH" \
      | python3 -c "
import sys, json
pid = '$PROJECT_ID'
for p in json.load(sys.stdin).get('projects', []):
    if p['id'] == pid:
        print(p.get('current_version_id') or '')
        break
else:
    print('', end='')
")
  fi

  # 查询 version_id（显式指定 -v 时）
  if [[ -n "$VERSION_NAME" && -z "$VERSION_ID" ]]; then
    VERSION_ID=$(curl -sf "$BASE_URL/api/versions?project=$PROJECT_ID" \
      -H "$AUTH" \
      | python3 -c "
import sys, json
name = '$VERSION_NAME'
for v in json.load(sys.stdin).get('versions', []):
    if v['name'] == name:
        print(v['id'])
        break
else:
    print('', end='')
")
    if [[ -z "$VERSION_ID" ]]; then
      echo -e "${YELLOW}⚠️  找不到版本: ${VERSION_NAME}，将使用项目默认版本${RESET}" >&2
    fi
  fi

  # 仍未指定 version -> 用项目 current_version_id（不传 -v 时自动选当前版本）
  if [[ -z "$VERSION_ID" && -n "$DEFAULT_VERSION_ID" ]]; then
    VERSION_ID="$DEFAULT_VERSION_ID"
    echo -e "${GRAY}📋 自动使用项目当前版本: $VERSION_ID${RESET}" >&2
  fi

  # --- --role 解析 (Role 场景化 P2, docs/plans/role-scoped-roles.md D2) ---
  #   同 ao-dispatch.sh: UUID 直传; NAME 按目标项目可用集 (全局 + 本项目专属)
  #   精确匹配; 重名 / 跨项目专属 = 显式失败列候选 (重名守卫惯例,
  #   docs/fixes/2026-10-12-project-name-collision.md).
  if [[ -n "$ROLE_ARG" ]]; then
    if [[ "$ROLE_ARG" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      ROLE_ID="$ROLE_ARG"
      echo -e "${GRAY}📋 role: UUID 直传 $ROLE_ID${RESET}" >&2
    else
      ROLES_JSON=$(curl -sf "$BASE_URL/api/roles" -H "$AUTH" 2>/dev/null) || \
        { echo -e "${RED}❌ GET /api/roles 失败 (auth? 网络?) --role 无法按名解析${RESET}" >&2; exit 1; }
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
        echo -e "${RED}❌ --role '$ROLE_ARG' 解析失败 (project=$PROJECT_ID)${RESET}" >&2
        exit 1
      fi
      echo -e "${GRAY}📋 role 解析: $ROLE_ARG → $ROLE_ID${RESET}" >&2
    fi
  fi

  # 构建请求体
  BODY=$(python3 -c "
import json
body = {
    'title': '''$TITLE''',
    'prompt': '''$MESSAGE''',
    'project_id': '$PROJECT_ID',
    'effort': '$EFFORT',
    'autoApprove': $( $AUTO_APPROVE && echo 'True' || echo 'False' ),
}
# maxTurns 只在显式指定时才传（默认空 → 平台用 200，不做人为限制）
if '$MAX_TURNS':     body['maxTurns'] = int('$MAX_TURNS')
if '$VERSION_ID':    body['version_id'] = '$VERSION_ID'
if '$CWD':           body['cwd'] = '$CWD'
if '$TAGS':          body['tags'] = '$TAGS'.split(',')
# Role 场景化 P2 (D2): ROLE_ID 是解析后的 UUID (hex+dash), 单引号插值安全
if '$ROLE_ID':       body['role_id'] = '$ROLE_ID'
# 波 2.5 (D7): auto_complete 透传 (server 读 body.autoComplete; 非 DAG 项目 400)
if '$AUTO_COMPLETE' == 'true': body['autoComplete'] = True
print(json.dumps(body, ensure_ascii=False))
")

  # 创建任务
  RESULT=$(curl -s -X POST "$BASE_URL/api/tasks" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$BODY")

  TASK_ID=$(echo "$RESULT" | python3 -c "
import sys, json
t = json.load(sys.stdin)
if t.get('error'):
    print(f\"ERROR: {t['error']}\", end='')
else:
    print(t.get('id', ''))
" 2>/dev/null || echo "")

  if [[ -z "$TASK_ID" || "$TASK_ID" == ERROR* ]]; then
    echo -e "${RED}❌ 创建任务失败: $TASK_ID${RESET}" >&2
    echo "   响应: $RESULT" >&2
    exit 1
  fi

  echo -e "${GREEN}✅ 任务已创建: ${BOLD}$TITLE${RESET}"
  echo -e "${GRAY}   ID: $TASK_ID${RESET}"
  echo -e "${GRAY}   平台: $BASE_URL/#/tasks/$TASK_ID${RESET}"

  # 启动任务
  START_RESULT=$(curl -s -X POST "$BASE_URL/api/tasks/$TASK_ID/start" \
    -H "$AUTH" \
    -H "Content-Type: application/json" 2>/dev/null)
  START_STATUS=$(echo "$START_RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('error'): print(f'ERROR: {r[\"error\"]}')
else: print(r.get('status', 'running'))
" 2>/dev/null || echo "ERROR: 无法解析启动响应: $START_RESULT")
  if [[ "$START_STATUS" == ERROR* ]]; then
    echo -e "${RED}❌ 启动失败: $START_STATUS${RESET}" >&2
  else
    echo -e "${GREEN}🚀 已启动 (状态: $START_STATUS)${RESET}"
  fi
fi

# ============================================================
# 交互式聊天循环
# ============================================================

# --- SSE 后台监听 ---
SSE_PID=""
SSE_FIFO="/tmp/ao-chat-sse-$TASK_ID-$$"
mkfifo "$SSE_FIFO" 2>/dev/null || true

# 启动 SSE 监听进程，将事件写入 FIFO
start_sse() {
  # 用 curl 的 --no-buffer 确保实时流
  curl -sN "$BASE_URL/api/tasks/$TASK_ID/stream" \
    -H "$AUTH" \
    > "$SSE_FIFO" 2>/dev/null &
  SSE_PID=$!
}

# 后台读取 SSE 事件并格式化输出
SSE_READER_PID=""
LAST_ASSISTANT_TEXT=""
sse_reader_running=true

start_sse_reader() {
  (
    while IFS= read -r line; do
      # SSE 格式: "data: {...}" 后跟空行
      [[ "$line" =~ ^data:\ (.*)$ ]] || continue
      payload="${BASH_REMATCH[1]}"
      [[ -z "$payload" ]] && continue

      # 解析事件类型
      event_type=$(echo "$payload" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(d.get('type', ''))
except:
    print('')
" 2>/dev/null)

      case "$event_type" in
        connected)
          # 连接建立，静默
          ;;
        history)
          # 历史事件，静默或简要显示
          ;;
        status_change)
          from_st=$(echo "$payload" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('data',{}).get('from','?'))" 2>/dev/null || echo "")
          to_st=$(echo "$payload" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('data',{}).get('to','?'))" 2>/dev/null || echo "")
          echo -e "\n${YELLOW}📊 状态变更: $from_st → $to_st${RESET}"
          ;;
        stream_delta)
          # 流式文本增量 — 直接输出（不换行，模拟打字效果）
          text=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('text',''),end='')" 2>/dev/null || echo "")
          printf "%s" "$text"
          ;;
        assistant_message)
          # 完整助手消息 — 换行
          text=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('text',''))" 2>/dev/null || echo "")
          if [[ -n "$text" && "$text" != "$LAST_ASSISTANT_TEXT" ]]; then
            LAST_ASSISTANT_TEXT="$text"
            echo ""
            echo -e "${CYAN}🤖 ${RESET}$text"
          fi
          ;;
        tool_use)
          tool_name=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('tool_name','?'))" 2>/dev/null || echo "")
          echo -e "\n${GRAY}🔧 工具调用: $tool_name${RESET}"
          ;;
        tool_use_update)
          tool_name=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('tool_name','?'))" 2>/dev/null || echo "")
          # 工具输入更新，简要显示
          ;;
        tool_approval_request)
          tool_name=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('tool_name','?'))" 2>/dev/null || echo "")
          echo -e "\n${YELLOW}⚠️  需要审批: $tool_name${RESET} (在平台 UI 中审批: $BASE_URL/#/tasks/$TASK_ID)"
          ;;
        message)
          role=$(echo "$payload" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('data',{}).get('role','?'))" 2>/dev/null || echo "")
          text=$(echo "$payload" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('data',{}).get('text',''),end='')" 2>/dev/null || echo "")
          if [[ "$role" == "user" ]]; then
            echo -e "\n${GREEN}👤 用户消息已送达${RESET}"
          fi
          ;;
        cost)
          cost=$(echo "$payload" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'${d.get(\"cost_usd\",0):.4f}')" 2>/dev/null || echo "")
          echo -e "\n${GRAY}💰 费用: \$$cost${RESET}"
          ;;
        error)
          err=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('error','未知错误'))" 2>/dev/null || echo "")
          echo -e "\n${RED}❌ 错误: $err${RESET}"
          ;;
        checkpoint)
          step=$(echo "$payload" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('step','?'))" 2>/dev/null || echo "")
          echo -e "\n${GRAY}📌 Checkpoint step=$step${RESET}"
          ;;
      esac
    done < "$SSE_FIFO"
  ) &
  SSE_READER_PID=$!
}

# 清理函数
cleanup() {
  sse_reader_running=false
  [[ -n "$SSE_READER_PID" ]] && kill "$SSE_READER_PID" 2>/dev/null || true
  [[ -n "$SSE_PID" ]] && kill "$SSE_PID" 2>/dev/null || true
  rm -f "$SSE_FIFO" 2>/dev/null || true
  echo -e "\n${GRAY}👋 退出聊天${RESET}"
  exit 0
}
trap cleanup EXIT INT TERM

# 启动 SSE
start_sse
start_sse_reader

echo ""
echo -e "${BOLD}═══════════════════════════════════════════${RESET}"
echo -e "${BOLD}  🗨️  Agent Chat — 输入消息与 agent 对话${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════${RESET}"
echo -e "${GRAY}  输入消息后按 Enter 发送${RESET}"
echo -e "${GRAY}  输入 /quit 或 /q 退出${RESET}"
echo -e "${GRAY}  输入 /status 查看任务状态${RESET}"
echo -e "${GRAY}  输入 /history 查看最近消息${RESET}"
echo ""

# --- 主循环 ---
while true; do
  # 读取用户输入
  read -r -e -p "💬 > " user_input || break

  # 去除首尾空格
  user_input="${user_input#"${user_input%%[![:space:]]*}"}"
  user_input="${user_input%"${user_input##*[![:space:]]}"}"

  # 空输入跳过
  [[ -z "$user_input" ]] && continue

  # 命令处理
  case "$user_input" in
    /q|/quit|/exit)
      echo -e "${GRAY}退出聊天...${RESET}"
      break
      ;;
    /status)
      TASK_DATA=$(curl -sf "$BASE_URL/api/tasks/$TASK_ID" \
        -H "$AUTH" 2>/dev/null) || {
        echo -e "${RED}获取状态失败${RESET}"
        continue
      }
      echo "$TASK_DATA" | python3 -c "
import sys, json
t = json.load(sys.stdin)
print(f\"  状态: {t.get('status','?')}\")
print(f\"  标题: {t.get('title','?')}\")
print(f\"  费用: \${t.get('cost_usd',0):.4f}\")
print(f\"  模型: {t.get('model','default')}\")
sid = t.get('session_id','')
if sid: print(f\"  Session: {sid[:16]}…\")
" 2>/dev/null
      continue
      ;;
    /history)
      # 获取最近消息
      curl -sf "$BASE_URL/api/tasks/$TASK_ID/messages" \
        -H "$AUTH" 2>/dev/null \
        | python3 -c "
import sys, json
msgs = json.load(sys.stdin)
# 只显示最近 10 条
for m in msgs[-10:]:
    role = m.get('type', '?')
    content = m.get('message', {}).get('content', '')
    if isinstance(content, list):
        content = ' '.join(b.get('text','') for b in content if b.get('type')=='text')
    content = str(content)[:200]
    icon = '🤖' if role == 'assistant' else '👤' if role == 'user' else '🔧'
    print(f'  {icon} {content}')
" 2>/dev/null || echo -e "${RED}获取历史失败${RESET}"
      continue
      ;;
  esac

  # 发送消息
  # 用 python3 做 JSON 转义，避免 shell 注入
  ENCODED_MSG=$(python3 -c "
import json, sys
print(json.dumps({'message': sys.argv[1]}, ensure_ascii=False))
" "$user_input")

  SEND_RESULT=$(curl -s -X POST "$BASE_URL/api/tasks/$TASK_ID/message" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$ENCODED_MSG" 2>/dev/null)

  SEND_OK=$(echo "$SEND_RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('ok'):
    print('ok')
elif r.get('error'):
    print(f'ERROR: {r[\"error\"]}')
else:
    print('ok')
" 2>/dev/null || echo "ERROR: 无法解析发送响应: $SEND_RESULT")

  if [[ "$SEND_OK" == ERROR* ]]; then
    echo -e "${RED}❌ 发送失败: $SEND_OK${RESET}"
  else
    # 如果任务被自动激活（从终态恢复），显示新状态
    new_status=$(echo "$SEND_RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
s = r.get('status','')
if s: print(s)
else: print('')
" 2>/dev/null || echo "")
    if [[ -n "$new_status" && "$new_status" != "running" ]]; then
      echo -e "${YELLOW}⚡ 任务已自动激活，状态: $new_status${RESET}"
    fi
  fi
done
