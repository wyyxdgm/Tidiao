// PreToolUse hook 拦截 Bash 走 runner (R3 echo 档修复).
//
// 2026-08-28 调研 (sdk-canuse-tool-deep-dive.md): SDK CLI 子进程默认不为
//   Bash 发 can_use_tool 控制请求 (P5 实测 canUseTool factory 调 1 次,
//   inner 闭包 0 次触发), 原本放在 canUseTool 里的 R3 拦截跑不通. 修复 =
//   把 Bash 拦截从 canUseTool 移到 PreToolUse hook (hook 对每个工具调用
//   必触发, 不受 CLI 内部 allowlist 影响).
//
// 本测试覆盖:
//   1. Bash + 命中白名单 + runner online → hook 返 permissionDecision:'deny'
//      + permissionDecisionReason 含 "[runner:...]" 前缀 + 真实 stdout
//   2. Bash + 不命中白名单 → permissionDecision:'allow' (透传, 走本地)
//   3. Bash + 命中但 runner offline → permissionDecision:'deny' + 显式 error
//      (不静默 fallback)
//   4. 非 Bash 工具 (e.g. Read) → permissionDecision:'allow' (透传)
//   5. canUseTool 看见 Bash 现在只走 autoApprove 路径 (Bash 路由交给 hook)
//      = 反测, 验证 Bash 拦截权完全转交 hook, canUseTool 不再管 Bash
//
// 关注点:
//   - hook 通过 createBashRunnerHook() 拿到, 跟 SDK 注册到的 hookCallback
//     是同一个函数体, 跑出行为 = 真实 SDK CLI 拿到 hookCallback 响应后的行为.
//   - executeOnRunner mock 掉 (./runners/exec); 不真连 daemon, 用 fake
//     SSE 流替换.
//   - 验证「permissionDecisionReason 含 [runner: 前缀」即可, 因为这是
//     CLI 注入 tool_result 文本的字段.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// 不需要跑 SDK 实际流, mock SDK 的 query (避免 spawn subprocess) + mock
// runners/exec (避免真连 daemon).
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

// Mock runners/exec (executeOnRunner) - 测 hook 时不让它真连 daemon.
//   fakeResult 提供可控 ExecResult, 默认给一个成功的 hello-from-mac 输出.
const mocks = vi.hoisted(() => ({
  executeOnRunnerImpl: undefined as
    | ((...args: any[]) => Promise<any>)
    | undefined,
}));

vi.mock("../runners/exec", () => ({
  executeOnRunner: (...args: any[]) => mocks.executeOnRunnerImpl!(...args),
}));

// Mock runners/registry.getConnection (abort listener 用) + 暴露 online
// 列表 mock, 让"命中后跑 executeOnRunner"的测试能拿到真 connection.
// 默认 listOnlineConnections 返空 (跟真实"无 runner 注册"一致); 各测试
// 用 mocks.onlineConnectionsImpl 按需覆盖.
const registryMocks = vi.hoisted(() => ({
  onlineConnectionsImpl: undefined as (() => any[]) | undefined,
  allConnectionsImpl: undefined as (() => any[]) | undefined,
}));

vi.mock("../runners/registry", () => ({
  getConnection: vi.fn(() => null),
  listOnlineConnections: () => registryMocks.onlineConnectionsImpl?.() ?? [],
  _listAllConnections: () => registryMocks.allConnectionsImpl?.() ?? [],
}));

// 构造一个 online connection (runner_id='r-mac-build', host='192.168.3.243:8081')
// 用于命中白名单后能真调 executeOnRunner 的测试. 测试前调用 setRunnerOnline().
function setRunnerOnline() {
  registryMocks.onlineConnectionsImpl = () => [
    {
      runner: {
        id: "r-mac-build",
        name: "mac-build",
        host: "192.168.3.243",
        port: 8081,
        os_type: "macos",
        status: "online",
        last_heartbeat_at: null,
      },
      authToken: "test-token",
      lastSeenAtMs: Date.now(),
      status: "online",
    },
  ];
  registryMocks.allConnectionsImpl = registryMocks.onlineConnectionsImpl;
}

// Mock runners/client.cancel (abort listener 用, mock 防崩)
vi.mock("../runners/client", () => ({
  cancel: vi.fn(async () => undefined),
}));

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-hook-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "runner-hook-test@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "runner-hook-test", ownerId: userId }).id;
  // 重置跨测试残留: 默认所有连接空, 测试需要时显式调 setRunnerOnline()
  registryMocks.onlineConnectionsImpl = undefined;
  registryMocks.allConnectionsImpl = undefined;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 给 project 配 runners 白名单, 命中 "echo hello-from-mac".
