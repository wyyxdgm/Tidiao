#!/usr/bin/env bash
# ao-idea.sh — 构思层 CLI (idea-canvas P0, docs/plans/idea-canvas.md §6)
#
# 用法:
#   ao idea add -t 标题 [--hypothesis H] [--criteria C] [--deadline YYYY-MM-DD] [--status S]
#   ao idea ls                                    # 列构思 (状态/计数/窗口)
#   ao idea show <id-prefix>                      # 详情 (节点 DAG + 收益面板 + 信号)
#   ao idea node <idea-id-prefix> -t 标题 [--detail D] [--deps prefix1,prefix2]
#   ao idea signal <id-prefix> --kind inquiry [--value N] [--note N] [--ref R]
#   ao idea conclude <id-prefix> --status rejected|decided|shelved|landed --conclusion "..."
#   ao idea export <id-prefix> [-o file.md]       # 导出冷启动源 md
#   ao idea link <id1> <id2> [--relation related]
#
# Exit codes: 0 成功 | 1 输入错 | 2 多义 | 3 平台错
# 依赖: curl, python3; 鉴权走 login.sh (ao-query 同款).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"
# 鉴权解析: AO_TOKEN 优先, 否则密码换 session (login.sh 公网→内网逐级降级)
ao_resolve_auth

CMD="${1:-}"; [ -n "$CMD" ] || { sed -n 2,12p "$0"; exit 1; }
shift

