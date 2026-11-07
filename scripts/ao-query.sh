#!/usr/bin/env bash
# ao-query.sh - 编排平台 CLI: 自动鉴权 + 缓存 + GET/POST/PUT/DELETE
#
# 痛点: scripts/login.sh 每次都走密码换 session cookie (走公网明文 POST),
#       而 .env.tokens 里的不过期 bearer 又会因为 JWT_SECRET 轮换失效 (401).
#       本脚本:
#         1. 优先用 ~/.cache/ao-query-token-{env}.txt 缓存的 bearer token
#         2. 用轻量请求验证有效性 (401 才重登)
#         3. 失效则 POST /api/auth/token 换新, 写盘, 重试
#         4. 给调用方 stdout = 响应体, stderr = HTTP 错误
#
# 用法:
#   scripts/ao-query.sh <PATH>                              # 默认 GET, env=prod
#   scripts/ao-query.sh --env dev <PATH>                    # 切本机 dev 实例(13001)
#   scripts/ao-query.sh --env pulu <PATH>                   # 远程实例(配 AO_BASE_URL)
#   scripts/ao-query.sh POST /api/tasks/<id>/approve
#   scripts/ao-query.sh POST /api/foo --data '{"k":"v"}'    # POST 带 body
#   scripts/ao-query.sh --refresh --env prod                # 强制刷 token
#   scripts/ao-query.sh --status                            # 看 token 健康度
#
# 凭证: 复用 testing-tokens.md 的 admin 账号. 密码走 HTTPS/SSH 公网时只在
#       token 失效时才会 POST 一次 (然后写盘缓存, 后续不再走密码).
#
# 设计取舍 (2026-09-09):
#   * 不复用 login.sh: 那套用 session cookie, 跟 token 缓存策略不同.
#     login.sh 是「每次都换」, 本脚本是「缓存+验证+按需刷新」, 二选一更清晰.
#   * token 缓存无 TTL: 不过期 token (type:"api") 永久有效, 直到 401 才发现.
#     加 TTL 只是平白换新, 浪费一次 POST. 真失效由 401 兜底.
#   * 缓存路径 ~/.cache/ 而不是 /tmp: 跨会话复用, 不会因重启清掉.
#   * --status 输出四列: env / URL / token_age / last_check, 一眼看出问题.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- 环境配置 ---
# 功能: env 名 → 平台 BASE URL + 鉴权信息.
# 关注点: 开源版不内置任何环境/凭据 —— BASE 由 AO_BASE_URL 或 --env prod|dev|pulu
#   (默认 localhost:13000/13001) 决定; 鉴权走 AO_TOKEN 或 AO_EMAIL + AO_PASSWORD.
env_base_url() {
  if [ -n "${AO_BASE_URL:-}" ]; then echo "$AO_BASE_URL"; return; fi
  case "$1" in
    prod) echo "http://localhost:13000" ;;
    dev)  echo "http://localhost:13001" ;;
    pulu) echo "http://localhost:13000" ;;
  esac
}
env_email() { echo "${AO_EMAIL:-}" ; }
env_pass()  { echo "${AO_PASSWORD:-}" ; }

CACHE_DIR="${HOME}/.cache"
mkdir -p "$CACHE_DIR"

# --- 参数解析 ---
ENV="prod"
METHOD="GET"
REFRESH=0
DATA=""
STATUS_ONLY=0
PATH_PARTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)    ENV="$2"; shift 2 ;;
    --refresh) REFRESH=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    --data)   DATA="$2"; shift 2 ;;
    GET|POST|PUT|DELETE|PATCH) METHOD="$1"; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)        PATH_PARTS+=("$1"); shift ;;
  esac
done

# 关注点: 位置参数里混入 JSON body (忘了 --data) 会被当路径段拼进 URL, 服务端收空 body
# 直接 500 (await request.json() → SyntaxError), 报错点离根因很远. 合法路径不会以 { [ 开头,
# 这里提前拦住并给正确写法. (2026-10-07 实测踩坑: PATCH tags 时少写 --data → HTTP 500)
for _part in "${PATH_PARTS[@]}"; do
  case "$_part" in
    '{'*|'['*)
      if [[ -z "$DATA" ]]; then
        echo "❌ 位置参数看起来是 JSON body: $_part" >&2
        echo "   → 正确写法: $0 $METHOD <path> --data '$_part'" >&2
        exit 2
      fi ;;
  esac
