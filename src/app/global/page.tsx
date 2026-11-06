// /global - Board across all projects and versions
// 加载 active 全量 + terminal 第一页 (limit=50) 给 RSC 初载. 后续由客户端
// loadMoreTerminal 接管 "加载更多" 按钮.

import { Suspense } from "react";
import { getServerUserId } from "@/lib/server-auth";
import { listTasksPage } from "@/lib/db/tasks";
import { listProjects } from "@/lib/db/projects";
import { listVersions } from "@/lib/db/versions";
import { resolveVerificationGloballyEnabled } from "@/lib/db/settings";
import GlobalBoard from "./global-board";

export default async function GlobalBoardPage() {
  const userId = await getServerUserId();
  const [activeRes, terminalRes] = [
    listTasksPage({ statusGroup: "active", ownerId: userId, limit: 200 }),
    listTasksPage({ statusGroup: "terminal", ownerId: userId, limit: 50 }),
  ];
  const tasks = [...activeRes.items, ...terminalRes.items];
  const projects = listProjects(userId);
  const versions = listVersions(undefined, userId);
  // 🆕 DAG P3 收尾 (2026-09-21): 同 [versionId] page — server 解析 L1 开关
  //   后传 prop, 不让 client 再 fetch. 默认值 false 与 B5 拍板一致.
  const globallyEnabled = resolveVerificationGloballyEnabled();

  return (
    <Suspense>
      <GlobalBoard initialTasks={tasks} projects={projects} versions={versions} globallyEnabled={globallyEnabled} />
    </Suspense>
  );
}
