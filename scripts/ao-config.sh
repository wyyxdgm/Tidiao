#!/usr/bin/env bash
# ao-config.sh - 查平台全局设置 GET /api/config (concurrency / timeout)
#
# 用法:
#   ao-config.sh                  当前环境默认 (http://localhost:13000)
#   ao-config.sh <url>            任意 BASE_URL
#
# 凭证:
#   走 AO_TOKEN（不过期 bearer）或 AO_EMAIL + AO_PASSWORD（密码换 session），
#   均可用环境变量覆盖；默认地址可用 AO_BASE_URL 覆盖。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ARG="${1:-}"
if [[ -n "$ARG" ]]; then
  case "$ARG" in
    http*) BASE_URL="$ARG" ;;
    *) echo "用法: ao-config.sh [<BASE_URL>]" >&2; exit 2 ;;
  esac
else
  source "$SCRIPT_DIR/login.sh"
  ao_init_env
  BASE_URL="${AO_BASE_URL:-$AO_DEF_BASE}"
fi

source "$SCRIPT_DIR/login.sh"
ao_init_env >/dev/null 2>&1 || true
EMAIL="${AO_EMAIL:-$AO_DEF_EMAIL}"
PASSWORD="${AO_PASSWORD:-$AO_DEF_PASS}"
ao_resolve_auth

printf 'BASE=%s  ' "$BASE_URL"
ao_curl GET /api/config \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
print("concurrency={c}  timeout={t}min  cmax={m}".format(
  c=d.get("concurrency"), t=d.get("task_timeout_minutes"), m=d.get("concurrency_max")))'
