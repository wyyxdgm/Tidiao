#!/usr/bin/env bash
# user.sh - 编排平台用户维护 CLI
#
# 封装 auth + user + llm-config + api-tokens API：
#   register / login / me / token / tokens / tokens-rm / llm-config
#
# 用法:
#   user.sh register --email a@b.com --password xxx
#   user.sh login                            # 验证当前凭据能否登录
#   user.sh me                               # 查看当前用户资料
#   user.sh token --name "my-cli"            # 生成不过期 ao_ bearer
#   user.sh tokens ; user.sh tokens-rm <id>[,<id>...]
#   user.sh llm-config                       # 查看当前 LLM 配置
#   user.sh llm-config set --api-key sk-... --base-url https://... --model claude-...
#   user.sh llm-config clear-key ; user.sh llm-config delete
#
# 依赖: curl, python3
# 鉴权: 除 register/login 外，均 source login.sh（AO_TOKEN 优先，否则 AO_EMAIL/AO_PASSWORD 登录）

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
user.sh - 编排平台用户维护 CLI

当前环境: ${AO_CUR_ENV} -> ${BASE_URL}

命令:
  register --email E --password P   注册新用户（首个用户成为 admin）
  login [--email E --password P]    验证凭据（密码登录自检）
  me                                当前用户资料（role + admin_llm_granted）
  token [--name NAME]               生成不过期 ao_ bearer（用当前鉴权）
  tokens                            列出当前用户的 API token
  tokens-rm <id>[,<id>...]           删除一个或多个 token（逗号分隔，调批量端点）
  llm-config                        查看当前用户的 LLM 配置（key 脱敏）
  llm-config set [--api-key K] [--base-url U] [--model M]   设置（仅传要改的字段）
  llm-config clear-key              清除 api_key
  llm-config delete                 删除整个 LLM 配置

通用:
  --base URL  --email EMAIL  --password PASS   覆盖默认鉴权/地址
  -h, --help

环境变量:
  AO_TOKEN                 ao_ bearer（me/token/tokens/llm-config 用）
  AO_BASE_URL / AO_EMAIL / AO_PASSWORD

示例:
  # 注册（首个用户自动 admin）
  user.sh register --email me@x.com --password secret123

  # 给当前账号 mint 一个 CLI token
  user.sh token --name "laptop-\$(date +%F)"

  # 配置自己的 LLM（火山方舟）
  user.sh llm-config set --api-key ark-... --base-url https://ark.cn-beijing.volces.com/api/plan --model claude-...
EOF
  exit 0
}

# --- 主命令派发 ---
CMD="${1:-}"
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && usage
shift

case "$CMD" in
  register)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        --base) BASE_URL="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    [[ -z "$EMAIL" || -z "$PASSWORD" ]] && { echo "❌ register 需 --email 和 --password" >&2; exit 1; }
    RESULT="$(curl -s -X POST "$BASE_URL/api/auth/register" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
    echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
u = r.get('user') or {}
if not u:
    sys.exit(1)
print(f\"✅ 注册成功: {u.get('email')} (role={u.get('role')})\")
" 2>/dev/null || { echo "❌ 注册失败: $RESULT" >&2; exit 1; }
    ;;

  login)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        --base) BASE_URL="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    [[ -z "$EMAIL" || -z "$PASSWORD" ]] && { echo "❌ login 需 --email 和 --password（或设 AO_EMAIL/AO_PASSWORD）" >&2; exit 1; }
    RESULT="$(curl -s -X POST "$BASE_URL/api/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
    echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
u = r.get('user') or {}
if not u:
    sys.exit(1)
print(f\"✅ 登录成功: {u.get('email')} (role={u.get('role')}) @ $BASE_URL\")
" 2>/dev/null || { echo "❌ 登录失败: $RESULT" >&2; exit 1; }
    ;;

  me)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --base) BASE_URL="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    ao_resolve_auth
    ao_curl GET /api/user/me | python3 -m json.tool
    ;;

  token)
    NAME_ARG=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) NAME_ARG="$2"; shift 2 ;;
        --base) BASE_URL="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    ao_resolve_auth
    BODY='{}'
    [[ -n "$NAME_ARG" ]] && BODY="{\"name\":\"$NAME_ARG\"}"
    RESULT="$(ao_curl POST /api/api-tokens -d "$BODY")"
    echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
tok = r.get('token')
if not tok:
    sys.exit(1)
