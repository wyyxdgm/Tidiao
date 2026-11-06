// Schedules list page -- server component wrapper.
// 🆕 飞书 R92: 默认拉「无筛选」数据进 initialSchedules 让 SSR 首屏快；筛选切换由 client
//   重新 fetch `/api/schedules?...` 拉新结果（与 showDeleted 切换同款）。
import SchedulesClient from "./schedules-client";
import { listSchedules } from "@/lib/db/schedules";
import { getServerUserId } from "@/lib/server-auth";

export default async function SchedulesPage() {
  const userId = await getServerUserId();
  // 默认不含软删除、不带项目/时间筛选, 与 damo 0823 R49 拍板一致。
  const schedules = listSchedules(userId);
  return <SchedulesClient initialSchedules={schedules} />;
}
