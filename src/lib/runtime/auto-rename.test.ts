// R15 sub-2 + sub-3: 自动改标题 (reviewing 进入时) + 手动优先 (用户 PATCH 过不覆盖).
// R122 T5-A: LLM 提炼 (统一 summary 链) + 失败回退; R200 turn2 撤掉 checkpoint 短路档.
//
// 覆盖:
//   - sub-2: 普通 task → reviewing 触发后, title 被改成 prompt 第一段摘要
//   - sub-2: title 已是合理标题且 prompt 与之一致 → 不动 title, 仅置 lock='auto'
//   - sub-3: metadata.title_lock='manual' → 完全跳过, title 不变, lock 不变
//   - sub-3: 已经 auto 改过 (lock='auto') → 后续 running→reviewing 不再覆盖
//   - 边界: 空 prompt + 占位标题 → no_prompt 跳过
//   - 边界: prompt 整段都是 markdown 噪音 (#, `, >) → generateAutoTitle 返回 null
//   - rule-engine 集成: running→reviewing 转换触发 builtin rule 后, events 表里
//     能查到 result=renamed:* 或 result=skipped:*
//   - R122 T5-A: LLM 兜底 / 失败回退 / lock 跳过 / 幂等 (R200 turn2: checkpoint 短路档撤)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask, getTaskById, mutateTaskMetadata, updateTask, updateTaskStatus } from "../db/tasks";
import { seedBuiltinRules } from "../db/rules";
import { insertCheckpoint } from "../db/checkpoints";
import { runRules } from "./rule-engine";
import {
  applyAutoRename,
  generateAutoTitle,
  readTitleLock,
  type AutoRenameOutcome,
} from "./auto-rename";

// mock LLM helper (auto-rename 通过此模块调 SDK 提炼标题, 单测里拦截掉, 不真
// 跑 SDK 子进程). 真实调用的语义在 llm-summarize.ts 自己的内部测试覆盖.
vi.mock("./llm-summarize", async () => {
  const actual = await vi.importActual<typeof import("./llm-summarize")>("./llm-summarize");
  return {
    ...actual,
    summarizeTitle: vi.fn(),
  };
});

// 导入必须在 mock 之后 (ESM hoist 行为).
import { summarizeTitle } from "./llm-summarize";
const summarizeTitleMock = vi.mocked(summarizeTitle);

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-autorename-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");

  projectId = createProject({ name: "auto-rename-test", cwd: tmpDir, ownerId }).id;
  seedBuiltinRules();

  // 默认: LLM 调 mock 失败 (返 null), 模拟「LLM 不可用」让旧 case 仍走 prompt
  // 提取路径. 个别 case 需要 LLM 返新标题时再单独覆写.
  summarizeTitleMock.mockReset();
  summarizeTitleMock.mockResolvedValue(null);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

// ---- generateAutoTitle 纯函数 ----

describe("generateAutoTitle", () => {
  it("returns null for empty prompt", async () => {
    expect(await generateAutoTitle({ ...emptyTask(), prompt: "" })).toBeNull();
  });

  it("truncates long prompts to MAX_TITLE_LEN with ellipsis", async () => {
    const long = "a".repeat(200);
    const t = (await generateAutoTitle({ ...emptyTask(), prompt: long }))!;
    expect(t).not.toBeNull();
    expect(t!.title.length).toBeLessThanOrEqual(60);
    expect(t!.title.endsWith("…")).toBe(true);
    // 默认 mock LLM 返 null → 走第 3 档 prompt 提取, source='prompt'
    expect(t!.source).toBe("prompt");
  });

  it("strips leading markdown headings and backticks", async () => {
    const t = await generateAutoTitle({
      ...emptyTask(),
      prompt: "## `Implement` 一下 R15 auto rename",
    });
    expect(t).not.toBeNull();
    expect(t!.title).toBe("Implement 一下 R15 auto rename");
    expect(t!.source).toBe("prompt");
  });

  it("uses the first paragraph (split on \\n\\n) for the title", async () => {
    const t = await generateAutoTitle({
      ...emptyTask(),
      prompt: "Fix login bug\n\nDetails: ... 第二段被忽略",
    });
    expect(t).not.toBeNull();
    expect(t!.title).toBe("Fix login bug");
    expect(t!.source).toBe("prompt");
  });

  it("skips createTask-injected [tag] blocks ([preflight check] / [dispatched by] / [role: ...])", async () => {
    // 模拟 createTask 实际拼出来的 prompt: preflight + dispatchedBy + role 前缀 + 用户 prompt
    const t = await generateAutoTitle({
      ...emptyTask(),
      prompt: "[preflight check]\nsystem did pwd\ngit remote origin\n\n[dispatched by] 上游 task「foo」\n\n[role: developer]\nbe helpful\n\nFix login bug\n\n后续段落...",
    });
    expect(t).not.toBeNull();
    expect(t!.title).toBe("Fix login bug");
    expect(t!.source).toBe("prompt");
  });
});

