#!/usr/bin/env bash
# cron.sh - 编排平台定时任务（schedules）CLI
#
# 封装 schedules API：list / get / create / update / delete / enable / disable
# / runs（触发历史）/ trigger（立即触发，走 POST /api/schedules/[id]/runs）。
#
# 用法:
#   cron.sh list
#   cron.sh get <id>
#   cron.sh create --name "每日巡检" --exec-type agent --schedule-type cron \
#       --expr "0 9 * * *" --project GDM --title "巡检" --prompt "检查项目状态并汇报"
#   cron.sh create --name "每5分钟备份" --exec-type shell --schedule-type cron \
#       --expr "*/5 * * * *" --command "/path/backup.sh"
#   cron.sh update <id> --expr "0 10 * * *"
#   cron.sh enable <id> ; cron.sh disable <id>
#   cron.sh runs <id> ; cron.sh trigger <id>
#   cron.sh delete <id>
#
# Goal-Driven Loop + 定时触发:
#   cron prompt 也能含 <goal>...</goal> marker, 触发后该 schedule task 走 goal loop.
#   例: 每 30 分钟检查 docs/foo.md 是否包含 'bar', 不含则 agent 自动修正
#   详见 docs/usage/18-goal-loop.md §与定时任务结合
#
# 依赖: curl, python3
# 鉴权: source login.sh（AO_TOKEN 优先，否则 AO_EMAIL/AO_PASSWORD 登录）

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env

BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"

usage() {
  cat <<EOF
cron.sh - 编排平台定时任务 CLI

当前环境: ${AO_CUR_ENV} -> ${BASE_URL}

命令:
  list   [--project ID] [--version ID] [--enabled true|false] [--all] [--include-deleted] [--last-run-from ISO] [--last-run-to ISO] [--next-run-from ISO] [--next-run-to ISO]
        列出定时任务（--all = 所有用户，admin only；--include-deleted = 含软删除；默认仅活跃）
        时间区间（飞书 R92）：上次/下次各自一组起止，ISO 8601 字符串（例 2026-09-01T00:00:00Z），空值忽略；未执行的（NULL）不在区间内
        版本过滤（飞书 R92 第二批）：--version <id> 精确匹配；与 --project AND 叠加
        状态过滤：--enabled true|false（2026-11-02）；未传 = 不过滤
  get    <id>                        查看单个
  create [flags]                     创建（见下）
  update <id> [flags]                更新（仅传要改的字段）
  delete <id>                        删除
  enable <id> / disable <id>         启用 / 停用
  runs   <id> [--limit N]            触发历史
  trigger <id>                       立即触发一次（不影响 cron 节奏；skip_if_running 仍生效）

create / update flags:
  --name NAME              任务名
  --description TEXT       描述 (飞书 R95 强烈建议填写; 缺省会 console.warn + UI toast 软告警, 不阻断)
  --exec-type agent|shell  执行体
  --schedule-type cron|once  调度类型
  --expr EXPR              调度表达式（cron 5 段；once 为 ISO 时间）
  --enabled | --disabled   启用状态（create 默认 enabled）
  --skip-if-running | --no-skip  防堆积；agent 默认 no-skip, shell 默认开
  --timezone TZ            默认 Asia/Shanghai
  agent 侧: --title T  --prompt P | --prompt-file F  --project NAME | --project-id UUID
            --version NAME | --version-id UUID  --effort LEVEL
            --max-turns N            轮次上限；**0 或空 = 不限**（清掉限制，运行时回落默认 200）
            --priority N  --model M  --tags a,b  --allowed-tools A,B
            --freq-min N  --freq-max N   自适应频率（仅 agent + cron; agent 每轮自选下轮
                                       expr 须落在 [min, max] 分钟区间内; 都填或都不填,
                                       都填时 min<=max, 都为 >=1 整数; 留空=关闭）
            --night-start-hour H  --night-end-hour H  --night-expr EXPR
                                       智能降频（飞书 R96）: H 是 0-23 的整数小时,
                                       窗口 [start, end) 跨午夜场景 start > end;
                                       --night-expr 是窗口内用的低频 cron。
                                       三参数要么都传要么都不传, 留空=关闭。
  🔴 --auto-approve / --no-auto-approve 已移除 —— agent schedule 是无人值守, 后端
     强制 auto_approve=true, 外部传入一律被忽略/PATCH 返 400 unknown_fields。
  说明: update 只提交显式传了的 flag；字符串类 flag 传空串 = 置空该字段。
        后端对未知字段返回 400（不会再静默丢弃 + 假装 200）。
  shell 侧: --command C | --command-file F  --cwd PATH

通用:
  --base URL  --email EMAIL  --password PASS   覆盖默认鉴权/地址
  -h, --help

环境变量:
  AO_TOKEN                 ao_ bearer（优先于密码登录）
  AO_BASE_URL / AO_EMAIL / AO_PASSWORD

示例:
  # shell 定时（每 5 分钟）
  cron.sh create --name "巡检" --exec-type shell --schedule-type cron \
    --expr "*/5 * * * *" --command "echo tick && date"

  # agent 定时（每天 9 点派任务）
  cron.sh create --name "每日巡检" --exec-type agent --schedule-type cron \
    --expr "0 9 * * *" --project GDM --title "巡检" --prompt "检查状态并汇报"

  # 立即触发
  cron.sh trigger <id>
EOF
  exit 0
}

