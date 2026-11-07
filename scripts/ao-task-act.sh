#!/usr/bin/env bash
# ao-task-act.sh — 任务动作封装（approve / refine / await / unawait / cancel / resolve）
#
# 用法:
#   ao-task-act.sh approve  <task-id-prefix> [feedback]
#   ao-task-act.sh refine   <task-id-prefix> [message]      # reviewing → running
#   ao-task-act.sh await    <task-id-prefix> <reason> [note]
#                                                              # running → await_user
#                                                              # reason: dispatch_needed|decision_pending|suggestion
#   ao-task-act.sh unawait  <task-id-prefix> <reason> [note]
#                                                              # await_user → running
#                                                              # reason: agent_self_resolved|user_timeout|external_event
#   ao-task-act.sh cancel   <task-id-prefix>
#   ao-task-act.sh resolve  <task-id-prefix>                 # 只打 UUID，不执行（dry-run）
#
# 行为:
#   - 8 位前缀 → 从列表查完整 UUID（必须**唯一匹配**，多义直接报错）
#   - resolve = dry-run，只输出完整 UUID（监控轮用来核对「这条 task 还在吗」）
#   - approve / refine 的 message 可选
#   - await / unawait 的 reason 必填, note 可选
#   - cancel 无 body
#   - 完整 UUID 接受完整 36 位 / 也接受 8 位（同样走查表）
#
# 🆕 R131 (2026-09-15): 旧 reject / revive 移除 (单人协作系统无 reject 终态).
#   - refine 取代 reject: 投消息让 agent 接着干, session 保留, 不进 rejected 终态.
#   - await: running → await_user, 等用户介入/拍板/建议.
#   - unawait: await_user → running, agent 可继续工作 (区别 approve → completed).
#
# Exit codes:
#   0  成功（resolve / approve / refine / await / unawait / cancel 都成功）
#   1  输入错（前缀不存在 / 缺少必填 reason / 子命令错）
#   2  多义（同一前缀匹配多个 task）
#   3  平台错（HTTP 失败 / 状态非 ok）
#
# 依赖: curl, python3, awk, sed, tr
# bash 3.2 兼容（Mac 自带 bash）

set -euo pipefail

if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; RESET=''
fi

# --- 环境检测 + 鉴权（共享 login.sh）---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"

ACTION=""
PREFIX=""
MESSAGE=""
AWAIT_REASONS=("dispatch_needed" "decision_pending" "suggestion")
UNAWAIT_REASONS=("agent_self_resolved" "user_timeout" "external_event")
REASON=""
NOTE=""
LIMIT="200"

usage() {
  cat <<'EOF'
ao-task-act.sh — 任务动作封装（approve/refine/await/unawait/cancel/resolve）

用法:
  ao-task-act.sh approve  <task-id-prefix>
  ao-task-act.sh refine   <task-id-prefix> [message]      # reviewing → running
  ao-task-act.sh await    <task-id-prefix> <reason> [note]    # running → await_user
  ao-task-act.sh unawait  <task-id-prefix> <reason> [note]    # await_user → running
  ao-task-act.sh cancel   <task-id-prefix>
  ao-task-act.sh resolve  <task-id-prefix>

行为:
  - 8 位前缀必须**唯一**匹配一个 task（多义拒绝执行）
  - 完整 36 位 UUID 也接受（直通）
  - resolve = dry-run，只打印完整 UUID，不发请求
  - refine 的 message 可选（不传只切状态）
  - await 的 reason 必填: dispatch_needed / decision_pending / suggestion
  - unawait 的 reason 必填: agent_self_resolved / user_timeout / external_event
  - 不会动 ORCHESTRATOR_TASK_ID / 派发方引用等元数据

环境:
  AO_TOKEN, AO_EMAIL, AO_PASSWORD, AO_BASE_URL — 同 ao-dispatch.sh

示例:
  ao-task-act.sh approve  5b3d4e7a
  ao-task-act.sh refine   5b3d4e7a "改用 jwt.verify 而不是 jwt.decode"
  ao-task-act.sh await    5b3d4e7a decision_pending "等 R88 拍板"
  ao-task-act.sh unawait  5b3d4e7a agent_self_resolved
  ao-task-act.sh cancel   8a1f2c30
  ao-task-act.sh resolve  5b3d4e7a     # 只打完整 UUID
EOF
}

