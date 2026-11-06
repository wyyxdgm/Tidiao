#!/bin/bash
# Integration test script for Agent Task Orchestrator
# Usage: bash test-e2e.sh

BASE="http://localhost:3000"
PASS=0; FAIL=0; TOTAL=0

ok() { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); echo "✅ $1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "❌ $1 — $2"; }

echo "========================================"
echo " Agent Task Orchestrator E2E Tests"
echo "========================================"
echo ""

# ---- 1. API Health ----
echo "--- 1. API 健康检查 ---"

S=$(curl -s "$BASE/api/stats" | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok')" 2>/dev/null)
if [ "$S" = "ok" ]; then ok "/api/stats 可访问"; else fail "/api/stats" "返回异常"; fi

C=$(curl -s "$BASE/api/config" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['api_key_configured'])" 2>/dev/null)
if [ "$C" = "True" ]; then ok "API Key 已配置"; else fail "API Key" "未配置"; fi

B=$(curl -s "$BASE/api/config" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['base_url'])" 2>/dev/null)
if [ "$B" = "https://api.minimaxi.com/anthropic" ]; then ok "Base URL 正确 ($B)"; else fail "Base URL" "$B"; fi

echo ""

# Create one Project/Version used by all task-creation tests
PR=$(curl -s -X POST "$BASE/api/projects" -H "Content-Type: application/json" \
  -d '{"name":"e2e-ownership","description":"test-e2e.sh"}')
PID=$(echo "$PR" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('project') or {}).get('id',''))" 2>/dev/null)
if [ -z "$PID" ]; then
  PID=$(curl -s "$BASE/api/projects" | python3 -c "import sys,json; print(next((p['id'] for p in json.load(sys.stdin).get('projects',[]) if p['name']=='e2e-ownership'),''))" 2>/dev/null)
fi
VR=$(curl -s -X POST "$BASE/api/versions" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PID\",\"name\":\"v1\"}")
VID=$(echo "$VR" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('version') or {}).get('id',''))" 2>/dev/null)
if [ -z "$VID" ]; then
  VID=$(curl -s "$BASE/api/versions?project=$PID" | python3 -c "import sys,json; print(next((v['id'] for v in json.load(sys.stdin).get('versions',[]) if v['name']=='v1'),''))" 2>/dev/null)
fi
if [ -n "$PID" ] && [ -n "$VID" ]; then ok "准备测试 Project/Version"; else fail "准备 Project/Version" "$PR / $VR"; fi

# ---- 2. Task CRUD ----
echo "--- 2. 任务 CRUD ---"

# Create
R=$(curl -s -X POST "$BASE/api/tasks" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PID\",\"title\":\"测试CRUD\",\"prompt\":\"echo hello\",\"model\":\"MiniMax-M3\",\"autoApprove\":true,\"maxTurns\":3}")
TID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [ -n "$TID" ]; then ok "创建任务 $TID"; else fail "创建任务" "无ID返回"; fi

# Read
S=$(curl -s "$BASE/api/tasks/$TID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['title'])" 2>/dev/null)
if [ "$S" = "测试CRUD" ]; then ok "读取任务标题: $S"; else fail "读取任务" "$S"; fi

# List
CNT=$(curl -s "$BASE/api/tasks" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$CNT" -ge 1 ]; then ok "任务列表 ($CNT 个)"; else fail "任务列表" "空"; fi

# Patch
curl -s -X PATCH "$BASE/api/tasks/$TID" -H "Content-Type: application/json" -d '{"title":"测试CRUD-已修改"}' > /dev/null
S2=$(curl -s "$BASE/api/tasks/$TID" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])" 2>/dev/null)
if [ "$S2" = "测试CRUD-已修改" ]; then ok "PATCH 更新标题"; else fail "PATCH" "$S2"; fi

