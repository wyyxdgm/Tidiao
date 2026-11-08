#!/usr/bin/env bash
# requirements.sh — 需求点管理 + 派发任务 + 任务列表查询
#
# 一个脚本覆盖三件事 (覆盖范围对齐 docs/usage/17-requirements-api.md):
#   1. 需求点 CRUD (create/get/list/patch/delete/revisions/attach)
#   2. 需求点派发任务 (dispatch = 在需求点下创建 task, 可选自动启动)
#   3. 任务列表查询 (tasks = 关联 task / list-tasks = 我的 task 列表)
#
# 设计要点:
#   - 子命令风格: 第一参数是动作名, 后续按子命令各自解析 (仿 feishu.sh).
#   - 鉴权复用 login.sh 的 ao_curl: AO_TOKEN 不过期 bearer 优先, 否则密码换 session.
#   - 输出默认走 python json.dumps 漂亮打印; --json 走 raw (一行).
#   - 错误处理: ao_curl 已把 HTTP 错误打到 stderr, set -e 下直接 fail.
#   - 与飞书无关: 本脚本不读写飞书 sheet, 飞书写回另见 feishu.sh / write-back.ts.
#
# 依赖: bash 4+, curl, python3.
#
# 用法示例:
#   requirements.sh create --project-id 37c28ff5-... --title "实现导出"
#   requirements.sh list --project-id 37c28ff5-... --status pending
#   requirements.sh get --id <uuid>
#   requirements.sh patch --id <uuid> --status awaiting_reply
#   requirements.sh dispatch --requirement-id <uuid> --title "fix: ..." --prompt "..."
#   requirements.sh dispatch --requirement-id <uuid> --title "..." --prompt-file ./spec.md --no-start
#   requirements.sh tasks --requirement-id <uuid> --with-deps
#   requirements.sh list-tasks --status running
#   requirements.sh revisions --id <uuid>
#   requirements.sh revisions-stream --since 2026-09-01T00:00:00Z
#   requirements.sh delete --id <uuid>

set -euo pipefail

# --- 共享鉴权 + base ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"

# --- 全局默认 ---
SUBCMD="${1:-help}"
[[ $# -gt 0 ]] && shift
JSON_RAW=false
QUIET=false
TOKEN="${AO_TOKEN:-}"

# --- 帮助 ---
print_global_help() {
  cat <<'EOF'
requirements.sh — 需求点管理 + 派发任务 + 任务列表查询

子命令:
  create           新建需求点 (--project-id + --title 必填)
  get              单条详情 + 关联 task + eligible_for_done
  list             列表 (按 project/status/version 过滤, 分页)
  patch            白名单改 (title/description/status/priority/tags/version_id)
  delete           软删 (status='closed')
  revisions        单条字段级时间线
  revisions-stream 全局增量变更流 (since/until/actor_type)
  attach           上传附件 (multipart file)
  dispatch         在需求点下创建 task (默认自动启动, --no-start 仅创建)
  tasks            关联 task 列表 (森林 API, --with-deps 带 edges)
  list-tasks       列我的 task (按 requirement/status/type 过滤, 分页)

通用:
  --base URL          平台地址 (默认按环境检测, localhost:13000)
  --token AO_XXX      不过期 API token (优先于密码登录)
  --email EMAIL       登录邮箱 (默认按环境, 见 login.sh)
  --password PASS     登录密码 (默认按环境)
  --json              原始 JSON 输出 (默认漂亮打印)
  --quiet             只输出关键 id (供脚本管道)
  -h, --help          通用帮助; 或 help <subcommand> 看子命令帮助

与飞书无关 — 飞书写回 (task 完成 → 飞书 T/W/Z 列) 见 scripts/feishu.sh 与
src/lib/feishu/write-back.ts. 本脚本只操作 platform 一侧 (in_app 需求点).

详情 / 入参 / 出参 / 错误码: docs/usage/17-requirements-api.md
EOF
}

# --- 工具函数 ---
die() { echo "❌ $*" >&2; exit 1; }
warn() { echo "⚠️  $*" >&2; }

# 漂亮打印 JSON (默认). 失败时不退出, 原样吐出.
pretty_json() {
  python3 -c "
import sys, json
try:
    print(json.dumps(json.loads(sys.stdin.read()), indent=2, ensure_ascii=False))
except Exception:
    sys.stdout.write(sys.stdin.read())
"
}

# 从 stdin 抽字段 (jq 替代). 用法: echo "$JSON" | jget .id
jget() {
  python3 -c "
import sys, json
key = sys.argv[1]
try:
    obj = json.loads(sys.stdin.read())
    for part in key.lstrip('.').split('.'):
        if part == '': continue
        if isinstance(obj, list):
            obj = obj[int(part)]
        else:
            obj = obj.get(part)
    if isinstance(obj, (dict, list)):
        print(json.dumps(obj, ensure_ascii=False))
    elif obj is None:
        print('')
    else:
        print(obj)
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr); sys.exit(1)
" "$1"
}

# --- 参数解析 (子命令之间独立, 用 while + case 跳进) ---
# 通用: --base / --token / --email / --password / --json / --quiet
COMMON_KNOWN=(--base --token --email --password --json --quiet --help)
collect_common() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base)     BASE_URL="$2"; shift 2 ;;
      --token)    TOKEN="$2"; shift 2 ;;
      --email)    EMAIL="$2"; AO_EMAIL="$2"; shift 2 ;;
      --password) PASSWORD="$2"; AO_PASSWORD="$2"; shift 2 ;;
      --json)     JSON_RAW=true; shift ;;
      --quiet)    QUIET=true; shift ;;
      -h|--help)  print_subcommand_help; exit 0 ;;
      *)          REMAINING+=("$1"); shift ;;
    esac
  done
}