// ---- readTitleLock ----

describe("readTitleLock", () => {
  it("returns null for empty metadata", () => {
    expect(readTitleLock(null)).toBeNull();
    expect(readTitleLock(undefined)).toBeNull();
    expect(readTitleLock("")).toBeNull();
  });

  it("returns the lock value when present and valid", () => {
    expect(readTitleLock(JSON.stringify({ title_lock: "manual" }))).toBe("manual");
    expect(readTitleLock(JSON.stringify({ title_lock: "auto" }))).toBe("auto");
  });

  it("returns null on dirty/missing values (fail-open)", () => {
    expect(readTitleLock(JSON.stringify({ title_lock: "MANUAL" }))).toBeNull();
    expect(readTitleLock(JSON.stringify({ title_lock: 1 }))).toBeNull();
    expect(readTitleLock("not-json")).toBeNull();
  });
});

// ---- applyAutoRename ----

describe("applyAutoRename", () => {
  it("sub-2: rewrites title from first prompt line on first call", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix R15 auto rename for first time",
      project_id: projectId,
    });

    const outcome = await applyAutoRename(task.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("prompt");
    expect(outcome.to).toBe("Fix R15 auto rename for first time");

    const after = getTaskById(task.id)!;
    expect(after.title).toBe("Fix R15 auto rename for first time");
    expect(readTitleLock(after.metadata)).toBe("auto");
  });

  it("sub-3: skips when title_lock='manual' (user already PATCH-ed title)", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix login bug",
      project_id: projectId,
    });
    // 模拟用户先 PATCH 了 title → 路由层置 manual lock
    mutateTaskMetadata(task.id, (m) => {
      m.title_lock = "manual";
    });

    const outcome = await applyAutoRename(task.id);
    expect(outcome).toEqual({ ok: false, reason: "manual_lock" });

    const after = getTaskById(task.id)!;
    expect(after.title).toBe("untitled"); // 没动
    expect(readTitleLock(after.metadata)).toBe("manual"); // 锁没变
  });

  it("idempotent: second call after auto rename → auto_lock skip", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix something",
      project_id: projectId,
    });

    const first = await applyAutoRename(task.id);
    expect(first.ok).toBe(true);

    const second = await applyAutoRename(task.id);
    expect(second).toEqual({ ok: false, reason: "auto_lock" });

    // title 没被第二次修改, 还是第一次的结果
    const after = getTaskById(task.id)!;
    expect(after.title).toBe("Fix something");
  });

  it("R200 turn2 force: auto lock 也重刷 (批量标题修正); manual lock 仍不可覆盖", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix something else",
      project_id: projectId,
    });

    const first = await applyAutoRename(task.id);
    expect(first.ok).toBe(true);
    expect(getTaskById(task.id)!.title).toBe("Fix something else");

    // force=true: auto lock 被覆盖, prompt 档再产一次标题 (新 prompt 没给 → 相同标题
    // 也会走 unchanged ok 路径, 这里换 prompt 验证真的重写)
    updateTask(task.id, { prompt: "Rename the database schema now" });
    const forced = await applyAutoRename(task.id, { force: true });
    expect(forced).toEqual({
      ok: true,
      from: "Fix something else",
      to: "Rename the database schema now",
      source: "prompt",
    });

    // manual lock: force 也动不了
    mutateTaskMetadata(task.id, (meta) => {
      meta.title_lock = "manual";
    });
    const manual = await applyAutoRename(task.id, { force: true });
    expect(manual).toEqual({ ok: false, reason: "manual_lock" });
    expect(getTaskById(task.id)!.title).toBe("Rename the database schema now");
  });

  it("returns no_prompt when prompt is empty AND title is generic", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "",
      project_id: projectId,
    });

    const outcome = await applyAutoRename(task.id);
    expect(outcome).toEqual({ ok: false, reason: "no_prompt" });
    expect(readTitleLock(task.metadata)).toBeNull(); // 没置 lock
  });

  it("source='unchanged' when newTitle equals existing title", async () => {
    const task = createTask({
      title: "Fix login bug",
      prompt: "Fix login bug",
      project_id: projectId,
    });

    const outcome = await applyAutoRename(task.id) as Extract<AutoRenameOutcome, { ok: true }>;
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("unchanged");
    expect(outcome.to).toBe("Fix login bug");

    // 即便没改 title, lock 也要置, 避免反复进入 reviewing 重复跑.
    expect(readTitleLock(getTaskById(task.id)!.metadata)).toBe("auto");
  });
});

