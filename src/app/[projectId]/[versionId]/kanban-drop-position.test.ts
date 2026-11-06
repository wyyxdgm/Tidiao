// 单元测: R154 修复点 — 看板拖到某 card 上时, 跨列 = 切 status + 插入到那
//   张 card 之前; 同列 = 仅插入排序. 纯函数测, 无 React 依赖.
//
// 关注点:
//   - 输入/输出是 plain string[] + null, 与 React 拖拽事件无关.
//   - 跨列 → onStatusChange + onReorder 都调, 顺序由本函数算.
//   - 同列 → onStatusChange 不调, onReorder 行为与改造前 byte-identical.
//   - drop 落空 (beforeTaskId null / 不在列) → 落到列尾.

import { describe, it, expect } from "vitest";
import { computeCrossColumnDrop } from "./kanban-drop-position";

describe("computeCrossColumnDrop (R154)", () => {
  describe("跨列 drop", () => {
    it("queued → running, drop 到某 card 上: action=start + 插到那张 card 之前", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "running",
        draggedId: "t-queued",
        beforeTaskId: "t-running-2",
        targetColumnIds: ["t-running-1", "t-running-2", "t-running-3"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("start");
      // 拖到 t-running-2 之前 → t-queued 插到 idx=1
      expect(r.newOrder).toEqual([
        "t-running-1",
        "t-queued",
        "t-running-2",
        "t-running-3",
      ]);
    });

    it("queued → running, drop 到列尾空白: action=start + 落到列尾", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "running",
        draggedId: "t-queued",
        beforeTaskId: null,
        targetColumnIds: ["t-running-1", "t-running-2"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("start");
      expect(r.newOrder).toEqual(["t-running-1", "t-running-2", "t-queued"]);
    });

    it("queued → running, beforeTaskId 不在 target 列: 落到列尾 (兜底)", () => {
      // 防御: drop 时机异常, beforeTaskId 指了一个已不在内存里的 card (SSE patch
      //   后被移除). 不抛错, 直接落到列尾 — 行为与 beforeTaskId=null 一致.
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "running",
        draggedId: "t-queued",
        beforeTaskId: "ghost-id",
        targetColumnIds: ["t-running-1"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("start");
      expect(r.newOrder).toEqual(["t-running-1", "t-queued"]);
    });

    it("running → paused, drop 到某 card 上: action=pause + 插入", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "running",
        targetColKey: "paused",
        draggedId: "t-running",
        beforeTaskId: "t-paused-1",
        targetColumnIds: ["t-paused-1"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("pause");
      expect(r.newOrder).toEqual(["t-running", "t-paused-1"]);
    });

    it("非法 transition (queued → paused 不在白名单): action=null + 仍插队 (顺序照算)", () => {
      // 当前 VALID_STATUS_TRANSITIONS 中 queued 不允许直接 paused, action 应为
      //   null; 但 newOrder 仍按 beforeTaskId 计算 — 调用方负责只调 onReorder
      //   不调 onStatusChange (action=null 兜底). 用户拖了非合法 status → 仅
      //   排序, 不切 status (避免后端 400).
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "paused",
        draggedId: "t-queued",
        beforeTaskId: "t-paused-1",
        targetColumnIds: ["t-paused-1", "t-paused-2"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBeNull();
      expect(r.newOrder).toEqual(["t-queued", "t-paused-1", "t-paused-2"]);
    });

    // 2026-09-20 bugfix: paused → completed 之前前端白名单漏, 拖到「已完成」列
    //   时静默 noop (handleColDrop 直接 return). 服务端 approveTask 早支持 paused
    //   (agent-runtime.ts line 1323). 修复后白名单含 completed + action="approve".
    it("paused → completed: action=approve + 插入目标列 (R-kanban-paused-complete)", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "paused",
        targetColKey: "completed",
        draggedId: "t-paused",
        beforeTaskId: "t-completed-2",
        targetColumnIds: ["t-completed-1", "t-completed-2", "t-completed-3"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("approve");
      expect(r.newOrder).toEqual([
        "t-completed-1",
        "t-paused",
        "t-completed-2",
        "t-completed-3",
      ]);
    });

    // 2026-09-22 R162: 看板允许把排队中的任务拖回「待执行」列. 走新加的
    //   dequeue action (queued → pending, 后端把 task 从 scheduler.queue 摘除 +
    //   翻 status, 不删 session_id, 后续可重新 start). 与 paused → completed
    //   同结构: action 字符串直接喂给 board-client.runAction 拼 URL.
    it("queued → pending: action=dequeue + 插入目标列 (R162)", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "pending",
        draggedId: "t-queued",
        beforeTaskId: "t-pending-2",
        targetColumnIds: ["t-pending-1", "t-pending-2", "t-pending-3"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("dequeue");
      expect(r.newOrder).toEqual([
        "t-pending-1",
        "t-queued",
        "t-pending-2",
        "t-pending-3",
      ]);
    });

    it("queued → pending, drop 到列尾空白: action=dequeue + 落到列尾", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "pending",
        draggedId: "t-queued",
        beforeTaskId: null,
        targetColumnIds: ["t-pending-1", "t-pending-2"],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("dequeue");
      expect(r.newOrder).toEqual(["t-pending-1", "t-pending-2", "t-queued"]);
    });
  });

  describe("同列 drop", () => {
    it("running 列内 drop, 拖到某 card 之前: action=null + 仅插入排序", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "running",
        targetColKey: "running",
        draggedId: "t-3",
        beforeTaskId: "t-1",
        targetColumnIds: ["t-1", "t-2", "t-3"],
      });
      expect(r.crossColumn).toBe(false);
      expect(r.action).toBeNull();
      // t-3 从 withoutSelf 中过滤掉 (withoutSelf = [t-1, t-2]), 再插到 t-1 之前
      expect(r.newOrder).toEqual(["t-3", "t-1", "t-2"]);
    });

    it("running 列内 drop 到列尾: 仅排序", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "running",
        targetColKey: "running",
        draggedId: "t-1",
        beforeTaskId: null,
        targetColumnIds: ["t-1", "t-2", "t-3"],
      });
      expect(r.crossColumn).toBe(false);
      expect(r.action).toBeNull();
      expect(r.newOrder).toEqual(["t-2", "t-3", "t-1"]);
    });
  });

  describe("边界", () => {
    it("draggedId 空 → 无操作 (兜底)", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "running",
        draggedId: "",
        beforeTaskId: null,
        targetColumnIds: ["t-1"],
      });
      expect(r.crossColumn).toBe(false); // 早返回, 不算跨列
      expect(r.action).toBeNull();
      expect(r.newOrder).toEqual([]); // 调用方按空数组走 noop
    });

    it("sourceColKey 为 null (dataTransfer 解析失败): crossColumn=false + action=null", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: null,
        targetColKey: "running",
        draggedId: "t-1",
        beforeTaskId: null,
        targetColumnIds: [],
      });
      expect(r.crossColumn).toBe(false);
      expect(r.action).toBeNull();
      expect(r.newOrder).toEqual(["t-1"]);
    });

    it("target 列空: 新顺序 = [draggedId]", () => {
      const r = computeCrossColumnDrop({
        sourceColKey: "queued",
        targetColKey: "running",
        draggedId: "t-queued",
        beforeTaskId: null,
        targetColumnIds: [],
      });
      expect(r.crossColumn).toBe(true);
      expect(r.action).toBe("start");
      expect(r.newOrder).toEqual(["t-queued"]);
    });
  });
});