#!/usr/bin/env bash
# ao-monitor.sh — 编排平台任务监控（按 project_id 过滤 + 对时换算 + 判卡）
#
# 用法:
#   ao-monitor.sh <project_id> [--base URL] [--stale-min 90] [--limit 200] [--json]
#
# 作用（解决 unattended-dispatch-playbook.md §4 #2/#3/#16 三个坑）:
#   - 平台时间戳是 UTC → 全部 +8 小时换算成本地时间打印，elapsed 用 UTC 秒数差
#     本地 date 对比，不再把"卡了多久"算差 8 小时
#   - 监控谁在飞要按 project_id 过滤（服务端已支持 ?projectId= 查询参数），
#     不再扫全平台被 R94/R56 之类别家任务污染
#   - 列表与 detail 的 status 有延迟差 → 本脚本只读 list，不追 detail，输出明确
#     标注 "（list）"，验收以 detail 为准
#
# Exit codes:
#   0  无事（无卡死/失败/reviewing）
#   1  有需处理（卡死/失败/reviewing/queued 堆积）—— 监控轮收到该码就告警
#   2  平台不可达 / 鉴权失败
#   3  参数错
#
# 依赖: curl, python3, awk, sed, tr
# bash 3.2 兼容（Mac 自带 bash）：不用 ${var^^}/${var,,}/declare -A/mapfile

set -euo pipefail

# --- 颜色（无 tty 时自动停用）---
if [[ -t 1 ]]; then
  RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

# --- 环境检测 + 鉴权（共享 login.sh）---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=login.sh
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-${AO_DEF_BASE}}"
EMAIL="${AO_EMAIL:-${AO_DEF_EMAIL}}"
PASSWORD="${AO_PASSWORD:-${AO_DEF_PASS}}"

PROJECT_ID=""
STALE_MIN="90"
LIMIT="200"
JSON_OUT="false"

usage() {
  cat <<'EOF'
ao-monitor.sh — 编排平台任务监控（按 project_id 过滤）

用法:
  ao-monitor.sh <project_id> [--base URL] [--stale-min N] [--limit N] [--json]

参数:
  <project_id>       项目 UUID（必填；不接受名字，名字请先用 ao-dispatch.sh --dry-run 查）
      --base URL     平台地址（默认按环境自动检测）
      --stale-min N  running 状态超过 N 分钟没更新视为卡死（默认 90）
      --limit N      拉多少条（默认 200）
      --json         输出 JSON 报告（机器读；退出码同文本模式）
      --help         帮助

环境:
  AO_TOKEN, AO_EMAIL, AO_PASSWORD, AO_BASE_URL — 同 ao-dispatch.sh

输出示例:
  === ao-monitor @ 2026-08-28 09:14 (+0800)  project=e72cd0fd... ===
  ⚙  total=12  running=1  queued=0  reviewing=2  failed=0  completed=8  stale=1
  --- 卡死 (running 距 updated_at > 90 min) ---
   🔴 8a1f2c30... running 14:32  02h17m stale  「T1: 飞书重构」
  --- 需批 (reviewing) ---
   🟡 5b3d4e7a... reviewing 0:42   0h42m        「T2: demo 效果版」
  --- 在飞 (running/queued/pending) ---
   ⚙ 1c17aefb... running 0:05   0h05m        「T3: ...」
  --- 终态摘要 ---
   ✓ completed: 8  ✗ failed: 0  ↩ rejected: 0  ⊘ cancelled: 0

Exit: 0=无事 1=有需处理 2=不可达 3=参数错
EOF
}