// ---- R122 T5-A: 三档策略 + lock + 失败回退 + 幂等 ----

describe("applyAutoRename R122 T5-A", () => {
  it("调 LLM: 占位标题 + prompt 信息量不足 → 调 LLM, 不走 prompt 提取", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix something brief",
      project_id: projectId,
    });

    // LLM mock 返新标题, 模拟第 2 档产出
    summarizeTitleMock.mockResolvedValueOnce("LLM 提的标题: R15 auto-rename 升级");
    const outcome = await applyAutoRename(task.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("llm");
    expect(outcome.to).toBe("LLM 提的标题: R15 auto-rename 升级");

    // 验证 LLM 真的被调了一次
    expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
    // 入参含 promptHead + checkpointSummaries + latestTranscript (R144 新增)
    const call = summarizeTitleMock.mock.calls[0][0];
    expect(call.promptHead).toContain("Fix something brief");
    expect(Array.isArray(call.checkpointSummaries)).toBe(true);
    expect(call.checkpointSummaries.length).toBe(0); // 本 case 无 checkpoint
    expect(call.latestTranscript).toBeNull(); // 无 checkpoint 时不传 transcript
  });

  it("R144: checkpoint 含 transcript_slice 时, 透传给 summarizeTitle 让 LLM 看整段对话", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "把 README 加一段安装说明",
      project_id: projectId,
    });
    insertCheckpoint({
      task_id: task.id,
      session_id: "test-session",
      step: "1",
      summary: "添加 README 安装说明段落, 含 macOS / Linux / WSL 三种环境的命令",
      commit_id: null,
      transcript_slice: "用户: 帮我加安装说明\n助手: 已加 macOS / Linux / WSL 三种环境的命令, 提交 commit abc123",
      up_to_message_id: null,
    });
    summarizeTitleMock.mockResolvedValueOnce("README 三平台安装命令");

    const outcome = await applyAutoRename(task.id);

    expect(outcome.source).toBe("llm");
    // 关键: LLM 收到 latestTranscript, 不是 undefined
    const call = summarizeTitleMock.mock.calls[0][0];
    expect(call.latestTranscript).toContain("macOS / Linux / WSL");
    expect(call.latestTranscript).toContain("提交 commit abc123");
  });

  it("R144: 多个 checkpoint → 取最后一个的 transcript_slice (最新)", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Multi-step task",
      project_id: projectId,
    });
    insertCheckpoint({
      task_id: task.id,
      session_id: "test-session",
      step: "1",
      summary: "first step",
      commit_id: null,
      transcript_slice: "OLD transcript about step 1",
      up_to_message_id: null,
    });
    insertCheckpoint({
      task_id: task.id,
      session_id: "test-session",
      step: "2",
      summary: "second step",
      commit_id: null,
      transcript_slice: "NEW transcript about step 2 final",
      up_to_message_id: null,
    });
    summarizeTitleMock.mockResolvedValueOnce("Step 2 final");

    const outcome = await applyAutoRename(task.id);

    expect(outcome.source).toBe("llm");
    const call = summarizeTitleMock.mock.calls[0][0];
    expect(call.latestTranscript).toContain("NEW transcript about step 2 final");
    expect(call.latestTranscript).not.toContain("OLD transcript");
  });

  it("R200 turn2: 有达标 checkpoint 摘要也不再切片短路, 一律走 LLM 提炼", async () => {
    const task = createTask({
      title: "Upgrade auto-rename with LLM fallback", // 已有信息量
      prompt: "Add checkpoint-first short-circuit to auto-rename pipeline",
      project_id: projectId,
    });

    // 插一条 summary > 30 字符的 checkpoint — 旧行为会短路切片, 新行为必须仍走 LLM
    insertCheckpoint({
      task_id: task.id,
      session_id: "test-session",
      step: "1",
      summary: "实现 R122 T5-A 两档策略: LLM 提炼 + prompt 兜底",
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: null,
    });

    summarizeTitleMock.mockResolvedValueOnce("LLM 提的标题: auto-rename 两档策略");
    const outcome = await applyAutoRename(task.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("llm");
    expect(outcome.to).toBe("LLM 提的标题: auto-rename 两档策略");
    expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
  });

  it("checkpoint 短路阈值: summary 长度 ≤ 30 → 不短路, 触发 LLM 兜底", async () => {
    const task = createTask({
      title: "Auto-rename short-circuit threshold check",
      prompt: "Test checkpoint short-circuit threshold",
      project_id: projectId,
    });

    // 插一条 summary = 30 字符 (刚好边界, 触发应不通过: > 30 才短路)
    insertCheckpoint({
      task_id: task.id,
      session_id: "test-session",
      step: "1",
      summary: "123456789012345678901234567890", // 恰好 30 字符
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: null,
    });

    summarizeTitleMock.mockResolvedValueOnce("LLM 兜底标题: 阈值边界验证");
    const outcome = await applyAutoRename(task.id);

    expect(outcome.ok).toBe(true);
    // 没短路 → LLM 兜底
    expect(outcome.source).toBe("llm");
    expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
  });

  it("失败回退: LLM 抛错 → 静默回退到原 prompt 提取, 不污染外层", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix login bug",
      project_id: projectId,
    });

    // LLM mock 抛错 (模拟 SDK 异常, 如撞 429 / 网络断开)
    summarizeTitleMock.mockRejectedValueOnce(new Error("429 rate limit exceeded"));

    const outcome = await applyAutoRename(task.id);

    // 没 throw 给外层, 且回退到 prompt 提取
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("prompt");
    expect(outcome.to).toBe("Fix login bug");
    expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
  });

  it("失败回退: LLM 返 null → 静默回退到原 prompt 提取", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix login bug",
      project_id: projectId,
    });

    // 默认 beforeEach mock 已返 null, 这里显式一次确认
    summarizeTitleMock.mockResolvedValueOnce(null);

    const outcome = await applyAutoRename(task.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("prompt");
    expect(outcome.to).toBe("Fix login bug");
  });

  it("lock 跳过: title_lock='manual' → 完全跳过, 不调 LLM, title 不变", async () => {
    const task = createTask({
      title: "用户手动改过的标题",
      prompt: "Fix login bug",
      project_id: projectId,
    });
    mutateTaskMetadata(task.id, (m) => {
      m.title_lock = "manual";
    });

    const outcome = await applyAutoRename(task.id);

    expect(outcome).toEqual({ ok: false, reason: "manual_lock" });
    // 关键: LLM 完全没被调
    expect(summarizeTitleMock).not.toHaveBeenCalled();
    expect(getTaskById(task.id)!.title).toBe("用户手动改过的标题");
  });

  it("幂等性: LLM 返回与当前 title 完全相同 → 不写库, lock 仍置 auto", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Fix something",
      project_id: projectId,
    });

    // LLM 返回与 task.title 完全一致的标题 → 应 source='unchanged'
    // (但当前 task.title = "untitled", prompt 提取会得 "Fix something";
    //  所以要把 LLM mock 设成"也提取 Fix something", 让两边相等)
    // 改一下: 让 task.title 已经是合理标题 + LLM 也提同一标题
    const task2 = createTask({
      title: "Fix something",
      prompt: "Fix something", // 故意 prompt 提出来 = "Fix something"
      project_id: projectId,
    });
    summarizeTitleMock.mockResolvedValueOnce("Fix something");

    const outcome = await applyAutoRename(task2.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("unchanged");
    expect(outcome.to).toBe("Fix something");

    // 验证: LLM 被调了 (因为 checkpoint 没短路), 但 title 没被覆盖
    expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
    expect(getTaskById(task2.id)!.title).toBe("Fix something");
    // lock 已置 auto (避免下次 reviewing 重复跑)
    expect(readTitleLock(getTaskById(task2.id)!.metadata)).toBe("auto");

    // 沉默防止未使用变量警告
    void task;
  });

  it("damo 1004 B2: task.result 喂进 summarizeTitle 入参 (LLM 档)", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "修 R176 自动标题选错 checkpoint 的问题",
      project_id: projectId,
    });
    updateTaskStatus(task.id, "reviewing", {
      result: "修好 auto-rename 第 1 档: 含 R176 编号的 checkpoint summary 优先入选, 补 3 个测试",
    });
    summarizeTitleMock.mockResolvedValueOnce("修 R176 自动标题选错条");

    const outcome = await applyAutoRename(task.id);
    expect(outcome.source).toBe("llm");

    const call = summarizeTitleMock.mock.calls[0][0];
    expect(call.taskResult).toContain("R176");
    expect(call.taskResult).toContain("checkpoint summary 优先入选");
  });

  it("damo 1004 B2: result 为空时 taskResult=null, LLM 档不炸", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "普通任务没有写 result",
      project_id: projectId,
    });
    summarizeTitleMock.mockResolvedValueOnce("普通标题");

    const outcome = await applyAutoRename(task.id);
    expect(outcome.source).toBe("llm");
    expect(summarizeTitleMock.mock.calls[0][0].taskResult).toBeNull();
  });
});

