// Board frontmatter 解析单测 (R61 / P0).
import { describe, it, expect } from "vitest";
import { parseBoardFile, parseIntervalSeconds } from "./frontmatter";

describe("parseIntervalSeconds", () => {
  it("parses bare number as seconds", () => {
    expect(parseIntervalSeconds("30")).toBe(30);
    expect(parseIntervalSeconds(45)).toBe(45);
  });
  it("parses s/m/h units", () => {
    expect(parseIntervalSeconds("30s")).toBe(30);
    expect(parseIntervalSeconds("5m")).toBe(300);
    expect(parseIntervalSeconds("1h")).toBe(3600);
  });
  it("rejects garbage", () => {
    expect(parseIntervalSeconds("foo")).toBeNull();
    expect(parseIntervalSeconds("")).toBeNull();
    expect(parseIntervalSeconds(null)).toBeNull();
    expect(parseIntervalSeconds(undefined)).toBeNull();
    expect(parseIntervalSeconds({})).toBeNull();
  });
});

describe("parseBoardFile", () => {
  it("returns minimum config when no frontmatter", () => {
    const r = parseBoardFile("# just markdown\n\nbody");
    expect(r.config.title).toBe("Untitled Board");
    expect(r.config.sources).toEqual([]);
    expect(r.config.refresh).toEqual({ kind: "interval", seconds: 30 });
    expect(r.body).toContain("# just markdown");
  });

  it("returns minimum config when frontmatter yaml is malformed", () => {
    const r = parseBoardFile("---\n:bad: yaml: [unclosed\n---\nbody");
    expect(r.config.title).toBe("Untitled Board");
    expect(r.body).toContain("body");
  });

  it("parses a full board config", () => {
    const md = `---
title: 平台总览
refresh: 1m
sources:
  - name: projects
    kind: api
    path: /api/projects
  - name: running
    kind: sql
    query: SELECT id, title FROM tasks WHERE status='running'
---
<div id="app"></div>`;
    const r = parseBoardFile(md);
    expect(r.config.title).toBe("平台总览");
    expect(r.config.refresh).toEqual({ kind: "interval", seconds: 60 });
    expect(r.config.sources).toHaveLength(2);
    expect(r.config.sources[0]).toEqual({ name: "projects", kind: "api", path: "/api/projects", query: undefined });
    expect(r.config.sources[1]).toMatchObject({ name: "running", kind: "sql" });
    expect(r.body).toContain('<div id="app"></div>');
  });

  it("rejects refresh < 10s (冷启动源 §5.4)", () => {
    const md = `---
title: x
refresh: 2s
sources: []
---`;
    const r = parseBoardFile(md);
    expect(r.config.refresh).toEqual({ kind: "interval", seconds: 30 });
  });

  it("accepts sse refresh", () => {
    const md = `---
title: live
refresh: sse
sources: []
---`;
    expect(parseBoardFile(md).config.refresh).toEqual({ kind: "sse" });
  });

  it("accepts manual refresh (off)", () => {
    const md = `---
title: static
refresh: manual
sources: []
---`;
    expect(parseBoardFile(md).config.refresh).toEqual({ kind: "manual" });
  });

  it("drops sources with missing name", () => {
    const md = `---
title: x
sources:
  - kind: api
    path: /api/projects
---`;
    expect(parseBoardFile(md).config.sources).toEqual([]);
  });

  it("drops sources with non-absolute api path", () => {
    const md = `---
title: x
sources:
  - name: bad
    kind: api
    path: api/projects
---`;
    expect(parseBoardFile(md).config.sources).toEqual([]);
  });

  it("drops duplicate source names (first wins)", () => {
    const md = `---
title: x
sources:
  - name: a
    kind: api
    path: /api/projects
  - name: a
    kind: api
    path: /api/tasks
---`;
    const r = parseBoardFile(md);
    expect(r.config.sources).toHaveLength(1);
    expect(r.config.sources[0]?.kind).toBe("api");
  });

  it("unknown source kind is dropped", () => {
    const md = `---
title: x
sources:
  - name: weird
    kind: graphql
    query: foo
---`;
    expect(parseBoardFile(md).config.sources).toEqual([]);
  });

  it("api source with query object preserves keys", () => {
    const md = `---
title: x
sources:
  - name: p
    kind: api
    path: /api/tasks
    query:
      status: running
      limit: "10"
---`;
    const r = parseBoardFile(md);
    expect(r.config.sources[0]).toMatchObject({
      name: "p",
      kind: "api",
      path: "/api/tasks",
      query: { status: "running", limit: "10" },
    });
  });

  it("layout: panel is recognized", () => {
    const md = `---
title: x
layout: panel
sources: []
---`;
    expect(parseBoardFile(md).config.layout).toBe("panel");
  });

  it("default layout is page", () => {
    const md = `---
title: x
sources: []
---`;
    expect(parseBoardFile(md).config.layout).toBe("page");
  });
});