done

if [[ -z "$(env_base_url "$ENV")" ]]; then
  echo "❌ 未知 env: $ENV (支持: prod|dev|pulu)" >&2; exit 1
fi
BASE_URL="$(env_base_url "$ENV")"
EMAIL="$(env_email "$ENV")"
PASS="$(env_pass "$ENV")"
CACHE_FILE="${CACHE_DIR}/ao-query-token-${ENV}.txt"

# --- token 获取: 缓存 / 重登 ---
# 功能: 返回一个有效的 ao_ bearer; 失败 exit 1.
# 关注点: 验证用 /api/projects (轻量, 不依赖特定 owner 数据); 重登只在缓存
#   不存在 / --refresh / 401 时触发.
refresh_token() {
  # name 带 ms 时间戳: API 对同名 token 拒绝创建(不可覆盖), 固定 name 会让
  # 第二次 refresh 永远 401 → 401 重登路径死锁.
  local tok_name="ao-query-$(date +%s)-$RANDOM"
  curl -s -X POST "$BASE_URL/api/auth/token" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"$tok_name\"}" \
    | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "token" not in d:
    print("❌ 换 token 失败:", d, file=sys.stderr); sys.exit(1)
print(d["token"], end="")
'
}

verify_token() {
  local tok="$1"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $tok" "$BASE_URL/api/projects")
  [[ "$code" == "200" ]]
}

get_token() {
  if [[ $REFRESH -eq 1 || ! -s "$CACHE_FILE" ]]; then
    local tok
    tok=$(refresh_token) || exit 1
    printf '%s' "$tok" > "$CACHE_FILE"
    chmod 600 "$CACHE_FILE"
    echo "🔄 已刷新 token ($ENV)" >&2
    echo "$tok"
    return
  fi
  local tok
  tok=$(cat "$CACHE_FILE")
  if verify_token "$tok"; then
    echo "$tok"
    return
  fi
  echo "⚠️  缓存 token 失效, 重登..." >&2
  local new
  new=$(refresh_token) || exit 1
  printf '%s' "$new" > "$CACHE_FILE"
  chmod 600 "$CACHE_FILE"
  echo "🔄 已重登换 token ($ENV)" >&2
  echo "$new"
}

# --- status 子命令 ---
if [[ $STATUS_ONLY -eq 1 ]]; then
  printf "%-5s %-40s %-12s %s\n" "env" "url" "cache" "status"
  printf "%-5s %-40s %-12s %s\n" "$ENV" "$BASE_URL" \
    "$([[ -s $CACHE_FILE ]] && echo 'has' || echo 'empty')" \
    "$([[ -s $CACHE_FILE ]] && (verify_token "$(cat $CACHE_FILE)" && echo '✅ valid' || echo '❌ stale') || echo '⚠️  none')"
  exit 0
fi

if [[ ${#PATH_PARTS[@]} -eq 0 ]]; then
  echo "❌ 缺路径 (例: /api/tasks/<uuid>)" >&2; exit 1
fi
REQ_PATH="${PATH_PARTS[0]}"

# token 来源优先级: 平台注入 AO_TOKEN > 本地缓存 > 密码重登
# 线上 agent (buildEnv 注入 env.AO_TOKEN = issueSwitchToken(userId)) 直接用,
# 不再走密码换新 —— 避免破坏 owner_id 归因 (admin 越权读)。
TOK="${AO_TOKEN:-}"
if [[ -z "$TOK" ]]; then
  TOK=$(get_token)
fi

# --- 发请求 ---
ARGS=(-s -w '\n%{http_code}' -X "$METHOD"
      -H "Authorization: Bearer $TOK"
      -H "Content-Type: application/json")
if [[ -n "$DATA" ]]; then
  ARGS+=(-d "$DATA")
fi

RAW=$(curl "${ARGS[@]}" "$BASE_URL$REQ_PATH") || {
  echo "❌ 请求失败: $METHOD $BASE_URL$REQ_PATH" >&2; exit 1
}
CODE="${RAW##*$'\n'}"
BODY="${RAW%$'\n'*}"

printf '%s' "$BODY"
if [[ ! "$CODE" =~ ^2[0-9][0-9]$ ]]; then
  echo "❌ HTTP $CODE  $METHOD $REQ_PATH" >&2
  [[ -n "$BODY" ]] && echo "   $BODY" >&2
  exit 1
fi