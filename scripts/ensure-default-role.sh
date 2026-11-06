#!/usr/bin/env bash
# Ensure "default" role exists AND matches desired system_prompt on all instances.
# Converge: missing → create; exists but prompt differs → PATCH (deploy 后所有实例自动升级 prompt).
# Idempotent. Called by deploy.sh after sync. Standalone: bash scripts/ensure-default-role.sh
set -euo pipefail

ADMIN_EMAIL="${ADMIN_EMAIL:-you@example.com}"
ADMIN_PASS="${ADMIN_PASS:-bbb123456.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_JSON_FILE="$SCRIPT_DIR/.default-role.json"

# --- Default role system_prompt (single source of truth) ---
# 风格口径 (damo 1007 拍板): 隐式——checkpoint 是「顺手记进度」的习惯, 不用「强制要求」
# 章节施压; 从第 1 步就写; 状态四态与 awaiting 收尾同一套口径; summary 粒度与收尾
# 总结「核心细节」层 (result-layers-llm) 完全同口径 —— 实时 checkpoint 流 ≈ 事后细节流程图.
cat > "$ROLE_JSON_FILE" <<'JSON'
{
  "name": "default",
  "description": "默认 role: 顺手记进度 (checkpoint) + 通用工作约定",
  "system_prompt": "## 通用约定\n\n- 写操作前 `git pull --ff-only`；完成后 `git commit`，message 写清楚改了什么\n- 优先用中文回答\n- 工具审批：写操作默认需要人工确认，除非任务标记 auto_approve\n- 边做边把每一步记进任务面板：每完成一个实质步骤，顺手输出一行 `<checkpoint step=N summary=\"...\"/>`（N 从 1 递增；第 1 步就写，单步任务写 `step=final`）。summary 按处理顺序写「做了什么动作 → 得到什么结果」，多段用「；」连接，覆盖改了什么文件 / 做了什么决策（选了什么、为什么）/ 拿到什么关键数据 / 有什么坑；commit id 必须配含义。这行会实时渲染成面板上的进度流程图，任务收尾的细节总结也按同一口径生成 —— 你写清楚了，收尾总结就省事。\n- 格式：summary 的值用英文双引号包住，内部不能再出现英文双引号（要引用用「」）\n- 某一步停在等回复 / 有建议 / 需拍板 / 卡住时，同一行加 `status=\"需拍板\"`（四选一），面板会标彩色状态；任务收尾需要 damo 拍板或选方案时，按平台 awaiting 约定写 marker"
}
JSON

# login <ssh_prefix_or_empty> <port> -> echoes switchToken
login() {
  local ssh_prefix="$1" port="$2"
  if [ -z "$ssh_prefix" ]; then
    # Mac local
    curl -s -X POST "http://localhost:$port/api/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null
  else
    ssh $ssh_prefix "curl -s -X POST http://localhost:$port/api/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}'" 2>/dev/null
  fi | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('switchToken',''))" 2>/dev/null
}

# find_default_role <ssh_prefix_or_empty> <port> <token>
#   -> echoes "<action> <role_id>" where action ∈ has-fresh|needs-update|missing
find_default_role() {
  local ssh_prefix="$1" port="$2" token="$3"
  if [ -z "$ssh_prefix" ]; then
    curl -s "http://localhost:$port/api/roles" -H "Authorization: Bearer $token" 2>/dev/null
  else
    ssh $ssh_prefix "curl -s http://localhost:$port/api/roles -H 'Authorization: Bearer $token'" 2>/dev/null
  fi | DESIRED="$(python3 -c "import json;print(json.load(open('$ROLE_JSON_FILE'))['system_prompt'])")" python3 -c "
import sys,json,re
r=re.sub(r'[\x00-\x1f\x7f]',' ',sys.stdin.read())
d=json.loads(r)
roles = d if isinstance(d,list) else []
role = next((x for x in roles if x.get('name')=='default'), None)
if role is None:
    print('missing')
elif role.get('system_prompt','').strip() == __import__('os').environ['DESIRED'].strip():
    print('has-fresh ' + role.get('id',''))
else:
    print('needs-update ' + role.get('id',''))" 2>/dev/null
}

# create_role <ssh_prefix_or_empty> <port> <token> -> echoes role_id or ERR
create_role() {
  local ssh_prefix="$1" port="$2" token="$3"
  if [ -z "$ssh_prefix" ]; then
    curl -s -X POST "http://localhost:$port/api/roles" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d @"$ROLE_JSON_FILE" 2>/dev/null
  else
    cat "$ROLE_JSON_FILE" | ssh $ssh_prefix "curl -s -X POST http://localhost:$port/api/roles -H 'Content-Type: application/json' -H 'Authorization: Bearer $token' -d @-" 2>/dev/null
  fi | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('id','ERR'))" 2>/dev/null
}

# update_role <ssh_prefix_or_empty> <port> <token> <role_id> -> echoes ok or ERR
update_role() {
  local ssh_prefix="$1" port="$2" token="$3" role_id="$4"
  local payload
  payload="$(python3 -c "import json;d=json.load(open('$ROLE_JSON_FILE'));print(json.dumps({'system_prompt':d['system_prompt'],'description':d['description']}))")"
  if [ -z "$ssh_prefix" ]; then
    curl -s -X PATCH "http://localhost:$port/api/roles/$role_id" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$payload" 2>/dev/null
  else
    printf '%s' "$payload" | ssh $ssh_prefix "curl -s -X PATCH http://localhost:$port/api/roles/$role_id -H 'Content-Type: application/json' -H 'Authorization: Bearer $token' -d @-" 2>/dev/null
  fi | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('id') else 'ERR')" 2>/dev/null
}

# ensure <name> <ssh_prefix> <port>
ensure() {
  local name="$1" ssh_prefix="$2" port="$3"
  local token found action role_id
  token=$(login "$ssh_prefix" "$port")
  if [ -z "$token" ]; then
    echo "❌ $name: login failed"; return 1
  fi
  found=$(find_default_role "$ssh_prefix" "$port" "$token")
  action="${found%% *}"
  role_id="${found#* }"
  case "$action" in
    has-fresh)
      echo "✅ $name: default role 已是最新"
      ;;
    needs-update)
      if [ "$(update_role "$ssh_prefix" "$port" "$token" "$role_id")" = "ok" ]; then
        echo "✅ $name: default role system_prompt 已更新 ($role_id)"
      else
        echo "❌ $name: 更新失败"; return 1
      fi
      ;;
    *)
      local result
      result=$(create_role "$ssh_prefix" "$port" "$token")
      if [ "$result" != "ERR" ] && [ -n "$result" ]; then
        echo "✅ $name: default role 已创建 ($result)"
      else
        echo "❌ $name: 创建失败"; return 1
      fi
      ;;
  esac
}

echo "🔐 Ensuring default role on all instances..."

# Mac local (direct curl, no SSH)
ensure "Mac-local" "" "13000" || true

# WSL ao-prod (port 13000 via SSH)
ensure "WSL-ao-prod" "-p 2222 user@win" "13000" || true

# WSL ao-dev (port 13001 via SSH)
ensure "WSL-ao-dev" "-p 2222 user@win" "13001" || true

# Pulu (port 13000 via SSH as root, app runs as orchestrator)
ensure "Pulu" "root@203.0.113.10" "13000" || true

rm -f "$ROLE_JSON_FILE"
echo ""
echo "Done."
