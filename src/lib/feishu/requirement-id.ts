// 需求点 ID 的生成与反解. 纯函数, 无 node 依赖.
//
// 单独成文件是因为 sheets.ts 引了 child_process(lark-cli), 而前端
// task-detail-client.tsx ("use client") 也要反解行号 —— 从 sheets.ts 导入会
// 把 child_process 拖进浏览器 bundle 直接编译失败.

/**
 * 功能: 生成需求点 ID. 有版本名时带版本前缀(`v1.6-R12`), 否则回退裸行号(`R12`).
 *
 * 关注点: 一版一张飞书表后 row 号在每张表里都从 1 开始, 裸 `R12` 会让
 *   `git log --grep "feat(R12)"` 同时命中多个版本的改动. 版本名是自由文本,
 *   必须 slug 化(空白/斜杠/引号 -> `-`), 否则会破坏 commit message 约定与 grep.
 */
export function formatRequirementId(row: number, versionName?: string | null): string {
  const slug = (versionName ?? "")
    .trim()
    .replace(/[\s/\\"'`()]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${slug}-R${row}` : `R${row}`;
}

/**
 * 功能: 从 task tags 里反解需求行号, 兼容裸 `R12` 与带版本前缀的 `v1.6-R12`.
 *   拿不到返回 null.
 *
 * 关注点: 飞书写回(`/api/feishu/write-back`)和前端写回按钮都靠它定位行号,
 *   解不出来的后果是**静默**的 —— 按钮直接不渲染, 用户只会觉得"功能没了".
 *   必须同时认两种格式: D6 之前建的 task 存的是裸 `R12`, 之后是 `v1.6-R12`,
 *   两者会长期共存. 只认末段 `R\d+`, 因为版本名 slug 里也可能含 `-`.
 */
export function parseRequirementRow(tags: string[]): number | null {
  for (const t of tags) {
    const m = /^(?:.*-)?R(\d+)$/.exec(t);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
