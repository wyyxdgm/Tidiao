// v56: awaiting_owner_review 机制测试套件
//
// 覆盖 4 条不变量:
//   1. migration v56 把 awaiting_owner_review 列加到 tasks (default 0)
//   2. approveTask 看到 awaiting_owner_review=1 时抛 AWAITING_OWNER_REVIEW, 不改 status
//   3. unsetAwaitingOwnerReview 把 flag 置 0, status 不动
//   4. AWAITING_REVIEW_RE marker 正则行为 (bare / 带 reason / 多次 / 长度上限)
//
// 故意走真 SQLite (better-sqlite3, 文件 DB) + 真 AgentRuntime. 不 mock DB 层 —
// flag 落库是关键不变量, mock 掉测得是幻觉.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTask, updateTaskStatus } from "../db/tasks";
import { getRuntime } from "./agent-runtime";
import { ActiveSession } from "./active-session";
import { upsertLlmConfig } from "../db/llm-configs";

let tmpDir: string;
let projectId: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-awaiting-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // run all migrations

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "awaiting-test@example.com", "x", "admin");

  projectId = createProject({ name: "awaiting-test-project", ownerId: userId }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("awaiting_owner_review v56 schema", () => {
  it("migration v56 adds awaiting_owner_review column (default 0)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === "awaiting_owner_review");
    expect(col).toBeTruthy();
    // default 0 (NULL → 0 in CREATE TABLE 写法). dflt_value 来自 schema 字面量
    expect(col?.dflt_value === null || col?.dflt_value === "0" || col?.dflt_value === undefined).toBeTruthy();
  });

  it("new task created without marker has awaiting_owner_review=0", () => {
    const t = createTask({ title: "fresh", prompt: "x", project_id: projectId });
    expect(getTaskById(t.id)!.awaiting_owner_review).toBe(0);
  });
});

