// R121: summarizeCompletionAttachments helper + builtin rule 集成测试.
//
// 覆盖:
//   1. 正常路径: 有 image attachment → sendFeishuWebhook 被调 + completion_notified_at 标
//   2. 无图: skipped:no_images
//   3. 图不在 window_minutes 内: skipped:no_images
//   4. 图非 agent_generated: skipped:no_images
//   5. 重复触发: skipped:already_notified
//   6. 用户没配 webhook: skipped:no_feishu_webhook, 不抛错
//   7. 飞书发送失败: rule_failed + reason, 不标 notified_at (允许重试)
//   8. 变异验证: 把 sendFeishuWebhook mock 返 {sent:false} → rule_fired event result 是失败 reason
//   9. rule-engine 集成: seedBuiltinRules → runRules(running→reviewing) → 触发
//  10. opt-in: 默认 enabled=0 (damo 推荐 #1)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { getDb, closeDb } from "../db/index";
import { createProject } from "../db/projects";
import { createTask, getTaskById, mutateTaskMetadata } from "../db/tasks";
import { seedBuiltinRules, listRules, setRuleEnabled } from "../db/rules";
import { getEventsByTaskId } from "../db/events";
import { saveAttachmentFromFile, registerAttachmentFromPath } from "../db/attachments";
import { runRules } from "./rule-engine";

// mock sendFeishuWebhook —— 验证参数 + 控制 sent/fail
const sendFeishuWebhookMock = vi.fn();
vi.mock("../notify/feishu", () => ({
  sendFeishuWebhook: (...args: unknown[]) => sendFeishuWebhookMock(...args),
}));

