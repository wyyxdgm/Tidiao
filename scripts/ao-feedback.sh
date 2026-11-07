#!/usr/bin/env bash
# ao-feedback.sh - 平台工具问题反馈入口
#
# 功能: 把 agent/用户踩到的平台工具问题（脚本报错 / 行为不符预期 / 文档失配等）
#   一条命令派成开发项目（默认找名含 ao-dev 的项目，AO_FEEDBACK_PROJECT 可覆盖）的 task。
#   自动采集环境信息（机器 / 用户 / 工具版本），按固定模板组织，agent 拿到即可复现。
#
# 用法:
#   ao-feedback "现象一句话"                        # 最简：只报现象，环境自动采集
#   ao-feedback "现象" -d trace.txt                 # 附复现 trace / 报错原文（文件）
#   ao-dispatch.sh ... 2>&1 | ao-feedback "现象" -d -   # stdin 直接喂报错输出
#   ao-feedback "现象" -s ao-dispatch.sh            # 标注出问题的脚本（自动带其版本）
#   ao-feedback --template                          # 只打印报告模板（不派发）
#
# 验收入口: 本 --help 即 self-document；登录失败等公共报错在 login.sh 指回本命令。
#
# 依赖: curl, python3, login.sh（同目录）
# 关注点: 报告内容自动脱敏 —— 环境采集阶段排除 *PASSWORD* / *TOKEN* / *SECRET* 变量，
#   附件原样上送（调用方自己别把密码贴进 -d 文件）。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${AO_LOGIN_SH:-$SCRIPT_DIR/login.sh}"
ao_init_env
BASE_URL="${AO_BASE_URL:-$AO_DEF_BASE}"
EMAIL="${AO_EMAIL:-$AO_DEF_EMAIL}"
PASSWORD="${AO_PASSWORD:-$AO_DEF_PASS}"

TITLE=""
DETAIL_FILE=""
DETAIL_STDIN="false"
PROBLEM_SCRIPT=""

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

case "${1:-}" in
  -h|--help|help) usage ;;
  --template)
    sed -n '/^# ==== 报告模板 BEGIN/,/^# ==== 报告模板 END/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "") echo "用法: ao-feedback \"现象一句话\" [-d 文件|-] [-s 出问题的脚本名]（-h 看完整帮助）" >&2; exit 1 ;;
esac

TITLE="$1"; shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--detail)    DETAIL_FILE="$2"; shift 2 ;;
    -s|--script)    PROBLEM_SCRIPT="$2"; shift 2 ;;
    --base)         BASE_URL="$2"; shift 2 ;;
    *) echo "未知参数: $1（-h 看用法）" >&2; exit 1 ;;
  esac
done

# --- 采集环境（脱敏: 密码/token/secret 类变量一律不进报告）---
ENV_INFO=$(python3 <<'PYEOF'
import os, platform, subprocess
from datetime import datetime
who = subprocess.run(["whoami"], capture_output=True, text=True).stdout.strip()
host = platform.node()
sysname = f"{platform.system()} {platform.release()}"
lines = [
    f"- 时间: {datetime.now().isoformat(timespec='seconds')}",
    f"- 机器: {who}@{host} ({sysname})",
]
vals = []
for k in sorted(os.environ):
    if any(s in k.upper() for s in ("PASSWORD", "TOKEN", "SECRET")):
        continue
    if k.startswith(("AO_", "ORCHESTRATOR_", "FEISHU_")):
        vals.append(f"  {k}={os.environ[k][:120]}")
if vals:
    lines.append("- AO/编排相关 env:")
    lines.extend(vals)
print("\n".join(lines))
PYEOF
)
SCRIPT_VERSION="(未指定)"
if [[ -n "$PROBLEM_SCRIPT" ]]; then
  for cand in "$PROBLEM_SCRIPT" "$SCRIPT_DIR/$PROBLEM_SCRIPT" "$HOME/bin/$PROBLEM_SCRIPT"; do
    if [[ -f "$cand" ]]; then
      # 关注点: md5sum(Linux) / md5(Mac) 二选一，按 uname 判而不是管道兜底
      #   （管道 exit code 取 cut，md5sum 失败不会走到 md5 分支）
      # 关注点: 这段在顶层作用域（非函数内），不能用 local；md5sum(Linux)/md5(Mac) 按 uname 判
      _md5=$(md5sum "$cand" 2>/dev/null | cut -c1-8)
      [[ -z "${_md5:-}" ]] && _md5=$(md5 -q "$cand" 2>/dev/null | cut -c1-8)
      SCRIPT_VERSION="${_md5:-无md5} ($(wc -c < "$cand" | tr -d ' ') bytes, $cand)"
      break
    fi
  done
fi

# --- 收集 detail（文件 / stdin / 无）---
DETAIL=""
if [[ "$DETAIL_STDIN" == "true" || "${DETAIL_FILE:-}" == "-" ]]; then
  DETAIL="$(cat)"