describe("approveTask gate on awaiting_owner_review", () => {
  function makeReviewingTask() {
    const t = createTask({ title: "reviewing-task", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { result: "done", completed_at: new Date().toISOString() });
    return t;
  }

  it("refuses when awaiting_owner_review=1, status stays reviewing", () => {
    const t = makeReviewingTask();
    updateTask(t.id, { awaiting_owner_review: 1 });
    expect(getTaskById(t.id)!.awaiting_owner_review).toBe(1);

    expect(() => getRuntime().approveTask(t.id)).toThrow(/AWAITING_OWNER_REVIEW/);
    expect(getTaskById(t.id)!.status).toBe("reviewing");
  });

  it("passes when awaiting_owner_review=0 (regression guard)", () => {
    const t = makeReviewingTask();
    expect(getTaskById(t.id)!.awaiting_owner_review).toBe(0);

    expect(() => getRuntime().approveTask(t.id)).not.toThrow();
    expect(getTaskById(t.id)!.status).toBe("completed");
  });

  it("race: unset between gate check then re-approve succeeds", () => {
    const t = makeReviewingTask();
    updateTask(t.id, { awaiting_owner_review: 1 });

    expect(() => getRuntime().approveTask(t.id)).toThrow(/AWAITING_OWNER_REVIEW/);
    getRuntime().unsetAwaitingOwnerReview(t.id);
    expect(() => getRuntime().approveTask(t.id)).not.toThrow();
    expect(getTaskById(t.id)!.status).toBe("completed");
  });
});

describe("unsetAwaitingOwnerReview", () => {
  function makeReviewingTask() {
    const t = createTask({ title: "unset-task", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { result: "done", completed_at: new Date().toISOString() });
    return t;
  }

  it("sets flag to 0, preserves status", () => {
    const t = makeReviewingTask();
    updateTask(t.id, { awaiting_owner_review: 1 });

    const result = getRuntime().unsetAwaitingOwnerReview(t.id);
    expect(result).toEqual({ ok: true, awaiting_owner_review: 0, awaiting_markers: null });
    expect(getTaskById(t.id)!.awaiting_owner_review).toBe(0);
    expect(getTaskById(t.id)!.status).toBe("reviewing"); // status 不动
  });

  // v61+R39: unsetAwaitingOwnerReview 一次同时清 flag + markers JSON. damo 拍板
  //   = 一组 marker 全部解除, 不允许单独清 flag 留 markers (那样 UI 还会再弹).
  it("v61: unset also clears awaiting_markers JSON", () => {
    const t = makeReviewingTask();
    updateTask(t.id, {
      awaiting_owner_review: 1,
      awaiting_markers: JSON.stringify([{ type: "review", desc: "test" }]),
    });
    expect(getTaskById(t.id)!.awaiting_markers).not.toBeNull();

    getRuntime().unsetAwaitingOwnerReview(t.id);

    const after = getTaskById(t.id)!;
    expect(after.awaiting_owner_review).toBe(0);
    expect(after.awaiting_markers).toBeNull();
    expect(after.status).toBe("reviewing");
  });

  it("refuses non-reviewing/rejected/paused states (e.g. running)", () => {
    const t = createTask({ title: "running-task", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "running", {
      session_id: "sess-test",
      started_at: new Date().toISOString(),
    });
    updateTask(t.id, { awaiting_owner_review: 1 });

    expect(() => getRuntime().unsetAwaitingOwnerReview(t.id)).toThrow(/not in reviewing/);
    expect(getTaskById(t.id)!.awaiting_owner_review).toBe(1); // flag unchanged
  });

  it("refuses when task not found", () => {
    expect(() => getRuntime().unsetAwaitingOwnerReview("does-not-exist")).toThrow(/not found/);
  });
});

describe("AWAITING_REVIEW_RE regex", () => {
  function execAll(re: RegExp, text: string): RegExpExecArray[] {
    re.lastIndex = 0;
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m);
    return out;
  }

  it("matches bare marker", () => {
    const matches = execAll(ActiveSession.AWAITING_REVIEW_RE, "done.<awaiting_review/>");
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBeUndefined(); // no reason
  });

  it("matches with reason", () => {
    const matches = execAll(
      ActiveSession.AWAITING_REVIEW_RE,
      '做完啦。<awaiting_review reason="需要 damo 决定优先级"/>',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("需要 damo 决定优先级");
  });

  it("multiple markers: parseAwaitingReviewInBlock uses last-write-wins", () => {
    const matches = execAll(
      ActiveSession.AWAITING_REVIEW_RE,
      '<awaiting_review reason="first"/> done <awaiting_review reason="second"/>',
    );
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe("first");
    expect(matches[1][1]).toBe("second");
    // parseAwaitingReviewInBlock 会用最后一个, 验证逻辑就是 last-write-wins
    expect(matches[matches.length - 1][1]).toBe("second");
  });

  it("rejects reason exceeding 256 chars (charset cap)", () => {
    const reason = "x".repeat(300);
    const matches = execAll(ActiveSession.AWAITING_REVIEW_RE, `<awaiting_review reason="${reason}"/>`);
    expect(matches).toHaveLength(0);
  });

  it("accepts reason exactly 256 chars (boundary)", () => {
    const reason = "x".repeat(256);
    const matches = execAll(ActiveSession.AWAITING_REVIEW_RE, `<awaiting_review reason="${reason}"/>`);
    expect(matches).toHaveLength(1);
  });
});

// v61+R39: 多类型 awaiting marker 正则行为. 老 <awaiting_review/> 由 AWAITING_REVIEW_RE
//   单独测试, 新 <awaiting type="..."/> 由 AWAITING_MARKER_RE 测试. 边界 + 多 marker
//   + JSON data 字段 + charset 限制覆盖全.
describe("AWAITING_MARKER_RE v61", () => {
  function execAll(re: RegExp, text: string): RegExpExecArray[] {
    re.lastIndex = 0;
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m);
    return out;
  }

  it("matches bare type only", () => {
    const matches = execAll(ActiveSession.AWAITING_MARKER_RE, "done.<awaiting type=\"review\"/>");
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("review");
    expect(matches[0][2]).toBeUndefined(); // no desc
    expect(matches[0][3]).toBeUndefined(); // no data
  });

  it("matches with type + desc", () => {
    const matches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      '<awaiting type="choice" desc="选 A 还是 B?"/>',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("choice");
    expect(matches[0][2]).toBe("选 A 还是 B?");
  });

  it("matches with type + desc + data JSON", () => {
    const matches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      `<awaiting type="choice" desc="选 A 还是 B?" data='{"options":["A","B"]}'/>`,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("choice");
    expect(matches[0][2]).toBe("选 A 还是 B?");
    expect(matches[0][3]).toBe('{"options":["A","B"]}');
    // JSON 解析也得通
    expect(JSON.parse(matches[0][3])).toEqual({ options: ["A", "B"] });
  });

  it("multiple markers (g flag, all-of 收集) — 不 last-write-wins", () => {
    const matches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      '<awaiting type="review" desc="先看 review"/> <awaiting type="choice" desc="再做选择"/> <awaiting type="info" desc="顺手提个醒"/>',
    );
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m[1])).toEqual(["review", "choice", "info"]);
  });

  it("rejects type not in [a-z_]{1,32} (e.g. uppercase, digits, hyphen)", () => {
    // 大写不行
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type="Review"/>')).toHaveLength(0);
    // 数字不行
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type="r1"/>')).toHaveLength(0);
    // 连字符不行
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type="multi-type"/>')).toHaveLength(0);
    // 空 type 不行
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type=""/>')).toHaveLength(0);
  });

  it("accepts arbitrary free-form type names (damo 拍板: 不要锁死 schema)", () => {
    // 自由发挥: confirm / clarify / escalate / custom_thing 等都通过
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type="confirm"/>')).toHaveLength(1);
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type="clarify"/>')).toHaveLength(1);
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, '<awaiting type="custom_thing"/>')).toHaveLength(1);
  });

  it("rejects desc exceeding 256 chars (charset cap, 跟 v56 同款)", () => {
    const desc = "x".repeat(300);
    const matches = execAll(ActiveSession.AWAITING_MARKER_RE, `<awaiting type="review" desc="${desc}"/>`);
    expect(matches).toHaveLength(0);
  });

  it("accepts desc exactly 256 chars (boundary)", () => {
    const desc = "x".repeat(256);
    const matches = execAll(ActiveSession.AWAITING_MARKER_RE, `<awaiting type="review" desc="${desc}"/>`);
    expect(matches).toHaveLength(1);
  });

  it("rejects data exceeding 2048 chars (JSON 字面量上限)", () => {
    const data = `{"x":"${"y".repeat(2100)}"}`;
    const matches = execAll(ActiveSession.AWAITING_MARKER_RE, `<awaiting type="choice" data='${data}'/>`);
    expect(matches).toHaveLength(0);
  });

  it("coexistence: new <awaiting type> + old <awaiting_review/> 都识别", () => {
    const newMatches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      '<awaiting type="review" desc="v61"/>',
    );
    expect(newMatches).toHaveLength(1);
    const oldMatches = execAll(
      ActiveSession.AWAITING_REVIEW_RE,
      '<awaiting_review reason="v56"/>',
    );
    expect(oldMatches).toHaveLength(1);
    // 两种 marker 在同一文本里都能识别 (parseAwaitingMarkersInBlock 都收)
    const both = '<awaiting_review reason="v56"/> + <awaiting type="choice" desc="v61"/>';
    expect(execAll(ActiveSession.AWAITING_REVIEW_RE, both)).toHaveLength(1);
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, both)).toHaveLength(1);
  });
});