# --- 解析 schedule 字段 flags（create / update 共用）---
# 设置字段变量 + 对应 SET_<FIELD>=1（update 只传 set 的字段）
NAME=""; DESCRIPTION=""; EXEC_TYPE=""; SCHED_TYPE=""; SCHED_EXPR=""; TIMEZONE=""
ENABLED=""; SKIP_RUNNING=""; TITLE=""; PROMPT=""; PROMPT_FILE=""
PROJECT_NAME=""; PROJECT_ID=""; VERSION_NAME=""; VERSION_ID=""
EFFORT=""; MAX_TURNS=""; PRIORITY=""; MODEL=""; TAGS=""; ALLOWED_TOOLS=""
COMMAND=""; COMMAND_FILE=""; CWD=""
FREQ_MIN=""; FREQ_MAX=""
NIGHT_START_HOUR=""; NIGHT_END_HOUR=""; NIGHT_EXPR=""
# SET_<F>=1 标记该字段被显式提供（update 只传这些；create 用作默认判断）
SET_NAME=""; SET_DESCRIPTION=""; SET_EXEC_TYPE=""; SET_SCHEDULE_TYPE=""; SET_SCHEDULE_EXPR=""
SET_TIMEZONE=""; SET_ENABLED=""; SET_SKIP_IF_RUNNING=""; SET_TITLE=""
SET_PROMPT=""; SET_PROJECT_ID=""; SET_VERSION_ID=""; SET_EFFORT=""
SET_MAX_TURNS=""; SET_PRIORITY=""; SET_MODEL=""; SET_TAGS=""
SET_ALLOWED_TOOLS=""; SET_COMMAND=""; SET_CWD=""
SET_FREQ_MIN=""; SET_FREQ_MAX=""
SET_NIGHT_START_HOUR=""; SET_NIGHT_END_HOUR=""; SET_NIGHT_EXPR=""