// ---- rule-engine 集成: running → reviewing 触发 builtin auto-rename rule ----

describe("runRules with auto_rename_title action (R15 sub-2 集成)", () => {
  it("fires auto_rename_title on running → reviewing transition", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Add heartbeat ping to dispatcher",
      project_id: projectId,
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);

    await runRules({ taskId: task.id, from: "running", to: "reviewing" });

    const after = getTaskById(task.id)!;
    expect(after.title).toBe("Add heartbeat ping to dispatcher");

    // events 表应该有 rule_fired, result 含 renamed:*
    const events = getDb()
      .prepare("SELECT data FROM events WHERE task_id = ? AND type = 'rule_fired'")
      .all(task.id) as Array<{ data: string }>;
    const renameEvent = events.find((e) => JSON.parse(e.data).action_type === "auto_rename_title");
    expect(renameEvent).toBeTruthy();
    const data = JSON.parse(renameEvent!.data) as { result: string };
    expect(data.result.startsWith("renamed:")).toBe(true);
  });

  it("sub-3 集成: title_lock='manual' 跳过, events 记 skipped:manual_lock", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "Should not be renamed",
      project_id: projectId,
    });
    mutateTaskMetadata(task.id, (m) => {
      m.title_lock = "manual";
    });
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);

    await runRules({ taskId: task.id, from: "running", to: "reviewing" });

    const after = getTaskById(task.id)!;
    expect(after.title).toBe("untitled"); // 没动

    const events = getDb()
      .prepare("SELECT data FROM events WHERE task_id = ? AND type = 'rule_fired'")
      .all(task.id) as Array<{ data: string }>;
    const renameEvent = events.find((e) => JSON.parse(e.data).action_type === "auto_rename_title");
    expect(renameEvent).toBeTruthy();
    const data = JSON.parse(renameEvent!.data) as { result: string };
    expect(data.result).toBe("skipped:manual_lock");
  });
});

