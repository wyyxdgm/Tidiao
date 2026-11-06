// Unit tests for buildAllowedTools() MCP tool injection (PR-3 fix).
//
// Bug history: 2026-09-02 task 15e1572f. PR-3 wired mcpServers: { media: ... }
// into SDK query options, but SDK doesn't auto-register MCP tools into the
// agent's tool list — they MUST be in `allowedTools`. Without these two
// entries the agent reports "我的工具集里没有 mcp__media__image_gen" and
// falls back to Bash mmx CLI (writes file but skips attachment registration
// = chat stays empty + /assets list misses it).
//
// These tests pin the contract: image_gen + video_gen are always in the
// returned array, regardless of task.allowed_tools shape.

import { describe, it, expect, vi } from "vitest";

// Mock heavy imports so we don't pull in the world.
vi.mock("@/lib/db/tasks", () => ({ getTaskById: vi.fn() }));
vi.mock("@/lib/db/projects", () => ({}));
vi.mock("@/lib/db/sessions", () => ({ upsertSession: vi.fn(), getSession: vi.fn() }));
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    emitAttachment: vi.fn(),
    emitEvent: vi.fn(),
    logEvent: vi.fn(),
  }),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));
vi.mock("@/lib/runtime/active-session-spawn", () => ({ spawnClaude: vi.fn() }));
vi.mock("@/lib/intake", () => ({}));

// Import after mocks so the ActiveSession constructor doesn't pull real DB.
import { ActiveSession } from "./active-session";

function makeTask(overrides: Partial<{ allowed_tools: string | null }> = {}): any {
  return {
    id: "task-test-id",
    title: "test",
    prompt: "p",
    status: "running",
    cwd: "/tmp",
    project_id: "p1",
    version_id: "v1",
    allowed_tools: overrides.allowed_tools ?? null,
    auto_approve: 0,
    max_turns: null,
    effort: "high",
    session_id: null,
    model: null,
    resolved_model: null,
    deleted_at: null,
    result: null,
    error: null,
    preflight_result: null,
    tags: null,
    cost_usd: null,
    context_tokens: null,
    context_max: null,
    created_at: new Date().toISOString(),
    user_id: "u1",
  };
}

describe("ActiveSession.buildAllowedTools (PR-3 MCP fix)", () => {
  // Build a session without calling constructor side-effects.
  function session(): ActiveSession {
    // @ts-expect-error -- poking private for white-box test
    return Object.create(ActiveSession.prototype);
  }

  it("includes image_gen + video_gen even when task.allowed_tools is null (default ALL_TOOLS)", () => {
    const s = session();
    const result = (s as any).buildAllowedTools(makeTask({ allowed_tools: null }));
    expect(result).toContain("mcp__media__image_gen");
    expect(result).toContain("mcp__media__video_gen");
  });

  it("includes image_gen + video_gen even when task.allowed_tools is a custom JSON array", () => {
    // Simulate operator who configured a custom tool list (read-only-ish).
    const custom = JSON.stringify(["Read", "Grep", "Glob", "WebSearch"]);
    const s = session();
    const result = (s as any).buildAllowedTools(makeTask({ allowed_tools: custom }));
    expect(result).toContain("mcp__media__image_gen");
    expect(result).toContain("mcp__media__video_gen");
    // Read-only built-ins preserved
    expect(result).toContain("Read");
    expect(result).toContain("Grep");
    // Write-class stripped
    expect(result).not.toContain("Write");
    expect(result).not.toContain("Bash");
  });

  it("strips write-class tools (Write/Edit/Bash/NotebookEdit) from default ALL_TOOLS", () => {
    const s = session();
    const result = (s as any).buildAllowedTools(makeTask({ allowed_tools: null }));
    expect(result).not.toContain("Write");
    expect(result).not.toContain("Edit");
    expect(result).not.toContain("Bash");
    expect(result).not.toContain("NotebookEdit");
    // Read-only built-ins kept
    expect(result).toContain("Read");
    expect(result).toContain("Grep");
  });

  it("does not deduplicate MCP tools when task.allowed_tools already lists them", () => {
    // Defensive: even if operator already listed them, the push is idempotent
    // (SDK tolerates duplicate entries in allowedTools). We just verify the
    // tool is present — count is allowed to be > 1.
    const custom = JSON.stringify(["Read", "mcp__media__image_gen"]);
    const s = session();
    const result = (s as any).buildAllowedTools(makeTask({ allowed_tools: custom }));
    expect(result).toContain("mcp__media__image_gen");
    expect(result.filter((t: string) => t === "mcp__media__image_gen").length).toBeGreaterThanOrEqual(1);
  });
});