parse_schedule_flags() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name)            NAME="$2"; SET_NAME=1; shift 2 ;;
      --description)     DESCRIPTION="$2"; SET_DESCRIPTION=1; shift 2 ;;
      --exec-type)       EXEC_TYPE="$2"; SET_EXEC_TYPE=1; shift 2 ;;
      --schedule-type)   SCHED_TYPE="$2"; SET_SCHEDULE_TYPE=1; shift 2 ;;
      --expr)            SCHED_EXPR="$2"; SET_SCHEDULE_EXPR=1; shift 2 ;;
      --timezone)        TIMEZONE="$2"; SET_TIMEZONE=1; shift 2 ;;
      --enabled)         ENABLED="1"; SET_ENABLED=1; shift ;;
      --disabled)        ENABLED="0"; SET_ENABLED=1; shift ;;
      --skip-if-running) SKIP_RUNNING="1"; SET_SKIP_IF_RUNNING=1; shift ;;
      --no-skip)         SKIP_RUNNING="0"; SET_SKIP_IF_RUNNING=1; shift ;;
      --title)           TITLE="$2"; SET_TITLE=1; shift 2 ;;
      --prompt)          PROMPT="$2"; SET_PROMPT=1; shift 2 ;;
      --prompt-file)     PROMPT_FILE="$2"; SET_PROMPT=1; shift 2 ;;
      --project)         PROJECT_NAME="$2"; SET_PROJECT_ID=1; shift 2 ;;
      --project-id)      PROJECT_ID="$2"; SET_PROJECT_ID=1; shift 2 ;;
      --version)         VERSION_NAME="$2"; SET_VERSION_ID=1; shift 2 ;;
      --version-id)      VERSION_ID="$2"; SET_VERSION_ID=1; shift 2 ;;
      --effort)          EFFORT="$2"; SET_EFFORT=1; shift 2 ;;
      --max-turns)       MAX_TURNS="$2"; SET_MAX_TURNS=1; shift 2 ;;
      --priority)        PRIORITY="$2"; SET_PRIORITY=1; shift 2 ;;
      --auto-approve|--no-auto-approve)
        # 🔴 旧 flag 已移除 —— agent schedule 强制 auto_approve=true, 外部传值不再生效
        #   (POST 直接忽略 / PATCH 返 400 unknown_fields)。早给清晰报错, 避免老脚本
        #   静默成功以为生效了。
        echo "❌ --auto-approve / --no-auto-approve 已移除：agent schedule 强制自动审批, 无需也不接受外部设置 (damo 2026-08-31 拍板)" >&2; exit 1 ;;
      --model)           MODEL="$2"; SET_MODEL=1; shift 2 ;;
      --tags)            TAGS="$2"; SET_TAGS=1; shift 2 ;;
      --allowed-tools)   ALLOWED_TOOLS="$2"; SET_ALLOWED_TOOLS=1; shift 2 ;;
      --command)         COMMAND="$2"; SET_COMMAND=1; shift 2 ;;
      --command-file)    COMMAND_FILE="$2"; SET_COMMAND=1; shift 2 ;;
      --cwd)             CWD="$2"; SET_CWD=1; shift 2 ;;
      --freq-min)        FREQ_MIN="$2"; SET_FREQ_MIN=1; shift 2 ;;
      --freq-max)        FREQ_MAX="$2"; SET_FREQ_MAX=1; shift 2 ;;
      --night-start-hour) NIGHT_START_HOUR="$2"; SET_NIGHT_START_HOUR=1; shift 2 ;;
      --night-end-hour)   NIGHT_END_HOUR="$2"; SET_NIGHT_END_HOUR=1; shift 2 ;;
      --night-expr)       NIGHT_EXPR="$2"; SET_NIGHT_EXPR=1; shift 2 ;;
      --base)            BASE_URL="$2"; shift 2 ;;
      --email)           EMAIL="$2"; shift 2 ;;
      --password)        PASSWORD="$2"; shift 2 ;;
      -h|--help)         usage ;;
      *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
  done
}