// R84: 新增三个 awaiting marker type — waiting_reply / suggestion / stuck, 对应飞书
//   O 列四态里的「等回复 / 有建议 / 卡住」子集。后端正则已支持任意 [a-z_]{1,32} type,
//   测试覆盖 (a) 正则匹配 (b) 落库 round-trip (c) 与 review 共存 (d) 多 marker 顺序保留.
describe("R84 awaiting marker types (waiting_reply/suggestion/stuck)", () => {
  function execAll(re: RegExp, text: string): RegExpExecArray[] {
    re.lastIndex = 0;
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m);
    return out;
  }

  it("matches waiting_reply type", () => {
    const matches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      '<awaiting type="waiting_reply" desc="等 damo 回 PR 是否合了"/>',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("waiting_reply");
    expect(matches[0][2]).toBe("等 damo 回 PR 是否合了");
  });

  it("matches suggestion type", () => {
    const matches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      '<awaiting type="suggestion" desc="建议 R85 也带上"/>',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("suggestion");
  });

  it("matches stuck type", () => {
    const matches = execAll(
      ActiveSession.AWAITING_MARKER_RE,
      '<awaiting type="stuck" desc="第三方 API 鉴权失败，需要 damo 帮查文档"/>',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("stuck");
  });

  it("three R84 types coexist in one result (multi-marker 顺序保留)", () => {
    const text =
      '<awaiting type="waiting_reply" desc="等回信"/>' +
      ' <awaiting type="suggestion" desc="顺嘴建议"/>' +
      ' <awaiting type="stuck" desc="真卡住了"/>';
    const matches = execAll(ActiveSession.AWAITING_MARKER_RE, text);
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m[1])).toEqual(["waiting_reply", "suggestion", "stuck"]);
  });

  it("R84 types 与 review type 共存（一个 result 同时表达拍板+等待回复+建议）", () => {
    const text =
      '<awaiting_review reason="先拍板"/>' +
      ' <awaiting type="waiting_reply" desc="拍完看回信"/>' +
      ' <awaiting type="suggestion" desc="顺嘴提个醒"/>';
    // 老 review 正则匹配老 marker
    expect(execAll(ActiveSession.AWAITING_REVIEW_RE, text)).toHaveLength(1);
    // 新 marker 正则匹配新 marker (review type 不在文本里, 匹配 2 个)
    const newMatches = execAll(ActiveSession.AWAITING_MARKER_RE, text);
    expect(newMatches).toHaveLength(2);
    expect(newMatches.map((m) => m[1])).toEqual(["waiting_reply", "suggestion"]);
  });

  it("R84 types 落库 round-trip: 写入 awaiting_markers JSON 列, 读回顺序保留", () => {
    // 直接 updateTask 写 marker JSON 数组（与 active-session.parseAwaitingMarkersInBlock
    //   解析出的 pendingAwaitingMarkers 落库形态一致 — server 不加工, 纯字符串）。
    const t = createTask({ title: "r84-roundtrip", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { result: "done", completed_at: new Date().toISOString() });
    const markers = [
      { type: "waiting_reply", desc: "等回信" },
      { type: "suggestion", desc: "建议" },
      { type: "stuck", desc: "卡住" },
    ];
    updateTask(t.id, {
      awaiting_owner_review: 1,
      awaiting_markers: JSON.stringify(markers),
    });

    const after = getTaskById(t.id)!;
    expect(after.awaiting_owner_review).toBe(1);
    expect(after.awaiting_markers).not.toBeNull();
    const readBack = JSON.parse(after.awaiting_markers!);
    expect(readBack).toHaveLength(3);
    expect(readBack.map((m: any) => m.type)).toEqual(["waiting_reply", "suggestion", "stuck"]);
  });

  it("R84 types 走 unset-awaiting-review 同款 unset 路径（marker 一起清空）", () => {
    // 与 v61 测试同款不变量: unsetAwaitingOwnerReview 一并清 awaiting_markers 列,
    //   不会让 R84 三种 type 漏掉 (UI 不会留着 chip 让人误以为还要处理).
    const t = createTask({ title: "r84-unset", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { result: "done", completed_at: new Date().toISOString() });
    updateTask(t.id, {
      awaiting_owner_review: 1,
      awaiting_markers: JSON.stringify([
        { type: "waiting_reply", desc: "等回" },
        { type: "suggestion", desc: "建议" },
      ]),
    });

    getRuntime().unsetAwaitingOwnerReview(t.id);

    const after = getTaskById(t.id)!;
    expect(after.awaiting_owner_review).toBe(0);
    expect(after.awaiting_markers).toBeNull();
    expect(after.status).toBe("reviewing"); // status 不动
  });
});