// ---- R166: 标题质量加固 (剥编号 / 剥派发模板尾巴) ----
//
// 两条线上真实坏标题的回归 (DB events 实证, 见 auto-rename.ts 注释):
//   1. c7ca8ab6 → 「1. 列出平台所有项目」 (编号没剥)
//   2. 198a62fc → 「飞书 GDM-v0.2 R71 更新，请处理下。」 (派发模板尾巴没剥)
//   (原第 3 条 38dc8de7 半句截断回归随 checkpoint 短路档一起撤, R200 turn2)

describe("R166 标题质量加固", () => {
  it("prompt 档: 剥列表编号前缀 (回归 c7ca8ab6)", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "1. 列出平台所有项目\n2. 过滤出来有飞书的项目，列出所有飞书链接",
      project_id: projectId,
    });
    const outcome = await applyAutoRename(task.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("prompt");
    expect(outcome.to).toBe("列出平台所有项目");
  });

  it("prompt 档: 剥 sheetwatch 派发模板尾巴 (回归 198a62fc)", async () => {
    const task = createTask({
      title: "untitled",
      prompt: "飞书 GDM-v0.2 R71 更新，请处理下。\n\n完工必填 O 列。",
      project_id: projectId,
    });
    const outcome = await applyAutoRename(task.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("prompt");
    expect(outcome.to).toBe("飞书 GDM-v0.2 R71");
  });

});

// helper: 最小可用的 Task stub (applyAutoRename 内部读 prompt/title/metadata,
// 不读其他字段, 空对象兜底即可).
function emptyTask(): Parameters<typeof generateAutoTitle>[0] {
  return {
    id: "",
    title: "",
    prompt: "",
    metadata: null,
  } as Parameters<typeof generateAutoTitle>[0];
}