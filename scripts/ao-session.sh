#!/usr/bin/env bash
# ao-session.sh — 导出 / 导入编排平台 task 会话（备份 + 跨机器共享）
#
# 为什么需要它: 一个 task 的完整会话在 SDK jsonl 里（$ORCHESTRATOR_HOME/claude-config/
# projects/<cwd-slug>/<sessionId>.jsonl），DB 的 events 表只有约 1/5 内容。要把 A 机器上
# 的上下文交给 B 机器，就得把完整会话导出成文件，再当附件喂给 B 上的会话读。
#
# ⚠️ 这不是 SDK resume: 导入后是全新 session_id，历史只是 agent 读到的一份材料。
#
# 用法:
#   # 导出（--env 可跨机器直取，不落地中转）
#   ao-session.sh export <task-id>                          # -> ./ao-session-<task>.md
#   ao-session.sh export <task-id> -o /tmp/a.md --full      # 逐字（含 thinking）
#   ao-session.sh export <task-id> --format jsonl           # 逐字存档格式
#   ao-session.sh export <task-id> --env prod               # 从远程实例拉（AO_REMOTE_BASE）
#
#   # 导入到已有 task（上传附件 + 发一条消息让 agent 先读）
#   ao-session.sh import /tmp/a.md --to <task-id>
#
#   # 导入到新建 task
#   ao-session.sh import /tmp/a.md --new -p my-project -t "接手：修复 SMTP 超时"
#
#   # 跨机器一步到位（= export 到临时文件再 import）
#   ao-session.sh transfer <src-task-id> --from prod --new -p my-project -t "接手 xxx"
#
# 环境变量: AO_TOKEN(bearer 优先) / AO_BASE_URL / AO_EMAIL / AO_PASSWORD
# 依赖: curl, python3

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; GRAY='\033[0;90m'; BOLD='\033[1m'; RESET='\033[0m'

SUBCMD="${1:-}"; shift || true

# --- 各环境 base URL（--env / --from / --to-env 用）---
# 功能: 环境名 -> base URL. 关注点: 开源版不内置任何环境拓扑 —— 全部默认
#   localhost，可用 AO_LOCAL_BASE / AO_REMOTE_BASE 覆盖为你的实例地址.
env_base() {
  case "$1" in
    local|mac) echo "${AO_LOCAL_BASE:-http://localhost:13000}" ;;
    wsl|prod)  echo "${AO_REMOTE_BASE:-http://localhost:13000}" ;;
    pulu|remote) echo "${AO_REMOTE_BASE:-http://localhost:13000}" ;;
    *) echo ""; return 1 ;;
  esac
}

# 功能: 针对某个环境解析出 base + 鉴权头, 结果写进全局 R_BASE / R_AUTH.
# 关注点: 复用 login.sh 的 ao_resolve_auth, 它读全局 BASE_URL/EMAIL/PASSWORD,
#   所以这里必须先赋这三个再调用; AO_TOKEN 存在时直接 bearer, 不发登录请求.
resolve_target() {
  local env_name="$1"
  local base; base="$(env_base "$env_name")" || {
    echo -e "${RED}❌ 未知环境: $env_name（可选 local/wsl/remote，pulu 兼容）${RESET}" >&2; exit 1; }
  BASE_URL="${AO_BASE_URL:-$base}"
  EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
  PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"
  ao_resolve_auth
  R_BASE="$BASE_URL"
  R_AUTH="$AO_AUTH"
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "当前环境: ${AO_CUR_ENV} → $(env_base "$AO_CUR_ENV")"
}