# 解析完通用参数后, 应用 token / 鉴权.
apply_auth() {
  if [[ -n "$TOKEN" ]]; then
    export AO_TOKEN="$TOKEN"
  fi
  ao_resolve_auth   # 设 AO_AUTH / AO_AUTH_MODE
}

# 输出包装
emit() {
  local body="$1"
  if [[ "$QUIET" == "true" ]]; then
    # 静默模式 = 只输出 id (或第一行的 error 信息)
    echo "$body" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    if isinstance(d, dict):
        print(d.get('id') or d.get('task', {}).get('id') or json.dumps(d))
    else:
        print(json.dumps(d))
except Exception:
    sys.stdout.write(sys.stdin.read())
"
  elif [[ "$JSON_RAW" == "true" ]]; then
    echo "$body"
  else
    echo "$body" | pretty_json
  fi
}

# ========================================================================
# 子命令: create
# ========================================================================
cmd_create() {
  print_subcommand_help() {
    cat <<'EOF'
create — 新建需求点

必选:
  --project-id UUID        项目 ID
  --title TEXT             标题 (1-200 字符, 自动 trim)

可选:
  --version-id UUID        版本 ID (不传 = 项目当前版本; 传空值 = 不挂版本)
  --description TEXT       描述
  --priority 1-5           优先级 (整数)
  --tags a,b,c             逗号分隔标签 (元素非空)

输出: 201 + Requirement (status='pending', source='in_app')
错误: 400 PROJECT_REQUIRED/TITLE_REQUIRED/PRIORITY_OUT_OF_RANGE/TAGS_INVALID/VERSION_*;
      404 PROJECT_NOT_FOUND/VERSION_NOT_FOUND
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id)  PROJECT_ID="$2"; shift 2 ;;
      --title)       TITLE="$2"; shift 2 ;;
      --version-id)  VERSION_ID="$2"; shift 2 ;;
      --description) DESCRIPTION="$2"; shift 2 ;;
      --priority)    PRIORITY="$2"; shift 2 ;;
      --tags)        TAGS="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"

  [[ -z "${PROJECT_ID:-}" ]] && die "create: 缺少 --project-id"
  [[ -z "${TITLE:-}" ]] && die "create: 缺少 --title"

  apply_auth

  # 用 python 构造 body (避免 shell 转义 prompt/description 的坑, 与 ao-dispatch.sh 同根)
  BODY_FILE=$(mktemp -t req-create.XXXXXX.json)
  trap 'rm -f "$BODY_FILE"' EXIT

  python3 - "$BODY_FILE" "$PROJECT_ID" "${TITLE:-}" "${VERSION_ID:-}" "${DESCRIPTION:-}" \
    "${PRIORITY:-}" "${TAGS:-}" <<'PYEOF'