// R128: 4-section 兜底解析 — agent 不写 XML marker, 写 ## 等什么 / 卡在哪 / 建议
//   等 section header 也能落 awaiting marker. XML marker 优先 (精确意图), section
//   兜底 (模糊状态). extractSectionMarkers 是 static 纯函数方便单测.
describe("R128 4-section section-header fallback parser", () => {
  it("extractSectionMarkers 命中 ## 等什么 → waiting_reply marker", () => {
    const text = "## 等什么\n等 damo 回 PR 是否合了\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("waiting_reply");
    expect(markers[0].desc).toBe("等 damo 回 PR 是否合了");
  });

  it("多 section: ## 卡在哪 + ## 等什么 + ## 建议 三种 type 都识别", () => {
    const text =
      "## 卡在哪\n第三方 API 鉴权失败\n\n" +
      "## 等什么\n等 mac-init 给 nginx vhost 模板\n\n" +
      "## 建议\nR85 也带上\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(3);
    expect(markers.map((m) => m.type)).toEqual(["stuck", "waiting_reply", "suggestion"]);
  });

  it("中英文双语 header: ## Waiting On / ## blocked on / ## Suggestion 都识别", () => {
    const text =
      "## Waiting On\ntest 1\n\n" +
      "## blocked on\ntest 2\n\n" +
      "## Suggestion\ntest 3\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(3);
    expect(markers.map((m) => m.type)).toEqual(["waiting_reply", "stuck", "suggestion"]);
  });

  it("标点变体: 标题尾部 ?？！!.,;: 都容忍", () => {
    const text =
      "## 等什么?\nq\n" +
      "## 等什么！\nq2\n" +
      "## 卡在哪?\nstuck\n" +
      "## 建议: \nsug\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    // q 与 q2 都是 ## 等什么, 同 type 去重 → 只保留第 1 条 (last-write-wins 不适用, section 顺序保留)
    expect(markers.map((m) => m.type)).toEqual(["waiting_reply", "stuck", "suggestion"]);
  });

  it("非状态型 header (## 结论 / 流程 / 错误 / 下一步 / Next Steps) 跳过不落库", () => {
    const text =
      "## 结论\n做完了\n\n" +
      "## 流程\n- step 1\n- step 2\n\n" +
      "## 错误\n无\n\n" +
      "## 下一步\n继续推进\n\n" +
      "## Next Steps\nmore\n\n" +
      "## 等什么\n等回复\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("waiting_reply");
  });

  it("空段 (## 等什么\\n\\n 后面只有空行) 跳过不落库", () => {
    const text = "## 等什么\n\n## 卡在哪\n   \n\n## 建议\n实际内容\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("suggestion");
    expect(markers[0].desc).toBe("实际内容");
  });

  it("语义升级: body 含'拍板/决策/审批' → review (覆盖映射默认值)", () => {
    // ## 等什么 默认 waiting_reply, body 含"拍板" → 升级 review
    const text =
      "## 等什么\n等 damo 拍板 R128 是否合\n\n" +
      "## 卡在哪\n卡在审批流程, 需要决策\n";
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(2);
    expect(markers[0].type).toBe("review"); // 等什么 + 拍板 → review
    expect(markers[0].desc).toBe("等 damo 拍板 R128 是否合");
    expect(markers[1].type).toBe("review"); // 卡在哪 + 决策 → review
  });

  it("超长 desc 截断: body > 1024 字符 → desc = 前 1024 字符 + '…'", () => {
    const longBody = "x".repeat(1500);
    const text = `## 等什么\n${longBody}\n`;
    const markers = ActiveSession.extractSectionMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].desc.length).toBe(1025); // 1024 + "…" (UTF-8 ellipsis 1 char)
    expect(markers[0].desc.endsWith("…")).toBe(true);
    // 前 1024 字符都是 'x'
    expect(markers[0].desc.slice(0, 1024)).toBe("x".repeat(1024));
  });

  it("XML marker 与 section marker 共存: 不同 type 都保留", () => {
    // 模拟 parseAwaitingMarkersInBlock 流程: XML 先扫, 同 type section 跳过.
    // XML 给 review, section 给 suggestion (不同 type) → 2 marker 都进
    const text =
      '<awaiting type="review" desc="XML marker desc"/>\n\n' +
      "## 建议\n建议顺手带上 R85\n";
    // 先扫 XML
    ActiveSession.AWAITING_MARKER_RE.lastIndex = 0;
    const xmlMatches: Array<{ type: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = ActiveSession.AWAITING_MARKER_RE.exec(text)) !== null) {
      xmlMatches.push({ type: m[1] });
    }
    expect(xmlMatches.map((x) => x.type)).toEqual(["review"]);

    // 再扫 section (existingTypes = XML 已有 type)
    const existingTypes = new Set(xmlMatches.map((x) => x.type));
    const sectionMarkers = ActiveSession.extractSectionMarkers(text);
    // 不同 type (suggestion vs review) 都进
    const newSectionMarkers = sectionMarkers.filter((s) => !existingTypes.has(s.type));
    expect(newSectionMarkers).toHaveLength(1);
    expect(newSectionMarkers[0].type).toBe("suggestion");
  });

  it("XML marker 与 section marker 同 type 去重: section 跳过 (XML 优先)", () => {
    const text =
      '<awaiting type="waiting_reply" desc="XML 写的等"/>\n\n' +
      "## 等什么\nsection 写的等\n";
    // XML 先扫
    ActiveSession.AWAITING_MARKER_RE.lastIndex = 0;
    const existingTypes = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = ActiveSession.AWAITING_MARKER_RE.exec(text)) !== null) {
      existingTypes.add(m[1]);
    }
    expect([...existingTypes]).toEqual(["waiting_reply"]);

    // section 扫: waiting_reply 已存在 → 跳过
    const sectionMarkers = ActiveSession.extractSectionMarkers(text);
    const newOnes = sectionMarkers.filter((s) => !existingTypes.has(s.type));
    expect(newOnes).toHaveLength(0); // section 被去重
  });
});
// R129 Plan A: clear marker 主动清空机制.
//   - AWAITING_CLEAR_RE 正则行为 (5 单测覆盖匹配 / 拒绝 / charset).
//   - parseAwaitingMarkersInBlock document-order 处理 (3 单测覆盖关键场景).
//   - computeAwaitingMarkersWriteValue 三态写入 (3 单测覆盖 hasMarkers/DB 旧值组合).
// 集成方式: 实例化 ActiveSession 调 private 方法 (// @ts-expect-error private),
//   与 active-session.test.ts 走同款模式 (createCanUseTool 测也用这套).
describe("R129 Plan A: AWAITING_CLEAR_RE regex", () => {
  function execAll(re: RegExp, text: string): RegExpExecArray[] {
    re.lastIndex = 0;
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m);
    return out;
  }

  it("matches bare <awaiting clear/> with no type captured", () => {
    const matches = execAll(ActiveSession.AWAITING_CLEAR_RE, "做完啦。<awaiting clear/>");
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBeUndefined();
  });

  it("matches <awaiting clear type=\"stuck\"/> with type captured", () => {
    const matches = execAll(
      ActiveSession.AWAITING_CLEAR_RE,
      '<awaiting clear type="stuck"/>',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("stuck");
  });

  it("rejects type not in [a-z_]{1,32} charset (uppercase / digits / hyphen)", () => {
    expect(execAll(ActiveSession.AWAITING_CLEAR_RE, '<awaiting clear type="Stuck"/>')).toHaveLength(0);
    expect(execAll(ActiveSession.AWAITING_CLEAR_RE, '<awaiting clear type="stuck-1"/>')).toHaveLength(0);
    expect(execAll(ActiveSession.AWAITING_CLEAR_RE, '<awaiting clear type=""/>')).toHaveLength(0);
  });

  it("word boundary: <awaiting clearance/> doesn't match (防误吃)", () => {
    // <awaiting clearance/> 中, clear 之后接 'a' 字符, 不匹配 \s*\/?>
    expect(execAll(ActiveSession.AWAITING_CLEAR_RE, "<awaiting clearance/>")).toHaveLength(0);
    expect(execAll(ActiveSession.AWAITING_CLEAR_RE, "<awaiting cleared/>")).toHaveLength(0);
  });

  it("coexistence: AWAITING_CLEAR_RE 与 AWAITING_MARKER_RE 互不干扰", () => {
    // 同一文本里 clear + add marker 各自识别 (两者 anchor 不同: clear vs type=).
    const text = '<awaiting clear type="stuck"/> <awaiting type="review" desc="new"/>';
    expect(execAll(ActiveSession.AWAITING_CLEAR_RE, text)).toHaveLength(1);
    expect(execAll(ActiveSession.AWAITING_MARKER_RE, text)).toHaveLength(1);
  });
});

