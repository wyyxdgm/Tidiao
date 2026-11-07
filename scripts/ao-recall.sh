#!/usr/bin/env bash
# ao-recall.sh — 跨源知识检索 CLI (飞书 R92, 2026-09-06).
#
# 设计动机 (2026-09-06): 跨仓问题排查缺统一检索入口;
#   agent 高频检索场景 → 走平台 /api/knowledge/search (4 源并发, 飞书走本地缓存 0 限速).
#
# 与 scripts/recall.sh 的区别:
#   - recall.sh   = ripgrep 跨仓 + 平台 task DB 搜 (急救包, 30 秒级, 不需要登录态)
#   - ao recall   = 走平台 /api/knowledge/search (4 源并发 + 飞书本地缓存 + 鉴权)
#   - 两者互补: recall.sh 找仓内代码/文档, ao recall 找平台历史 + 需求点 + 项目文档
#
# 用法:
#   ao recall <keyword> [<keyword> ...]            # 跨源 (任务/需求点/飞书缓存/项目文档 + 代码符号)
#   ao recall --project <uuid> <keyword> ...      # 限定项目
#   ao recall --source tasks <keyword>             # 只搜任务
#   ao recall --source docs <keyword>             # 只搜项目文档
#   ao recall --source requirement_cache <kw>     # 只搜飞书需求点缓存
#   ao recall --source symbols <keyword>          # 只搜代码符号 (L1 AST, T2 接入)
#   ao recall --limit 50 <keyword>                # 每源最多返 50 条 (默认 20)
#   ao recall --refresh-cache                     # 触发后台刷新飞书缓存 (admin)
#   ao recall --refresh-status                    # 看当前缓存健康
#   ao recall --selfcheck                         # 自检
#   ao recall --help                              # 帮助
#
# 鉴权: 与 ao notify / ao feishu 一致 -- 走 scripts/login.sh 的 AO_TOKEN / AO_EMAIL+AO_PASSWORD.
#
# 不做的事 (scope):
#   - 不接 git/ripgrep (那是 scripts/recall.sh)
#   - 不替 orchestrator-query skill (那是查单 task 详情; 本命令是 task **列表** + 跨源)
#   - 不动 platform 代码 / 不建 KB 表 (那是 knowledge-broadcast.md §6 拍板后的活)

set -euo pipefail

# ---- help ----
print_help() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

# ---- 颜色 ----
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
  CYAN=$'\033[0;36m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; DIM=''; BOLD=''; RESET=''
fi

# ---- 鉴权 (复用 login.sh) ----
resolve_auth() {
  if [[ -z "${AO_TOKEN:-}" || -z "${AO_EMAIL:-}" ]]; then
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -f "$here/login.sh" ]]; then
      # shellcheck disable=SC1091
      source "$here/login.sh"
      ao_init_env 2>/dev/null || true
    fi
  fi
}

