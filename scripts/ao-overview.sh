#!/usr/bin/env bash
# ao-overview.sh — 项目概览 (单文件 markdown 看板) 读写 CLI
#
# 用法:
#   ao-overview.sh show <project>                    # 读概览正文 (stdout = 纯 markdown)
#   ao-overview.sh edit <project> <file>              # 用本地文件整体覆盖概览 (写完自动回写)
#   ao-overview.sh set <project> <file>               # 同 edit, 语义别名 (覆盖语义)
#   ao-overview.sh append <project> <file>            # 追加 (在原正文后接一段, 不覆盖)
#   ao-overview.sh clear <project>                    # 删掉概览
#   ao-overview.sh url <project>                      # 打印概览页面 URL (给人点)
#   ao-overview.sh --help
#
# 为什么要有 CLI:
#   1. **给 agent 用** —— agent 拿到「这个项目的现状是什么 / 链接在哪」不需要开
#      浏览器; `ao overview show <project>` 直接吐纯 markdown, agent 可读可改.
#   2. **给人用** —— `ao overview edit <project> README.md` 用本地编辑器写,
#      写完回写; 页面随即刷新 (刷新即可见).
#   3. 两边写的是**同一个** key (project_configs.overview_md, AES-256-GCM 加密),
#      所以「人在页面写 / agent 在 CLI 改」不会分叉.
#
# 项目标识:
#   <project> 可以是完整 UUID、完整项目名、或项目名的唯一子串 (与 ao-dispatch.sh
#   的四级解析同口径: 精确 > 别名 > 大小写不敏感 > 子串唯一). 多义 → 拒绝执行,
#   报错列出候选 (不猜).
#
# Exit codes:
#   0  成功
#   1  输入错 (缺参数 / 找不到项目 / 子命令错)
#   2  多义 (名称匹配多个项目)
#   3  平台错 (HTTP 失败 / 非 2xx)
#
# 依赖: curl, python3. bash 3.2 兼容 (Mac 自带 bash).

set -euo pipefail

if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; RESET=''
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
# 关注点: login.sh 的 ao_fetch_session / ao_resolve_auth 读全局 EMAIL / PASSWORD
# (不是 AO_EMAIL / AO_PASSWORD) —— 这两个变量必须在 resolve 前落到全局, 否则
# set -u 下报 "EMAIL: unbound variable" (ao-dispatch.sh / cron.sh 同款做法).
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"

usage() {
  cat <<'EOF'
ao-overview.sh — 项目概览 (单文件 markdown 看板) 读写 CLI

用法:
  ao-overview.sh show <project>              # 读正文 (stdout = 纯 markdown, 无杂音)
  ao-overview.sh edit <project> <file>        # 用文件覆盖概览
  ao-overview.sh set <project> <file>         # 同 edit (别名)
  ao-overview.sh append <project> <file>      # 追加 (不覆盖原正文)
  ao-overview.sh clear <project>              # 删掉概览
  ao-overview.sh url <project>                # 打印概览页面 URL

<project> = 完整 UUID / 完整项目名 / 名称的唯一子串. 多义时拒绝执行.

说明:
  - 概览存 DB 加密 (project_configs.overview_md, AES-256-GCM), **不进 git** ——
    凭据/密码可以放心写在概览里.
  - 页面 = 项目详情页第一个 tab (「概览」). 改了刷新页面即可见.
  - 正文是 markdown: 链接 / 表格 / 代码块都支持. 平台内跳转用
    `task:任务ID` 或相对 `.md` 路径; 飞书等外部链接贴 URL 即可.

环境:
  AO_BASE_URL, AO_EMAIL, AO_PASSWORD — 同 ao-dispatch.sh

示例:
  ao-overview.sh show <项目名>
  ao-overview.sh edit <项目名> /tmp/status.md
  ao-overview.sh append <项目名> /tmp/new-link.md
EOF
}

[[ $# -ge 1 ]] || { usage >&2; exit 1; }
[[ "$1" != "--help" && "$1" != "-h" ]] || { usage; exit 0; }

CMD="$1"; shift

case "$CMD" in
  show|edit|set|append|clear|url) ;;
  *) echo "❌ 未知子命令: $CMD (可用: show/edit/set/append/clear/url)" >&2; exit 1 ;;
esac