# --- 把 schedule 字段组装成 JSON body（仅含 SET_* 标记的字段）---
# 读各 SET_<F> 与字段值；空字符串 -> null（用于 update 清字段）
build_schedule_body() {
  if [[ -n "$PROMPT_FILE" ]]; then PROMPT="$(cat "$PROMPT_FILE")"; fi
  if [[ -n "$COMMAND_FILE" ]]; then COMMAND="$(cat "$COMMAND_FILE")"; fi
  CR_NAME="$NAME" CR_DESCRIPTION="$DESCRIPTION" CR_EXEC_TYPE="$EXEC_TYPE" CR_SCHEDULE_TYPE="$SCHED_TYPE" \
  CR_SCHEDULE_EXPR="$SCHED_EXPR" CR_TIMEZONE="$TIMEZONE" CR_ENABLED="$ENABLED" \
  CR_SKIP_IF_RUNNING="$SKIP_RUNNING" CR_TITLE="$TITLE" CR_PROMPT="$PROMPT" \
  CR_PROJECT_ID="$PROJECT_ID" CR_VERSION_ID="$VERSION_ID" CR_EFFORT="$EFFORT" \
  CR_MAX_TURNS="$MAX_TURNS" CR_PRIORITY="$PRIORITY" CR_MODEL="$MODEL" \
  CR_TAGS="$TAGS" CR_ALLOWED_TOOLS="$ALLOWED_TOOLS" CR_COMMAND="$COMMAND" \
  CR_CWD="$CWD" CR_FREQ_MIN="$FREQ_MIN" CR_FREQ_MAX="$FREQ_MAX" \
  CR_NIGHT_START_HOUR="$NIGHT_START_HOUR" CR_NIGHT_END_HOUR="$NIGHT_END_HOUR" \
  CR_NIGHT_EXPR="$NIGHT_EXPR" \
  SET_NAME="${SET_NAME:-}" SET_DESCRIPTION="${SET_DESCRIPTION:-}" SET_EXEC_TYPE="${SET_EXEC_TYPE:-}" \
  SET_SCHEDULE_TYPE="${SET_SCHEDULE_TYPE:-}" SET_SCHEDULE_EXPR="${SET_SCHEDULE_EXPR:-}" \
  SET_TIMEZONE="${SET_TIMEZONE:-}" SET_ENABLED="${SET_ENABLED:-}" \
  SET_SKIP_IF_RUNNING="${SET_SKIP_IF_RUNNING:-}" SET_TITLE="${SET_TITLE:-}" \
  SET_PROMPT="${SET_PROMPT:-}" SET_PROJECT_ID="${SET_PROJECT_ID:-}" \
  SET_VERSION_ID="${SET_VERSION_ID:-}" SET_EFFORT="${SET_EFFORT:-}" \
  SET_MAX_TURNS="${SET_MAX_TURNS:-}" SET_PRIORITY="${SET_PRIORITY:-}" \
  SET_MODEL="${SET_MODEL:-}" SET_TAGS="${SET_TAGS:-}" \
  SET_ALLOWED_TOOLS="${SET_ALLOWED_TOOLS:-}" SET_COMMAND="${SET_COMMAND:-}" \
  SET_CWD="${SET_CWD:-}" SET_FREQ_MIN="${SET_FREQ_MIN:-}" SET_FREQ_MAX="${SET_FREQ_MAX:-}" \
  SET_NIGHT_START_HOUR="${SET_NIGHT_START_HOUR:-}" SET_NIGHT_END_HOUR="${SET_NIGHT_END_HOUR:-}" \
  SET_NIGHT_EXPR="${SET_NIGHT_EXPR:-}" \
  python3 -c '
import json, os
def setval(k):
    return os.environ.get("SET_" + k.upper()) == "1"
def val(k):
    return os.environ.get("CR_" + k.upper(), "")
def setval_env(set_env, cr_env):
    """🆕 v60 fix: CLI flag 用短名（SET_FREQ_MIN）, field 用长名（freq_min_minutes）,
    直接套 setval()/val() 会查 SET_FREQ_MIN_MINUTES 永远 None → 字段被静默吞。
    这里显式按 (SET_env, CR_env) 配对。"""
    return os.environ.get(set_env) == "1", os.environ.get(cr_env, "")
body = {}
# 字符串字段：空串 -> None（清字段）
for k in ("name","description","exec_type","schedule_type","schedule_expr","timezone","title",
          "prompt","project_id","version_id","effort","model","command","cwd"):
    if setval(k):
        v = val(k)
        body[k] = v or None
# 数值字段
# max_turns: 空串或 0 -> None（= 清掉限制, 运行时回落默认 200）。这是「放开轮次」
# 的唯一表达方式; 0 本身不是合法轮次上限, 后端也会拒。
for k in ("max_turns",):
    if setval(k):
        raw = val(k)
        n = int(raw) if raw else 0
        body[k] = n if n > 0 else None
for k in ("priority",):
    if setval(k):
        body[k] = int(val(k)) if val(k) else 0
# 🆕 v60 自适应频率字段。空串 -> None（PATCH 清掉 = 关闭自适应）; 非空 -> int。
# 注意: bash flag 用 --freq-min/--freq-max, env 是 SET_FREQ_MIN/SET_FREQ_MAX,
# 而 body 字段名是 freq_min_minutes/freq_max_minutes —— 不能套通用 setval/val。
for k, set_env, cr_env in (("freq_min_minutes", "SET_FREQ_MIN", "CR_FREQ_MIN"),
                           ("freq_max_minutes", "SET_FREQ_MAX", "CR_FREQ_MAX")):
    ok, v = setval_env(set_env, cr_env)
    if ok:
        body[k] = int(v) if v else None
# 🆕 飞书 R96 智能降频（v70）字段。三字段同填/同空；空串 -> None（清字段）。
# 命名同样错位：bash flag 是 NIGHT_START_HOUR/SET_NIGHT_START_HOUR, body 字段名是 night_start_hour，
# 不能套 setval/val() 通用模板。
for k, set_env, cr_env in (
        ("night_start_hour", "SET_NIGHT_START_HOUR", "CR_NIGHT_START_HOUR"),
        ("night_end_hour", "SET_NIGHT_END_HOUR", "CR_NIGHT_END_HOUR")):
    ok, v = setval_env(set_env, cr_env)
    if ok:
        body[k] = int(v) if v else None
for k, set_env, cr_env in (
        ("night_schedule_expr", "SET_NIGHT_EXPR", "CR_NIGHT_EXPR"),):
    ok, v = setval_env(set_env, cr_env)
    if ok:
        body[k] = v or None
# 布尔字段（CR_ 值 1/0）
# 🔴 auto_approve 已移除 —— agent schedule 后端强制 true, 不再走 CLI。
for k in ("enabled","skip_if_running"):
    if setval(k):
        body[k] = (val(k) == "1")
# 列表字段（逗号分隔）
for k in ("tags","allowed_tools"):
    if setval(k):
        v = val(k)
        body[k] = [s.strip() for s in v.split(",") if s.strip()] if v else []
print(json.dumps(body, ensure_ascii=False))
'
}