function configureRunnerWhitelist(commandPatterns: string[], runnerId = "r-mac-build") {
  const runners = [
    {
      runner_id: runnerId,
      purpose: "build_macos",
      cwd_mapping: "/Users/user/workspace/agent-orch-runner",
      command_patterns: commandPatterns,
    },
  ];
  // 直接走底层 updateProject, 因为 runner_id 是假 ID, 真实存在性校验会拒.
  getDb()
    .prepare(`UPDATE projects SET runners = ? WHERE id = ?`)
    .run(JSON.stringify(runners), projectId);
}

function makeTask(): Task {
  const task = createTask({
    title: "runner-hook-test",
    prompt: "echo test",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

function hookFor(task: Task) {
  const session = new ActiveSession(task);
  // @ts-expect-error private, 测试需要触达
  return session.createBashRunnerHook();
}

const baseSignal = new AbortController().signal;

// 通用 hook options: 与 SDK 调 hook 时 shape 一致 (hook_event_name 等).
const baseHookOpts = {
  signal: baseSignal,
};

const baseHookInput = (cmd: string, toolName = "Bash") => ({
  hook_event_name: "PreToolUse" as const,
  tool_name: toolName,
  tool_input: { command: cmd },
  tool_use_id: "tool-use-1",
} as any);

// 默认 fakeExecResult: 成功 + stdout=hello-from-mac (匹配白名单命令的输出).
const fakeSuccessResult = (override: Partial<any> = {}) => ({
  runId: "rid-test",
  stdout: "hello-from-mac\n",
  stderr: "",
  exitCode: 0,
  durationMs: 250,
  reqId: "req-test-uuid",
  errored: false,
  errorMessage: null,
  ...override,
});

describe("Bash runner hook: 命中白名单 + runner online", () => {
  it("permissionDecision:'deny' + permissionDecisionReason 含 [runner:...] 前缀 + stdout", async () => {
    setRunnerOnline();
    configureRunnerWhitelist(["echo hello-from-mac"]);
    mocks.executeOnRunnerImpl = vi.fn(async () => fakeSuccessResult());

    const task = makeTask();
    const hook = hookFor(task);
    const result = (await hook(baseHookInput("echo hello-from-mac"), "tool-use-1", baseHookOpts)) as any;

    // CLI 写入 tool_result 的字段就是 permissionDecisionReason (CLI 把它
    // 当作 is_error tool_result 文本). model 看到这串文本.
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /^\[runner:mac-build \(192\.168\.3\.243:8081\) req=/,
    );
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("hello-from-mac");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("exit=0");

    // executeOnRunner 必须被调过一次, cmd 透传 + cwd_mapping 正确
    expect(mocks.executeOnRunnerImpl).toHaveBeenCalledTimes(1);
    const callArgs = (mocks.executeOnRunnerImpl as any).mock.calls[0];
    expect(callArgs[1]).toBe("echo hello-from-mac"); // command
    expect(callArgs[2]).toBe("/Users/user/workspace/agent-orch-runner"); // cwdMapping
  });

  it("命中后 generate 唯一 reqId (跨次调用不重复)", async () => {
    setRunnerOnline();
    configureRunnerWhitelist(["echo hello-from-mac"]);
    const seenReqIds: string[] = [];
    mocks.executeOnRunnerImpl = vi.fn(async (_runner, _cmd, _cwd, _env, opts) => {
      seenReqIds.push(opts.reqId);
      return fakeSuccessResult({ reqId: opts.reqId });
    });

    const task = makeTask();
    const hook = hookFor(task);
    await hook(baseHookInput("echo hello-from-mac"), "tool-use-1", baseHookOpts);
    await hook(baseHookInput("echo hello-from-mac"), "tool-use-2", baseHookOpts);
    expect(seenReqIds).toHaveLength(2);
    expect(seenReqIds[0]).not.toBe(seenReqIds[1]);
    // uuid 格式粗检
    expect(seenReqIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Bash runner hook: 不命中白名单 = 透传", () => {
  it("permissionDecision:'allow' + Bash 走本地 SDK (不调 executeOnRunner)", async () => {
    configureRunnerWhitelist(["echo hello-from-mac"]);
    mocks.executeOnRunnerImpl = vi.fn(); // 不应被调

    const task = makeTask();
    const hook = hookFor(task);
    const result = (await hook(baseHookInput("echo not-whitelisted"), "tool-use-1", baseHookOpts)) as any;

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(mocks.executeOnRunnerImpl).not.toHaveBeenCalled();
  });

  it("project 未配 runners → 透传 allow", async () => {
    // 不调 configureRunnerWhitelist, project.runners 仍为 NULL
    mocks.executeOnRunnerImpl = vi.fn();

    const task = makeTask();
    const hook = hookFor(task);
    const result = (await hook(baseHookInput("echo hello-from-mac"), "tool-use-1", baseHookOpts)) as any;

    expect(result.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(mocks.executeOnRunnerImpl).not.toHaveBeenCalled();
  });
});

describe("Bash runner hook: 命中但 runner offline", () => {
  it("permissionDecision:'deny' + 显式 error (不静默 fallback, 不调 executeOnRunner)", async () => {
    // registry 返空 (mock 不调 setRunnerOnline) → resolveRunnerRoute 走
    // "runner 不在 registry" 分支 (因为 _listAllConnections 也是空).
    configureRunnerWhitelist(["echo hello-from-mac"]);
    mocks.executeOnRunnerImpl = vi.fn();

    const task = makeTask();
    const hook = hookFor(task);
    const result = (await hook(baseHookInput("echo hello-from-mac"), "tool-use-1", baseHookOpts)) as any;

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toMatch(/runner offline/);
    // 关键: 不调 executeOnRunner (没 runner 可用, 不应该尝试连)
    expect(mocks.executeOnRunnerImpl).not.toHaveBeenCalled();
  });
});

describe("Bash runner hook: 非 Bash 工具 = 透传", () => {
  it("Read 工具 → continue:true, 不挂 hookSpecificOutput (透传给 CLI 默认处理)", async () => {
    configureRunnerWhitelist(["echo hello-from-mac"]);
    mocks.executeOnRunnerImpl = vi.fn();

    const task = makeTask();
    const hook = hookFor(task);
    const result = await hook(
      baseHookInput("any content", "Read"),
      "tool-use-1",
      baseHookOpts,
    );

    // Read 工具名不匹配 Bash 分支 → hook 不干预, 返 continue:true 不带
    // hookSpecificOutput. CLI 按默认 (allowedTools 含 Read) 自行 allow.
    expect((result as any).continue).toBe(true);
    expect((result as any).hookSpecificOutput).toBeUndefined();
    expect(mocks.executeOnRunnerImpl).not.toHaveBeenCalled();
  });

  it("hook_event_name 非 PreToolUse → 透传 continue", async () => {
    const task = makeTask();
    const hook = hookFor(task);
    const result = await hook(
      {
        hook_event_name: "PostToolUse" as any,
        tool_name: "Bash",
        tool_input: { command: "echo x" },
        tool_use_id: "tool-use-1",
      } as any,
      "tool-use-1",
      baseHookOpts,
    );

    expect((result as any).continue).toBe(true);
    expect((result as any).hookSpecificOutput).toBeUndefined();
  });
});

describe("Bash runner hook: 失败模式", () => {
  it("executeOnRunner 抛错 (mock throw) → hook 不静默 fallback, throw 冒泡 = SDK 控制流可见", async () => {
    // exec.ts 正常结构化错误 (errored=true), 不抛. 但万一 throw → hook
    // 不静默吞 (会掩盖真错误让 agent 误以为没出错). 当前实现 try/finally
    // 包 executeOnRunner, throw 会从 hook 冒泡 → SDK 拿 'Hook callback
    // failed', 把错误显示给用户 (不让 tool_result 静默 = 安全).
    setRunnerOnline();
    configureRunnerWhitelist(["echo hello-from-mac"]);
    mocks.executeOnRunnerImpl = vi.fn(async () => {
      throw new Error("simulated boom");
    });

    const task = makeTask();
    const hook = hookFor(task);
    let threw: Error | null = null;
    try {
      await hook(baseHookInput("echo hello-from-mac"), "tool-use-1", baseHookOpts);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw?.message).toMatch(/simulated boom/);
  });

  it("daemon 端 timeout / startExec 失败 → permissionDecisionReason 含 error 行", async () => {
    setRunnerOnline();
    configureRunnerWhitelist(["echo hello-from-mac"]);
    mocks.executeOnRunnerImpl = vi.fn(async () =>
      fakeSuccessResult({
        errored: true,
        errorMessage: "timeout after 5000ms",
        exitCode: null,
      }),
    );

    const task = makeTask();
    const hook = hookFor(task);
    const result = (await hook(baseHookInput("echo hello-from-mac"), "tool-use-1", baseHookOpts)) as any;

    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("--- error ---");
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("timeout after 5000ms");
  });
});

describe("canUseTool 对 Bash 不再管 (反测: Bash 拦截权完全转交 hook)", () => {
  it("canUseTool('Bash', ...) 在 autoApprove=1 下返 allow (Bash 不走 deploy-guard/process-kill/都不命中)", async () => {
    // 这条是为了"修后不破坏既有行为"的反测. canUseTool 看见 Bash 时,
    // deploy-guard 检查没有命中, process-kill 检查没有命中, runner
    // 路由移走了 → 走到末尾的 autoApprove 分支返 allow. Bash 实际
    // 路由由 hook 接管.
    const task = makeTask();
    getDb().prepare(`UPDATE tasks SET auto_approve = 1 WHERE id = ?`).run(task.id);
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    const canUseTool = session.createCanUseTool();
    const result = await canUseTool(
      "Bash",
      { command: "echo something" },
      {
        signal: new AbortController().signal,
        toolUseID: "tu-1",
        requestId: "r-1",
      },
    );
    expect(result!.behavior).toBe("allow");
  });
});