import sys, json
body_file, project_id, title, version_id, description, priority, tags = sys.argv[1:]
body = {"project_id": project_id, "title": title}
if version_id:
    body["version_id"] = version_id
if description:
    body["description"] = description
if priority:
    body["priority"] = int(priority)
if tags:
    body["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
with open(body_file, "w", encoding="utf-8") as f:
    json.dump(body, f, ensure_ascii=False)
PYEOF

  RESP=$(ao_curl POST /api/requirements --data-binary "@$BODY_FILE")
  rm -f "$BODY_FILE"
  trap - EXIT
  emit "$RESP"
}

# ========================================================================
# 子命令: get
# ========================================================================
cmd_get() {
  print_subcommand_help() {
    cat <<'EOF'
get — 单条详情 + 关联 task + eligible_for_done

必选:
  --id UUID    需求点 ID

输出: Requirement + tasks[] + eligible_for_done: boolean
错误: 404 (不存在或跨 owner, 不泄露存在性)
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) ID="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"
  [[ -z "${ID:-}" ]] && die "get: 缺少 --id"

  apply_auth
  RESP=$(ao_curl GET "/api/requirements/$ID")
  emit "$RESP"
}

# ========================================================================
# 子命令: list
# ========================================================================
cmd_list() {
  print_subcommand_help() {
    cat <<'EOF'
list — 列需求点

可选:
  --project-id UUID       按项目过滤
  --version-id UUID       按版本过滤 (--no-version = 过滤无版本)
  --status pending,done   状态过滤 (逗号分隔, 见 6 态)
  --page N                页码 (默认 1)
  --page-size 1-100       每页条数 (默认 20)

输出: {items: Requirement[], total, has_more, page, page_size}
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id)  PROJECT_ID="$2"; shift 2 ;;
      --version-id)  VERSION_ID="$2"; shift 2 ;;
      --no-version)  VERSION_NULL=true; shift ;;
      --status)      STATUS_FILTER="$2"; shift 2 ;;
      --page)        PAGE="$2"; shift 2 ;;
      --page-size)   PAGE_SIZE="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"

  apply_auth

  # 构造 query string
  QS=()
  [[ -n "${PROJECT_ID:-}" ]] && QS+=("project_id=$PROJECT_ID")
  if [[ "${VERSION_NULL:-}" == "true" ]]; then
    QS+=("version_id=null")
  elif [[ -n "${VERSION_ID:-}" ]]; then
    QS+=("version_id=$VERSION_ID")
  fi
  [[ -n "${STATUS_FILTER:-}" ]] && QS+=("status=$STATUS_FILTER")
  [[ -n "${PAGE:-}" ]] && QS+=("page=$PAGE")
  [[ -n "${PAGE_SIZE:-}" ]] && QS+=("page_size=$PAGE_SIZE")
  QSTR=""
  if [[ ${#QS[@]} -gt 0 ]]; then
    QSTR="?$(IFS='&'; echo "${QS[*]}")"
  fi

  RESP=$(ao_curl GET "/api/requirements$QSTR")
  emit "$RESP"
}

# ========================================================================
# 子命令: patch
# ========================================================================
cmd_patch() {
  print_subcommand_help() {
    cat <<'EOF'
patch — 白名单改 (其他字段 400 + FIELDS_NOT_ALLOWED)

必选:
  --id UUID

可选 (至少 1 个, 与白名单严格匹配):
  --title TEXT
  --description TEXT
  --status <6 态>            pending|awaiting_reply|has_suggestion|blocked|done|closed
  --priority 1-5
  --tags a,b,c
  --version-id UUID
  --no-version              显式置空 version (跨版本迁移临时态)

错误: 400 FIELDS_NOT_ALLOWED/STATUS_INVALID/PRIORITY_OUT_OF_RANGE/REQUIREMENT_DONE_GUARD/
      VERSION_*; 404

警告: status='done' 守卫 — 必须先 GET 看 eligible_for_done=true 才走.
      设计/调研 task 完成不算实现, 不能翻 done.
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)          ID="$2"; shift 2 ;;
      --title)       TITLE="$2"; shift 2 ;;
      --description) DESCRIPTION="$2"; shift 2 ;;
      --status)      STATUS_VAL="$2"; shift 2 ;;
      --priority)    PRIORITY="$2"; shift 2 ;;
      --tags)        TAGS_ARR="$2"; shift 2 ;;
      --version-id)  VERSION_ID="$2"; shift 2 ;;
      --no-version)  VERSION_NULL=true; shift ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"
  [[ -z "${ID:-}" ]] && die "patch: 缺少 --id"

  apply_auth

  BODY_FILE=$(mktemp -t req-patch.XXXXXX.json)
  trap 'rm -f "$BODY_FILE"' EXIT

  python3 - "$BODY_FILE" "${TITLE:-}" "${DESCRIPTION:-}" "${STATUS_VAL:-}" \
    "${PRIORITY:-}" "${TAGS_ARR:-}" "${VERSION_ID:-}" "${VERSION_NULL:-}" <<'PYEOF'