# --- 项目名/版本名 -> id 解析（复用 ao_curl）---
resolve_project_id() {
  ao_curl GET /api/projects 2>/dev/null \
    | python3 -c "
import sys, json
name = '$PROJECT_NAME'
ms = [p for p in json.load(sys.stdin).get('projects', []) if p['name'] == name]
if len(ms) > 1:  # 跨 owner 重名 = 歧义, 显式失败不做猜测 (2026-10-12 ao-dev 实证)
    print('⚠️  项目名重名 %d 个: %s; 用 --project-id 指定' % (len(ms), ', '.join(m['id'][:8] for m in ms)), file=sys.stderr)
elif ms:
    print(ms[0]['id'])
"
}
resolve_version_id() {
  ao_curl GET "/api/versions?project=$PROJECT_ID" 2>/dev/null \
    | python3 -c "
import sys, json
name = '$VERSION_NAME'
for v in json.load(sys.stdin).get('versions', []):
    if v['name'] == name:
        print(v['id'])
        break
" 2>/dev/null
}
# --- schedule id 前缀 -> 完整 UUID（API 只认完整 UUID, 8 位前缀 PATCH/GET 404）---
# 用法: ID="$(resolve_schedule_id "$ID")"  完整 UUID 原样返回; 唯一命中前缀→完整 id; 否则空串+stderr
resolve_schedule_id() {
  local PID="$1"
  if [[ "$PID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "$PID"; return 0
  fi
  ao_curl GET /api/schedules 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('schedules') or []
pid = '$PID'
hits = [s['id'] for s in items if s.get('id','').startswith(pid)]
if len(hits) == 1:
    print(hits[0])
elif len(hits) > 1:
    print('⚠️  schedule id 前缀歧义 %d 个: %s' % (len(hits), ', '.join(h[:8] for h in hits)), file=sys.stderr)
" 2>/dev/null
}

# --- 主命令派发 ---
CMD="${1:-}"
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && usage
shift

# 子命令前先解析可能透传的通用鉴权 flag（list/get/runs/trigger 也允许 --base 等）
case "$CMD" in
  list)
    PROJ_FILTER=""
    VERSION_FILTER=""
    LIST_ALL=""
    INCLUDE_DELETED=""
    LAST_RUN_FROM=""
    LAST_RUN_TO=""
    NEXT_RUN_FROM=""
    NEXT_RUN_TO=""
    ENABLED_FILTER=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --project) PROJ_FILTER="$2"; shift 2 ;;
        # 🆕 R92 第二批: 版本精确过滤 (damo 0830 R 列「版本也支持筛选」)。
        #   与 --project AND 叠加; 留空 = 不过滤。
        --version) VERSION_FILTER="$2"; shift 2 ;;
        --all) LIST_ALL=1; shift ;;
        --include-deleted) INCLUDE_DELETED=1; shift ;;
        # 🆕 飞书 R92: 时间区间筛 — lastRun 上次执行 / nextRun 下次执行。
        #   ISO 8601 字符串（如 2026-09-01T00:00:00Z）。空串/缺一 = 忽略。
        --last-run-from) LAST_RUN_FROM="$2"; shift 2 ;;
        --last-run-to)   LAST_RUN_TO="$2"; shift 2 ;;
        --next-run-from) NEXT_RUN_FROM="$2"; shift 2 ;;
        --next-run-to)   NEXT_RUN_TO="$2"; shift 2 ;;
        # 🆕 启用状态筛: --enabled true|false。未传 = 不过滤。
        --enabled)       ENABLED_FILTER="$2"; shift 2 ;;
        --base) BASE_URL="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    ao_resolve_auth
    # --all 需要 admin（服务端对非 admin 静默忽略, 只返回自己的）
    QS=""
    [[ -n "$PROJ_FILTER" ]] && QS="project=$PROJ_FILTER"
    # 🆕 R92 第二批: 版本过滤
    [[ -n "$VERSION_FILTER" ]] && QS="${QS:+$QS&}version=$VERSION_FILTER"
    [[ -n "$LIST_ALL" ]] && QS="${QS:+$QS&}all=true"
    [[ -n "$INCLUDE_DELETED" ]] && QS="${QS:+$QS&}includeDeleted=true"
    [[ -n "$LAST_RUN_FROM" ]] && QS="${QS:+$QS&}lastRunFrom=$(printf %s "$LAST_RUN_FROM" | sed 's/ /%20/g')"
    [[ -n "$LAST_RUN_TO"   ]] && QS="${QS:+$QS&}lastRunTo=$(printf %s "$LAST_RUN_TO" | sed 's/ /%20/g')"
    [[ -n "$NEXT_RUN_FROM" ]] && QS="${QS:+$QS&}nextRunFrom=$(printf %s "$NEXT_RUN_FROM" | sed 's/ /%20/g')"
    [[ -n "$NEXT_RUN_TO"   ]] && QS="${QS:+$QS&}nextRunTo=$(printf %s "$NEXT_RUN_TO" | sed 's/ /%20/g')"
    # 🆕 启用状态筛
    [[ -n "$ENABLED_FILTER" ]] && QS="${QS:+$QS&}enabled=$ENABLED_FILTER"
    PATH_Q="${QS:+?$QS}"
    ao_curl GET "/api/schedules$PATH_Q" \
      | AO_BASE_URL="$BASE_URL" AO_CUR_ENV="$AO_CUR_ENV" python3 -c "
