// 飞书写回核心逻辑 —— 供 /api/feishu/write-back/[taskId] 和 rule engine 共用
//
// 功能: 把 task 的运行时状态写回其来源飞书 sheet 的对应行. 通过 task.tags 里的
//   R{row} tag 定位行号（parseRequirementRow 反解）.
//
// 关注点:
//   - T/W/Z 列从 task 状态映射:
//       T = task.status (v42 起 T 列直接承载 task status, 不再走 requirement.status 中转)
//       W = head_commit
//       Z = task.status
//   - 飞书行 → task 的关联靠 task.tags 里的 R{row} tag.
//   - 非飞书 task (tags 里没 R{row}) → no-op (rule engine 调用时已过滤).
//   - 写回失败不抛错 (lark-cli 可能临时挂), 由调用方记 events.
//   - R60 改造 (damo 2026-09-03 拍板): 不再写 requirements 表 / iteration 标记,
//     飞书 sheet 是唯一需求存储. 镜像模型已废弃.

import { getDb } from "@/lib/db/index";
import { parseRequirementRow } from "./requirement-id";
import { writeField, ORCHESTRATOR_WRITABLE } from "./sheets";
import { getTaskById } from "@/lib/db/tasks";
import type { Task, TaskStatus } from "@/lib/runtime/types";

export interface WriteBackResult {
  ok: boolean;
  row: number | null;
  wrote: number;
  total: number;
  results: Array<{ field: string; ok: boolean; error?: string; value?: string }>;
  reason?: "not_feishu_task" | "no_sheet_config" | "no_req_id";
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

function extractRowIndex(task: { tags: string | null }): number | null {
  return parseRequirementRow(parseTags(task.tags));
}

// 写回飞书 sheet. R60 起不再更新 platform requirements 表.
// 失败不抛错, 返回 ok:false 让 rule engine 记 events.
export async function writeBackFeishu(taskId: string, ownerId?: string): Promise<WriteBackResult> {
  const task = ownerId
    ? getTaskById(taskId, ownerId)
    : getTaskById(taskId);
  if (!task) {
    return { ok: false, row: null, wrote: 0, total: 0, results: [], reason: "no_req_id" };
  }

  const rowIdx = extractRowIndex(task);
  if (rowIdx === null) {
    return { ok: false, row: null, wrote: 0, total: 0, results: [], reason: "not_feishu_task" };
  }

  // 解析 sheet URL. 从 task.version_id 反查.
  const { getSheetConfigFromVersion } = await import("@/lib/db/versions");
  if (!task.version_id) {
    return { ok: false, row: null, wrote: 0, total: 0, results: [], reason: "no_sheet_config" };
  }
  const cfg = getSheetConfigFromVersion(task.version_id);
  if (!cfg?.sheetUrl) {
    return { ok: false, row: null, wrote: 0, total: 0, results: [], reason: "no_sheet_config" };
  }

  const writes: Array<{ field: string; value: string }> = [
    { field: "S", value: task.id },
    { field: "T", value: task.status },
    { field: "W", value: task.head_commit || "" },
    { field: "Z", value: task.status },
  ].filter((w) => w.value !== "");

  const results: WriteBackResult["results"] = [];
  for (const w of writes) {
    if (!ORCHESTRATOR_WRITABLE.has(w.field)) {
      results.push({ field: w.field, ok: false, error: "not orchestrator-writable" });
      continue;
    }
    try {
      await writeField({
        row: rowIdx,
        field: w.field,
        value: w.value,
        sheetUrl: cfg.sheetUrl,
        sheetName: cfg.sheetName || "Sheet2",
      });
      results.push({ field: w.field, ok: true, value: w.value });
    } catch (err) {
      results.push({ field: w.field, ok: false, error: (err as Error).message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    ok: succeeded === results.length,
    row: rowIdx,
    wrote: succeeded,
    total: results.length,
    results,
  };
}

// 在 rule engine / 自动化场景里用的轻量版: 不带完整错误返回, 只关心成功失败.
export async function tryWriteBackFeishu(taskId: string, ownerId?: string): Promise<boolean> {
  try {
    const r = await writeBackFeishu(taskId, ownerId);
    return r.ok;
  } catch {
    return false;
  }
}

// 抑制 unused warning (Task 类型在编译期被引用).
export type { Task };
// TaskStatus 仍可能在外部类型引用.
export type { TaskStatus };