# --- 参数解析 ---
[[ $# -ge 1 ]] || { usage >&2; exit 1; }
[[ "$1" != "--help" && "$1" != "-h" ]] || { usage; exit 0; }

ACTION="$1"; shift

case "$ACTION" in
  approve|refine|await|unawait|cancel|resolve) ;;
  *) echo "❌ 未知子命令: ${ACTION}（期望 approve|refine|await|unawait|cancel|resolve）" >&2; exit 1 ;;
esac

# 每个动作的参数需求
case "$ACTION" in
  approve|cancel|resolve)
    [[ $# -ge 1 ]] || { echo "❌ $ACTION 需要 task-id 前缀" >&2; exit 1; }
    PREFIX="$1"; shift
    ;;
  refine)
    [[ $# -ge 1 ]] || { echo "❌ refine 需要 task-id 前缀" >&2; exit 1; }
    PREFIX="$1"; shift
    if [[ $# -ge 1 ]]; then
      MESSAGE="$1"; shift
    fi
    ;;
  await)
    [[ $# -ge 2 ]] || { echo "❌ await 需要 <task-id-prefix> <reason> [note]" >&2; echo "   reason 必填: ${AWAIT_REASONS[*]}" >&2; exit 1; }
    PREFIX="$1"; shift
    REASON="$1"; shift
    # 校验 reason
    REASON_OK=0
    for r in "${AWAIT_REASONS[@]}"; do
      [[ "$REASON" == "$r" ]] && REASON_OK=1
    done
    [[ $REASON_OK -eq 1 ]] || { echo "❌ await reason 必须是: ${AWAIT_REASONS[*]}" >&2; exit 1; }
    if [[ $# -ge 1 ]]; then
      NOTE="$1"; shift
    fi
    ;;
  unawait)
    [[ $# -ge 2 ]] || { echo "❌ unawait 需要 <task-id-prefix> <reason> [note]" >&2; echo "   reason 必填: ${UNAWAIT_REASONS[*]}" >&2; exit 1; }
    PREFIX="$1"; shift
    REASON="$1"; shift
    REASON_OK=0
    for r in "${UNAWAIT_REASONS[@]}"; do
      [[ "$REASON" == "$r" ]] && REASON_OK=1
    done
    [[ $REASON_OK -eq 1 ]] || { echo "❌ unawait reason 必须是: ${UNAWAIT_REASONS[*]}" >&2; exit 1; }
    if [[ $# -ge 1 ]]; then
      NOTE="$1"; shift
    fi
    ;;
esac

# --- 校验 PREFIX（8 位 hex 或完整 UUID；不接受空 / 0 位）---
if [[ -z "$PREFIX" ]]; then
  echo "❌ 前缀不能为空" >&2; exit 1
fi

# 完整 UUID 直通
IS_FULL_UUID=0
if [[ "$PREFIX" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  IS_FULL_UUID=1
elif [[ ! "$PREFIX" =~ ^[0-9a-fA-F]{1,36}$ ]]; then
  echo "❌ 前缀只能含 hex 字符（0-9a-f），最长 36 位（完整 UUID）: $PREFIX" >&2; exit 1
fi

# --- 鉴权 ---
ao_resolve_auth

# --- 拉列表查全 UUID ---
TMP=$(mktemp -t ao-task-act.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT

if ! BODY=$(ao_curl GET "/api/tasks?limit=$LIMIT" 2>"$TMP.err"); then
  echo "❌ 拉取任务列表失败" >&2
  head -5 "$TMP.err" >&2 || true
  exit 3
fi
printf '%s' "$BODY" > "$TMP"

# python 解析: 返回匹配的 UUID（唯一 / 多义 / 无）
MATCH_INFO=$(python3 - "$TMP" "$PREFIX" "$IS_FULL_UUID" <<'PYEOF'
import sys, json
path, prefix, is_full = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(path, encoding="utf-8") as f:
    tasks = json.load(f)
if not isinstance(tasks, list):
    print("BADJSON\t0", end="")
    sys.exit(0)

if is_full:
    for t in tasks:
        if t.get("id") == prefix:
            print(f"UNIQUE\t{prefix}")
            sys.exit(0)
    print(f"NONE\t0")
    sys.exit(0)

# 8 位前缀匹配
matches = [t["id"] for t in tasks if t.get("id", "").startswith(prefix)]
if len(matches) == 0:
    print("NONE\t0")
elif len(matches) == 1:
    print(f"UNIQUE\t{matches[0]}")
else:
    print(f"AMBIG\t{','.join(matches[:5])}")
PYEOF
)

MATCH_KIND="${MATCH_INFO%%	*}"
MATCH_VAL="${MATCH_INFO#*	}"

case "$MATCH_KIND" in
  BADJSON)
    echo "❌ /api/tasks 返回非数组（解析失败）" >&2
    exit 3
    ;;
  NONE)
    echo "❌ 前缀 '$PREFIX' 在任务列表里找不到匹配" >&2
    echo "   提示: ao-monitor.sh <project_id> --json 看完整列表" >&2
    exit 1
    ;;
  AMBIG)
    echo "❌ 前缀 '$PREFIX' 匹配多个 task，多义拒绝执行：" >&2
    IFS=',' read -ra ALL <<< "$MATCH_VAL"
    for id in "${ALL[@]}"; do
      echo "   - $id" >&2
    done
    echo "   提示: 多给几位前缀直到唯一" >&2
    exit 2
    ;;
  UNIQUE)
    TASK_UUID="$MATCH_VAL"
    ;;
  *)
    echo "❌ 内部错误: $MATCH_INFO" >&2
    exit 3
    ;;
esac

# --- 展示解析结果 ---
SHORT="${TASK_UUID:0:8}"
echo "🔎 $ACTION → $TASK_UUID"

# --- resolve 是 dry-run，到此返回 ---
if [[ "$ACTION" == "resolve" ]]; then
  echo "   (resolve = dry-run，未发请求)"
  exit 0
fi

# --- 构造请求 body ---
ENDPOINT="$ACTION"
BODY=""
case "$ACTION" in
  approve|cancel)
    BODY='{}'
    ;;
  refine)
    # message 可选
    if [[ -n "$MESSAGE" ]]; then
      BODY=$(MESSAGE="$MESSAGE" python3 -c 'import json,os; print(json.dumps({"message": os.environ["MESSAGE"]}, ensure_ascii=False))')
    else
      BODY='{}'
    fi
    ;;
  await|unawait)
    BODY=$(REASON="$REASON" NOTE="$NOTE" python3 -c '
import json, os
d = {"reason": os.environ["REASON"], "requested_by": "user"}
note = os.environ["NOTE"]
if note:
    d["note"] = note
print(json.dumps(d, ensure_ascii=False))
')
    ;;
esac

# --- 发送请求 ---
REQ_BODY_FILE=$(mktemp -t ao-task-act-body.XXXXXX.json)
printf '%s' "$BODY" > "$REQ_BODY_FILE"
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/tasks/$TASK_UUID/$ENDPOINT" \
  -H "$AO_AUTH" -H "Content-Type: application/json" \
  --data-binary "@$REQ_BODY_FILE" 2>&1) || {
    echo "❌ 请求失败（curl 错误）" >&2
    rm -f "$REQ_BODY_FILE"
    exit 3
}
rm -f "$REQ_BODY_FILE"
CODE="${RESP##*$'\n'}"
RESP_BODY="${RESP%$'\n'*}"

if [[ ! "$CODE" =~ ^2[0-9][0-9]$ ]]; then
  echo "❌ HTTP ${CODE}（${ACTION}）" >&2
  echo "   $RESP_BODY" >&2
  exit 3
fi

# 解析响应里的 status
NEW_STATUS=$(printf '%s' "$RESP_BODY" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read() or '{}')
    print(d.get('status', '?'))
except Exception:
    print('?')
")

echo "✅ $ACTION 成功 → 状态: $NEW_STATUS"
echo "   平台: $BASE_URL/#/tasks/$TASK_UUID"
exit 0
