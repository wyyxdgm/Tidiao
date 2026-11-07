#!/usr/bin/env bash
# ao-task-tags.sh — task tags 读写 CLI (R122 / T2 顺手补 GDM T2.1 撞出的缺口)
#
# 用法:
#   ao-task-tags.sh <task-id-prefix>                # 读 tags (JSON 数组, 解析后按 dim/mod/req 拆桶)
#   ao-task-tags.sh <task-id-prefix> <tag1,tag2,...> # 写 tags (覆盖语义, PATCH /api/tasks/[id])
#   ao-task-tags.sh selfcheck                       # 跑正/反例自检 (无网络, 校验脚本自身)
#
# 行为:
#   - 8 位前缀 → 从列表查完整 UUID (必须唯一匹配; 多义拒绝执行, 同 ao-task-act.sh).
#   - 完整 36 位 UUID 也接受 (直通).
#   - 读模式: GET /api/tasks/[id], 解析 tags JSON 数组, 走 src/lib/tasks/tags.ts 的同款
#     prefix 拆分 (dim: / mod: / req:) 输出.
#   - 写模式: PATCH /api/tasks/[id] body.tags=[...]. 覆盖语义 (不是 add); 想增量走 src/lib/tasks/tags.ts addTag.
#   - 写时自动去前缀: 输入 "dim:auth" 和 "auth" 等价; 输入 "auth" 自动加 "dim:" 前缀 (按 dim 默认桶).
#     想精确控 prefix → 显式写 "dim:auth" / "mod:billing" / "req:R122".
#
# Exit codes:
#   0  成功
#   1  输入错 (前缀不存在 / 缺参数 / 子命令错)
#   2  多义 (同一前缀匹配多个 task)
#   3  平台错 (HTTP 失败 / 状态非 ok)
#
# 依赖: curl, python3
# bash 3.2 兼容 (Mac 自带 bash)

set -euo pipefail

if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; RESET=''
fi

# --- 环境检测 + 鉴权 (共享 login.sh) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"

PREFIX=""
TAGS_CSV=""

usage() {
  cat <<'EOF'
ao-task-tags.sh — task tags 读写 CLI

用法:
  ao-task-tags.sh <task-id-prefix>                  # 读 tags
  ao-task-tags.sh <task-id-prefix> <tag1,tag2,...>  # 写 tags (覆盖)
  ao-task-tags.sh selfcheck                         # 自检 (无网络)

行为:
  - 8 位前缀必须**唯一**匹配 (同 ao-task-act.sh, 多义拒绝执行)
  - 完整 36 位 UUID 也接受 (直通)
  - 读: 输出三类分桶 (dim/mod/req) + 其他无前缀
  - 写: 覆盖语义, 不是 add. 自动去前缀 (输入 "auth" 自动加 "dim:" 前缀)

tag 命名空间 (R122 / T1.1):
  dim:<name>    维度 (例: backend / frontend / infra / 沟通)
  mod:<name>    模块 (例: auth / billing / ui)
  req:<name>    需求 (例: R122 / 用户登录)

环境:
  AO_TOKEN, AO_EMAIL, AO_PASSWORD, AO_BASE_URL — 同 ao-dispatch.sh

示例:
  ao-task-tags.sh 5b3d4e7a                           # 读
  ao-task-tags.sh 5b3d4e7a "dim:backend,mod:api"     # 写
  ao-task-tags.sh 5b3d4e7a "auth,api,R122"           # 写 (无前缀自动归 dim 桶)
EOF
}