import sys, json
(body_file, title, description, status, priority, tags_csv,
 version_id, version_null) = sys.argv[1:]
body = {}
if title:       body["title"] = title
if description: body["description"] = description
if status:      body["status"] = status
if priority:    body["priority"] = int(priority)
if tags_csv:    body["tags"] = [t.strip() for t in tags_csv.split(",") if t.strip()]
if version_null == "true":
    body["version_id"] = None
elif version_id:
    body["version_id"] = version_id
with open(body_file, "w", encoding="utf-8") as f:
    json.dump(body, f, ensure_ascii=False)
PYEOF

  if [[ ! -s "$BODY_FILE" ]] || [[ "$(cat "$BODY_FILE")" == "{}" ]]; then
    rm -f "$BODY_FILE"; trap - EXIT
    die "patch: 至少要传一个白名单字段 (--title/--description/--status/--priority/--tags/--version-id)"
  fi

  RESP=$(ao_curl PATCH "/api/requirements/$ID" --data-binary "@$BODY_FILE")
  rm -f "$BODY_FILE"; trap - EXIT
  emit "$RESP"
}

# ========================================================================
# 子命令: delete
# ========================================================================
cmd_delete() {
  print_subcommand_help() {
    cat <<'EOF'
delete — 软删 (status='closed', 不物理删; 关联 task FK 不解绑)

必选:
  --id UUID

输出: {id, status: "closed"}
错误: 404 (不存在或已 closed)
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) ID="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"
  [[ -z "${ID:-}" ]] && die "delete: 缺少 --id"

  apply_auth
  RESP=$(ao_curl DELETE "/api/requirements/$ID")
  emit "$RESP"
}

# ========================================================================
# 子命令: revisions (单条时间线)
# ========================================================================
cmd_revisions() {
  print_subcommand_help() {
    cat <<'EOF'
revisions — 单条需求点的字段级变更时间线

必选:
  --id UUID

可选:
  --limit 1-500     默认 100

输出: {requirement_id, revisions: [{field, old_value, new_value, actor_type, actor_id, task_id, created_at}, ...]}
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)    ID="$2"; shift 2 ;;
      --limit) LIMIT="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"
  [[ -z "${ID:-}" ]] && die "revisions: 缺少 --id"

  apply_auth
  QSTR=""
  [[ -n "${LIMIT:-}" ]] && QSTR="?limit=$LIMIT"
  RESP=$(ao_curl GET "/api/requirements/$ID/revisions$QSTR")
  emit "$RESP"
}