import sys, json, os
base_url = os.environ.get('AO_BASE_URL', '?')
ao_cur_env = os.environ.get('AO_CUR_ENV', '?')
arr = json.load(sys.stdin)
if not arr:
    print('（无定时任务）'); sys.exit()
print(f\"# 实例: {base_url}  (env={ao_cur_env})\")
print(f\"{'NAME':20} {'EXEC':6} {'TYPE':5} {'EN':3} {'EXPR':18} {'NEXT':20} {'ID':36}\")
for s in arr:
    en = '✓' if s['enabled'] else '✗'
    nxt = (s.get('next_run') or '-')[:20]
    print(f\"{s['name'][:20]:20} {s['exec_type']:6} {s['schedule_type']:5} {en:3} {s['schedule_expr'][:18]:18} {nxt:20} {s['id']}\")
"
    ;;

  get)
    ID="${1:?用法: cron.sh get <id>}"
    ID="$(resolve_schedule_id "$ID")" || { echo "❌ schedule id 解析失败: $ID" >&2; exit 1; }
    [[ -n "$ID" ]] || { echo "❌ 无法唯一解析 schedule id 前缀" >&2; exit 1; }
    ao_resolve_auth
    ao_curl GET "/api/schedules/$ID" | python3 -m json.tool
    ;;

  create)
    parse_schedule_flags "$@"
    # 校验必填
    for f in NAME EXEC_TYPE SCHED_TYPE SCHED_EXPR; do
      if [[ -z "${!f:-}" ]]; then echo "❌ create 缺少必填: --name / --exec-type / --schedule-type / --expr" >&2; exit 1; fi
    done
    # agent 必填 project + title + prompt；shell 必填 command
    if [[ "$EXEC_TYPE" == "agent" ]]; then
      if [[ -z "$PROJECT_ID" && -z "$PROJECT_NAME" ]]; then echo "❌ agent 类型需 --project 或 --project-id" >&2; exit 1; fi
      if [[ -z "$TITLE" ]]; then echo "❌ agent 类型需 --title" >&2; exit 1; fi
      if [[ -z "$PROMPT" && -z "$PROMPT_FILE" ]]; then echo "❌ agent 类型需 --prompt 或 --prompt-file" >&2; exit 1; fi
    elif [[ "$EXEC_TYPE" == "shell" ]]; then
      if [[ -z "$COMMAND" && -z "$COMMAND_FILE" ]]; then echo "❌ shell 类型需 --command 或 --command-file" >&2; exit 1; fi
      if [[ -n "$SET_FREQ_MIN" || -n "$SET_FREQ_MAX" ]]; then echo "❌ shell schedule 不支持 --freq-min/--freq-max（自适应频率仅 agent + cron）" >&2; exit 1; fi
    else
      echo "❌ --exec-type 必须是 agent 或 shell" >&2; exit 1
    fi
    if [[ "$EXEC_TYPE" == "agent" && -n "$SET_FREQ_MIN$SET_FREQ_MAX" ]]; then
      if [[ "$SCHED_TYPE" != "cron" ]]; then echo "❌ 自适应频率仅支持 cron 类型（once 一次性的没意义）" >&2; exit 1; fi
      if [[ -n "$SET_FREQ_MIN" && -n "$SET_FREQ_MAX" && "$FREQ_MIN" -gt "$FREQ_MAX" ]]; then
        echo "❌ --freq-min ($FREQ_MIN) 不能大于 --freq-max ($FREQ_MAX)" >&2; exit 1
      fi
    fi
    ao_resolve_auth
    # 解析项目名 / 版本名 -> id
    if [[ -z "$PROJECT_ID" && -n "$PROJECT_NAME" ]]; then
      PROJECT_ID="$(resolve_project_id)" || true
      [[ -z "$PROJECT_ID" ]] && { echo "❌ 找不到项目: $PROJECT_NAME" >&2; exit 1; }
    fi
    if [[ -n "$VERSION_NAME" && -z "$VERSION_ID" ]]; then
      VERSION_ID="$(resolve_version_id)" || true
      [[ -z "$VERSION_ID" ]] && { echo "⚠️  找不到版本: $VERSION_NAME" >&2; }
    fi
    # 默认 enabled；skip_if_running 按 exec_type 分档：
    #   agent  默认 no-skip —— agent 干完停在 reviewing 是常态, 「上一次还在飞」不该挡
    #           新一轮；fire 前 runner 会读上轮 reviewing 结果拼进新 prompt（B 逻辑）。
    #   shell  默认 skip —— shell 是真「命令执行」, 重叠跑可能撞资源/数据, 默认防堆积。
    [[ -z "$SET_ENABLED" ]] && { ENABLED="1"; SET_ENABLED=1; }
    if [[ -z "$SET_SKIP_IF_RUNNING" ]]; then
      if [[ "$EXEC_TYPE" == "agent" ]]; then
        SKIP_RUNNING="0"; SET_SKIP_IF_RUNNING=1
      else
        SKIP_RUNNING="1"; SET_SKIP_IF_RUNNING=1
      fi
    fi
    BODY="$(build_schedule_body)"
    RESULT="$(ao_curl POST /api/schedules -d "$BODY")"
    SID="$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)"
    if [[ -z "$SID" ]]; then
      echo "❌ 创建失败: $RESULT" >&2; exit 1
    fi
    echo "✅ 定时任务已创建: $SID"
    echo "   $BASE_URL/schedules"
    ;;

  update)
    ID="${1:?用法: cron.sh update <id> [flags]}"; shift
    parse_schedule_flags "$@"
    ao_resolve_auth
    ID="$(resolve_schedule_id "$ID")" || { echo "❌ schedule id 解析失败" >&2; exit 1; }
    [[ -n "$ID" ]] || { echo "❌ 无法唯一解析 schedule id 前缀" >&2; exit 1; }
    if [[ -n "$PROJECT_NAME" && -z "$PROJECT_ID" ]]; then
      PROJECT_ID="$(resolve_project_id)" || true
    fi
    if [[ -n "$VERSION_NAME" && -z "$VERSION_ID" ]]; then
      VERSION_ID="$(resolve_version_id)" || true
    fi
    BODY="$(build_schedule_body)"
    RESULT="$(ao_curl PATCH "/api/schedules/$ID" -d "$BODY")"
    # 回显 agent 执行参数: 以前这些 flag 是空转的（后端静默丢弃）还照打 ✅,
    # 现在把服务端读回的实际值打出来, 值没变一眼能看见。
    echo "$RESULT" | AO_SENT_BODY="$BODY" python3 -c "