# --- 参数解析 ---
[[ $# -ge 1 ]] || { usage >&2; exit 1; }
[[ "$1" != "--help" && "$1" != "-h" ]] || { usage; exit 0; }

if [[ "$1" == "selfcheck" ]]; then
  shift
  exec "${SCRIPT_DIR}/ao-task-tags-selfcheck.sh"
fi

PREFIX="$1"; shift
TAGS_CSV="${1:-}"

if [[ -z "$PREFIX" ]]; then
  echo "❌ 前缀不能为空" >&2; exit 1
fi

# 完整 UUID 直通
IS_FULL_UUID=0
if [[ "$PREFIX" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  IS_FULL_UUID=1
elif [[ ! "$PREFIX" =~ ^[0-9a-fA-F]{1,36}$ ]]; then
  echo "❌ 前缀只能含 hex 字符 (0-9a-f), 最长 36 位 (完整 UUID): $PREFIX" >&2; exit 1
fi

# --- 鉴权 ---
ao_resolve_auth

# --- 拉列表查全 UUID ---
TMP=$(mktemp -t ao-task-tags.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT

if ! BODY=$(ao_curl GET "/api/tasks?limit=200" 2>"$TMP.err"); then
  echo "❌ 拉取任务列表失败" >&2
  head -5 "$TMP.err" >&2 || true
  exit 3
fi
printf '%s' "$BODY" > "$TMP"

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
    echo "� /api/tasks 返回非数组 (解析失败)" >&2
    exit 3
    ;;
  NONE)
    echo "❌ 前缀 '$PREFIX' 在任务列表里找不到匹配" >&2
    echo "   提示: ao-monitor.sh 看完整列表" >&2
    exit 1
    ;;
  AMBIG)
    echo "❌ 前缀 '$PREFIX' 匹配多个 task, 多义拒绝执行:" >&2
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

SHORT="${TASK_UUID:0:8}"

# --- 分支: 读 / 写 ---
if [[ -z "$TAGS_CSV" ]]; then
  # 读模式
  RESP_BODY=$(ao_curl GET "/api/tasks/$TASK_UUID") || {
    echo "� 读 task 失败" >&2
    exit 3
  }
  echo "🔎 读 tags → $TASK_UUID"
  printf '%s' "$RESP_BODY" | python3 - <<'PYEOF'
import sys, json
try:
    d = json.loads(sys.stdin.read() or "{}")
except Exception as e:
    print(f"❌ 解析响应失败: {e}")
    sys.exit(1)
tags_raw = d.get("tags")
if not tags_raw:
    print("   (无 tags)")
    sys.exit(0)
try:
    arr = json.loads(tags_raw) if isinstance(tags_raw, str) else tags_raw
except Exception:
    arr = []
if not isinstance(arr, list) or len(arr) == 0:
    print("   (无 tags)")
    sys.exit(0)
dims, mods, reqs, others = [], [], [], []
for t in arr:
    if not isinstance(t, str):
        continue
    if t.startswith("dim:"):
        dims.append(t[4:])
    elif t.startswith("mod:"):
        mods.append(t[4:])
    elif t.startswith("req:"):
        reqs.append(t[4:])
    else:
        others.append(t)
if dims:
    print(f"   dim:  {', '.join(dims)}")
if mods:
    print(f"   mod:  {', '.join(mods)}")
if reqs:
    print(f"   req:  {', '.join(reqs)}")
if others:
    print(f"   raw:  {', '.join(others)}  (无前缀, 建议显式加 dim:/mod:/req:)")
PYEOF
  exit 0
fi

# 写模式: CSV → JSON 数组; 无前缀默认归 dim 桶 (跟 tags.ts addTag 一致)
REQ_BODY_FILE=$(mktemp -t ao-task-tags-body.XXXXXX.json)
printf '%s' "$TAGS_CSV" > "$REQ_BODY_FILE.tmp"
python3 - "$REQ_BODY_FILE.tmp" "$REQ_BODY_FILE" <<'PYEOF'
import sys, json
csv_path, out_path = sys.argv[1], sys.argv[2]
with open(csv_path, encoding="utf-8") as f:
    raw = f.read().strip()
if not raw:
    arr = []
else:
    parts = [p.strip() for p in raw.split(",")]
    parts = [p for p in parts if p]
    arr = []
    for p in parts:
        if p.startswith("dim:") or p.startswith("mod:") or p.startswith("req:"):
            arr.append(p)
        else:
            arr.append(f"dim:{p}")  # 默认 dim 桶, 与 tags.ts addTag 一致
with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"tags": arr}, f, ensure_ascii=False)
PYEOF
rm -f "$REQ_BODY_FILE.tmp"

echo "🔎 写 tags → $TASK_UUID"
echo "   payload: $(cat "$REQ_BODY_FILE")"

RESP=$(ao_curl PATCH "/api/tasks/$TASK_UUID" --data-binary "@$REQ_BODY_FILE") || {
  echo "❌ 写 task 失败" >&2
  rm -f "$REQ_BODY_FILE"
  exit 3
}
rm -f "$REQ_BODY_FILE"

NEW_TAGS=$(printf '%s' "$RESP" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read() or '{}')
    t = d.get('tags')
    if isinstance(t, str):
        t = json.loads(t) if t else []
    print(', '.join(t) if t else '(empty)')
except Exception:
    print('(parse error)')
")
echo "✅ 写入成功"
echo "   回读 tags: $NEW_TAGS"
exit 0
