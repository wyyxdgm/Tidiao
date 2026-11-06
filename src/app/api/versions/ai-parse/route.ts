// POST /api/versions/ai-parse - 新建版本弹窗「AI 解析输入」(飞书 R172).
// 入参 {project_id, text} → 解析自由文本 → 返回表单建议值 (不落库, 前端填表单后走正常 POST /api/versions).

import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/db/projects";
import { listVersions } from "@/lib/db/versions";
import { parseVersionInput } from "@/lib/feishu/version-ai-parse";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { project_id?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.project_id?.trim() || !body.text?.trim()) {
    return NextResponse.json({ error: "project_id and text are required" }, { status: 400 });
  }

  const project = getProjectById(body.project_id.trim(), userId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // 同项目现有版本供 LLM 排重 / 起名对齐.
  const existing = listVersions(project.id, userId).map((v) => ({
    name: v.name,
    description: v.description,
  }));

  try {
    const { suggestion, llmFailed } = await parseVersionInput({
      projectName: project.name,
      projectCwd: project.cwd,
      existingVersions: existing,
      userText: body.text,
      userId,
      projectId: project.id,
    });
    return NextResponse.json({ suggestion, llm_failed: llmFailed });
  } catch (err) {
    return NextResponse.json(
      { error: `ai-parse failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
