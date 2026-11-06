// /[projectId]/unversioned - Project-level tasks without a Version

import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getProjectById } from "@/lib/db/projects";
import { listTasksPage } from "@/lib/db/tasks";
import { getServerRole, getServerUserId } from "@/lib/server-auth";
import { resolveVerificationGloballyEnabled } from "@/lib/db/settings";
import BoardClient from "../[versionId]/board-client";

interface Props {
  params: Promise<{ projectId: string }>;
}

export default async function UnversionedBoardPage({ params }: Props) {
  const { projectId } = await params;
  const userId = await getServerUserId();
  // Admin sees every project (matches /api/projects list semantics); non-admin
  // is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;
  const project = getProjectById(projectId, ownerId);
  if (!project) notFound();

  // listTasksPage treats empty-string ownerId as "no owner filter" (matches
  // listProjects admin bypass). Pass userId for non-admin; "" for admin.
  const taskOwnerId = ownerId ?? "";

  const [activeRes, terminalRes] = [
    listTasksPage({
      statusGroup: "active",
      project_id: projectId,
      unversioned: true,
      ownerId: taskOwnerId,
      limit: 200,
    }),
    listTasksPage({
      statusGroup: "terminal",
      project_id: projectId,
      unversioned: true,
      ownerId: taskOwnerId,
      limit: 50,
    }),
  ];
  const tasks = [...activeRes.items, ...terminalRes.items];
  // 🆕 DAG P3 收尾 (2026-09-21): 同 [versionId] page — server 解析 L1 开关
  //   后作为 prop 传入, 让 BoardClient 据此过滤 verifying. RSC 直读 KV (零额外成本).
  const globallyEnabled = resolveVerificationGloballyEnabled();

  return (
    <Suspense>
      <BoardClient tasks={tasks} project={project} version={null} globallyEnabled={globallyEnabled} />
    </Suspense>
  );
}
