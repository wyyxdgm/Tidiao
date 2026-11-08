#!/usr/bin/env bash
# check-stuck-schedules.sh
#
# 功能: 找出「被非终态僵尸任务卡死、已过期还不触发」的 enabled schedule; --fix 清掉
#   其中 paused 类僵尸（走平台 cancel），让 schedule 下一 tick 自动补触发。
#   exit 0 = 无卡死; exit 1 = 有卡死（--fix 修完仍剩非 paused 阻塞也算 1）; exit 2 = 环境错。
#
# 背景 (2026-09-07 round-33 实证): `AO-R6 全局目标自动推进-守护&纠正` (c16abf84, */40)
#   + `reviewing 全项目自动审核` (cdd896a7, */30) 两条 cron 静默失语 14h+。
#   根因 = 2026-09-06 22:02 CST 平台重启把它们派出的任务留在 `paused`;
#   `paused` 不在 TERMINAL_TASK_STATUSES (src/lib/db/tasks.ts:417) 内 →
#   skip_if_running 闸门 `getUnfinishedTaskBySchedule()` 永远认为「还在飞」→ 永不重派,
#   且 next_run 冻结在过去。源码注释自带处方: 「清掉僵尸任务能直接解开被卡住的 schedule」。
#
# 用法:
#   bash scripts/check-stuck-schedules.sh              # 只报告
#   bash scripts/check-stuck-schedules.sh --fix        # 报告 + cancel paused 僵尸
#   bash scripts/check-stuck-schedules.sh --grace 10   # 过期宽限 10 分钟 (默认 5)
#   DB_PATH=<db> bash scripts/check-stuck-schedules.sh
#
# 关注点:
#   - **只 cancel `paused`**: `reviewing` 是等人验收的人工闸门（cancel 会吃掉产物）,
#     `running`/`queued` 是真在飞 —— 这两类只报告, 交人判断。这条边界别放宽。
#   - grace 防抖: schedule 刚过期几十秒不算卡死（runner 60s tick + claimSchedule 先推 next_run）。
#   - cancel 走 `scripts/ao act cancel`（平台状态机 + 鉴权），不直接 UPDATE DB。
#   - 只读 DB 判定, 幂等: 同一条僵尸 cancel 后再跑即为 clean。
set -euo pipefail

DB_USER_SET=1; [[ -n "${DB_PATH:-}" ]] || DB_USER_SET=""
DB_PATH="${DB_PATH:-$HOME/.agent-orchestrator/orchestrator.db}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX=0
GRACE_MIN=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix) FIX=1; shift ;;
    --grace) GRACE_MIN="${2:?--grace 需要分钟数}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "❌ 未知参数: $1（--help 看用法）" >&2; exit 2 ;;
  esac
done

[[ -f "$DB_PATH" ]] || { echo "❌ DB 不存在: $DB_PATH" >&2; exit 2; }
command -v sqlite3 >/dev/null || { echo "❌ 缺 sqlite3" >&2; exit 2; }

# 防呆: 默认 DB_PATH 指向 $HOME/.agent-orchestrator —— 只在跑平台的机器上才命中
# 真实实例 DB; 本机 dev 数据会报出线上根本不存在的僵尸任务. 查远程实例请 ssh 到
# 对面机器跑, 或显式 DB_PATH=.
if [[ -z "${DB_USER_SET:-}" && "$(uname -s)" == "Darwin" && -z "${WSL_DISTRO_NAME:-}" ]]; then
  echo "⚠️  本机: 未显式指定 DB_PATH, 读的是 $DB_PATH (本机 dev 数据, 非线上实例)." >&2
  echo "   查线上: ssh 到跑平台的机器后 DB_PATH=<实例 DB 路径> bash scripts/check-stuck-schedules.sh" >&2
fi

# 终态口径必须与 src/lib/db/tasks.ts:TERMINAL_TASK_STATUSES 一致
TERMINAL="'completed','failed','cancelled'"

ROWS=$(sqlite3 -separator '|' "$DB_PATH" "
  SELECT s.id, s.name, s.schedule_expr, s.next_run,
         CAST((julianday('now') - julianday(s.next_run)) * 1440 AS INT) AS overdue_min,
         t.id, t.status,
         CAST((julianday('now') - julianday(t.updated_at)) * 1440 AS INT) AS task_age_min
  FROM schedules s
  JOIN tasks t ON t.schedule_id = s.id AND t.deleted_at IS NULL
                 AND t.status NOT IN ($TERMINAL)
  WHERE s.enabled = 1
    AND (s.deleted_at IS NULL OR s.deleted_at = '')
    AND s.next_run < datetime('now', '-$GRACE_MIN minutes')
  ORDER BY overdue_min DESC, (t.status = 'paused') DESC;
")
# 🔴 刻意不 GROUP BY s.id: 一条 schedule 可能被多个非终态任务同时挡住, GROUP BY 会让
#   SQLite 任意挑一条 —— 实测（负向测试）会挑中 reviewing 而漏掉同 schedule 下可修的
#   paused 僵尸, 导致 --fix 静默失效。列全量阻塞行才能让 PAUSED 收集完整。

if [[ -z "$ROWS" ]]; then
  echo "✅ 无卡死 schedule（enabled + 过期 >${GRACE_MIN}min + 有非终态任务阻塞 = 0 条）"
  exit 0
fi

echo "🔴 卡死 schedule（过期 >${GRACE_MIN}min 且被非终态任务挡住 skip_if_running 闸门）:"
printf '%s\n' "$ROWS" | while IFS='|' read -r sid sname sexpr snext overdue tid tstatus tage; do
  printf '  %s  %-34s %-14s 过期 %5s min | 阻塞任务 %s status=%-9s 停滞 %s min\n' \
    "${sid:0:8}" "$sname" "$sexpr" "$overdue" "${tid:0:8}" "$tstatus" "$tage"
done

PAUSED=$(printf '%s\n' "$ROWS" | awk -F'|' '$7=="paused" {print $6}')

if [[ $FIX -eq 0 ]]; then
  if [[ -n "$PAUSED" ]]; then
    echo "→ 其中 $(printf '%s\n' "$PAUSED" | wc -l | tr -d ' ') 条是 paused 僵尸（重启遗留），可 --fix 自动 cancel 解锁"
  fi
  echo "→ reviewing / running / queued 阻塞不自动动（人工闸门 / 真在飞），需人判断"
  exit 1
fi

if [[ -z "$PAUSED" ]]; then
  echo "→ 无 paused 僵尸可修（剩下的都是 reviewing / running / queued，交人判断）"
  exit 1
fi

echo
echo "🔧 --fix: cancel paused 僵尸（走平台状态机）"
while read -r tid; do
  [[ -n "$tid" ]] || continue
  echo "  → cancel $tid"
  bash "$SCRIPT_DIR/ao" act cancel "$tid" 2>&1 | sed 's/^/    /'
done <<< "$PAUSED"

echo
echo "→ 已 cancel，schedule 下一 tick（runner 60s 轮询）会补触发。60s 后复跑本脚本核验。"
exit 1