# ---- HTTP POST /api/knowledge/search ----
search() {
  local -a keywords=("$@")
  local base="${AO_BASE_URL:-${AO_DEF_BASE:-http://localhost:13000}}"

  # 拼 sources JSON
  local sources_json="[]"
  if [[ ${#SOURCES[@]} -gt 0 ]]; then
    sources_json="["
    local i=0
    for s in "${SOURCES[@]}"; do
      [[ $i -gt 0 ]] && sources_json+=","
      sources_json+="\"$s\""
      i=$((i+1))
    done
    sources_json+="]"
  fi

  # 拼 keywords (空格 OR)
  local q
  q=$(printf '%s ' "${keywords[@]}")
  q="${q% }"

  local body
  body=$(printf '{"query":"%s","limit_per_source":%d' "${q//\"/\\\"}" "$LIMIT")
  if [[ -n "$PROJECT_ID" ]]; then
    body+=$(printf ',"project_id":"%s"' "${PROJECT_ID//\"/\\\"}")
  fi
  if [[ "$sources_json" != "[]" ]]; then
    body+=$(printf ',"sources":%s' "$sources_json")
  fi
  body+="}"

  # 鉴权头: AO_TOKEN (Bearer) 优先; 否则 AO_COOKIE (session=)
  local -a headers=(-H "Content-Type: application/json")
  if [[ -n "${AO_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer $AO_TOKEN")
  elif [[ -n "${AO_COOKIE:-}" ]]; then
    headers+=(-H "Cookie: session=$AO_COOKIE")
  else
    # 走 email+password 临时拿 cookie (单次, 不持久化)
    if [[ -n "${AO_EMAIL:-}" && -n "${AO_PASSWORD:-}" ]]; then
      local cookie
      cookie=$(curl -s -m 5 -X POST "$base/api/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"email\":\"${AO_EMAIL}\",\"password\":\"${AO_PASSWORD}\"}" \
        -i 2>&1 | grep -i '^set-cookie:' | sed 's/.*session=//;s/;.*//' | tr -d '\r' | head -1) || true
      if [[ -n "$cookie" ]]; then
        headers+=(-H "Cookie: session=$cookie")
      fi
    fi
  fi
  # x-user-id 头 (平台很多端点沿用此头, search 端点也是)
  if [[ -n "${AO_USER_ID:-}" ]]; then
    headers+=(-H "x-user-id: $AO_USER_ID")
  fi

  local resp
  resp=$(curl -s -m 15 "${headers[@]}" -X POST -d "$body" "$base/api/knowledge/search" 2>&1) || {
    echo -e "${RED}❌ curl 失败 (网络/超时)${RESET}" >&2
    return 3
  }
  printf '%s\n' "$resp"
}

# ---- HTTP POST /api/knowledge/refresh-cache ----
refresh_cache() {
  local base="${AO_BASE_URL:-${AO_DEF_BASE:-http://localhost:13000}}"
  local -a headers=(-H "Content-Type: application/json")
  if [[ -n "${AO_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer $AO_TOKEN")
  elif [[ -n "${AO_COOKIE:-}" ]]; then
    headers+=(-H "Cookie: session=$AO_COOKIE")
  fi
  if [[ -n "${AO_USER_ID:-}" ]]; then
    headers+=(-H "x-user-id: $AO_USER_ID")
  fi
  local body='{}'
  if [[ -n "${VERSION_ID:-}" ]]; then
    body="{\"version_id\":\"${VERSION_ID}\"}"
  fi
  if [[ -n "${REFRESH_USER_ID:-}" ]]; then
    body="${body%\} },\"user_id\":\"${REFRESH_USER_ID}\"}"
  fi

  curl -s -m 60 "${headers[@]}" -X POST -d "$body" "$base/api/knowledge/refresh-cache" 2>&1
}

refresh_status() {
  local base="${AO_BASE_URL:-${AO_DEF_BASE:-http://localhost:13000}}"
  local -a headers=()
  if [[ -n "${AO_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer $AO_TOKEN")
  elif [[ -n "${AO_COOKIE:-}" ]]; then
    headers+=(-H "Cookie: session=$AO_COOKIE")
  fi
  if [[ -n "${AO_USER_ID:-}" ]]; then
    headers+=(-H "x-user-id: $AO_USER_ID")
  fi
  curl -s -m 10 "${headers[@]}" "$base/api/knowledge/refresh-cache" 2>&1
}

# ---- selfcheck (无网络) ----
selfcheck() {
  echo "═══ ao recall selfcheck ═══"
  local fail=0

  # 1. 工具
  for tool in curl python3 jq; do
    if command -v "$tool" >/dev/null 2>&1; then
      printf "  ${GREEN}✅${RESET} %s\n" "$tool"
    else
      printf "  ${YELLOW}⚠️${RESET}  %s 缺失 (建议装)\n" "$tool"
      [[ "$tool" == "curl" ]] && fail=1
    fi
  done
  echo ""

  # 2. 鉴权
  resolve_auth
  if [[ -n "${AO_TOKEN:-}" ]]; then
    printf "  ${GREEN}✅${RESET} 鉴权: AO_TOKEN (Bearer)\n"
  elif [[ -n "${AO_EMAIL:-}" ]]; then
    printf "  ${GREEN}✅${RESET} 鉴权: AO_EMAIL+AO_PASSWORD (login 换 cookie)\n"
  else
    printf "  ${YELLOW}⚠️${RESET}  鉴权: 未设 AO_TOKEN / AO_EMAIL (POST 会缺头)\n"
  fi
  echo ""

  # 3. 平台可达
  local base="${AO_BASE_URL:-${AO_DEF_BASE:-}}"
  if [[ -z "$base" ]]; then
    printf "  ${YELLOW}⚠️${RESET}  AO_BASE_URL 未设, 跳过\n"
  else
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$base/api/projects" || echo "000")
    if [[ "$code" == "401" || "$code" == "200" ]]; then
      printf "  ${GREEN}✅${RESET}  %s → %s\n" "$base/api/projects" "$code"
    else
      printf "  ${RED}❌${RESET}  %s → %s (HTTP 错)\n" "$base/api/projects" "$code"
      fail=1
    fi
  fi
  echo ""

  if [[ $fail -eq 0 ]]; then
    printf "${GREEN}🎉 selfcheck 全过${RESET}\n"; return 0
  else
    printf "${RED}❌ selfcheck 有失败项${RESET}\n"; return 1
  fi
}

# ---- 渲染响应 ----
render_search() {
  local resp="$1"
  local total
  total=$(echo "$resp" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('total_hits',0))" 2>/dev/null || echo "0")
  if [[ "$total" == "0" ]]; then
    echo -e "  ${DIM}(无命中)${RESET}"
    local warns
    warns=$(echo "$resp" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); ws=d.get('warnings',[]); print(' / '.join(ws))" 2>/dev/null || echo "")
    [[ -n "$warns" ]] && echo -e "  ${YELLOW}warnings: $warns${RESET}"
    return 1
  fi

  echo "$resp" | python3 - "$total" <<'PYEOF'
import json, sys, re
data = json.loads(sys.stdin.read())
total = int(sys.argv[1])
q = data.get("query", "")
by_src = data.get("by_source", {})
# 7 源排序 (T4 加 embeddings, plan §3.2.3 + 任务提示词 §4.8)
src_order = ["symbols", "links", "requirements", "tasks", "requirement_cache", "docs", "embeddings"]
src_label = {
    "tasks": "🗂 任务",
    "requirements": "📋 in_app 需求点",
    "requirement_cache": "📡 飞书需求点缓存",
    "docs": "📄 项目文档",
    "symbols": "🔣 代码符号",
    "links": "🔗 代码↔业务",
    "embeddings": "🧠 代码语义",
}

for src in src_order:
    hits = by_src.get(src, [])
    if not hits: continue
    print(f"\n{BOLD}{src_label[src]}{RESET}  ({len(hits)} 条)")
    for h in hits[:10]:
        tid = h.get("id","")[:8]
        title = h.get("title","")[:60]
        snip = h.get("snippet","")[:140]
        url = h.get("url","")
        meta = h.get("meta", {})
        status = meta.get("status", "")
        updated = meta.get("updated_at", "")[:10]
        # symbols 源特殊渲染: file:line 必显示 (不误导 §5 约束 1)
        file_loc = meta.get("file", "")
        line_loc = meta.get("line", "")
        kind = meta.get("kind", "")
        line = f"  {tid} | {title}"
        if status: line += f"  [{status}]"
        if updated: line += f"  ({updated})"
        if file_loc and line_loc:
            line += f"  📍{file_loc}:{line_loc}"
            if kind: line += f"  ({kind})"
        print(line)
        if snip: print(f"    \033[2m{snip}\033[0m")
        if url: print(f"    \033[36m{url}\033[0m")

ws = data.get("warnings", [])
if ws:
    print(f"\n{YELLOW}warnings: {' / '.join(ws)}{RESET}")
PYEOF
}

# ---- 主入口 ----
main() {
  local keywords=()
  PROJECT_ID=""
  VERSION_ID=""
  SOURCES=()
  LIMIT=20
  REFRESH_USER_ID=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) print_help; exit 0 ;;
      --selfcheck) selfcheck; exit $? ;;
      --refresh-cache) shift; refresh_cache; exit $? ;;
      --refresh-status) shift; refresh_status; exit $? ;;
      --project) PROJECT_ID="${2:-}"; shift 2 ;;
      --version) VERSION_ID="${2:-}"; shift 2 ;;
      --source) SOURCES+=("${2:-}"); shift 2 ;;
      --limit) LIMIT="${2:-20}"; shift 2 ;;
      --user) REFRESH_USER_ID="${2:-}"; shift 2 ;;
      --) shift; while [[ $# -gt 0 ]]; do keywords+=("$1"); shift; done ;;
      -*) echo "❌ unknown flag: $1" >&2; exit 2 ;;
      *)  keywords+=("$1"); shift ;;
    esac
  done

  if [[ ${#keywords[@]} -eq 0 && -z "${VERSION_ID:-}" ]]; then
    echo "❌ 至少要一个关键词, 或 --version <id>" >&2
    print_help
    exit 2
  fi

  resolve_auth

  if [[ ${#keywords[@]} -gt 0 ]]; then
    echo -e "${BOLD}🔍 ao recall: ${keywords[*]}${RESET}"
    [[ -n "$PROJECT_ID" ]] && echo -e "${DIM}project: $PROJECT_ID${RESET}"
    [[ ${#SOURCES[@]} -gt 0 ]] && echo -e "${DIM}sources: ${SOURCES[*]}${RESET}"
    echo ""

    local resp
    resp=$(search "${keywords[@]}") || exit 3
    render_search "$resp"
  fi
}

main "$@"