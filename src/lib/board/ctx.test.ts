// Board source ctx 注入单测 (R91 第二步).
import { describe, it, expect } from "vitest";
import { applyApiSourceCtx, appendQueryString, type BoardSourceCtx } from "./ctx";

const ctx: BoardSourceCtx = { projectId: "p-abc-123", ownerId: "u-1" };

describe("applyApiSourceCtx", () => {
  it("replaces {project_id} placeholder in path", () => {
    const r = applyApiSourceCtx(
      { kind: "api", path: "/api/projects/{project_id}/tasks" },
      ctx
    );
    expect(r.path).toBe("/api/projects/p-abc-123/tasks");
  });

  it("replaces {owner_id} placeholder in path", () => {
    const r = applyApiSourceCtx(
      { kind: "api", path: "/api/users/{owner_id}/sessions" },
      ctx
    );
    expect(r.path).toBe("/api/users/u-1/sessions");
  });

  it("auto-adds project_id query when author didn't write one", () => {
    const r = applyApiSourceCtx({ kind: "api", path: "/api/tasks" }, ctx);
    expect(r.query).toEqual({ project_id: "p-abc-123" });
  });

  it("respects author's project_id query (no override)", () => {
    const r = applyApiSourceCtx(
      { kind: "api", path: "/api/tasks", query: { project_id: "p-other", status: "running" } },
      ctx
    );
    expect(r.query).toEqual({ project_id: "p-other", status: "running" });
  });

  it("URL-encodes placeholder values", () => {
    const r = applyApiSourceCtx(
      { kind: "api", path: "/api/projects/{project_id}/x" },
      { projectId: "p with space & slash", ownerId: "u" }
    );
    expect(r.path).toBe("/api/projects/p%20with%20space%20%26%20slash/x");
  });

  it("throws on unknown placeholder", () => {
    expect(() =>
      applyApiSourceCtx({ kind: "api", path: "/api/x/{nope}" }, ctx)
    ).toThrow(/unknown placeholder/);
  });

  it("does nothing when no placeholders and projectId absent", () => {
    const r = applyApiSourceCtx({ kind: "api", path: "/api/projects" }, { ownerId: "u-1" });
    expect(r.path).toBe("/api/projects");
    expect(r.query).toEqual({});
  });
});

describe("appendQueryString", () => {
  it("appends with ? when path has no query", () => {
    expect(appendQueryString("/api/x", { a: "1" })).toBe("/api/x?a=1");
  });
  it("appends with & when path already has ?", () => {
    expect(appendQueryString("/api/x?z=0", { a: "1" })).toBe("/api/x?z=0&a=1");
  });
  it("returns path unchanged when query empty", () => {
    expect(appendQueryString("/api/x", {})).toBe("/api/x");
  });
});
