// 版本下需求详情页 - 重定向到全局详情.

import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function VersionRequirementDetailPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/requirements/${id}`);
}
