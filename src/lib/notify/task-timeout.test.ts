// 任务超时邮件通知回归测试 (v41)
//
// 守四件事, 每一条都对应一个「上线就会被关掉」的失败模式:
//   1. **正常结束的任务不发邮件**。这是整个特性的存亡线 —— 每个任务都收一封,
//      damo 第一天就会把功能关掉。结构性保证是「只有超时回调调 notifyTaskTimeout,
//      runTask 的 finally 里 clearTimeout 掉了正常路径」, 这里用「没走过超时回调
//      的 task 上不存在 timeout_notified_at 标记」+「pause/complete 不触发发送」来断言。
//   2. **同一个 task 只发一次**。paused 是非终态, 超时任务会被恢复, 恢复后再超时
//      会第二次进回调 —— 去重用 DB 标记(metadata.timeout_notified_at)而不是内存
//      Set, 所以这里显式验证「第二次调用返回 already notified 且不再发信」。
//   3. **收件人解析链** users.notify_email → NOTIFY_FALLBACK_TO → 不发。
//   4. **通知失败不抛错**。调用点在任务状态机里, 抛出去就是把「邮件服务器抽风」
//      升级成「任务运行时崩溃」。所以 SMTP 未配置 / 收件人为空一律返回
//      { sent:false, reason }。
//
// 关注点: 全程 mock nodemailer, **不真发** —— 真发验证在交付报告里贴 SMTP 250 响应
//   原文(单测里真发会把 CI 变成发信机, 且信誉是有限资源)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const sendMailMock = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail: sendMailMock }),
  },
}));

import { notifyTaskTimeout } from "./task-timeout";
import { resolveNotifyTo, sendNotify, isMailerConfigured } from "./mailer";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";
import { createUser, setUserNotifyEmail, isValidNotifyEmail } from "../db/users";

let tmpDir: string;
let projectId: string;
let userId: string;

const SMTP_ENV = {
  SMTP_HOST: "mail.example.test",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "sender@example.test",
  SMTP_PASS: "x",
  NOTIFY_FROM: "sender@example.test",
};

function setSmtpEnv() {
  for (const [k, v] of Object.entries(SMTP_ENV)) process.env[k] = v;
}
function clearSmtpEnv() {
  for (const k of Object.keys(SMTP_ENV)) delete process.env[k];
  delete process.env.NOTIFY_FALLBACK_TO;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notify-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑 migration (含 v41 users.notify_email)
  userId = (await createUser("owner@example.test", "pw")).id;
  // ⚠️ createTask 的 owner_id 是**从 project 继承**的(T2), 传 def.owner_id 无效 ——
  // 所以项目必须先带 ownerId 建出来, 否则 task.owner_id 是 null, 收件人解析
  // 会直接走系统兜底邮箱, 「用户自己的通知邮箱」那条断言永远测不到。
  projectId = createProject({ name: "p", ownerId: userId }).id;
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({
    response: "250 2.0.0 OK: queued",
    messageId: "<test@example.test>",
  });
  setSmtpEnv();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  clearSmtpEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(): string {
  return createTask({
    title: "长任务",
    prompt: "p",
    project_id: projectId,
    owner_id: userId,
  } as Parameters<typeof createTask>[0]).id;
}

describe("v41 收件人解析链", () => {
  it("users.notify_email 非空 → 用它", () => {
    setUserNotifyEmail(userId, "me@example.test");
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    expect(resolveNotifyTo(userId)).toBe("me@example.test");
  });

  it("没配 → 回落 NOTIFY_FALLBACK_TO", () => {
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    expect(resolveNotifyTo(userId)).toBe("sys@example.test");
  });

  it("清空(传 null / 空串)归一成 NULL, 回落系统邮箱", () => {
    setUserNotifyEmail(userId, "me@example.test");
    setUserNotifyEmail(userId, "   ");
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    expect(resolveNotifyTo(userId)).toBe("sys@example.test");
  });

  it("两者都没有 → null(= 不发), 不抛错", () => {
    expect(resolveNotifyTo(userId)).toBeNull();
    expect(resolveNotifyTo(null)).toBeNull();
  });

  it("userId 不存在时不抛错, 走系统邮箱", () => {
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    expect(resolveNotifyTo("no-such-user")).toBe("sys@example.test");
  });
});

describe("v41 邮箱格式校验", () => {
  it("接受常见写法", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.com"]) {
      expect(isValidNotifyEmail(ok)).toBe(true);
    }
  });
  it("挡住明显写错的", () => {
    for (const bad of ["", "no-at-sign", "a@b", "a b@c.com", "a@@b.com", "a@b."]) {
      expect(isValidNotifyEmail(bad)).toBe(false);
    }
  });
});

