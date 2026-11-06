// /[projectId] - Redirect to current version

import { redirect } from "next/navigation";
import { getProjectById } from "@/lib/db/projects";
import { listVersions } from "@/lib/db/versions";
import { getServerRole, getServerUserId } from "@/lib/server-auth";

interface Props {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectRedirectPage({ params }: Props) {
  const { projectId } = await params;
  const userId = await getServerUserId();
  // Admin sees every project (matches /api/projects list semantics); non-admin
  // is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;
  const project = getProjectById(projectId, ownerId);
  if (!project) {
    // Project doesn't exist (or belongs to another user) - redirect to home
    redirect("/?error=project_not_found");
  }

  // Prefer current_version_id, fall back to first version alphabetically
  if (project.current_version_id) {
    redirect(`/${project.id}/${project.current_version_id}`);
  }

  const versions = listVersions(project.id, ownerId);
  if (versions.length === 0) {
    redirect(`/${project.id}/unversioned`);
  }
  redirect(`/${project.id}/${versions[0].id}`);
}