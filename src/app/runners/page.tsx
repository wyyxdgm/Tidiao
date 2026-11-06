// /runners - admin-only 注册 / 管理 Runner daemon 的页面 (R4: UI).
//
// 关注点:
//  - server component 做鉴权: middleware 注入了 x-user-role, 任何非 admin
//    直接 redirect("/"). admin client-side 再列/注册/删除/健康检查.
//  - 不缓存: 注册完 token 立刻刷新页面让 operator 复制.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import RunnersClient from "./runners-client";

export const dynamic = "force-dynamic";

export default async function RunnersPage() {
  const h = await headers();
  const role = h.get("x-user-role");
  if (role !== "admin") {
    redirect("/");
  }
  return <RunnersClient />;
}