describe("v41 sendNotify 永不抛错", () => {
  it("SMTP env 不完整 → { sent:false }, 不抛", async () => {
    clearSmtpEnv();
    expect(isMailerConfigured()).toBe(false);
    const r = await sendNotify({ to: "x@example.test", subject: "s", text: "t" });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/not configured/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("收件人为空 → { sent:false }, 不抛", async () => {
    const r = await sendNotify({ to: "", subject: "s", text: "t" });
    expect(r.sent).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("SMTP 抛错(服务器挂了) → { sent:false, reason }, 不抛", async () => {
    sendMailMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await sendNotify({ to: "x@example.test", subject: "s", text: "t" });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it("成功时把 SMTP 原始响应带回来(留档/排障用)", async () => {
    const r = await sendNotify({ to: "x@example.test", subject: "s", text: "t" });
    expect(r.sent).toBe(true);
    expect(r.response).toBe("250 2.0.0 OK: queued");
  });
});

describe("v41 超时通知 —— 正例", () => {
  it("超时时发一封, 正文含标题/短码/项目/阈值/链接", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://ao.test:13000";
    setUserNotifyEmail(userId, "me@example.test");
    const taskId = makeTask();

    const r = await notifyTaskTimeout(taskId, 30 * 60 * 1000);
    expect(r.sent).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("me@example.test");
    expect(mail.subject).toContain("长任务");
    expect(mail.subject).toContain(taskId.slice(0, 8));
    expect(mail.text).toContain("30 分钟");
    expect(mail.text).toContain("p"); // 项目名
    expect(mail.text).toContain(`http://ao.test:13000/#/tasks/${taskId}`);
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("用户没配通知邮箱时发到系统兜底邮箱", async () => {
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    const taskId = makeTask();
    const r = await notifyTaskTimeout(taskId, 60_000);
    expect(r.sent).toBe(true);
    expect(sendMailMock.mock.calls[0][0].to).toBe("sys@example.test");
  });

  it("NEXT_PUBLIC_APP_URL 没配时不编造 host, 只给 task id", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    const taskId = makeTask();
    await notifyTaskTimeout(taskId, 60_000);
    const text = sendMailMock.mock.calls[0][0].text as string;
    expect(text).toContain(taskId);
    expect(text).not.toContain("http");
  });
});

describe("v41 超时通知 —— 反例(不该发的场景)", () => {
  it("🔴 正常结束的任务不发: 没走超时回调 = 没有通知标记, 也没有发信", () => {
    const taskId = makeTask();
    updateTaskStatus(taskId, "running");
    updateTaskStatus(taskId, "completed");
    const meta = JSON.parse(getTaskById(taskId)?.metadata || "{}");
    expect(meta.timeout_notified_at).toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("🔴 手动暂停的任务不发(pause 本身不是超时)", () => {
    const taskId = makeTask();
    updateTaskStatus(taskId, "running");
    updateTaskStatus(taskId, "paused");
    expect(sendMailMock).not.toHaveBeenCalled();
    const meta = JSON.parse(getTaskById(taskId)?.metadata || "{}");
    expect(meta.timeout_notified_at).toBeUndefined();
  });

  it("🔴 同一 task 第二次超时不重复发(pause→resume→再超时)", async () => {
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    const taskId = makeTask();

    const first = await notifyTaskTimeout(taskId, 60_000);
    expect(first.sent).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const second = await notifyTaskTimeout(taskId, 60_000);
    expect(second.sent).toBe(false);
    expect(second.reason).toBe("already notified");
    expect(sendMailMock).toHaveBeenCalledTimes(1); // 仍然只有一封
  });

  it("去重标记落库(不是内存 Set): 关掉重开连接后仍然挡住", async () => {
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    const taskId = makeTask();
    await notifyTaskTimeout(taskId, 60_000);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    closeDb();
    getDb(); // 模拟 pm2 restart —— 内存标记会丢, DB 标记不会

    const again = await notifyTaskTimeout(taskId, 60_000);
    expect(again.sent).toBe(false);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("task 不存在 / 无收件人 都不抛错", async () => {
    const r1 = await notifyTaskTimeout("no-such-task", 60_000);
    expect(r1.sent).toBe(false);

    const taskId = makeTask(); // NOTIFY_FALLBACK_TO 未设 + 用户未配
    const r2 = await notifyTaskTimeout(taskId, 60_000);
    expect(r2.sent).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