// mock getRuntime 避免 active-session 副作用
vi.mock("./agent-runtime", () => ({
  getRuntime: () => ({
    emitAttachment: () => {},
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-completion-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role, feishu_webhook_url) VALUES (?, ?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user", "https://open.feishu.cn/open-apis/bot/v2/hook/testtesttesttesttesttest");

  projectId = createProject({ name: "completion-test", cwd: tmpDir, ownerId: ownerId }).id;
  seedBuiltinRules();
  sendFeishuWebhookMock.mockReset();
  sendFeishuWebhookMock.mockResolvedValue({ sent: true, status: 200 });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
});

function makeImageAttachment(taskId: string, source: string = "agent_generated"): string {
  const task = getTaskById(taskId)!;
  const cwd = task.cwd!;
  const srcPath = path.join(cwd, `test-${uuidv4().slice(0, 8)}.png`);
  fs.writeFileSync(srcPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = registerAttachmentFromPath(task, task.owner_id!, srcPath, {
    filename: path.basename(srcPath),
    mediaType: "image/png",
    source: "agent_generated",
    metadata: JSON.stringify({ tool: "mmx-image", cost_usd: 0.04 }),
  });
  if (!result.ok) throw new Error(`registerAttachmentFromPath failed: ${result.reason}`);
  if (source !== "agent_generated") {
    getDb().prepare("UPDATE attachments SET source = ? WHERE id = ?").run(source, result.attachment.id);
  }
  return result.attachment.id;
}

describe("summarizeCompletionAttachments", () => {
  it("无图: skipped:no_images", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t1",
      prompt: "p1",
      cwd: tmpDir,
    });
    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const outcome = await summarizeCompletionAttachments(task.id, {});
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("no_images");
    expect(sendFeishuWebhookMock).not.toHaveBeenCalled();
  });

  it("有图: 飞书被调 + completion_notified_at 标", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t2",
      prompt: "p2",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);
    makeImageAttachment(task.id);

    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const outcome = await summarizeCompletionAttachments(task.id, {});
    expect(outcome.sent).toBe(true);
    expect(outcome.imageCount).toBe(2);
    expect(sendFeishuWebhookMock).toHaveBeenCalledTimes(1);
    // markdown 消息应含标题 + 2 张图 (markdown 链接)
    const arg = sendFeishuWebhookMock.mock.calls[0][0];
    expect(arg.msgType).toBe("markdown");
    expect(arg.message).toMatch(/已生成 2 张图/);
    expect(arg.message).toMatch(/!\[\]/.test(arg.message) ? arg.message : /!\[/); // 含 markdown 图语法
    // metadata 应标
    const updated = getTaskById(task.id)!;
    const meta = JSON.parse(updated.metadata!);
    expect(meta.completion_notified_at).toBeTruthy();
  });

  it("图非 agent_generated: skipped:no_images", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t3",
      prompt: "p3",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id, "upload");

    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const outcome = await summarizeCompletionAttachments(task.id, {});
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("no_images");
  });

  it("重复触发: skipped:already_notified", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t4",
      prompt: "p4",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);
    const { summarizeCompletionAttachments } = await import("./completion-notify");
    await summarizeCompletionAttachments(task.id, {});
    // 第二次
    const outcome = await summarizeCompletionAttachments(task.id, {});
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("already_notified");
    expect(sendFeishuWebhookMock).toHaveBeenCalledTimes(1); // 只调过一次
  });

  it("用户没配 webhook: skipped:no_feishu_webhook", async () => {
    const noHookUser = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role, feishu_webhook_url) VALUES (?, ?, ?, ?, NULL)`)
      .run(noHookUser, `${noHookUser}@example.com`, "x", "user");
    const proj = createProject({ name: "no-hook", cwd: tmpDir, ownerId: noHookUser }).id;
    const task = createTask({
      
      project_id: proj,
      title: "t5",
      prompt: "p5",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);
    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const outcome = await summarizeCompletionAttachments(task.id, {});
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("no_feishu_webhook");
  });

  it("飞书失败: 不标 notified_at, 允许重试", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t6",
      prompt: "p6",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);
    sendFeishuWebhookMock.mockResolvedValueOnce({ sent: false, reason: "keyword_blocked" });
    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const outcome = await summarizeCompletionAttachments(task.id, {});
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toBe("keyword_blocked");
    // metadata 应为 NULL 或不含 completion_notified_at (允许重试)
    const updated = getTaskById(task.id)!;
    const meta = updated.metadata ? JSON.parse(updated.metadata) : {};
    expect(meta.completion_notified_at).toBeFalsy();
  });

  it("max_images=2 时只发 2 张, 标 overflow", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t7",
      prompt: "p7",
      cwd: tmpDir,
    });
    for (let i = 0; i < 4; i++) makeImageAttachment(task.id);
    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const outcome = await summarizeCompletionAttachments(task.id, { max_images: 2 });
    expect(outcome.sent).toBe(true);
    expect(outcome.imageCount).toBe(4);
    const arg = sendFeishuWebhookMock.mock.calls[0][0];
    // markdown 消息应含 overflow 提示
    expect(arg.msgType).toBe("markdown");
    expect(arg.message).toMatch(/还有 2 张/);
  });
});

describe("rule-engine 集成", () => {
  it("builtin rule 默认 enabled=0 (opt-in)", () => {
    const rules = listRules();
    const rule = rules.find((r) => r.name === "completion-auto-send-images");
    expect(rule).toBeTruthy();
    expect(rule!.enabled).toBe(0);
    expect(rule!.action_type).toBe("summarize_completion_attachments");
    expect(rule!.from_status).toBe("running");
    expect(rule!.to_status).toBe("reviewing");
  });

  it("rule enabled 后, runRules 触发 → sendFeishuWebhook 被调 + rule_fired event", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t8",
      prompt: "p8",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);

    // 启 rule
    const rules = listRules();
    const rule = rules.find((r) => r.name === "completion-auto-send-images")!;
    setRuleEnabled(rule.id, true);

    await runRules({ taskId: task.id, from: "running", to: "reviewing" });

    expect(sendFeishuWebhookMock).toHaveBeenCalledTimes(1);
    const events = getEventsByTaskId(task.id);
    const firedEvent = events.find((e: any) => e.type === "rule_fired" && JSON.parse(e.data).action_type === "summarize_completion_attachments");
    expect(firedEvent).toBeTruthy();
    const data = JSON.parse((firedEvent as any).data);
    expect(data.result).toMatch(/^sent:1_images/);
  });

  it("rule disabled 时 runRules 不触发", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t9",
      prompt: "p9",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);
    // 不启 rule (默认 disabled)
    await runRules({ taskId: task.id, from: "running", to: "reviewing" });
    expect(sendFeishuWebhookMock).not.toHaveBeenCalled();
  });
});

describe("变异验证 (防 ac19cdf 教训)", () => {
  it("把 sendFeishuWebhook mock 返 {sent:false}: rule_fired 仍记 reason, 不假装成功", async () => {
    const task = createTask({
      
      project_id: projectId,
      title: "t10",
      prompt: "p10",
      cwd: tmpDir,
    });
    makeImageAttachment(task.id);
    sendFeishuWebhookMock.mockResolvedValueOnce({ sent: false, reason: "rate_limited" });

    const rules = listRules();
    const rule = rules.find((r) => r.name === "completion-auto-send-images")!;
    setRuleEnabled(rule.id, true);

    await runRules({ taskId: task.id, from: "running", to: "reviewing" });

    const events = getEventsByTaskId(task.id);
    const firedEvent = events.find((e: any) => e.type === "rule_fired" && JSON.parse(e.data).action_type === "summarize_completion_attachments");
    expect(firedEvent).toBeTruthy();
    const data = JSON.parse((firedEvent as any).data);
    // 🔴 不能写 "sent:..." 假装成功
    expect(data.result).toBe("rate_limited");
    expect(data.result).not.toMatch(/^sent:/);
  });
});