import sys, json, os
s = json.load(sys.stdin)
if 'id' not in s:
    print('❌ 更新失败: %s' % s, file=sys.stderr); sys.exit(1)
print(f\"✅ 已更新: {s.get('name','?')} enabled={s.get('enabled')} expr={s.get('schedule_expr')}\")
sent = json.loads(os.environ.get('AO_SENT_BODY') or '{}')
# 🔴 auto_approve 不在 echoed 里 —— 后端不再接受 PATCH, 传了也只会 400。
echoed = [k for k in ('max_turns','effort','model','priority','allowed_tools','tags','project_id','version_id','freq_min_minutes','freq_max_minutes','night_start_hour','night_end_hour','night_schedule_expr') if k in sent]
for k in echoed:
    print(f'   {k} = {s.get(k)!r}' + ('' if s.get(k) == sent[k] else f'  ⚠️ 提交的是 {sent[k]!r}'))
" || { echo "❌ 更新失败: $RESULT" >&2; exit 1; }
    ;;

  delete)
    ID="${1:?用法: cron.sh delete <id>}"
    ID="$(resolve_schedule_id "$ID")" || { echo "❌ schedule id 解析失败: $ID" >&2; exit 1; }
    [[ -n "$ID" ]] || { echo "❌ 无法唯一解析 schedule id 前缀" >&2; exit 1; }
    ao_resolve_auth
    ao_curl DELETE "/api/schedules/$ID" | python3 -c "import sys,json; print('✅ 已删除' if json.load(sys.stdin).get('ok') else '?')" 2>/dev/null
    ;;

  enable|disable)
    ID="${1:?用法: cron.sh $CMD <id>}"
    ID="$(resolve_schedule_id "$ID")" || { echo "❌ schedule id 解析失败: $ID" >&2; exit 1; }
    [[ -n "$ID" ]] || { echo "❌ 无法唯一解析 schedule id 前缀" >&2; exit 1; }
    ao_resolve_auth
    VAL="$([[ "$CMD" == "enable" ]] && echo "true" || echo "false")"
    ao_curl PATCH "/api/schedules/$ID" -d "{\"enabled\":$VAL}" >/dev/null
    echo "✅ $CMD: $ID"
    ;;

  runs)
    ID="${1:?用法: cron.sh runs <id> [--limit N]}"; shift
    ID="$(resolve_schedule_id "$ID")" || { echo "❌ schedule id 解析失败" >&2; exit 1; }
    [[ -n "$ID" ]] || { echo "❌ 无法唯一解析 schedule id 前缀" >&2; exit 1; }
    LIMIT="20"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --limit) LIMIT="$2"; shift 2 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    ao_resolve_auth
    ao_curl GET "/api/schedules/$ID/runs?limit=$LIMIT" \
      | python3 -c "
