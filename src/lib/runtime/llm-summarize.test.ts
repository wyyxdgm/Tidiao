// R122 T5-A (auto-rename) + Goal-driven loop 阶段 2 实施 (D19):
//   llm-summarize.ts 的「single-turn SDK wrapper」行为契约测试.
//
// 为什么先写这个测试: 阶段 2 任务抽 runSingleTurnLlm() 出来给 goal-grader 共用.
//   summarizeTitle 走的 R122 T5-A fire-and-forget 关键路径 (rule-engine →
//   auto-rename → summarizeTitle) 不能在抽取后行为漂移, 否则会污染 auto-rename
//   全链路. 因此抽取前先固化契约 = 抽取后跑同一份测试必须全过.
//
// 契约 (对应 docs/decisions/2026-08-29-r122-t4-frontend-stats.md §2.1 + llm-summarize.ts
//   头部注释):
//   - cwd = os.tmpdir() 子目录 (orch-summarize-* 前缀), 跑完 finally 清理
//   - allowedTools = [] (显式禁止工具, 防写文件 / 跑命令)
//   - maxTurns = 1 (single-turn, 收一次 result 即停)
//   - env 注入三件套 (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL)
//   - 失败 (SDK 抛错 / result subtype != success / 无 result 文本) → return null
//   - 模型 = config.model || process.env.ANTHROPIC_MODEL (走 task.model 的链路)
//
// 关注点:
//   - 真跑 SDK 子进程太重 (实测 2-5s + token 消耗), mock @anthropic-ai/claude-agent-sdk 的
//     query() 拿 call 选项断言. 这是契约测试, 不验证 SDK 内部行为.
//   - 这层契约 = 抽取 runSingleTurnLlm 后对外承诺的最小集合. 抽取后 summarizeTitle 调它,
//     goal-grader 也调它, 两路调用方共享同一份契约.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// mock SDK query, 不真跑子进程. 用 hoisted 变量存 mock 实例, beforeEach 重置.
const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

// mock resolveLlmConfig: 让「API key 已配」返回固定值, 隔离 DB / 配置链路.
vi.mock("../db/llm-configs", () => ({
  resolveLlmConfig: vi.fn(() => ({
    api_key: "test-api-key",
    base_url: "https://api.test.example/v1",
    model: "claude-haiku-test-model",
  })),
}));

import { summarizeTitle, summarizeTranscriptForGrader } from "./llm-summarize";

type QueryCall = {
  prompt: string;
  options: {
    cwd?: string;
    model?: string;
    allowedTools?: string[];
    maxTurns?: number;
    includePartialMessages?: boolean;
    env?: Record<string, string | undefined>;
  };
};

function captureLastCall(): QueryCall {
  expect(queryMock).toHaveBeenCalledTimes(1);
  const call = queryMock.mock.calls[0]![0] as QueryCall;
  return call;
}

function makeAsyncIterableSuccess(text: string): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true } as const;
          done = true;
          return {
            value: { type: "result", subtype: "success", result: text },
            done: false,
          } as const;
        },
      };
    },
  };
}

function makeAsyncIterableError(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { value: undefined, done: true } as const;
          done = true;
          return {
            value: { type: "result", subtype: "error_max_turns", message: "too many" },
            done: false,
          } as const;
        },
      };
    },
  };
}

beforeEach(() => {
  queryMock.mockReset();
  // 默认 env 兜底 (resolveLlmConfig mock 不依赖 process.env, 但 model fallback 链会读)
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "env-fallback-key";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_MODEL;
});

afterEach(() => {
  // 不强删 process.env (其他测试可能需要), 只清我们设的
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_MODEL;
});

