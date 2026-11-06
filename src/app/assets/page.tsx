// /assets - 全平台资源池页 (server component).
//
// PR-2 (docs/plans/projects/asset-gallery-and-chat-media.md):
//   列当前用户所有 attachment, 支持 5 维筛选 + 排序 + 分页 + 单删 + 批量删.
//   数据源 = GET /api/assets, 客户端组件再发起请求 + 渲染表格.

import AssetsClient from "./assets-client";

export default async function AssetsPage() {
  return <AssetsClient />;
}