[[ $# -ge 1 ]] || { echo "❌ 缺 <project> 参数" >&2; usage >&2; exit 1; }
PROJECT_REF="$1"; shift

FILE=""
if [[ "$CMD" == "edit" || "$CMD" == "set" || "$CMD" == "append" ]]; then
  [[ $# -ge 1 ]] || { echo "❌ 缺 <file> 参数" >&2; usage >&2; exit 1; }
  FILE="$1"; shift
  [[ -f "$FILE" ]] || { echo "❌ 文件不存在: $FILE" >&2; exit 1; }
fi

# --- 鉴权 ---
ao_resolve_auth

# --- 项目名 → project_id ---
# 关注点: 与 ao-dispatch.sh 同款四级解析 (精确 > 别名 > 大小写不敏感 > 子串唯一).
# 多义**拒绝执行**并列出候选 —— 不猜 (2026-10-12 实证: 猜错 = 改错项目).
resolve_project_id() {
  local ref="$1"
  local tmp; tmp=$(mktemp -t ao-overview.XXXXXX.json)
  ao_curl GET "/api/projects" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 3; }
  local out
  out=$(PROJECT_REF="$ref" python3 - "$tmp" <<'PYEOF'
import sys, json, os
path = sys.argv[1]
ref = os.environ["PROJECT_REF"]
ALIASES = {
}
with open(path, encoding="utf-8") as f:
    data = json.load(f)
projects = data.get("projects", []) if isinstance(data, dict) else []
name = ALIASES.get(ref.lower(), ref)

# 完整 UUID 直通
if len(ref) == 36 and ref.count("-") == 4:
    for p in projects:
        if p.get("id") == ref:
            print("OK\t" + ref)
            sys.exit(0)

# 🔴 多义检查**先于**任何匹配 —— 精确同名多个 (跨 owner 重名, 2026-10-12 实证)
#   必须拒绝执行并列出候选, 不能静默挑一个 (挑错 = 改错项目的凭据).
exact = [p for p in projects if p.get("name") == name]
if len(exact) > 1:
    print("AMBIG\t" + ",".join(p["id"] for p in exact))
    sys.exit(0)

ci = [p for p in projects if (p.get("name") or "").lower() == name.lower()]
if len(ci) > 1:
    print("AMBIG\t" + ",".join(p["id"] for p in ci))
    sys.exit(0)
sub = [p for p in projects if name.lower() in (p.get("name") or "").lower()]
if len(sub) > 1:
    print("AMBIG\t" + ",".join(p["id"] for p in sub))
    sys.exit(0)

p = None
for cand in (exact, ci, sub):
    if len(cand) == 1:
        p = cand[0]
        break

if p is None:
    names = sorted({x.get("name") or "?" for x in projects})
    print("NONE\t" + ",".join(names))
    sys.exit(0)

print("OK\t" + p["id"])
PYEOF
)
  rm -f "$tmp"
  printf '%s' "$out"
}

RESOLVE_OUT="$(resolve_project_id "$PROJECT_REF")" || {
  echo "❌ 拉项目列表失败 (平台不通? 检查 AO_BASE_URL)" >&2; exit 3; }
KIND="${RESOLVE_OUT%%	*}"
VAL="${RESOLVE_OUT#*	}"

case "$KIND" in
  NONE)
    echo "❌ 找不到项目: $PROJECT_REF" >&2
    echo "   可用项目: ${VAL}" >&2
    exit 1
    ;;
  AMBIG)
    echo "❌ 项目名 '$PROJECT_REF' 匹配多个项目, 多义拒绝执行:" >&2
    IFS=',' read -ra IDS <<< "$VAL"
    for i in "${IDS[@]}"; do echo "   - $i" >&2; done
    echo "   用完整 UUID 显式指定" >&2
    exit 2
    ;;
  *) ;;
esac
PROJECT_ID="$VAL"

# --- 子命令实现 ---
case "$CMD" in
  show)
    BODY=$(ao_curl GET "/api/projects/${PROJECT_ID}/overview")
    echo "$BODY" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("exists"):
    sys.exit(0)
sys.stdout.write(d.get("markdown") or "")
'
    ;;

  edit|set)
    BODY=$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    sys.stdout.write(json.dumps({"markdown": f.read()}, ensure_ascii=False))
' "$FILE")
    ao_curl PUT "/api/projects/${PROJECT_ID}/overview" --data "$BODY" > /dev/null
    echo "✅ 概览已更新 (project ${PROJECT_ID}, 来自 ${FILE})" >&2
    ;;

  append)
    CURRENT=$(ao_curl GET "/api/projects/${PROJECT_ID}/overview" | python3 -c '
import sys, json
d = json.load(sys.stdin)
sys.stdout.write((d.get("markdown") or "") if d.get("exists") else "")
')
    NEW=$(cat "$FILE")
    MERGED=$(printf '%s\n\n%s' "$CURRENT" "$NEW")
    BODY=$(printf '%s' "$MERGED" | python3 -c '
import json, sys
sys.stdout.write(json.dumps({"markdown": sys.stdin.read()}, ensure_ascii=False))
')
    ao_curl PUT "/api/projects/${PROJECT_ID}/overview" --data "$BODY" > /dev/null
    echo "✅ 概览已追加 (project ${PROJECT_ID})" >&2
    ;;

  clear)
    ao_curl DELETE "/api/projects/${PROJECT_ID}/overview" > /dev/null
    echo "✅ 概览已删除 (project ${PROJECT_ID})" >&2
    ;;

  url)
    echo "http://localhost:13000/#/projects/${PROJECT_ID}"
    ;;
esac