describe("llm-summarize 契约 (R122 T5-A + 阶段 2 runSingleTurnLlm 抽取共用)", () => {
  const task = {
    id: "task-uuid",
    owner_id: "owner-uuid",
    project_id: "project-uuid",
    model: "claude-sonnet-test",
  } as Parameters<typeof summarizeTitle>[0]["task"];

  it("调 SDK 时 cwd = os.tmpdir() 子目录 (orch-summarize-* 前缀)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({
      task,
      promptHead: "把 README 改一下",
      checkpointSummaries: [],
    });
    const call = captureLastCall();
    expect(call.options.cwd).toBeDefined();
    expect(call.options.cwd).toMatch(/^.*\/orch-summarize-[A-Za-z0-9]+$/);
    // cwd 路径前缀必须是 os.tmpdir() (字符串前缀即可, finally 已清目录, 不能再 lstat).
    const tmpRoot = os.tmpdir();
    expect(call.options.cwd!.startsWith(tmpRoot)).toBe(true);
  });

  it("allowedTools = [] (显式禁工具)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.options.allowedTools).toEqual([]);
  });

  it("maxTurns = 1 (single-turn)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.options.maxTurns).toBe(1);
  });

  it("env 注入 ANTHROPIC_API_KEY (走 config.api_key, 不透传 process.env 整包)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.options.env).toBeDefined();
    expect(call.options.env!.ANTHROPIC_API_KEY).toBe("test-api-key");
  });

  it("env 注入 ANTHROPIC_BASE_URL (config.base_url 存在时)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.options.env!.ANTHROPIC_BASE_URL).toBe("https://api.test.example/v1");
  });

  it("env 注入 ANTHROPIC_MODEL (config.model 存在时)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.options.env!.ANTHROPIC_MODEL).toBe("claude-haiku-test-model");
  });

  it("model 选项优先走 config.model (而不是 process.env.ANTHROPIC_MODEL)", async () => {
    process.env.ANTHROPIC_MODEL = "env-model-should-not-be-used";
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok 标题"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.options.model).toBe("claude-haiku-test-model");
  });

  it("finally 清 tmpdir (cwd 在 SDK 调用后被删)", async () => {
    let capturedCwd: string | undefined;
    queryMock.mockImplementationOnce((params: QueryCall) => {
      capturedCwd = params.options.cwd;
      return makeAsyncIterableSuccess("ok 标题");
    });
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(capturedCwd).toBeDefined();
    expect(fs.existsSync(capturedCwd!)).toBe(false);
  });

  it("SDK 返 error_* subtype → 返回 null (caller 回退)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableError());
    const r = await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(r).toBeNull();
  });

  it("SDK 抛异常 → 返回 null (不 throw 给 caller)", async () => {
    queryMock.mockImplementationOnce(() => {
      throw new Error("network 502");
    });
    const r = await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(r).toBeNull();
  });

  it("R182: success result 但 result 是 API Error 文本 → 返 null (别把错误文本当标题)", async () => {
    // 实测 2026-10-04: glm-5.3-flash 撞 429 周配额时 SDK 发 subtype=success 的
    // result, msg.result 即 "API Error: ..." → 旧版把错误文本截 22 字当标题,
    // task c6d50986 / d0e626b0 / 5b338fa2 标题全被写成「API Error: Request re…」.
    queryMock.mockReturnValueOnce(
      makeAsyncIterableSuccess(
        "API Error: Request rejected (429) · You have exceeded the weekly usage quota.",
      ),
    );
    const r = await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(r).toBeNull();
  });

  it("1007: success result 是「Not logged in」失败文本 → 返 null (配额死/无凭据形态)", async () => {
    // 实测 2026-10-07: ark 配置月配额爆掉时 SDK 吐这个前缀, 旧版不认 → 链停在死跳.
    queryMock.mockReturnValueOnce(
      makeAsyncIterableSuccess("Not logged in · Please run /login"),
    );
    const r = await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(r).toBeNull();
  });

  it("result subtype=success + 清洗后返回 ≤ 40 字符标题 (hard cap)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("把 README 改一下"));
    const r = await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(r).toBe("把 README 改一下");
    expect(r!.length).toBeLessThanOrEqual(40);
  });

  it("cleanResultText 行为保留: 剥 markdown / 引号 / 截断到 40 字, 不加省略号 (damo 1007)", async () => {
    // 输入 markdown + 长内容, 验证清洗链路没破 + hard cap 生效
    const long = "a".repeat(80);
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess(`## \`${long}\``));
    const r = await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    expect(r).not.toBeNull();
    expect(r!.startsWith("a")).toBe(true);
    expect(r!.length).toBeLessThanOrEqual(40);
    expect(r!.endsWith("…")).toBe(false);
  });

  it("system prompt 含硬字数约束 + 整段对话要求 (R144)", async () => {
    // R144 反馈: 模型不读列表里的 (1)≤ 60 字, 会写超. 必须开篇强调.
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok"));
    await summarizeTitle({ task, promptHead: "x", checkpointSummaries: [] });
    const call = captureLastCall();
    expect(call.prompt).toBeDefined();
    // user prompt 末尾的「请输出标题 (≤ 36 字符, 一行)」是契约
    expect(call.prompt).toContain("≤ 36 字符");
    expect(call.prompt).toContain("请输出标题");
  });

  it("latestTranscript 透传到 user prompt 的【最近 transcript】段", async () => {
    // R144: 模型要看到整段对话, 不是只看 prompt 开头.
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok"));
    await summarizeTitle({
      task,
      promptHead: "x",
      checkpointSummaries: [],
      latestTranscript: "用户: 帮我修 bug\n助手: 改完了, 加了单元测试",
    });
    const call = captureLastCall();
    expect(call.prompt).toContain("【最近 transcript】");
    expect(call.prompt).toContain("帮我修 bug");
    expect(call.prompt).toContain("加了单元测试");
  });

  it("latestTranscript 为空 / null / undefined 时跳过该段 (无噪音)", async () => {
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok"));
    await summarizeTitle({
      task,
      promptHead: "x",
      checkpointSummaries: ["cp1 summary"],
      latestTranscript: null,
    });
    const call = captureLastCall();
    expect(call.prompt).not.toContain("【最近 transcript】");
    // checkpoint 段仍然存在
    expect(call.prompt).toContain("cp1 summary");
  });

  it("超长 latestTranscript → summarizeTranscriptForGrader 截到 4KB + truncated 标记", async () => {
    // 防御: caller 传整个 SDK transcript 进来, 不能无限膨胀.
    const huge = "a".repeat(8000);
    queryMock.mockReturnValueOnce(makeAsyncIterableSuccess("ok"));
    await summarizeTitle({
      task,
      promptHead: "x",
      checkpointSummaries: [],
      latestTranscript: huge,
    });
    const call = captureLastCall();
    expect(call.prompt).toContain("[truncated: 8000 -> 4096]");
    // prompt 总长不超过一定上限 (粗略估算, 实际比 4096 大但远小于 8000)
    expect(call.prompt!.length).toBeLessThan(8000);
  });
});