# ========================================================================
# 子命令: revisions-stream (全局增量流)
# ========================================================================
cmd_revisions_stream() {
  print_subcommand_help() {
    cat <<'EOF'
revisions-stream — 全局字段级变更增量 (看板 / webhook 用)

可选:
  --since ISO8601           起 (含); 接受 'YYYY-MM-DDTHH:MM:SSZ' 或 sqlite 默认格式
  --until ISO8601           止 (不含)
  --actor-type user|agent|system   不传 = 全收
  --requirement-id UUID     限定单条
  --limit 1-500             默认 100
  --cursor BASE64URL        上一页 next_cursor 透传

输出: {items: [...], next_cursor, has_more}
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since)           SINCE="$2"; shift 2 ;;
      --until)           UNTIL="$2"; shift 2 ;;
      --actor-type)      ACTOR="$2"; shift 2 ;;
      --requirement-id)  REQ_ID="$2"; shift 2 ;;
      --limit)           LIMIT="$2"; shift 2 ;;
      --cursor)          CURSOR="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"

  apply_auth

  QS=()
  [[ -n "${SINCE:-}" ]]    && QS+=("since=$SINCE")
  [[ -n "${UNTIL:-}" ]]    && QS+=("until=$UNTIL")
  [[ -n "${ACTOR:-}" ]]    && QS+=("actor_type=$ACTOR")
  [[ -n "${REQ_ID:-}" ]]   && QS+=("requirement_id=$REQ_ID")
  [[ -n "${LIMIT:-}" ]]    && QS+=("limit=$LIMIT")
  [[ -n "${CURSOR:-}" ]]   && QS+=("cursor=$CURSOR")
  QSTR=""
  [[ ${#QS[@]} -gt 0 ]] && QSTR="?$(IFS='&'; echo "${QS[*]}")"

  RESP=$(ao_curl GET "/api/requirements/revisions$QSTR")
  emit "$RESP"
}

# ========================================================================
# 子命令: attach (上传附件)
# ========================================================================
cmd_attach() {
  print_subcommand_help() {
    cat <<'EOF'
attach — 上传附件到需求点 (multipart, 单文件 ≤10MB)

必选:
  --id UUID
  --file PATH    本地文件路径 (白名单: image/* / pdf / doc/docx/ppt/pptx/xlsx/txt/zip/tar)

输出: 201 + {attachment}
错误: 400 / 404 / 413 / 415
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)   ID="$2"; shift 2 ;;
      --file) FILE_PATH="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"
  [[ -z "${ID:-}" ]] && die "attach: 缺少 --id"
  [[ -z "${FILE_PATH:-}" ]] && die "attach: 缺少 --file"
  [[ ! -f "$FILE_PATH" ]] && die "attach: 文件不存在: $FILE_PATH"

  # 鉴权走 session/bearer (multipart 不走 --data-binary, 单独处理)
  apply_auth
  RESP=$(curl -s -w '\n%{http_code}' -X POST -H "$AO_AUTH" \
    -F "file=@${FILE_PATH}" \
    "${BASE_URL}/api/requirements/$ID/attachments")
  CODE="${RESP##*$'\n'}"
  BODY="${RESP%$'\n'*}"
  if [[ ! "$CODE" =~ ^2[0-9][0-9]$ ]]; then
    echo "❌ HTTP $CODE POST /api/requirements/$ID/attachments" >&2
    [[ -n "$BODY" ]] && echo "   $BODY" >&2
    exit 1
  fi
  emit "$BODY"
}

# ========================================================================
# 子命令: dispatch (在需求点下创建 task; 默认自动启动)
# ========================================================================
cmd_dispatch() {
  print_subcommand_help() {
    cat <<'EOF'
dispatch — 在需求点下创建 task (可选自动启动)

必选:
  --requirement-id UUID
  --title TEXT
  --prompt TEXT           或 --prompt-file PATH

可选:
  --type design|dev|test|deploy     默认 dev (R78 W1 §4.3: 只有 dev/test/deploy 完成后
                                              才能把 requirement 翻 done)
  --effort low|medium|high|max      默认 high
  --auto-approve / --no-auto-approve  默认 auto-approve=true
  --max-turns N                      默认 200 (空 = 不限)
  --allowed-tools t1,t2              默认全部 AVAILABLE_TOOLS
  --no-start                         只创建不启动 (后续手动 startTask)
  --start-task-id UUID               记录派发方 (UI 派发血缘, 通常由 ORCHESTRATOR_TASK_ID 继承)
  --wait                             启动后等待完成 (30s 轮询, 类似 ao-dispatch.sh)

错误: 400 REQUIREMENT_CLOSED / TYPE_INVALID / QUOTA_BLOCKED (quota 超限)
注意: closed 需求点拒收; quota 超限需先调 quota 释放或等窗口.
EOF
  }
  REMAINING=()
  PROMPT=""
  PROMPT_FILE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requirement-id)  REQ_ID="$2"; shift 2 ;;
      --title)           TITLE="$2"; shift 2 ;;
      --prompt)          PROMPT="$2"; shift 2 ;;
      --prompt-file)     PROMPT_FILE="$2"; shift 2 ;;
      --type)            TYPE_VAL="$2"; shift 2 ;;
      --effort)          EFFORT="$2"; shift 2 ;;
      --auto-approve)    AUTO_APPROVE=true; shift ;;
      --no-auto-approve) AUTO_APPROVE=false; shift ;;
      --max-turns)       MAX_TURNS="$2"; shift 2 ;;
      --allowed-tools)   ALLOWED_TOOLS="$2"; shift 2 ;;
      --no-start)        NO_START=true; shift ;;
      --start-task-id)   FROM_TASK="$2"; shift 2 ;;
      --wait)            WAIT_FLAG=true; shift ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"

  [[ -z "${REQ_ID:-}" ]] && die "dispatch: 缺少 --requirement-id"
  [[ -z "${TITLE:-}" ]] && die "dispatch: 缺少 --title"
  if [[ -z "$PROMPT" && -z "$PROMPT_FILE" ]]; then
    die "dispatch: 缺少 --prompt 或 --prompt-file"
  fi
  if [[ -n "$PROMPT_FILE" ]]; then
    [[ ! -f "$PROMPT_FILE" ]] && die "dispatch: --prompt-file 不存在: $PROMPT_FILE"
    PROMPT="$(cat "$PROMPT_FILE")"
  fi

  # 默认值
  TYPE_VAL="${TYPE_VAL:-dev}"
  EFFORT="${EFFORT:-high}"
  AUTO_APPROVE="${AUTO_APPROVE:-true}"
  NO_START="${NO_START:-false}"
  WAIT_FLAG="${WAIT_FLAG:-false}"
  MAX_TURNS="${MAX_TURNS:-}"

  # 派发方 task 引用 (派发血缘)
  FROM_TASK="${FROM_TASK:-${ORCHESTRATOR_TASK_ID:-}}"

  apply_auth

  # --- Step 1: 读 requirement 拿 project_id / version_id (建 task 需要) ---
  REQ_JSON=$(ao_curl GET "/api/requirements/$REQ_ID")
  PROJECT_ID=$(echo "$REQ_JSON" | jget .project_id)
  VERSION_ID=$(echo "$REQ_JSON" | jget .version_id)
  REQ_STATUS=$(echo "$REQ_JSON" | jget .status)
  if [[ "$REQ_STATUS" == "closed" ]]; then
    die "dispatch: 需求点已 closed, 拒收 (REQUIREMENT_CLOSED)"
  fi
  if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "None" ]]; then
    die "dispatch: 需求点缺 project_id (legacy data)"
  fi

  # --- Step 2: 构造 task body ---
  PROMPT_TMP=$(mktemp -t req-dispatch-prompt.XXXXXX)
  BODY_FILE=$(mktemp -t req-dispatch-body.XXXXXX.json)
  trap 'rm -f "$PROMPT_TMP" "$BODY_FILE"' EXIT
  printf '%s' "$PROMPT" > "$PROMPT_TMP"

  python3 - "$TITLE" "$PROMPT_TMP" "$BODY_FILE" "$PROJECT_ID" "${VERSION_ID:-}" \
    "$TYPE_VAL" "$EFFORT" "$AUTO_APPROVE" "$MAX_TURNS" \
    "${ALLOWED_TOOLS:-}" "${FROM_TASK:-}" "$REQ_ID" "$NO_START" <<'PYEOF'
import sys, json
(title, prompt_file, body_file, project_id, version_id, type_val, effort,
 auto_approve, max_turns, allowed_tools_csv, from_task, requirement_id,
 no_start) = sys.argv[1:]
with open(prompt_file, encoding="utf-8") as f:
    prompt = f.read()
body = {
    "title": title,
    "prompt": prompt,
    "project_id": project_id,
    "type": type_val,
    "effort": effort,
    "auto_approve": auto_approve.lower() == "true",
    "requirement_id": requirement_id,
    # auto-dispatch 端点 body.start: true=自动入队, false=仅创建. 不传 = 默认 true.
    # 注意类型: JSON 序列化时 True/False 必须小写 (Python bool 大写首字母 OK, json 接受).
    "start": no_start.lower() != "true",
}
if version_id:
    body["version_id"] = version_id
if max_turns:
    body["max_turns"] = int(max_turns)
if allowed_tools_csv:
    body["allowed_tools"] = [t.strip() for t in allowed_tools_csv.split(",") if t.strip()]
if from_task:
    body["dispatched_by_task_id"] = from_task
with open(body_file, "w", encoding="utf-8") as f:
    json.dump(body, f, ensure_ascii=False)
PYEOF

  # --- Step 3: 走 auto-dispatch 端点 (含 quota / closed / type 校验) ---
  RESP=$(ao_curl POST "/api/requirements/$REQ_ID/auto-dispatch" --data-binary "@$BODY_FILE")
  TASK_ID=$(echo "$RESP" | jget .task.id)
  TASK_STATUS=$(echo "$RESP" | jget .task.status)
  STARTED=$(echo "$RESP" | jget .started)

  rm -f "$PROMPT_TMP" "$BODY_FILE"; trap - EXIT

  if [[ -z "$TASK_ID" || "$TASK_ID" == "None" ]]; then
    die "dispatch: 创建 task 失败, 响应: $RESP"
  fi

  echo "✅ task 已创建: $TASK_ID (type=$TYPE_VAL, status=$TASK_STATUS, started=$STARTED)" >&2
  echo "   平台: $BASE_URL/#/tasks/$TASK_ID" >&2

  # --- Step 4: 等待完成 (--wait, 仿 ao-dispatch.sh) ---
  if [[ "$WAIT_FLAG" == "true" && "$STARTED" == "True" ]]; then
    echo "⏳ 等待 task 完成 (30s 轮询)..." >&2
    PREV_ST=""
    while true; do
      TASK_DATA=$(ao_curl GET "/api/tasks/$TASK_ID" 2>/dev/null) || { sleep 30; continue; }
      CUR_ST=$(echo "$TASK_DATA" | jget .status)
      if [[ "$CUR_ST" != "$PREV_ST" ]]; then
        echo "   状态: ${PREV_ST:-(start)} → $CUR_ST" >&2
        PREV_ST="$CUR_ST"
      fi
      case "$CUR_ST" in
        completed|failed|rejected|cancelled)
          echo "🏁 task 结束: $CUR_ST" >&2
          RESULT=$(echo "$TASK_DATA" | jget .result)
          if [[ -n "$RESULT" ]]; then
            echo "   结果: ${RESULT:0:500}" >&2
          fi
          break ;;
      esac
      sleep 30
    done
  fi

  emit "$RESP"
}

# ========================================================================
# 子命令: tasks (关联 task 列表, 森林 API)
# ========================================================================
cmd_tasks() {
  print_subcommand_help() {
    cat <<'EOF'
tasks — 关联 task 列表 (森林 API)

必选:
  --requirement-id UUID

可选:
  --with-deps       额外返 edges (from depends on to)

输出: {requirement_id, tasks: [...], edges?: [...]}
注意: depends_on 是 1 层直接依赖; 递归由调用方按需 GET /api/tasks/[id].
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --requirement-id) REQ_ID="$2"; shift 2 ;;
      --with-deps)      WITH_DEPS=true; shift ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"
  [[ -z "${REQ_ID:-}" ]] && die "tasks: 缺少 --requirement-id"

  apply_auth
  QSTR=""
  [[ "${WITH_DEPS:-}" == "true" ]] && QSTR="?with_deps=true"
  RESP=$(ao_curl GET "/api/requirements/$REQ_ID/tasks$QSTR")
  emit "$RESP"
}

# ========================================================================
# 子命令: list-tasks (我的 task, 全局 + 过滤)
# ========================================================================
cmd_list_tasks() {
  print_subcommand_help() {
    cat <<'EOF'
list-tasks — 我的 task 列表 (按 requirement/status/type 过滤)

可选:
  --project-id UUID
  --requirement-id UUID    按需求点过滤 (关联 task)
  --status pending|queued|running|completed|failed|...
  --type design|dev|test|deploy
  --page N
  --page-size 1-100        默认 50 (避免无过滤时刷出几千条)

注意: /api/tasks 不带过滤返回**全平台 task 数组** (非信封结构), 必传
--requirement-id 或 --status 缩小范围; --page-size 默认 50 兜底.
EOF
  }
  REMAINING=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id)      PROJECT_ID="$2"; shift 2 ;;
      --requirement-id)  REQ_ID="$2"; shift 2 ;;
      --status)          STATUS_FILTER="$2"; shift 2 ;;
      --type)            TYPE_FILTER="$2"; shift 2 ;;
      --page)            PAGE="$2"; shift 2 ;;
      --page-size)       PAGE_SIZE="$2"; shift 2 ;;
      *) collect_common "$@" && break ;;
    esac
  done
  set -- "${REMAINING[@]:-}"

  apply_auth

  QS=()
  [[ -n "${PROJECT_ID:-}" ]]   && QS+=("project_id=$PROJECT_ID")
  [[ -n "${REQ_ID:-}" ]]       && QS+=("requirement_id=$REQ_ID")
  [[ -n "${STATUS_FILTER:-}" ]] && QS+=("status=$STATUS_FILTER")
  [[ -n "${TYPE_FILTER:-}" ]]   && QS+=("type=$TYPE_FILTER")
  [[ -n "${PAGE:-}" ]]          && QS+=("page=$PAGE")
  # 默认 page_size=50 (避免 /api/tasks 不带过滤时返全平台几千条把屏幕刷爆)
  PAGE_SIZE="${PAGE_SIZE:-50}"
  QS+=("page_size=$PAGE_SIZE")
  QSTR=""
  [[ ${#QS[@]} -gt 0 ]] && QSTR="?$(IFS='&'; echo "${QS[*]}")"

  RESP=$(ao_curl GET "/api/tasks$QSTR")
  emit "$RESP"
}

# ========================================================================
# 主入口: 派发到子命令
# ========================================================================
case "$SUBCMD" in
  create)             cmd_create "$@" ;;
  get)                cmd_get "$@" ;;
  list)               cmd_list "$@" ;;
  patch)              cmd_patch "$@" ;;
  delete)             cmd_delete "$@" ;;
  revisions)          cmd_revisions "$@" ;;
  revisions-stream)   cmd_revisions_stream "$@" ;;
  attach)             cmd_attach "$@" ;;
  dispatch)           cmd_dispatch "$@" ;;
  tasks)              cmd_tasks "$@" ;;
  list-tasks)         cmd_list_tasks "$@" ;;
  help|-h|--help)
    if [[ "${1:-}" == "create" || "${1:-}" == "get" || "${1:-}" == "list" || \
          "${1:-}" == "patch" || "${1:-}" == "delete" || "${1:-}" == "revisions" || \
          "${1:-}" == "revisions-stream" || "${1:-}" == "attach" || \
          "${1:-}" == "dispatch" || "${1:-}" == "tasks" || "${1:-}" == "list-tasks" ]]; then
      # 委托子命令打印它自己的 help (但子命令 help 通常需要传 --help)
      SUBCMD="$1"; shift
      case "$SUBCMD" in
        create)            cmd_create --help ;;
        get)               cmd_get --help ;;
        list)              cmd_list --help ;;
        patch)             cmd_patch --help ;;
        delete)            cmd_delete --help ;;
        revisions)         cmd_revisions --help ;;
        revisions-stream)  cmd_revisions_stream --help ;;
        attach)            cmd_attach --help ;;
        dispatch)          cmd_dispatch --help ;;
        tasks)             cmd_tasks --help ;;
        list-tasks)        cmd_list_tasks --help ;;
      esac
    else
      print_global_help
    fi
    ;;
  *) die "未知子命令: $SUBCMD   (跑 'requirements.sh help' 看列表)" ;;
esac