[[ $# -ge 1 ]] || { usage >&2; exit 3; }
[[ "$1" != "--help" && "$1" != "-h" ]] || { usage; exit 0; }
PROJECT_ID="$1"; shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_URL="$2"; shift 2 ;;
    --stale-min) STALE_MIN="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --json) JSON_OUT="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 3 ;;
  esac
done

# UUID 格式校验（与 ao-dispatch.sh 口径一致）
if [[ ! "$PROJECT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "❌ project_id 不是合法 UUID: $PROJECT_ID" >&2
  echo "   提示: 先用 ao-dispatch.sh -p NAME --dry-run 查" >&2
  exit 3
fi

if ! [[ "$STALE_MIN" =~ ^[0-9]+$ ]] || [[ "$STALE_MIN" -lt 1 ]]; then
  echo "❌ --stale-min 必须为正整数: $STALE_MIN" >&2; exit 3
fi
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
  echo "❌ --limit 必须为正整数: $LIMIT" >&2; exit 3
fi

# --- 鉴权 ---
ao_resolve_auth

# --- 拉列表（带 project_id 过滤；playbook §4 #16 根治）---
TMP_JSON=$(mktemp -t ao-monitor.XXXXXX.json)
trap 'rm -f "$TMP_JSON"' EXIT

# ao_curl: stdout=body；非 2xx 写到 stderr 并返 1 (set -e 下直接终止)
if ! BODY=$(ao_curl GET "/api/tasks?projectId=$PROJECT_ID&limit=$LIMIT" 2>"$TMP_JSON.err"); then
  echo "❌ 拉取任务列表失败（$BASE_URL/api/tasks?projectId=$PROJECT_ID&limit=$LIMIT）" >&2
  head -10 "$TMP_JSON.err" >&2 || true
  exit 2
fi
printf '%s' "$BODY" > "$TMP_JSON"

# --- 渲染 ---
# 输入: $TMP_JSON (flat array of task objects) + STALE_MIN
# 输出:
#   文本模式：可读简报
#   JSON 模式：结构化简报
# 终态常量
TERMINAL='completed|failed|rejected|cancelled'

# 计算 now_utc 一次, render_text/render_json 都用 (之前 render_json 引用了未导出的局部变量, set -u 下崩)
now_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

render_text() {
  local now_local now_utc project_id
  now_local=$(date '+%Y-%m-%d %H:%M:%S %z')
  now_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  project_id="$PROJECT_ID"
  echo "=== ao-monitor @ ${now_local}  project=${project_id:0:8}... ==="
  echo "    now_utc=${now_utc}  stale_min=${STALE_MIN}  base=${BASE_URL}"
  echo

  python3 - "$TMP_JSON" "$STALE_MIN" "$now_utc" <<'PYEOF'
import sys, json, datetime as dt
path, stale_min, now_utc = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(path, encoding="utf-8") as f:
    tasks = json.load(f)

if not isinstance(tasks, list):
    print(f"❌ /api/tasks 返回非数组: {type(tasks).__name__}（期望 flat array）")
    sys.exit(2)

now = dt.datetime.strptime(now_utc, "%Y-%m-%dT%H:%M:%SZ")
# 平台 ts 是 "YYYY-MM-DD HH:MM:SS" UTC（无 tz 设计；与 .strptime("%Y-%m-%d %H:%M:%S") 兼容）

def parse_ts(s):
    if not s:
        return None
    # 兼容 ISO 'Z' 与 DB 朴素时间
    try:
        return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        pass
    try:
        return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        pass
    return dt.datetime.strptime(s.replace("T", " ").replace("Z", ""), "%Y-%m-%d %H:%M:%S")

def to_local(s):
    """UTC -> 本地 +8 字符串（print 用）"""
    u = parse_ts(s)
    return (u + dt.timedelta(hours=8)).strftime("%m-%d %H:%M")

def elapsed_str(s):
    u = parse_ts(s)
    sec = int((now - u).total_seconds())
    if sec < 0:
        return "0min"
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}min"
    return f"{sec // 3600}h{(sec % 3600) // 60}m"

stale_cutoff_sec = stale_min * 60

stats = {"total": 0, "running": 0, "queued": 0, "pending": 0,
         "reviewing": 0, "paused": 0, "failed": 0,
         "completed": 0, "rejected": 0, "cancelled": 0, "stale": 0}

stuck, reviewing, inflight, terminal_list = [], [], [], []

for t in tasks:
    stats["total"] += 1
    st = t.get("status", "?")
    if st in stats:
        stats[st] += 1
    title = (t.get("title") or "")[:40]
    tid = t.get("id", "?")
    upd = t.get("updated_at", "")
    upd_local = to_local(upd) if upd else "?"
    upd_elapsed = elapsed_str(upd) if upd else "?"
    line = {
        "id": tid, "status": st, "title": title,
        "updated_local": upd_local, "elapsed": upd_elapsed,
        "result": (t.get("result") or "")[:120],
    }
    if st == "running":
        inflight.append(line)
        if upd:
            u = parse_ts(upd)
            sec = int((now - u).total_seconds())
            if sec > stale_cutoff_sec:
                stats["stale"] += 1
                stuck.append(line)
    elif st in ("queued", "pending", "reviewing", "paused"):
        if st == "reviewing":
            reviewing.append(line)
        else:
            inflight.append(line)
    else:
        terminal_list.append(line)

def fmt(line):
    """一行任务摘要: id status updated_local elapsed  title"""
    return (f"   {line['id'][:8]}... {line['status']:9} {line['updated_local']:13} "
            f"{line['elapsed']:>8}  「{line['title']}」")

print(f"\033[1m⚙  total={stats['total']}  "
      f"running={stats['running']}  queued={stats['queued']}  "
      f"pending={stats['pending']}  reviewing={stats['reviewing']}  "
      f"paused={stats['paused']}  failed={stats['failed']}  "
      f"completed={stats['completed']}  stale={stats['stale']}\033[0m")

if stuck:
    print("--- 卡死 (running 距 updated_at > %d min) ---" % stale_min)
    for l in stuck:
        print(f"\033[0;31m🔴\033[0m{(' ' + fmt(l)).rstrip()}")
    print()

if reviewing:
    print("--- 需批 (reviewing) ---")
    for l in reviewing:
        print(f"\033[1;33m🟡\033[0m{(' ' + fmt(l)).rstrip()}")
    print()

if inflight:
    print("--- 在飞 (running/queued/pending/paused，去掉卡死) ---")
    inflight_nostale = [l for l in inflight if l["status"] != "running" or l not in stuck]
    for l in inflight_nostale:
        print(f"\033[0;36m⚙\033[0m{(' ' + fmt(l)).rstrip()}")
    print()

# 终态只给统计（detail 才是真实结果；list 拿到的 result 是部分字段，避免误导）
print("--- 终态摘要 ---")
print(f"   ✓ completed: {stats['completed']}  "
      f"✗ failed: {stats['failed']}  "
      f"↩ rejected: {stats['rejected']}  "
      f"⊘ cancelled: {stats['cancelled']}")

# Exit 码判定: stuck 或 failed 或 reviewing → 1；其他 → 0
sys.exit(1 if (stuck or stats["failed"] > 0 or reviewing) else 0)
PYEOF
}

render_json() {
  python3 - "$TMP_JSON" "$STALE_MIN" "$now_utc" <<'PYEOF'
import sys, json, datetime as dt
path, stale_min, now_utc = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(path, encoding="utf-8") as f:
    tasks = json.load(f)
now = dt.datetime.strptime(now_utc, "%Y-%m-%dT%H:%M:%SZ")

def parse_ts(s):
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(s.replace("T", " ").replace("Z", ""), fmt) if fmt == "%Y-%m-%d %H:%M:%S" else dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None

def to_local(s):
    u = parse_ts(s)
    return (u + dt.timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S") if u else None

def elapsed_sec(s):
    u = parse_ts(s)
    return int((now - u).total_seconds()) if u else None

stuck_cutoff = stale_min * 60
out = {"now_utc": now_utc, "project_id": sys.argv[4] if len(sys.argv) > 4 else None,
       "stale_min": stale_min, "stuck": [], "reviewing": [], "inflight": [], "stats": {}}
stats = {"total": 0, "running": 0, "queued": 0, "pending": 0, "reviewing": 0,
         "paused": 0, "failed": 0, "completed": 0, "rejected": 0, "cancelled": 0}
for t in tasks:
    stats["total"] += 1
    st = t.get("status", "?")
    if st in stats: stats[st] += 1
    upd = t.get("updated_at", "")
    upd_local = to_local(upd)
    upd_elapsed_sec = elapsed_sec(upd)
    item = {"id": t.get("id"), "title": t.get("title"), "status": st,
            "updated_at": upd, "updated_local": upd_local,
            "elapsed_sec": upd_elapsed_sec}
    if st == "running" and upd_elapsed_sec is not None and upd_elapsed_sec > stuck_cutoff:
        out["stuck"].append(item)
    elif st == "reviewing":
        out["reviewing"].append(item)
    elif st in ("running", "queued", "pending", "paused"):
        out["inflight"].append(item)
out["stats"] = stats
print(json.dumps(out, ensure_ascii=False))
exit_code = 1 if (out["stuck"] or out["reviewing"] or stats["failed"] > 0) else 0
sys.exit(exit_code)
PYEOF
}

if [[ "$JSON_OUT" == "true" ]]; then
  render_json
else
  render_text
fi
