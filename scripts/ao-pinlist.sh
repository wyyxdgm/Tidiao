#!/usr/bin/env bash
# ao-pinlist.sh — 人工分拣列表 CLI (idea-canvas, docs/plans/idea-canvas.md)
#
# 列表 = 项目级任务容器 (v524: 可挂 project + 条目带 data 扩展字段, 按 data_schema 校验)。
# 替代旧「需求」入口: 需求 = 一个带 schema 的列表。
#
# 用法:
#   ao pinlist ls [--project <项目名|id|null>]   # 列列表 (含条目; --project null 只看全局)
#   ao pinlist add -t 标题 [-p 项目名] [--schema JSON] [--required 字段1,字段2]
#       # schema 示例: '{"doc":{"title":"文档","type":"string"},"priority":{"title":"优先级","type":"string"}}'
#   ao pinlist schema <list-prefix> [--set JSON] # 看/设列表 data schema
#   ao pinlist rename <list-prefix> -t 新标题
#   ao pinlist put <list-prefix> --task <prefix> [--note N] [--data JSON] [--by agent:项目名]
#   ao pinlist put <list-prefix> --idea <prefix>
#   ao pinlist mv --task <prefix> --from 列表A --to 列表B   # 跨列表搬移 (note/data 随行)
#   ao pinlist rm <list-prefix> --item <item-id> | --all
#
# Exit codes: 0 成功 | 1 输入错 | 2 多义 | 3 平台错
# 依赖: curl, python3; 鉴权走 login.sh. 参数经 argv 传给 python (不做字符串插值, 免引号地狱)。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"
ao_resolve_auth

CMD="${1:-}"; [ -n "$CMD" ] || { sed -n 8,21p "$0"; exit 1; }
shift

resolve_list_id() {
  local p="$1"
  ao_curl GET "/api/pin-lists" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = sys.argv[1]
hits = [l for l in d.get('lists', []) if l['id'].startswith(p) or l['title'] == p]
if len(hits) == 1: print(hits[0]['id'])
elif len(hits) == 0: print(f'列表 {p} 不存在', file=sys.stderr); sys.exit(1)
else: print(f'前缀 {p} 匹配 {len(hits)} 个列表', file=sys.stderr); sys.exit(2)
" "$p"
}

