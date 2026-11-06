// /uncategorized - Compatibility redirect for legacy bookmarks

import { redirect } from "next/navigation";
import { listProjects } from "@/lib/db/projects";
import { getServerUserId } from "@/lib/server-auth";

export default async function UncategorizedRedirectPage() {
  const userId = await getServerUserId();
  const project = listProjects(userId).find((item) => item.name === "未分类");
  if (!project) redirect("/?error=uncategorized_project_not_found");
  redirect(`/${project.id}/unversioned`);
}