print(f'✅ token 已生成（仅显示一次）:\n{tok}')
print(f\"   name={r.get('name')} prefix={r.get('prefix')}\")
" 2>/dev/null || { echo "❌ 生成失败: $RESULT" >&2; exit 1; }
    ;;

  tokens)
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --base) BASE_URL="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
      esac
    done
    ao_resolve_auth
    ao_curl GET /api/api-tokens \
      | python3 -c "
import sys, json
r = json.load(sys.stdin)
ts = r.get('tokens', [])
if not ts:
    print('（无 token）'); sys.exit()
print(f\"{'NAME':20} {'PREFIX':12} {'CREATED':12} {'ID':36}\")
for t in ts:
    name = (t.get('name') or '')[:20]
    pre = (t.get('prefix') or '')[:12]
    cre = (t.get('created_at') or '')[:10]
    tid = t.get('id') or ''
    print(f'{name:20} {pre:12} {cre:12} {tid}')
"
    ;;

  tokens-rm)
    IDS=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --base) BASE_URL="$2"; shift 2 ;;
        --email) EMAIL="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) IDS+="${IDS:+,}$1"; shift ;;
      esac
    done
    [[ -z "$IDS" ]] && { echo "❌ tokens-rm 至少需要 1 个 id（逗号分隔）" >&2; exit 1; }
    ao_resolve_auth
    IDS_JSON="$(printf '%s' "$IDS" | python3 -c '
import sys, json
ids = [x.strip() for x in sys.stdin.read().split(",") if x.strip()]
print(json.dumps({"ids": ids}))
')"
    ao_curl POST /api/api-tokens/delete-batch -d "$IDS_JSON" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if 'deleted' in r:
    print(f\"✅ 已删除 {r['deleted']} / {r['requested']}\")
else:
    print(f\"❌ 失败: {r.get('error', r)}\"); sys.exit(1)
" 2>/dev/null
    ;;

  llm-config)
    SUB="${1:-}"; [[ -z "$SUB" ]] && SUB="get"
    [[ "$SUB" == "-h" || "$SUB" == "--help" ]] && usage
    case "$SUB" in
      get)
        ao_resolve_auth
        ao_curl GET /api/user/llm-config | python3 -m json.tool
        ;;
      set)
        shift
        API_KEY=""; BASE_URL_SET=""; MODEL=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --api-key) API_KEY="$2"; shift 2 ;;
            --base-url) BASE_URL_SET="$2"; shift 2 ;;
            --model) MODEL="$2"; shift 2 ;;
            --base) BASE_URL="$2"; shift 2 ;;
            --email) EMAIL="$2"; shift 2 ;;
            --password) PASSWORD="$2"; shift 2 ;;
            -h|--help) usage ;;
            *) echo "未知参数: $1" >&2; exit 1 ;;
          esac
        done
        [[ -z "$API_KEY" && -z "$BASE_URL_SET" && -z "$MODEL" ]] && { echo "❌ llm-config set 需至少一个: --api-key / --base-url / --model" >&2; exit 1; }
        ao_resolve_auth
        BODY="$(CR_API_KEY="$API_KEY" CR_BASE_URL="$BASE_URL_SET" CR_MODEL="$MODEL" python3 -c '
import json, os
body = {}
if os.environ.get("CR_API_KEY"): body["api_key"] = os.environ["CR_API_KEY"]
if os.environ.get("CR_BASE_URL"): body["base_url"] = os.environ["CR_BASE_URL"]
if os.environ.get("CR_MODEL"): body["model"] = os.environ["CR_MODEL"]
print(json.dumps(body, ensure_ascii=False))
')"
        ao_curl PUT /api/user/llm-config -d "$BODY" | python3 -m json.tool
        ;;
      clear-key)
        ao_resolve_auth
        ao_curl PUT /api/user/llm-config -d '{"clear_api_key":true}' | python3 -m json.tool
        ;;
      delete)
        ao_resolve_auth
        ao_curl DELETE /api/user/llm-config | python3 -c "import sys,json; print('✅ LLM 配置已删除' if json.load(sys.stdin).get('ok') else '?')" 2>/dev/null
        ;;
      *)
        echo "未知子命令: llm-config ${SUB}（可用: get / set / clear-key / delete）" >&2; exit 1 ;;
    esac
    ;;

  *)
    echo "未知命令: $CMD" >&2; usage ;;
esac