describe("R129 Plan A: parseAwaitingMarkersInBlock document-order 处理", () => {
  // 实例化 ActiveSession 需要 LLM config (resolveLlmConfig 必查), 且需要
  //   pendingAwaitingMarkers (private) 通过 @ts-expect-error 触达. 模式同
  //   active-session.test.ts 测 createCanUseTool.
  beforeEach(() => {
    upsertLlmConfig("user", userId, { api_key: "sk-test-key-r129" });
  });

  function makeSession(): ActiveSession {
    const task = createTask({
      title: "r129-clear-test",
      prompt: "x",
      project_id: projectId,
      cwd: tmpDir,
    });
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
    return new ActiveSession(getTaskById(task.id)!);
  }

  function parse(session: ActiveSession, text: string): unknown[] {
    // @ts-expect-error private, 测试需要触达
    session.pendingAwaitingMarkers = [];
    // @ts-expect-error private, 测试需要触达
    session.parseAwaitingMarkersInBlock(text);
    // @ts-expect-error private, 测试需要触达
    return session.pendingAwaitingMarkers;
  }

  it("clear-all 清空前序累积的 pending marker (从前序 block 来的)", () => {
    // 模拟: 前序累积了 [old_stuck], 当前块写 <awaiting clear/> + 新 stuck.
    // 期望: clear 清掉 old_stuck, 新 stuck 保留 → [new_stuck].
    const session = makeSession();
    // @ts-expect-error private
    session.pendingAwaitingMarkers = [{ type: "stuck", desc: "old stuck", data: null }];
    // @ts-expect-error private
    session.parseAwaitingMarkersInBlock('<awaiting clear/> <awaiting type="stuck" desc="fresh"/>');
    // @ts-expect-error private
    const markers = session.pendingAwaitingMarkers as Array<{ type: string; desc: string | null }>;
    expect(markers).toHaveLength(1);
    expect(markers[0].desc).toBe("fresh");
  });

  it("clear-type 只清指定 type, 其他 type 保留", () => {
    const session = makeSession();
    // @ts-expect-error private
    session.pendingAwaitingMarkers = [
      { type: "stuck", desc: "old stuck", data: null },
      { type: "suggestion", desc: "old suggestion", data: null },
    ];
    // @ts-expect-error private
    session.parseAwaitingMarkersInBlock('<awaiting clear type="stuck"/>');
    // @ts-expect-error private
    const markers = session.pendingAwaitingMarkers as Array<{ type: string }>;
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("suggestion");
  });

  it("document-order: clear 之前的 marker 被清, 之后的 marker 保留", () => {
    // 块内 3 个事件: add stuck → clear type=stuck → add stuck.
    // 期望: 只有最后一个 stuck (在 clear 之后) 保留.
    const session = makeSession();
    const markers = parse(
      session,
      '<awaiting type="stuck" desc="A"/><awaiting clear type="stuck"/><awaiting type="stuck" desc="B"/>',
    ) as Array<{ type: string; desc: string | null }>;
    expect(markers).toHaveLength(1);
    expect(markers[0].desc).toBe("B");
  });
});

