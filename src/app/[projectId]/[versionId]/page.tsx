// /[projectId]/[versionId] - Board for a specific version
//
// RSC 初载: 走新 listTasksPage() 拿精简投影 (TaskTrimmed), RSC payload 从 MB 级
// 降到 KB 级. active 部分全量 + terminal 第一页 (limit=50). 后续由客户端
// refreshActive / refreshTerminal / loadMoreTerminal 接管 (看板 SSE realtime +
// "加载更多" 按钮).

import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { listTasksPage } from "@/lib/db/tasks";
import { getServerRole, getServerUserId } from "@/lib/server-auth";
import { resolveVerificationGloballyEnabled } from "@/lib/db/settings";
import BoardClient from "./board-client";

interface Props {
  params: Promise<{ projectId: string; versionId: string }>;
}

const INITIAL_TERMINAL_LIMIT = 50;

export default async function VersionBoardPage({ params }: Props) {
  const { projectId, versionId } = await params;
  const userId = await getServerUserId();
  // Admin sees every project/version (matches /api/projects list semantics);
  // non-admin is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;

  const project = getProjectById(projectId, ownerId);
  if (!project) notFound();
  const version = getVersionById(versionId, ownerId);
  if (!version || version.project_id !== projectId) notFound();

  // active 全量 + terminal 第一页拼成 RSC 初载. BoardClient 按 status 拆到两个数组.
  // listTasksPage treats empty-string ownerId as "no owner filter" (matches
  // listProjects admin bypass). Pass userId for non-admin; "" for admin.
  const taskOwnerId = ownerId ?? "";
  const [activeRes, terminalRes] = [
    listTasksPage({
      statusGroup: "active",
      project_id: projectId,
      version_id: versionId,
      ownerId: taskOwnerId,
      limit: 200,
    }),
    listTasksPage({
      statusGroup: "terminal",
      project_id: projectId,
      version_id: versionId,
      ownerId: taskOwnerId,
      limit: INITIAL_TERMINAL_LIMIT,
    }),
  ];
  // 顺序固定: active 在前 (看板视觉上层).
  const tasks = [...activeRes.items, ...terminalRes.items];
  // 🆕 DAG P3 收尾 (2026-09-21): 把 L1 平台开关解析结果作为 prop 传给 client,
  //   让 BoardClient 据此过滤 verifying (筛选/列定义/默认选中全跟它走). server 解析
  //   避免 client 二次 fetch /api-config; RSC 直读 DB (KV, 零额外查询成本).
  const globallyEnabled = resolveVerificationGloballyEnabled();

  return (
    <Suspense>
      <BoardClient
        tasks={tasks}
        project={project}
        version={version}
        globallyEnabled={globallyEnabled}
      />
    </Suspense>
  );
}