# Delete
DR=$(curl -s -X DELETE "$BASE/api/tasks/$TID" | python3 -c "import sys,json; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
if [ "$DR" = "True" ]; then ok "删除任务"; else fail "删除任务" "$DR"; fi

echo ""

# ---- 3. Task Lifecycle (real agent) ----
echo "--- 3. 任务生命周期（真实 agent）---"

# Create + start
R=$(curl -s -X POST "$BASE/api/tasks" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PID\",\"title\":\"生命周期测试\",\"prompt\":\"请说你好，然后列出当前目录的文件\",\"model\":\"MiniMax-M3\",\"autoApprove\":true,\"maxTurns\":5}")
TID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
SR=$(curl -s -X POST "$BASE/api/tasks/$TID/start" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
if [ "$SR" = "queued" ]; then ok "任务入队"; else fail "入队" "$SR"; fi

# Wait for completion (up to 60s)
echo "   ⏳ 等待 agent 完成..."
for i in $(seq 1 30); do
  sleep 2
  ST=$(curl -s "$BASE/api/tasks/$TID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  if [ "$ST" = "reviewing" ] || [ "$ST" = "completed" ] || [ "$ST" = "failed" ]; then
    break
  fi
done

if [ "$ST" = "reviewing" ] || [ "$ST" = "completed" ]; then
  ok "Agent 完成，状态: $ST"
else
  fail "Agent 执行" "状态: $ST"
fi

# Check result
RES=$(curl -s "$BASE/api/tasks/$TID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','')[:60])" 2>/dev/null)
if [ -n "$RES" ] && [ "$RES" != "None" ]; then ok "有结果: ${RES:0:50}..."; else fail "结果" "空"; fi

# Check cost
COST=$(curl -s "$BASE/api/tasks/$TID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cost_usd'))" 2>/dev/null)
if [ "$COST" != "None" ] && [ -n "$COST" ]; then ok "花费: \$$COST"; else fail "花费" "未记录"; fi

# Approve
if [ "$ST" = "reviewing" ]; then
  AR=$(curl -s -X POST "$BASE/api/tasks/$TID/approve" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  if [ "$AR" = "completed" ]; then ok "审批通过"; else fail "审批" "$AR"; fi
fi

echo ""

# ---- 4. Task Dependencies ----
echo "--- 4. 任务依赖 ---"

# Create two tasks: A then B depends on A
RA=$(curl -s -X POST "$BASE/api/tasks" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PID\",\"title\":\"依赖A\",\"prompt\":\"说一句完成任务A\",\"model\":\"MiniMax-M3\",\"autoApprove\":true,\"maxTurns\":3}")
AID=$(echo "$RA" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

RB=$(curl -s -X POST "$BASE/api/tasks" -H "Content-Type: application/json" \
  -d "{\"title\":\"依赖B\",\"prompt\":\"说一句完成任务B\",\"model\":\"MiniMax-M3\",\"autoApprove\":true,\"maxTurns\":3,\"dependsOn\":[\"$AID\"],\"project_id\":\"$PID\"}")
BID=$(echo "$RB" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [ -n "$AID" ] && [ -n "$BID" ]; then ok "创建依赖任务 A=$AID B=$BID"; else fail "创建依赖任务" ""; fi

# Try starting B before A completes — should fail
BR=$(curl -s -X POST "$BASE/api/tasks/$BID/start" 2>/dev/null)
if echo "$BR" | grep -q "Dependencies not met"; then
  ok "B 启动被拒绝（依赖未满足）"
else
  fail "依赖检查" "应该拒绝但: $BR"
fi

# Start A, wait for it, approve
curl -s -X POST "$BASE/api/tasks/$AID/start" > /dev/null
echo "   ⏳ 等待任务 A 完成..."
for i in $(seq 1 20); do
  sleep 2
  ST=$(curl -s "$BASE/api/tasks/$AID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  if [ "$ST" = "reviewing" ] || [ "$ST" = "completed" ]; then break; fi
done
if [ "$ST" = "reviewing" ]; then curl -s -X POST "$BASE/api/tasks/$AID/approve" > /dev/null; fi

# After A approved, B should auto-start
sleep 2
BST=$(curl -s "$BASE/api/tasks/$BID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
if [ "$BST" = "queued" ] || [ "$BST" = "running" ]; then
  ok "B 自动启动（状态: $BST）"
else
  fail "B 自动启动" "状态: $BST"
fi

# Wait for B and clean up
for i in $(seq 1 20); do
  sleep 2
  BST=$(curl -s "$BASE/api/tasks/$BID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  if [ "$BST" = "reviewing" ] || [ "$BST" = "completed" ] || [ "$BST" = "failed" ]; then break; fi
done
if [ "$BST" = "reviewing" ]; then curl -s -X POST "$BASE/api/tasks/$BID/approve" > /dev/null; fi

echo ""

# ---- 5. Batch Import ----
echo "--- 5. 批量导入 ---"

IR=$(curl -s -X POST "$BASE/api/import/json" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PID\",\"content\":\"[{\\\"title\\\":\\\"导入1\\\",\\\"prompt\\\":\\\"echo 1\\\"},{\\\"title\\\":\\\"导入2\\\",\\\"prompt\\\":\\\"echo 2\\\"}]\"}")
ICNT=$(echo "$IR" | python3 -c "import sys,json; print(json.load(sys.stdin)['imported'])" 2>/dev/null)
if [ "$ICNT" = "2" ]; then ok "JSON 导入 2 个任务"; else fail "JSON 导入" "$ICNT"; fi

MR=$(curl -s -X POST "$BASE/api/import/markdown" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PID\",\"content\":\"- [ ] Markdown任务1\\n- [ ] Markdown任务2\\n- [ ] Markdown任务3\"}")
MCNT=$(echo "$MR" | python3 -c "import sys,json; print(json.load(sys.stdin)['imported'])" 2>/dev/null)
if [ "$MCNT" = "3" ]; then ok "Markdown 导入 3 个任务"; else fail "Markdown 导入" "$MCNT"; fi

echo ""

# ---- 6. Templates ----
echo "--- 6. 模板系统 ---"

TR=$(curl -s -X POST "$BASE/api/templates" -H "Content-Type: application/json" \
  -d '{"name":"快速测试","prompt":"执行简单测试","model":"MiniMax-M3","autoApprove":true}')
TID=$(echo "$TR" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [ -n "$TID" ]; then ok "创建模板"; else fail "创建模板" ""; fi

TL=$(curl -s "$BASE/api/templates" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$TL" -ge 1 ]; then ok "模板列表 ($TL 个)"; else fail "模板列表" "空"; fi

# Instantiate
IR2=$(curl -s -X POST "$BASE/api/templates/$TID/instantiate" -H "Content-Type: application/json" \
  -d "{\"title\":\"从模板创建\",\"project_id\":\"$PID\"}")
IID=$(echo "$IR2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [ -n "$IID" ]; then ok "模板实例化 $IID"; else fail "模板实例化" ""; fi

# Delete template
DR2=$(curl -s -X DELETE "$BASE/api/templates/$TID" | python3 -c "import sys,json; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
if [ "$DR2" = "True" ]; then ok "删除模板"; else fail "删除模板" ""; fi

echo ""

# ---- 7. Config ----
echo "--- 7. 配置管理 ---"

# Set concurrency
CR=$(curl -s -X PATCH "$BASE/api/config" -H "Content-Type: application/json" -d '{"concurrency":3}')
CC=$(echo "$CR" | python3 -c "import sys,json; print(json.load(sys.stdin)['concurrency'])" 2>/dev/null)
if [ "$CC" = "3" ]; then ok "设置并发=3"; else fail "设置并发" "$CC"; fi

# Reset
curl -s -X PATCH "$BASE/api/config" -H "Content-Type: application/json" -d '{"concurrency":2}' > /dev/null

echo ""

# ---- 8. Transcript ----
echo "--- 8. Session 转录 ---"

# Get the first completed task
FTID=$(curl -s "$BASE/api/tasks" | python3 -c "
import sys,json
tasks = json.load(sys.stdin)
for t in tasks:
  if t['status'] == 'completed' and t.get('session_id'):
    print(t['id']); break
" 2>/dev/null)

if [ -n "$FTID" ]; then
  TRES=$(curl -s "$BASE/api/tasks/$FTID/transcript?format=markdown" | head -c 100)
  if [ -n "$TRES" ]; then ok "Markdown 转录可获取"; else fail "转录" "空"; fi
else
  echo "   ⏭ 跳过（无已完成的任务有 session）"
fi

echo ""

# ---- 9. Cost Stats ----
echo "--- 9. 花费统计 ---"

SC=$(curl -s "$BASE/api/stats" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['cost']['total'])" 2>/dev/null)
if [ -n "$SC" ] && [ "$SC" != "None" ]; then ok "总花费: \$$SC"; else fail "花费统计" "无数据"; fi

# ---- 10. Project / Version ownership ----
echo "--- 10. Project / Version 归属约束 ---"

CODE=$(curl -s -o /tmp/orch-no-project.json -w "%{http_code}" -X POST "$BASE/api/tasks" \
  -H "Content-Type: application/json" -d '{"title":"orphan","prompt":"x"}')
if [ "$CODE" = "400" ]; then ok "缺少 project_id → 400"; else fail "project_id 必填" "HTTP $CODE"; fi

R=$(curl -s -X POST "$BASE/api/tasks" -H "Content-Type: application/json" \
  -d "{\"title\":\"项目级任务\",\"prompt\":\"x\",\"project_id\":\"$PID\"}")
UTID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
UV=$(curl -s "$BASE/api/tasks?project=$PID&unversioned=true" | python3 -c "import sys,json; d=json.load(sys.stdin); print(any(t['id']=='$UTID' and t.get('version_id') is None for t in d))" 2>/dev/null)
if [ "$UV" = "True" ]; then ok "项目级任务进入其他任务"; else fail "其他任务查询" "$R"; fi

P2R=$(curl -s -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"e2e-other-project"}')
P2=$(echo "$P2R" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('project') or {}).get('id',''))" 2>/dev/null)
if [ -z "$P2" ]; then
  P2=$(curl -s "$BASE/api/projects" | python3 -c "import sys,json; print(next((p['id'] for p in json.load(sys.stdin).get('projects',[]) if p['name']=='e2e-other-project'),''))" 2>/dev/null)
fi
CODE=$(curl -s -o /tmp/orch-version-mismatch.json -w "%{http_code}" -X POST "$BASE/api/tasks" \
  -H "Content-Type: application/json" -d "{\"title\":\"mismatch\",\"prompt\":\"x\",\"project_id\":\"$P2\",\"version_id\":\"$VID\"}")
if [ "$CODE" = "400" ]; then ok "跨项目 version_id → 400"; else fail "Version 归属校验" "HTTP $CODE"; fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$PID/unversioned")
if [ "$CODE" = "200" ]; then ok "其他任务页面可访问"; else fail "其他任务页面" "HTTP $CODE"; fi

echo ""
echo "========================================"
echo " 结果: $PASS/$TOTAL 通过, $FAIL 失败"
echo "========================================"
