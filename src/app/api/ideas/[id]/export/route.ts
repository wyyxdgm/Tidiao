// GET /api/ideas/[id]/export - 导出构思卡 md（含 mermaid DAG + 收益面板 + 挂的任务）
//
// 用途: AI 冷启动源兜底 —— 导出物可直接贴进 docs/plans/ 当 git 跟踪档, 保证
// 「git 可见不断链」(idea-canvas.md §6)。?download=1 时带 Content-Disposition。

import { NextRequest, NextResponse } from "next/server";
import { getIdea, listIdeaNodes, listIdeaSignals, getIdeaROI, listIdeaLinks } from "@/lib/db/ideas";
import { getDb } from "@/lib/db/index";

const STATUS_CN: Record<string, string> = {
  germinating: "构思中",
  exploring: "探索中",
  decided: "已定案",
  shelved: "搁置",
  rejected: "已否定",
  landed: "已落地",
  planned: "计划中",
  dispatched: "待执行",
  running: "执行中",
  reviewing: "待审核",
  awaiting_decision: "等决策",
  blocked: "卡住",
  done: "完成",
  dropped: "放弃",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const idea = getIdea(id, userId);
  if (!idea) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  const nodes = listIdeaNodes(id, userId);
  const signals = listIdeaSignals(id, userId);
  const roi = getIdeaROI(id, userId);
  const tasks = getDb()
    .prepare(
      `SELECT id, title, status, cost_usd FROM tasks WHERE idea_id = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at`
    )
    .all(id, userId) as Array<any>;
  const links = listIdeaLinks(userId).filter((l) => l.idea_id === id);

  const lines: string[] = [];
  lines.push(`# 构思：${idea.title}`);
  lines.push("");
  lines.push(`> 状态：${STATUS_CN[idea.status] ?? idea.status}｜创建：${idea.created_at.slice(0, 10)}${idea.deadline ? `｜验证窗口至：${idea.deadline.slice(0, 10)}` : ""}`);
  lines.push("");
  if (idea.hypothesis) {
    lines.push(`## 假设`);
    lines.push("");
    lines.push(idea.hypothesis);
    lines.push("");
  }
  if (idea.success_criteria) {
    lines.push(`## 验证判据（预写）`);
    lines.push("");
    lines.push(idea.success_criteria);
    lines.push("");
  }
  if (roi) {
    lines.push(`## 收益面板`);
    lines.push("");
    lines.push(`- 投入：$${roi.cost_usd.toFixed(2)}（${roi.task_count} 个任务）`);
    lines.push(`- 信号：咨询 ${roi.inquiry_count}｜注册 ${roi.signup_count}｜收入 ¥${roi.payment_total}`);
    if (roi.window_left_days !== null) {
      lines.push(`- 窗口：剩 ${roi.window_left_days} 天${roi.overdue ? "（🔴 过窗未复盘）" : ""}`);
    }
    lines.push("");
  }
  if (nodes.length > 0) {
    lines.push(`## 构思流程（${nodes.length} 节点）`);
    lines.push("");
    lines.push("```mermaid");
    lines.push("graph TD");
    for (const n of nodes) {
      lines.push(`  ${n.id.slice(0, 8)}["${n.title} (${STATUS_CN[n.status] ?? n.status})"]`);
    }
    for (const n of nodes) {
      for (const dep of n.depends_on) {
        lines.push(`  ${dep.slice(0, 8)} --> ${n.id.slice(0, 8)}`);
      }
    }
    lines.push("```");
    lines.push("");
    for (const n of nodes) {
      lines.push(`### ${n.title} —— ${STATUS_CN[n.status] ?? n.status}`);
      if (n.detail) lines.push(n.detail);
      lines.push("");
    }
  }
  if (tasks.length > 0) {
    lines.push(`## 挂的任务（${tasks.length}）`);
    lines.push("");
    lines.push(`| 任务 | 状态 | 成本 |`);
    lines.push(`|---|---|---|`);
    for (const t of tasks) {
      lines.push(`| ${t.title} | ${t.status} | $${(t.cost_usd ?? 0).toFixed(2)} |`);
    }
    lines.push("");
  }
  if (signals.length > 0) {
    lines.push(`## 反馈信号（${signals.length}）`);
    lines.push("");
    for (const s of signals) {
      lines.push(`- [${s.occurred_at?.slice(0, 10) ?? s.created_at.slice(0, 10)}] ${s.kind}${s.value !== null ? ` = ${s.value}` : ""}${s.note ? `：${s.note}` : ""}${s.ref ? `（${s.ref}）` : ""}`);
    }
    lines.push("");
  }
  if (idea.conclusion) {
    lines.push(`## 结论`);
    lines.push("");
    lines.push(idea.conclusion);
    lines.push("");
  }
  if (links.length > 0) {
    lines.push(`## 关联构思`);
    lines.push("");
    for (const l of links) {
      const other = l.idea_id === id ? l.linked_idea_id : l.idea_id;
      lines.push(`- ${l.relation}: ${other.slice(0, 8)}`);
    }
  }

  const md = lines.join("\n") + "\n";
  const url = new URL(request.url);
  const headers: Record<string, string> = { "Content-Type": "text/markdown; charset=utf-8" };
  if (url.searchParams.get("download")) {
    headers["Content-Disposition"] = `attachment; filename="idea-${id.slice(0, 8)}.md"`;
  }
  return new NextResponse(md, { headers });
}