import sys, json
arr = json.load(sys.stdin)
if not arr:
    print('（无触发记录）'); sys.exit()
print(f\"{'STARTED':20} {'TYPE':6} {'TASK_ID/EXIT':36} {'STATUS':10}\")
for r in arr:
    started = (r.get('started_at') or '-')[:20]
    et = r.get('exec_type', '-')
    tid = r.get('task_id') or ''
    exitc = r.get('exit_code')
    ref = tid if tid else (f'exit={exitc}' if exitc is not None else '-')
    status = r.get('status') or (r.get('completed_at') and 'done') or '-'
    print(f\"{started:20} {et:6} {ref[:36]:36} {status[:10]}\")
"
    ;;

  trigger)
    ID="${1:?用法: cron.sh trigger <id>}"
    ID="$(resolve_schedule_id "$ID")" || { echo "❌ schedule id 解析失败: $ID" >&2; exit 1; }
    [[ -n "$ID" ]] || { echo "❌ 无法唯一解析 schedule id 前缀" >&2; exit 1; }
    ao_resolve_auth
    # || true: 409「上次还在跑」是预期结果不是故障, 交给下面的 python 打友好文案
    # （其余非 2xx ao_curl 已经把状态码+响应体打到 stderr）
    RESULT="$(ao_curl POST "/api/schedules/$ID/runs" || true)"
    # 成功: {ok:true, task_id:...|null}；失败(409): {error:...}
    echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('ok'):
    tid = r.get('task_id')
    if tid:
        print(f'✅ 已触发，agent 任务: {tid}')
    else:
        print('✅ 已触发（shell 已执行）')
else:
    print(f\"❌ 触发失败: {r.get('error', r)}\")
" 2>/dev/null || echo "❌ 触发失败: $RESULT"
    ;;

  *)
    echo "未知命令: $CMD" >&2; usage ;;
esac