elif [[ -n "$DETAIL_FILE" ]]; then
  [[ -f "$DETAIL_FILE" ]] || { echo "❌ detail 文件不存在: $DETAIL_FILE" >&2; exit 1; }
  DETAIL="$(cat "$DETAIL_FILE")"
fi

# ==== 报告模板 BEGIN ====
# [ao-feedback] <现象一句话>
#
# ## 现象
# <agent/用户原话：期望 vs 实际>
#
# ## 环境
# <自动采集：时间 / 机器 / AO 相关 env（已脱敏）>
# - 出问题脚本版本: <md5 前 8 位 + 路径>
#
# ## 复现命令
# <agent 补：能复现的最短命令>
#
# ## 报错输出 / trace
# <agent 附：-d 文件或 stdin 喂进来的原文>
#
# ## 处理提示
# 派发方是工具使用者（多为其他项目 agent），无法回答追问 —— 按「先复现、再定位、
# 修复后 commit + 同步 ~/bin 副本」自主闭环；结论写进 task 收尾即可。
# ==== 报告模板 END ====

PROMPT="[ao-feedback] ${TITLE}

## 现象
（派发方只给了一句话现象；期望 vs 实际需你复现后自行补全）

## 环境
${ENV_INFO}
- 出问题脚本版本: ${PROBLEM_SCRIPT:-未指定} ${SCRIPT_VERSION}
- 平台地址: ${BASE_URL}

## 复现命令
（见下方 trace；若无法复现，按环境信息同构命令）

## 报错输出 / trace
${DETAIL:-(未附 —— 派发方没给 trace，靠上面的环境信息复现)}

## 处理提示
派发方是工具使用者（多为其他项目 agent），无法回答追问 —— 按「先复现、再定位、
修复后 commit + 同步各机 ~/bin 副本」自主闭环；结论写进 task 收尾即可。
"

# --- 鉴权 + 派发到接收反馈的项目 ---
ao_resolve_auth

FEEDBACK_PROJECT="${AO_FEEDBACK_PROJECT:-ao-dev}"

# 解析接收反馈的项目（默认找名含 ao-dev 的项目；AO_FEEDBACK_PROJECT 可改关键词）
PROJECT_ID=$(ao_curl GET /api/projects 2>/dev/null | FEEDBACK="$FEEDBACK_PROJECT" python3 -c '
import os, sys, json
try:
    fb = os.environ.get("FEEDBACK", "ao-dev")
    for p in json.load(sys.stdin).get("projects", []):
        if fb in (p.get("name") or "") or fb in (p.get("display_name") or ""):
            print(p["id"]); break
    else:
        print("")
except Exception:
    print("")
' 2>/dev/null || echo "")
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="${AO_FEEDBACK_PROJECT_ID:-}"
  [[ -z "$PROJECT_ID" ]] && { echo "❌ 找不到接收反馈的项目（自动发现名含 ao-dev 的项目失败）。用 -p <项目名> 指定，或 export AO_FEEDBACK_PROJECT_ID=<uuid>" >&2; exit 1; }
fi

BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE" "${BODY_FILE}.prompt"' EXIT
printf '%s' "$PROMPT" > "${BODY_FILE}.prompt"
python3 - "$PROJECT_ID" "$TITLE" "${BODY_FILE}.prompt" "$BODY_FILE" <<'PYEOF'
import sys, json
project_id, title, prompt_file, out_file = sys.argv[1:5]
prompt = open(prompt_file, encoding="utf-8").read()
json.dump({
    "title": f"[ao-feedback] {title}"[:200],
    "prompt": prompt,
    "project_id": project_id,
    "effort": "medium",
    "autoApprove": True,
}, open(out_file, "w", encoding="utf-8"), ensure_ascii=False)
PYEOF
rm -f "${BODY_FILE}.prompt"

RESULT=$(curl -s -X POST "$BASE_URL/api/tasks" \
  -H "$AO_AUTH" -H "Content-Type: application/json" \
  --data-binary "@$BODY_FILE")
TASK_ID=$(echo "$RESULT" | python3 -c "
import sys, json
t = json.load(sys.stdin)
print(t.get('id', '') if not t.get('error') else '')
" 2>/dev/null || echo "")
if [[ -z "$TASK_ID" ]]; then
  echo "❌ 反馈任务创建失败: $RESULT" >&2
  echo "   （这就是工具问题本身？直接到开发项目手工派发）" >&2
  exit 1
fi
curl -s -X POST "$BASE_URL/api/tasks/$TASK_ID/start" -H "$AO_AUTH" \
  -H "Content-Type: application/json" >/dev/null 2>&1 || true

echo "✅ 反馈已派给 $FEEDBACK_PROJECT: $TASK_ID"
echo "   平台: $BASE_URL/#/tasks/$TASK_ID"