# ---------- export ----------
do_export() {
  local task_id="" out="" format="md" verbosity="summary" env_name="$AO_CUR_ENV"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--out)     out="$2"; shift 2 ;;
      --format)     format="$2"; shift 2 ;;
      --full)       verbosity="full"; shift ;;
      --env)        env_name="$2"; shift 2 ;;
      -h|--help)    usage; exit 0 ;;
      -*)           echo -e "${RED}❌ 未知参数: $1${RESET}" >&2; exit 1 ;;
      *)            task_id="$1"; shift ;;
    esac
  done
  [[ -n "$task_id" ]] || { echo -e "${RED}❌ 需要 <task-id>${RESET}" >&2; exit 1; }

  local api_format ext
  case "$format" in
    md|markdown) api_format="markdown"; ext="md" ;;
    jsonl)       api_format="jsonl";    ext="jsonl" ;;
    *) echo -e "${RED}❌ --format 只支持 md / jsonl${RESET}" >&2; exit 1 ;;
  esac
  [[ -n "$out" ]] || out="./ao-session-${task_id:0:8}.${ext}"

  resolve_target "$env_name"
  echo -e "${GRAY}📤 从 ${env_name} (${R_BASE}) 导出 ${task_id:0:8} …${RESET}" >&2

  local code
  code=$(curl -s -H "$R_AUTH" -o "$out" -w "%{http_code}" \
    "${R_BASE}/api/tasks/${task_id}/transcript?format=${api_format}&verbosity=${verbosity}")
  if [[ "$code" != "200" ]]; then
    echo -e "${RED}❌ 导出失败 (HTTP $code): $(head -c 300 "$out")${RESET}" >&2
    rm -f "$out"; exit 1
  fi

  local size; size=$(wc -c < "$out" | tr -d ' ')
  # jsonl 一律逐字, verbosity 对它无意义, 不显示以免误导
  local label="$api_format"; [[ "$api_format" == "markdown" ]] && label="markdown/${verbosity}"
  echo -e "${GREEN}✅ 已导出: ${BOLD}${out}${RESET} (${size} bytes, ${label})"
  # attachments 上限 10MB —— 超了就明说, 不偷偷截断
  if (( size > 10 * 1024 * 1024 )); then
    echo -e "${YELLOW}⚠️  超过 attachments 10MB 上限，导入会被拒。改用默认 summary（别加 --full），或手工拆分。${RESET}" >&2
  fi
  EXPORT_OUT="$out"
}

# ---------- import ----------
# 功能: 上传文件为附件, 返回 attachment id (stdout).
# 关注点: 必须显式给 type —— curl -F 默认发 application/octet-stream,
#   服务端白名单按 media type 判, 不带就得靠服务端的扩展名兜底.
upload_attachment() {
  local task_id="$1" file="$2" mime="text/markdown"
  [[ "$file" == *.jsonl || "$file" == *.json ]] && mime="text/plain"
  curl -s -X POST "${R_BASE}/api/tasks/${task_id}/attachments" \
    -H "$R_AUTH" -F "file=@${file};type=${mime}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('error'):
    print('ERROR: ' + str(d['error']), end='')
else:
    print(d.get('attachment', {}).get('id', ''), end='')
"
}