# --- id 前缀解析: 8 位前缀 → 唯一 UUID (多义/不存在即退出, 同 ao-task-act 口径) ---
resolve_idea_id() {
  local p="$1"
  if [[ ${#p} -ge 36 ]]; then echo "$p"; return 0; fi
  local json
  json=$(ao_curl GET "/api/ideas") || { echo "平台请求失败" >&2; exit 3; }
  echo "$json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = '$p'
hits = [i for i in d.get('ideas', []) if i['id'].startswith(p)]
if len(hits) == 1:
    print(hits[0]['id'])
elif len(hits) == 0:
    print(f'前缀 {p} 无匹配 idea', file=sys.stderr); sys.exit(1)
else:
    print(f'前缀 {p} 匹配 {len(hits)} 个 idea, 需更长前缀', file=sys.stderr); sys.exit(2)
"
}

api() { ao_curl "$@"; }

case "$CMD" in
  add)
    TITLE=""; HYP=""; CRIT=""; DL=""; STATUS=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t|--title) TITLE="$2"; shift 2;;
        --hypothesis) HYP="$2"; shift 2;;
        --criteria) CRIT="$2"; shift 2;;
        --deadline) DL="$2"; shift 2;;
        --status) STATUS="$2"; shift 2;;
        *) echo "未知参数: $1" >&2; exit 1;;
      esac
    done
    [ -n "$TITLE" ] || { echo "缺 -t 标题" >&2; exit 1; }
    BODY=$(python3 -c "
import json
print(json.dumps({'title': '''$TITLE''', 'hypothesis': '''$HYP''' or None, 'success_criteria': '''$CRIT''' or None, 'deadline': '''$DL''' or None${STATUS:+, 'status': '$STATUS'}}))
")
    api "POST" "/api/ideas" --data-binary "$BODY" | python3 -c "
import sys, json
i = json.load(sys.stdin)
print(f\"✅ idea {i['id'][:8]} [{i['status']}] {i['title']}\")
print(f\"   假设: {i.get('hypothesis') or '-'}\")
print(f\"   判据: {i.get('success_criteria') or '-'}\")
"
    ;;
  ls)
    api "GET" "/api/ideas" | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
today = datetime.date.today()
for i in d.get('ideas', []):
    overdue = ''
    if i.get('deadline') and not i.get('concluded_at'):
        try:
            left = (datetime.date.fromisoformat(i['deadline'][:10]) - today).days
            overdue = f' | 窗口剩 {left} 天' + (' 🔴过窗未复盘' if left < 0 else '')
        except Exception: pass
    print(f\"{i['id'][:8]} [{i['status']:^11}] {i['title']}  (节点{i['node_count']}/任务{i['task_count']}/信号{i['signal_count']}){overdue}\")
"
    ;;
  show)
    P="${1:?缺 id 前缀}"; ID=$(resolve_idea_id "$P")
    api "GET" "/api/ideas/$ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
i, nodes, roi = d['idea'], d['nodes'], d['roi']
print(f\"# {i['title']}  [{i['status']}]  {i['id']}\")
if i.get('hypothesis'): print(f\"假设: {i['hypothesis']}\")
if i.get('success_criteria'): print(f\"判据: {i['success_criteria']}\")
print(f\"投入: \${roi['cost_usd']:.2f} / {roi['task_count']} 任务 | 信号: 咨询{roi['inquiry_count']} 注册{roi['signup_count']} 收入{roi['payment_total']}\")
if nodes:
    print('节点:')
    for n in nodes:
        deps = ' ← ' + ','.join(x[:8] for x in n['depends_on']) if n['depends_on'] else ''
        print(f\"  {n['id'][:8]} [{n['status']:^9}] {n['title']} ({n['task_count']} 任务){deps}\")
for s in d.get('signals', [])[:10]:
    v = f\" = {s['value']}\" if s.get('value') is not None else ''
    print(f\"信号 [{s['kind']}{v}] {s.get('note') or ''} {s.get('ref') or ''}\")
if i.get('conclusion'): print(f\"结论: {i['conclusion']}\")
"
    ;;
  node)
    IDEA_P="${1:?缺 idea 前缀}"; shift
    IDEA_ID=$(resolve_idea_id "$IDEA_P")
    TITLE=""; DETAIL=""; DEPS=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t|--title) TITLE="$2"; shift 2;;
        --detail) DETAIL="$2"; shift 2;;
        --deps) DEPS="$2"; shift 2;;
        *) echo "未知参数: $1" >&2; exit 1;;
      esac
    done
    [ -n "$TITLE" ] || { echo "缺 -t 标题" >&2; exit 1; }
    BODY=$(python3 -c "
import json
print(json.dumps({'title': '''$TITLE''', 'detail': '''$DETAIL''' or None}))
")
    NODE=$(api "POST" "/api/ideas/$IDEA_ID/nodes" --data-binary "$BODY")
    NODE_ID=$(echo "$NODE" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
    if [ -n "$DEPS" ]; then
      # deps 指向同 idea 的节点 (跨 idea 依赖平台 400 拒), 前缀在节点表里解析, 不是 idea 表
      NODES_JSON=$(api "GET" "/api/ideas/$IDEA_ID")
      DEP_IDS=$(echo "$NODES_JSON" | DEPS="$DEPS" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
ids = []
for p in [x.strip() for x in os.environ['DEPS'].split(',') if x.strip()]:
    hits = [n['id'] for n in d.get('nodes', []) if n['id'].startswith(p)]
    if len(hits) == 1:
        ids.append(hits[0])
    elif len(hits) == 0:
        print(f'前缀 {p} 无匹配节点', file=sys.stderr); sys.exit(1)
    else:
        print(f'前缀 {p} 匹配 {len(hits)} 个节点, 需更长前缀', file=sys.stderr); sys.exit(2)
print(','.join('\"%s\"' % i for i in ids))
")
      api "PATCH" "/api/idea-nodes/$NODE_ID" --data-binary "{\"deps\": [${DEP_IDS}]}" > /dev/null
    fi
    echo "✅ node $NODE_ID added to $IDEA_ID"
    ;;
  signal)
    P="${1:?缺 id 前缀}"; shift
    ID=$(resolve_idea_id "$P")
    KIND=""; VAL=""; NOTE=""; REF=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --kind) KIND="$2"; shift 2;;
        --value) VAL="$2"; shift 2;;
        --note) NOTE="$2"; shift 2;;
        --ref) REF="$2"; shift 2;;
        *) echo "未知参数: $1" >&2; exit 1;;
      esac
    done
    [ -n "$KIND" ] || { echo "缺 --kind (inquiry|signup|payment|review|usage|other)" >&2; exit 1; }
    BODY=$(python3 -c "
import json
val = '''$VAL'''
print(json.dumps({'kind': '$KIND', 'value': float(val) if val else None, 'note': '''$NOTE''' or None, 'ref': '''$REF''' or None}))
")
    api "POST" "/api/ideas/$ID/signals" --data-binary "$BODY" | python3 -c "
import sys, json
s = json.load(sys.stdin)
print(f\"✅ signal {s['id'][:8]} [{s['kind']}] 已归因到 {s['idea_id'][:8]}\")
"
    ;;
  conclude)
    P="${1:?缺 id 前缀}"; shift
    ID=$(resolve_idea_id "$P")
    ST=""; CON=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --status) ST="$2"; shift 2;;
        --conclusion) CON="$2"; shift 2;;
        *) echo "未知参数: $1" >&2; exit 1;;
      esac
    done
    [ -n "$ST" ] && [ -n "$CON" ] || { echo "缺 --status 或 --conclusion" >&2; exit 1; }
    api "PATCH" "/api/ideas/$ID" --data-binary "{\"conclusion\": $(python3 -c "import json;print(json.dumps('$CON'))"), \"status\": \"$ST\"}" | python3 -c "
import sys, json
i = json.load(sys.stdin)
print(f\"✅ 已出结论 [{i['status']}] {i['title']}\")
"
    ;;
  export)
    P="${1:?缺 id 前缀}"; shift
    ID=$(resolve_idea_id "$P")
    OUT=""
    if [ "${1:-}" = "-o" ]; then OUT="$2"; fi
    if [ -n "$OUT" ]; then
      api "GET" "/api/ideas/$ID/export" > "$OUT"
      echo "✅ 导出 → $OUT"
    else
      api "GET" "/api/ideas/$ID/export"
    fi
    ;;
  link)
    A=$(resolve_idea_id "${1:?缺 id1}"); B=$(resolve_idea_id "${2:?缺 id2}")
    api "POST" "/api/idea-links" --data-binary "{\"idea_id\": \"$A\", \"linked_idea_id\": \"$B\"}" > /dev/null
    echo "✅ linked ${A:0:8} ↔ ${B:0:8}"
    ;;
  *)
    sed -n 2,12p "$0"; exit 1;;
  esac