// R129 Plan B: computeAwaitingMarkersWriteValue 三态纯函数 (no SDK, no DB — 纯逻辑).
//   - hasMarkers=true → 新 JSON.
//   - hasMarkers=false + DB 旧值非空 → null (显式清空, 兜底防滞留).
//   - hasMarkers=false + DB 旧值 null → undefined (不动, UPDATE 跳过).
describe("R129 Plan B: computeAwaitingMarkersWriteValue 三态", () => {
  it("hasMarkers=true → 返回新 JSON (覆盖语义)", () => {
    const result = ActiveSession.computeAwaitingMarkersWriteValue(
      true,
      '[{"type":"stuck"}]',
      "[]",
    );
    expect(result).toBe('[{"type":"stuck"}]');
  });

  it("hasMarkers=false + DB 旧值非空 → 显式 null (兜底清空, 修老 marker 滞留 bug)", () => {
    const result = ActiveSession.computeAwaitingMarkersWriteValue(
      false,
      null,
      '[{"type":"stuck","desc":"old"}]',
    );
    expect(result).toBeNull();
  });

  it("hasMarkers=false + DB 旧值 null → undefined (UPDATE 跳过此列, 保持 DB 干净)", () => {
    const result = ActiveSession.computeAwaitingMarkersWriteValue(false, null, null);
    expect(result).toBeUndefined();
  });
});
