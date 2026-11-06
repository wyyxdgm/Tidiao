// 功能: 根据当前环境返回带前缀的页面 title.
// 关注点: 复用 deploy-guard 的 detectCurrentEnv; 认不出 (Mac 本地 / CI) = 原标题, 不报错.
//   仅供 layout.tsx 的 generateMetadata 调用, 别处要 title 文案请走 metadata, 别自己拼.
import { detectCurrentEnv, type DeployEnv } from "./deploy-guard";

export const BASE_PAGE_TITLE = "Agent Task Orchestrator";

const ENV_TITLE_PREFIX: Record<DeployEnv, string> = {
  "ao-pulu": "",
  "ao-prod": "[PROD] ",
  "ao-dev": "[DEV] ",
};

export function getPageTitle(): string {
  const env = detectCurrentEnv();
  const prefix = env ? ENV_TITLE_PREFIX[env] : "";
  return `${prefix}${BASE_PAGE_TITLE}`;
}