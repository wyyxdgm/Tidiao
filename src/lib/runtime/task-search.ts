// 功能: 纯函数 - 判断一条 TaskTrimmed 是否命中搜索框 query。
// 关注点: 客户端 useMemo 调用; 空 query = 不过滤 (= 全部命中); 大小写不敏感;
// 同时匹配 title / prompt_preview / description / result_preview / error_preview / tags / id(短串前缀也能命中)。
// 字段缺失视为空串(不抛)。tags 是 JSON 字符串, 解析失败降级为空数组。

import type { TaskTrimmed } from "@/lib/runtime/types";

export function matchesTaskSearch(task: TaskTrimmed, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;

  const matchTitle = task.title.toLowerCase().includes(q);
  const matchPrompt = task.prompt_preview.toLowerCase().includes(q);
  const matchDesc = task.description ? task.description.toLowerCase().includes(q) : false;
  const matchResult = task.result_preview.toLowerCase().includes(q);
  const matchError = task.error_preview.toLowerCase().includes(q);
  const matchId = task.id.toLowerCase().includes(q);

  let matchTags = false;
  if (task.tags) {
    try {
      const parsed = JSON.parse(task.tags);
      if (Array.isArray(parsed)) {
        matchTags = parsed.some(
          (tag) => typeof tag === "string" && tag.toLowerCase().includes(q)
        );
      }
    } catch {
      // tags 解析失败 = 当作无标签, 不影响其他字段判定
    }
  }

  return matchTitle || matchPrompt || matchDesc || matchResult || matchError || matchTags || matchId;
}