resolve_ref() {
  local type="$1" p="$2"
  if [[ ${#p} -ge 36 ]]; then echo "$p"; return 0; fi
  ao_curl GET "/api/${type}s?limit=500" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# /api/tasks 返回裸数组, /api/ideas 返回 {ideas}; 两种都兜住
items = d if isinstance(d, list) else (d.get('tasks') or d.get('ideas') or [])
hits = [i for i in items if i['id'].startswith(sys.argv[2])]
if len(hits) == 1: print(hits[0]['id'])
else: print(f'前缀 {sys.argv[2]} 匹配 {len(hits)} 个', file=sys.stderr); sys.exit(2)
" "$type" "$p"
}

resolve_project_id() {
  local p="$1"
  ao_curl GET "/api/projects" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ps = d.get('projects', d if isinstance(d, list) else [])
p = sys.argv[1]
name_hits = [x for x in ps if x['name'] == p]
if len(name_hits) > 1:  # 跨 owner 重名 = 歧义, 显式失败不做猜测
    print('⚠️  项目名重名 %d 个: %s; 用项目 UUID 指定' % (len(name_hits), ', '.join(m['id'][:8] for m in name_hits)), file=sys.stderr)
    print('')
elif name_hits:
    print(name_hits[0]['id'])
else:
    hits = [x for x in ps if x['id'].startswith(p)]
    print(hits[0]['id'] if hits else '')
" "$p"
}

case "$CMD" in
  ls)
    PROJ_FILTER=""
    while [ $# -gt 0 ]; do case "$1" in
      --project) PROJ_FILTER="$2"; shift 2;;
      *) shift;;
    esac; done
    Q="/api/pin-lists"
    if [ -n "$PROJ_FILTER" ]; then
      if [ "$PROJ_FILTER" = "null" ]; then
        Q="/api/pin-lists?project_id=null"
      else
        PROJ_ID=$(resolve_project_id "$PROJ_FILTER")
        [ -n "$PROJ_ID" ] || { echo "项目 $PROJ_FILTER 不存在" >&2; exit 1; }
        Q="/api/pin-lists?project_id=$PROJ_ID"
      fi
    fi
    ao_curl GET "$Q" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for l in d.get('lists', []):
    proj = f\" ·{l['project_id'][:8]}\" if l.get('project_id') else ''
    print(f\"== {l['title']}  ({l['id'][:8]}) {len(l['items'])} 条{proj}\")
    for i in l['items']:
        mark = ' (已删)' if i.get('missing') else ''
        data = ''
        if i.get('data'):
            try:
                dd = json.loads(i['data'])
                data = '  {' + ', '.join(f'{k}={v}' for k, v in dd.items()) + '}'
            except Exception: pass
        by = f\" [{i['added_by']}]\" if i.get('added_by') and i['added_by'] != 'user' else ''
        print(f\"   - [{i['ref_type']}] {i['title']}{data}{mark}{by}\")
"
    ;;
  add)
    TITLE=""; PROJ=""; SCHEMA=""; REQUIRED=""
    while [ $# -gt 0 ]; do case "$1" in
      -t|--title) TITLE="$2"; shift 2;;
      -p|--project) PROJ="$2"; shift 2;;
      --schema) SCHEMA="$2"; shift 2;;
      --required) REQUIRED="$2"; shift 2;;
      *) echo "未知参数: $1" >&2; exit 1;;
    esac; done
    [ -n "$TITLE" ] || { echo "缺 -t 标题" >&2; exit 1; }
    PROJ_ID=""
    [ -n "$PROJ" ] && PROJ_ID=$(resolve_project_id "$PROJ") && [ -n "$PROJ_ID" ] || { [ -z "$PROJ" ] || { echo "项目 $PROJ 不存在" >&2; exit 1; }; }
    BODY=$(python3 -c "
import json, sys
title, proj, schema_raw, required_raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
schema = None
if schema_raw:
    props = json.loads(schema_raw)
    schema = json.dumps({'properties': props, 'required': [k.strip() for k in required_raw.split(',') if k.strip()]})
print(json.dumps({'title': title, 'project_id': proj or None, 'data_schema': schema}))
" "$TITLE" "$PROJ_ID" "${SCHEMA:-}" "${REQUIRED:-}")
    ao_curl POST "/api/pin-lists" --data-binary "$BODY" | python3 -c "
import sys, json
l = json.load(sys.stdin)
print(f\"✅ 列表 {l['id'][:8]} 「{l['title']}」已建\")
"
    ;;
  schema)
    LP="${1:?缺列表前缀}"; shift
    LID=$(resolve_list_id "$LP")
    SET=""
    while [ $# -gt 0 ]; do case "$1" in --set) SET="$2"; shift 2;; *) shift;; esac; done
    if [ -n "$SET" ]; then
      BODY=$(python3 -c "
import json, sys
props = json.loads(sys.argv[1])
req = [k for k, v in props.items() if isinstance(v, dict) and v.get('required')]
print(json.dumps({'data_schema': json.dumps({'properties': props, 'required': req})}))
" "$SET")
      ao_curl PATCH "/api/pin-lists/$LID" --data-binary "$BODY" > /dev/null
      echo "✅ schema 已设置"
    fi
    ao_curl GET "/api/pin-lists" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for l in d.get('lists', []):
    if l['id'].startswith(sys.argv[1]):
        print(l.get('data_schema') or '(无 schema)')
" "$LID"
    ;;
  rename)
    LP="${1:?缺列表前缀}"; shift
    LID=$(resolve_list_id "$LP")
    TITLE=""
    while [ $# -gt 0 ]; do case "$1" in -t|--title) TITLE="$2"; shift 2;; *) shift;; esac; done
    [ -n "$TITLE" ] || { echo "缺 -t 新标题" >&2; exit 1; }
    BODY=$(python3 -c "
import json, sys
print(json.dumps({'title': sys.argv[1]}))
" "$TITLE")
    ao_curl PATCH "/api/pin-lists/$LID" --data-binary "$BODY" > /dev/null
    echo "✅ 已改名「$TITLE」"
    ;;
  put)
    LP="${1:?缺列表前缀}"; shift
    LID=$(resolve_list_id "$LP")
    TYPE=""; RID=""; NOTE=""; BY=""; DATA=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --task|--idea|--node|--plan) TYPE="${1#--}"; RID="$2"; shift 2;;
        --note) NOTE="$2"; shift 2;;
        --data) DATA="$2"; shift 2;;
        --by) BY="$2"; shift 2;;
        *) echo "未知参数: $1" >&2; exit 1;;
      esac
    done
    [ -n "$TYPE" ] && [ -n "$RID" ] || { echo "缺 --task/--idea/--node/--plan" >&2; exit 1; }
    # v530: plan 的 ref_id 是仓内相对路径 (docs/plans/x.md), 不走 ID 前缀解析直接透传
    if [ "$TYPE" = "plan" ]; then REF_ID="$RID"; else REF_ID=$(resolve_ref "$TYPE" "$RID"); fi
    BODY=$(python3 -c "
import json, sys
type_, ref_id, note, data, by = sys.argv[1:6]
print(json.dumps({'ref_type': type_, 'ref_id': ref_id, 'note': note or None,
                  'data': json.loads(data) if data else None, 'added_by': by or 'user'}))
" "$TYPE" "$REF_ID" "$NOTE" "$DATA" "$BY")
    LISTS_JSON=$(ao_curl GET "/api/pin-lists")
    # 🔴 ao_curl 对 409 会吐完 body 后 return 1, 管道段必须 || true 兜住, 否则 set -e
    #   直接杀脚本、ALREADY_IN_LIST 回退走不到 (响应体仍会进 python 解析)
    { ao_curl POST "/api/pin-lists/$LID/items" --data-binary "$BODY" || true; } | LID="$LID" REF="$REF_ID" LISTS_JSON="$LISTS_JSON" python3 -c "
import sys, json, os
i = json.load(sys.stdin)
if i.get('code') == 'ALREADY_IN_LIST':
    # 已存在: 走「删旧 + 重放」实现备注/data 更新 (API 无 PUT-note 端点, PUT 只管排序)
    lid, ref = os.environ['LID'], os.environ['REF']
    iid = ''
    for l in json.loads(os.environ['LISTS_JSON']).get('lists', []):
        if l['id'] != lid: continue
        for it in l.get('items', []):
            if it.get('ref_id') == ref:
                iid = it['id']; break
    print('ALREADY_IN_LIST ' + iid)
else:
    print(f\"✅ 已放入列表 ({i['ref_type']} {i['ref_id'][:8]})\")
" | {
      IFS= read -r RES
      if [ "${RES%% *}" = "ALREADY_IN_LIST" ]; then
        IID="${RES#ALREADY_IN_LIST }"
        [ -n "$IID" ] || { echo '已在列表但找不到条目 id' >&2; exit 3; }
        ao_curl DELETE "/api/pin-list-items/$IID" > /dev/null
        ao_curl POST "/api/pin-lists/$LID/items" --data-binary "$BODY" | python3 -c "
import sys, json
i = json.load(sys.stdin)
print(f\"♻️ 已更新列表条目 ({i['ref_type']} {i['ref_id'][:8]})\")
"
      fi
    }
    ;;
  mv)
    REF_TYPE="task"; REF_PREFIX=""; FROM=""; TO=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --task|--idea|--plan) REF_TYPE="${1#--}"; REF_PREFIX="$2"; shift 2;;
        --from) FROM="$2"; shift 2;;
        --to) TO="$2"; shift 2;;
        *) echo "未知参数: $1" >&2; exit 1;;
      esac
    done
    [ -n "$REF_PREFIX" ] && [ -n "$FROM" ] && [ -n "$TO" ] || { echo "用法: ao pinlist mv --task <prefix> --from 列表A --to 列表B" >&2; exit 1; }
    FROM_ID=$(resolve_list_id "$FROM")
    TO_ID=$(resolve_list_id "$TO")
    # v530: plan 的 ref_id 是路径, 直接透传 (与 put 同口径)
    if [ "$REF_TYPE" = "plan" ]; then REF_ID="$REF_PREFIX"; else REF_ID=$(resolve_ref "$REF_TYPE" "$REF_PREFIX"); fi
    STATE=$(ao_curl GET "/api/pin-lists" | python3 -c "
import sys, json
d = json.load(sys.stdin)
from_id, to_id, ref_id = sys.argv[1], sys.argv[2], sys.argv[3]
item = None
for l in d.get('lists', []):
    if l['id'] == from_id:
        for i in l['items']:
            if i['ref_id'] == ref_id:
                item = {'item_id': i['id'], 'note': i.get('note'), 'data': i.get('data')}
if not item: sys.exit(3)
print(json.dumps(item))
" "$FROM_ID" "$TO_ID" "$REF_ID") || { echo "该 ref 不在来源列表「$FROM」里" >&2; exit 1; }
    ITEM_ID=$(echo "$STATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['item_id'])")
    ao_curl DELETE "/api/pin-list-items/$ITEM_ID" > /dev/null
    BODY=$(echo "$STATE" | python3 -c "
import json, sys
s = json.load(sys.stdin)
print(json.dumps({'ref_type': sys.argv[1], 'ref_id': sys.argv[2], 'note': s.get('note'),
                  'data': json.loads(s['data']) if s.get('data') else None, 'added_by': 'agent:mv'}))
" "$REF_TYPE" "$REF_ID")
    ao_curl POST "/api/pin-lists/$TO_ID/items" --data-binary "$BODY" > /dev/null
    echo "✅ 已搬移 ${REF_ID:0:8}: $FROM → $TO"
    ;;
  rm)
    LP="${1:?缺列表前缀}"; shift
    LID=$(resolve_list_id "$LP")
    ITEM=""; ALL=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --item) ITEM="$2"; shift 2;;
        --all) ALL=1; shift;;
        *) shift;;
      esac
    done
    if [ -n "$ALL" ]; then
      ao_curl GET "/api/pin-lists" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for l in d.get('lists', []):
    if l['id'].startswith(sys.argv[1]) or sys.argv[1] == l['title']:
        for i in l['items']: print(i['id'])
" "$LID" | while read -r iid; do ao_curl DELETE "/api/pin-list-items/$iid" > /dev/null; done
      echo "✅ 已清空"
    else
      [ -n "$ITEM" ] || { echo "缺 --item 或 --all" >&2; exit 1; }
      ao_curl DELETE "/api/pin-list-items/$ITEM" > /dev/null
      echo "✅ 已摘除 $ITEM"
    fi
    ;;
  *)
    sed -n 8,21p "$0"; exit 1;;
esac