do_import() {
  local file="" to_task="" new_task=false project="" version="" title="" note="" env_name="$AO_CUR_ENV"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to)         to_task="$2"; shift 2 ;;
      --new)        new_task=true; shift ;;
      -p|--project) project="$2"; shift 2 ;;
      -v|--version) version="$2"; shift 2 ;;
      -t|--title)   title="$2"; shift 2 ;;
      -m|--message) note="$2"; shift 2 ;;
      --env)        env_name="$2"; shift 2 ;;
      -h|--help)    usage; exit 0 ;;
      -*)           echo -e "${RED}❌ 未知参数: $1${RESET}" >&2; exit 1 ;;
      *)            file="$1"; shift ;;
    esac
  done
  [[ -n "$file" && -f "$file" ]] || { echo -e "${RED}❌ 需要一个存在的会话文件${RESET}" >&2; exit 1; }
  if [[ -z "$to_task" ]] && ! $new_task; then
    echo -e "${RED}❌ 需要 --to <task-id> 或 --new -p <project> -t <title>${RESET}" >&2; exit 1
  fi

  resolve_target "$env_name"

  # 新建 task 路径: 建 -> 传附件 -> append_attachments -> start
  if $new_task; then
    [[ -n "$project" && -n "$title" ]] || {
      echo -e "${RED}❌ --new 需要 -p <project> 和 -t <title>${RESET}" >&2; exit 1; }

    local pv project_id version_id
    pv=$(curl -sf "${R_BASE}/api/projects" -H "$R_AUTH" | python3 -c "
import sys, json
name = sys.argv[1]
ms = [p for p in json.load(sys.stdin).get('projects', []) if p['name'] == name]
if len(ms) > 1:  # 跨 owner 重名 = 歧义, 显式失败不做猜测
    print('⚠️  项目名重名 %d 个: %s; 用 project UUID 指定' % (len(ms), ', '.join(m['id'][:8] for m in ms)), file=sys.stderr)
    print('', '')
elif ms:
    print(ms[0]['id'], ms[0].get('current_version_id') or '')
else:
    print('', '')
" "$project")
    project_id="${pv%% *}"; version_id="${pv#* }"
    [[ -n "$project_id" ]] || { echo -e "${RED}❌ 找不到项目: $project${RESET}" >&2; exit 1; }

    if [[ -n "$version" ]]; then
      version_id=$(curl -sf "${R_BASE}/api/versions?project=$project_id" -H "$R_AUTH" | python3 -c "
import sys, json
name = sys.argv[1]
for v in json.load(sys.stdin).get('versions', []):
    if v['name'] == name:
        print(v['id']); break
else:
    print('')
" "$version")
    fi

    local body
    body=$(python3 -c "
import json, sys
title, pid, vid, note = sys.argv[1:5]
prompt = note or '接手一段在另一台机器上进行过的工作。附件里是那次会话的完整记录，先读完再判断下一步做什么。'
body = {'title': title, 'prompt': prompt, 'project_id': pid, 'effort': 'medium', 'autoApprove': True}
if vid: body['version_id'] = vid
print(json.dumps(body, ensure_ascii=False))
" "$title" "$project_id" "$version_id" "$note")

    to_task=$(curl -s -X POST "${R_BASE}/api/tasks" -H "$R_AUTH" \
      -H "Content-Type: application/json" -d "$body" \
      | python3 -c "import sys, json; print(json.load(sys.stdin).get('id',''), end='')")
    [[ -n "$to_task" ]] || { echo -e "${RED}❌ 创建任务失败${RESET}" >&2; exit 1; }
    echo -e "${GREEN}✅ 任务已创建: ${to_task}${RESET}"

    local aid; aid=$(upload_attachment "$to_task" "$file")
    [[ "$aid" == ERROR* || -z "$aid" ]] && { echo -e "${RED}❌ 附件上传失败: $aid${RESET}" >&2; exit 1; }

    curl -s -X PATCH "${R_BASE}/api/tasks/${to_task}" -H "$R_AUTH" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c "import json,sys; print(json.dumps({'append_attachments':[sys.argv[1]]}))" "$aid")" >/dev/null

    curl -s -X POST "${R_BASE}/api/tasks/${to_task}/start" -H "$R_AUTH" \
      -H "Content-Type: application/json" >/dev/null
    echo -e "${GREEN}✅ 会话已导入并启动${RESET}"
    echo -e "${GRAY}   ${R_BASE}/#/tasks/${to_task}${RESET}"
    return
  fi

  # 已有 task 路径: 传附件 -> 发消息（消息里带附件路径, agent 自己去读）
  local aid; aid=$(upload_attachment "$to_task" "$file")
  [[ "$aid" == ERROR* || -z "$aid" ]] && { echo -e "${RED}❌ 附件上传失败: $aid${RESET}" >&2; exit 1; }

  local msg_body
  msg_body=$(python3 -c "
import json, sys
aid, note = sys.argv[1:3]
msg = note or '附件是同一件事在另一台机器上的完整会话记录。先读完它，再接着往下做。'
# R55 B1: transfer = script-generated handoff (not the user talking directly),
# UI shows 🤖脚本 instead of 👤你.
print(json.dumps({'message': msg, 'attachments': [aid], 'sender_type': 'script'}, ensure_ascii=False))
" "$aid" "$note")

  local resp
  resp=$(curl -s -X POST "${R_BASE}/api/tasks/${to_task}/message" -H "$R_AUTH" \
    -H "Content-Type: application/json" -d "$msg_body")
  if echo "$resp" | grep -q '"error"'; then
    echo -e "${RED}❌ 发送失败: $resp${RESET}" >&2; exit 1
  fi
  echo -e "${GREEN}✅ 会话已作为附件送入 task ${to_task:0:8}${RESET}"
  echo -e "${GRAY}   ${R_BASE}/#/tasks/${to_task}${RESET}"
}

# ---------- transfer ----------
# 功能: export + import 串起来, 中转文件放 mktemp.
# 关注点: --from 是源环境, --env(可选) 是目标环境, 默认目标=当前环境.
do_transfer() {
  local task_id="" from="" rest=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from) from="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      -*) rest+=("$1"); [[ "${2:-}" == -* || -z "${2:-}" ]] || { rest+=("$2"); shift; }; shift ;;
      *)  if [[ -z "$task_id" ]]; then task_id="$1"; else rest+=("$1"); fi; shift ;;
    esac
  done
  [[ -n "$task_id" ]] || { echo -e "${RED}❌ 需要 <src-task-id>${RESET}" >&2; exit 1; }
  [[ -n "$from" ]] || { echo -e "${RED}❌ transfer 需要 --from <local|wsl|remote>${RESET}" >&2; exit 1; }

  local tmp; tmp="$(mktemp -t ao-session).md"
  do_export "$task_id" -o "$tmp" --env "$from"
  do_import "$tmp" "${rest[@]}"
  rm -f "$tmp"
}

case "$SUBCMD" in
  export)   do_export "$@" ;;
  import)   do_import "$@" ;;
  transfer) do_transfer "$@" ;;
  ""|-h|--help|help) usage ;;
  *) echo -e "${RED}❌ 未知子命令: $SUBCMD${RESET}" >&2; usage; exit 1 ;;
esac