// Goal-driven loop 阶段 3 (D20): summarizeTranscriptForGrader (纯字符串 helper,
//   不调 SDK). 简单测 3 件事: 不超长 → 原样; 超长 → 截断 + truncated 标记;
//   非法 maxBytes → 兜底用 4KB.
describe("summarizeTranscriptForGrader (阶段 3, D20)", () => {
  it("不超长 → 原样返回 (无 truncated 标记)", () => {
    const t = "短 transcript, 不到 4KB";
    expect(summarizeTranscriptForGrader(t)).toBe(t);
  });

  it("超长 → 截到 4KB + 末尾追加 truncated 标记", () => {
    const t = "a".repeat(5000);
    const r = summarizeTranscriptForGrader(t);
    expect(r.length).toBeLessThanOrEqual(5000);
    // 前 4KB 字符 = 输入的前 4KB
    expect(r.startsWith("a".repeat(4096))).toBe(true);
    // 末尾 truncated 标记
    expect(r).toContain("[truncated: 5000 -> 4096]");
  });

  it("自定义 maxBytes 生效", () => {
    const t = "a".repeat(200);
    const r = summarizeTranscriptForGrader(t, 100);
    expect(r.startsWith("a".repeat(100))).toBe(true);
    expect(r).toContain("[truncated: 200 -> 100]");
  });

  it("maxBytes ≤ 0 或非数字 → 兜底用 4KB", () => {
    const t = "a".repeat(5000);
    const r1 = summarizeTranscriptForGrader(t, 0);
    expect(r1).toContain("-> 4096");
    const r2 = summarizeTranscriptForGrader(t, -1);
    expect(r2).toContain("-> 4096");
    const r3 = summarizeTranscriptForGrader(t, Number.NaN);
    expect(r3).toContain("-> 4096");
  });

  it("非字符串 transcript → 兜底为空字符串 (不抛)", () => {
    // 防御: caller 拿到非字符串也不应该炸, 应该当空 summary 处理.
    expect(summarizeTranscriptForGrader(undefined as unknown as string)).toBe("");
    expect(summarizeTranscriptForGrader(null as unknown as string)).toBe("");
    expect(summarizeTranscriptForGrader(123 as unknown as string)).toBe("");
  });

  it("正好等于 maxBytes → 原样返回 (边界)", () => {
    const t = "a".repeat(4096);
    expect(summarizeTranscriptForGrader(t)).toBe(t);
  });
});
