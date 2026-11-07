#!/usr/bin/env bash
# login.sh - 编排平台共享鉴权库（被 source，非直接执行）
#
# 提供：环境检测 + per-env 默认值 + 鉴权解析（AO_TOKEN 优先，否则密码换 session）
# + curl 鉴权包装。被 cron.sh / user.sh / ao-dispatch.sh / ao-chat.sh 复用。
#
# 依赖: curl
# 用法（在调用脚本中）:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
#   ao_init_env                                   # 设 AO_DEF_BASE / AO_DEF_EMAIL / AO_DEF_PASS
#   BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
#   EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
#   PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"
#   # ...参数解析可覆盖 BASE_URL / EMAIL / PASSWORD...
#   ao_resolve_auth                               # 设 AO_AUTH / AO_AUTH_MODE（失败 exit 1）
#   ao_curl GET /api/schedules                    # 自动带鉴权 + base + json header

# 防止被直接执行
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "login.sh 是共享库，请 source 它（被 cron.sh / user.sh / ao-dispatch.sh 等调用）" >&2
  exit 1
fi

# --- 环境检测 ---
# 仅用于日志展示当前运行环境（wsl / remote / local），不影响默认值
ao_detect_env() {
  local whoami; whoami=$(whoami 2>/dev/null || echo "")
  if [ -n "${WSL_DISTRO_NAME:-}" ]; then
    echo "wsl"
  else
    echo "local"
  fi
}

# --- 默认值（调用方作 fallback，可被 AO_* 环境变量 / 参数覆盖）---
# 开源版不内置任何凭据：鉴权一律走 AO_TOKEN（不过期 bearer）或
# AO_EMAIL + AO_PASSWORD 环境变量。默认平台地址 http://localhost:13000
# （自托管默认端口，可用 AO_BASE_URL / --base 覆盖）。
ao_init_env() {
  AO_CUR_ENV="$(ao_detect_env)"
  AO_DEF_BASE="http://localhost:13000"
  AO_DEF_FALLBACK_BASE=""
  AO_DEF_FALLBACK2_BASE=""
  AO_DEF_EMAIL=""
  AO_DEF_PASS=""
}

# --- 密码换 session cookie ---
# 读全局 BASE_URL / EMAIL / PASSWORD，echo session 值（失败输出空）
ao_fetch_session() {
  # 关注点: 不用 grep —— 某些环境 grep 被 alias/GREP_OPTIONS 注入 --color, ANSI 码混进
  # session 值会被服务端协议层裸拒 400 (2026-10-22 GDM tick 实证); sed -n 'p' 无此风险。
  curl -s -X POST "$BASE_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
    -D - -o /dev/null 2>/dev/null \
    | sed -n 's/.*[Ss]et-[Cc]ookie:.*session=//p' \
    | sed 's/;.*//' \
    | tr -d '\r'
}

# --- 鉴权解析：AO_TOKEN（ao_ bearer，优先）否则密码换 session ---
# 设 AO_AUTH（curl -H 用）+ AO_AUTH_MODE（bearer/session）；失败 exit 1
ao_resolve_auth() {
  if [[ -n "${AO_TOKEN:-}" ]]; then
    AO_AUTH="Authorization: Bearer $AO_TOKEN"
    AO_AUTH_MODE="bearer"
    return 0
  fi

  local session
  session="$(ao_fetch_session)"
  # BASE_URL 不通 + 有 fallback → 逐级切换重试（默认无 fallback；
  # 调用方可用 AO_DEF_FALLBACK_BASE 自定义降级链）。每级失败才换下一级.
  if [[ -z "$session" ]]; then
    local fb
    for fb in "${AO_DEF_FALLBACK_BASE:-}" "${AO_DEF_FALLBACK2_BASE:-}"; do
      [[ -z "$fb" || "$BASE_URL" == "$fb" ]] && continue
      echo "⚠️  $BASE_URL 不可达, 切 fallback → $fb" >&2
      BASE_URL="$fb"
      session="$(ao_fetch_session)"
      [[ -n "$session" ]] && break
    done
  fi

  if [[ -z "$session" ]]; then
    echo "❌ 登录失败（$EMAIL @ ${BASE_URL}）" >&2
    echo "   下一步: ① 用 AO_PASSWORD 环境变量设置密码 ② 或 AO_TOKEN 传不过期 bearer ③ 或 --base 换平台地址" >&2
    exit 1
  fi
  AO_AUTH="Cookie: session=$session"
  AO_AUTH_MODE="session"
}

# --- curl 鉴权包装 ---
# 功能: ao_curl METHOD PATH [curl-args...] -> 自动带 AO_AUTH + Content-Type + BASE_URL；
#   stdout 只有响应体，非 2xx 时把「HTTP 状态码 + 响应体」打到 stderr 并返回 1。
# 关注点: 状态码用 -w 追加在响应体尾部, 读出后必须剥掉 —— 调用方普遍 json.load(stdin),
#   混进 stdout 会全线炸。调用方**不要再加 -f**（curl -f 会吞掉错误体, 让这里只能报
#   "不可达"而拿不到状态码/error 文案）。想自己处理错误（如 trigger 的 409）的调用方
#   写 `ao_curl ... || true`, 否则 set -e 下会直接终止 —— 这是刻意的: 早先不检查状态码,
#   `cron.sh disable` 对着别人的 schedule 拿了 404 却打 ✅（见 docs/plans/schedule-runaway-shell-gap.md G2）。
ao_curl() {
  local method="$1"; shift
  local path="$1"; shift
  local raw code body
  raw="$(curl -s -w '\n%{http_code}' -X "$method" \
    -H "$AO_AUTH" \
    -H "Content-Type: application/json" \
    "$@" \
    "${BASE_URL}${path}")" || {
    echo "❌ 请求失败（网络/地址不可达）: $method ${BASE_URL}${path}" >&2
    return 1
  }
  code="${raw##*$'\n'}"      # 最后一行 = %{http_code}
  body="${raw%$'\n'*}"       # 其余 = 响应体
  printf '%s' "$body"        # 无论成败都吐响应体: 调用方加 `|| true` 就能自己解析 error 文案
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    echo "❌ HTTP $code  $method $path" >&2
    [[ -n "$body" ]] && echo "   $body" >&2
    return 1
  fi
}
