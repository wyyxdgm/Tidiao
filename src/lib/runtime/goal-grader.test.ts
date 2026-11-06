// Goal-driven loop 阶段 2 (D19) 单测 — 对齐 plan §9.1 + §9.2 定稿:
//   gradeGoal(input: GoalGradeInput) → GoalGradeResult (5 字段: verdict/reason/
//   model/durationMs/costUsd).
//
// 4 个核心 case:
//   1) met → 返回 met + reason + model/durationMs 元信息
//   2) not_yet_met → 返回 not_yet_met + reason
//   3) impossible → 返回 impossible + reason
//   4) verdict 越界 (typo "meta") → 视为 not_yet_met + reason 标记 invalid + console.warn
// + 抛错 case:
//   - goalText 空 → throw grader_goal_text_empty
//   - SDK 失败 (runSingleTurnLlm 返 null) → throw grader_sdk_failed
//   - JSON 解析失败 (regex 不命中) → throw grader_json_parse_failed
// + 边界:
//   - JSON 在 markdown fence 里 → regex 兜底命中
//   - reason 字段为空 → 兜底 "(no reason provided)"
//   - reason 超 80 字 → 截断到 80 字 (§9.1 prompt 字面约束)
//   - getGoalGraderModel 调用 1 次 + runSingleTurnLlm 拿到 model id
// 🆕 D26 P0 凭证注入 (3 个新 case):
//   - 正常凭证 → gradeGoal 成功 + envOverrides 含 ANTHROPIC_API_KEY
//   - 无 api_key → throw grader_no_api_key (没真跑 LLM)
//   - base_url 透传 → envOverrides 含 ANTHROPIC_BASE_URL
// 🆕 D28 self-report 替代 transcript (3 个新 case):
//   - selfReport 存在 → user prompt 写入 self-report 内容, 不写 transcript
//   - selfReport 空 + transcriptSummary 存在 → user prompt 走 transcript fallback
//   - 两者都空 → user prompt 写入 "(无 self-report 且无对话历史)" 占位
// 阶段 3 active-session 集成时再加「throw 时 caller 视为 not_yet_met 续跑」的
//   端到端断言 (那是 active-session.test.ts 范围).
//
// 测试策略:
//   - mock runSingleTurnLlm (gradeGoal 的唯一 LLM 调用入口) — 不真跑 SDK 子进程.
//   - mock getGoalGraderModel 返固定 model id, 隔离 settings 链路.
//   - mock resolveLlmConfig 返固定 api_key/base_url — D26 必须 mock, 不 mock =
//     走真 DB → 拿不到 → grader_no_api_key → 测试挂.
//   - spy console.warn 捕获越界日志.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runSingleTurnLlmMock = vi.hoisted(() => vi.fn());
const getGoalGraderModelMock = vi.hoisted(() => vi.fn(() => "claude-haiku-test-model"));
const resolveLlmConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./llm-summarize", () => ({
  runSingleTurnLlm: runSingleTurnLlmMock,
}));
vi.mock("../db/settings", () => ({
  getGoalGraderModel: getGoalGraderModelMock,
}));
// D26: mock resolveLlmConfig, 避免跑真 DB. 默认返合法凭证 (api_key + base_url),
//   个别 case 通过 mockResolvedValueOnce 覆盖 (如无 api_key 时返 api_key=undefined).
vi.mock("../db/llm-configs", () => ({
  resolveLlmConfig: resolveLlmConfigMock,
}));

import { gradeGoal, type GoalVerdict } from "./goal-grader";

beforeEach(() => {
  runSingleTurnLlmMock.mockReset();
  getGoalGraderModelMock.mockReset();
  getGoalGraderModelMock.mockReturnValue("claude-haiku-test-model");
  resolveLlmConfigMock.mockReset();
  // 默认返合法凭证 — 现有 4 case 不显式改 resolveLlmConfig, 仍能正常拿 api_key.
  resolveLlmConfigMock.mockReturnValue({
    api_key: "test-api-key",
    base_url: "https://api.anthropic.com",
    model: "claude-haiku-test-model",
    source_config_id: "test-config-id",
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 🆕 D28: VALID_INPUT 加 selfReport 字段. 现有用例 (met/not_yet_met/impossible/越界/
// 凭证/边界) 多数 ...VALID_INPUT 展开, 默认 selfReport 有内容 → 走新 self-report 路径,
// 跟现有断言 (verdict/reason) 兼容.
const VALID_INPUT = {
  goalText: "README 第一段第一个词是 bar",
  selfReport: "done\nWrite README.md\n路径: README.md\n内容: bar 是第一段第一个词",
  transcriptSummary: "改完了, prompt 提到 README 已重写",
  taskId: "task-uuid-1",
  // D26: 现有 4 case 改 input 加 taskModel/taskOwnerId/taskProjectId — 没设 llm_config_id
  //   (走默认 user/project fallback, mock 出来的 config 已满足合法凭证).
  taskModel: "claude-haiku-4-5-20251001",
  taskOwnerId: "user-uuid-1",
  taskProjectId: "project-uuid-1",
};

describe("gradeGoal — 4 case + 抛错 + 边界", () => {
  it("met → 返回 met + reason + model/durationMs/costUsd 元信息", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "README 已成功改完" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("README 已成功改完");
    expect(r.model).toBe("claude-haiku-test-model");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.costUsd).toBe(0); // 阶段 2 占位
  });

  it("not_yet_met → 返回 not_yet_met + reason", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "not_yet_met", reason: "bar 还没出现在第一段" }),
    );
    const r = await gradeGoal({
      goalText: "README 第一段第一个词是 bar",
      selfReport: "not_done\n尝试了 Write 但文件还没保存",
      transcriptSummary: "agent 改到了第三段, 没改第一段",
      taskId: "task-2",
      taskModel: "claude-haiku-4-5-20251001",
      taskOwnerId: "user-uuid-2",
      taskProjectId: "project-uuid-2",
    });
    expect(r.verdict).toBe<GoalVerdict>("not_yet_met");
    expect(r.reason).toBe("bar 还没出现在第一段");
    expect(r.model).toBe("claude-haiku-test-model");
  });

  it("impossible → 返回 impossible + reason", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "impossible", reason: "README 不存在, 无法改" }),
    );
    const r = await gradeGoal({
      goalText: "README 第一段第一个词是 bar",
      selfReport: "impossible\nREADME.md 不存在且无权限创建",
      transcriptSummary: "agent 报告 README.md 文件找不到",
      taskId: "task-3",
      taskModel: "claude-haiku-4-5-20251001",
      taskOwnerId: "user-uuid-3",
      taskProjectId: "project-uuid-3",
    });
    expect(r.verdict).toBe<GoalVerdict>("impossible");
    expect(r.reason).toBe("README 不存在, 无法改");
  });

  it("verdict 越界 (typo 'meta') → 视为 not_yet_met + reason 标记 invalid + console.warn", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "meta", reason: "已改完" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("not_yet_met");
    expect(r.reason).toMatch(/^grader_verdict_invalid: /);
    expect(r.reason).toContain("meta");
    expect(console.warn).toHaveBeenCalledTimes(1);
    const warnMsg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(warnMsg).toContain("task-uuid-1"); // taskId 进了 warn 日志
    expect(warnMsg).toContain("meta");
    expect(warnMsg).toContain("not in");
  });

  it("verdict 越界 (非字符串) → 视为 not_yet_met + console.warn", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: 123, reason: "数字 verdict" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("not_yet_met");
    expect(r.reason).toMatch(/^grader_verdict_invalid: /);
    expect(console.warn).toHaveBeenCalled();
  });

  it("goalText 空 → throw grader_goal_text_empty", async () => {
    await expect(
      gradeGoal({ ...VALID_INPUT, goalText: "" }),
    ).rejects.toThrow(/grader_goal_text_empty/);
    await expect(
      gradeGoal({ ...VALID_INPUT, goalText: "   " }),
    ).rejects.toThrow(/grader_goal_text_empty/);
    // 不该真跑 LLM
    expect(runSingleTurnLlmMock).not.toHaveBeenCalled();
  });

  it("SDK 失败 (runSingleTurnLlm 返 null) → throw grader_sdk_failed", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(null);
    await expect(gradeGoal(VALID_INPUT)).rejects.toThrow(/grader_sdk_failed/);
  });

  it("JSON 解析失败 (regex 不命中) → throw grader_json_parse_failed", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      "模型只返回了一堆解释文字, 没 JSON",
    );
    await expect(gradeGoal(VALID_INPUT)).rejects.toThrow(/grader_json_parse_failed/);
  });

  it("JSON.parse 失败 (抓到 {…} 但内容非法) → throw grader_json_parse_failed", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce('{"verdict": "met", "reason": '); // 不完整
    await expect(gradeGoal(VALID_INPUT)).rejects.toThrow(/grader_json_parse_failed/);
  });

  it("JSON 在 markdown fence 里 → regex 兜底命中 + 解析成功", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      '下面是结果:\n```json\n{"verdict":"met","reason":"OK"}\n```\n结束',
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("OK");
  });

  it("reason 字段为空字符串 → 兜底 ('(no reason provided)')", async () => {
    // regex 必须 verdict + reason 都在 (D6 接口契约); reason 为空串也算字段在.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("(no reason provided)");
  });

  it("reason 超 80 字 → 截断到 80 字 (§9.1 prompt 字面约束)", async () => {
    const longReason = "a".repeat(200);
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: longReason }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.reason.length).toBeLessThanOrEqual(80);
  });

  it("getGoalGraderModel 调用 1 次 + runSingleTurnLlm 拿到 model id + durationMs 元信息正确", async () => {
    getGoalGraderModelMock.mockReturnValueOnce("custom-model-x");
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    const start = Date.now();
    const r = await gradeGoal(VALID_INPUT);
    const end = Date.now();
    expect(getGoalGraderModelMock).toHaveBeenCalledTimes(1);
    expect(runSingleTurnLlmMock).toHaveBeenCalledTimes(1);
    expect(runSingleTurnLlmMock.mock.calls[0]![2]).toBe("custom-model-x");
    // durationMs 应在 [0, end-start] 范围内 (不可能 > end-start, 至少 = 0).
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.durationMs).toBeLessThanOrEqual(end - start + 5); // 5ms 余量
    expect(r.model).toBe("custom-model-x");
  });

  it("transcriptSummary 为空字符串 → user prompt 走 self-report (D28 改主依据)", async () => {
    // 🆕 D28: self-report 为主依据. transcriptSummary 空 + selfReport 有内容
    //   → user prompt 只写 self-report, 不写 "(无对话历史)" 占位.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    await gradeGoal({ ...VALID_INPUT, transcriptSummary: "" });
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    expect(userPrompt).toContain("Agent 自我报告");
    expect(userPrompt).toContain("done");
    expect(userPrompt).not.toContain("(无对话历史)");
  });

  // ===== 🆕 D26 P0 凭证注入 =====

  it("D26: 正常凭证 → gradeGoal 成功 + envOverrides 含 ANTHROPIC_API_KEY", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    resolveLlmConfigMock.mockReturnValueOnce({
      api_key: "sk-test-real-key",
      base_url: "https://api.anthropic.com",
      model: "claude-haiku-4-5-20251001",
      source_config_id: "test-config-1",
    });
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("ok");
    // resolveLlmConfig 被调 1 次, 传入 taskModel/taskOwnerId/taskProjectId
    expect(resolveLlmConfigMock).toHaveBeenCalledTimes(1);
    expect(resolveLlmConfigMock.mock.calls[0]![0]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      owner_id: "user-uuid-1",
      project_id: "project-uuid-1",
    });
    // runSingleTurnLlm 拿到 model id + envOverrides 含 ANTHROPIC_API_KEY
    expect(runSingleTurnLlmMock).toHaveBeenCalledTimes(1);
    const callArgs = runSingleTurnLlmMock.mock.calls[0]!;
    expect(callArgs[2]).toBe("claude-haiku-test-model"); // grader 走 getGoalGraderModel
    const envOverrides = callArgs[3] as Record<string, string | undefined>;
    expect(envOverrides.ANTHROPIC_API_KEY).toBe("sk-test-real-key");
    expect(envOverrides.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("D26: 无 api_key → throw grader_no_api_key + 不调 LLM", async () => {
    resolveLlmConfigMock.mockReturnValueOnce({
      api_key: undefined, // 用户没配 key — D26 边界
      base_url: undefined,
      model: null,
      source_config_id: null,
    });
    await expect(gradeGoal(VALID_INPUT)).rejects.toThrow(/grader_no_api_key/);
    // 不该真跑 LLM — 没 key 就别去试 SDK, 直接 fail-fast 让 caller 当 not_yet_met.
    expect(runSingleTurnLlmMock).not.toHaveBeenCalled();
  });

  it("D26: base_url 透传 → envOverrides 含 ANTHROPIC_BASE_URL", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    resolveLlmConfigMock.mockReturnValueOnce({
      api_key: "sk-test-key",
      base_url: "https://custom-proxy.example.com", // 非默认 base_url, 验证透传
      model: "claude-haiku-4-5-20251001",
      source_config_id: "test-config-custom",
    });
    await gradeGoal(VALID_INPUT);
    const callArgs = runSingleTurnLlmMock.mock.calls[0]!;
    const envOverrides = callArgs[3] as Record<string, string | undefined>;
    expect(envOverrides.ANTHROPIC_API_KEY).toBe("sk-test-key");
    expect(envOverrides.ANTHROPIC_BASE_URL).toBe("https://custom-proxy.example.com");
  });

  it("D26: base_url 为空 → envOverrides 不含 ANTHROPIC_BASE_URL", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    resolveLlmConfigMock.mockReturnValueOnce({
      api_key: "sk-test-key",
      base_url: undefined, // 用户没设 base_url, 不要写 undefined 字符串进 env
      model: "claude-haiku-4-5-20251001",
      source_config_id: "test-config-no-url",
    });
    await gradeGoal(VALID_INPUT);
    const callArgs = runSingleTurnLlmMock.mock.calls[0]!;
    const envOverrides = callArgs[3] as Record<string, string | undefined>;
    expect(envOverrides.ANTHROPIC_API_KEY).toBe("sk-test-key");
    expect("ANTHROPIC_BASE_URL" in envOverrides).toBe(false);
  });

  // ===== 🆕 D28: self-report 替代 transcriptSummary 作主依据 =====

  it("D28: selfReport 存在 → user prompt 写入 self-report 内容, 不依赖 transcript", async () => {
    // 主依据. grader 应该看到 selfReport 的 done + 内容, 不是 transcript.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "自报告 done 且内容匹配" }),
    );
    const selfReport =
      "done\nWrite docs/case.md\n路径: docs/case.md\n内容: 第一行=bar 是第一段第一个词";
    await gradeGoal({
      ...VALID_INPUT,
      selfReport,
      transcriptSummary: "不应该被看到的旧 transcript 内容",
    });
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    // self-report 内容在 prompt 里
    expect(userPrompt).toContain("Agent 自我报告");
    expect(userPrompt).toContain("done");
    expect(userPrompt).toContain("Write docs/case.md");
    expect(userPrompt).toContain("docs/case.md");
    // 不该出现 transcript fallback 标签
    expect(userPrompt).not.toContain("对话历史摘要");
    // 不该出现 transcript 内容
    expect(userPrompt).not.toContain("不应该被看到的旧 transcript 内容");
  });

  it("D28: selfReport 空 + transcriptSummary 存在 → user prompt 走 transcript fallback", async () => {
    // D28: self-report 缺失时, transcript 仍作 fallback (旧 D27 路径).
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "not_yet_met", reason: "信息不足" }),
    );
    await gradeGoal({
      ...VALID_INPUT,
      selfReport: "",
      transcriptSummary: "agent 刚启动还没动作",
    });
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    expect(userPrompt).toContain("对话历史摘要");
    expect(userPrompt).toContain("agent 刚启动还没动作");
    // 不该出现 self-report 标签
    expect(userPrompt).not.toContain("Agent 自我报告");
  });

  it("D28: selfReport + transcriptSummary 都空 → '(无 self-report 且无对话历史)' 占位", async () => {
    // D13 不对称兜底保留: 信息不足 → not_yet_met. 占位文本明确告诉模型两边都没.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "not_yet_met", reason: "信息不足" }),
    );
    await gradeGoal({
      ...VALID_INPUT,
      selfReport: "",
      transcriptSummary: undefined,
    });
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    expect(userPrompt).toContain("(无 self-report 且无对话历史)");
  });

  it("D28: selfReport 是空白字符 → 视为空, 走 transcript fallback", async () => {
    // 空白字符 trim 后视为空 (跟 transcriptSummary 处理同款).
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "not_yet_met", reason: "信息不足" }),
    );
    await gradeGoal({
      ...VALID_INPUT,
      selfReport: "   \n  ",
      transcriptSummary: "有 transcript",
    });
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    expect(userPrompt).toContain("对话历史摘要");
    expect(userPrompt).toContain("有 transcript");
  });

  it("D28: SYSTEM_PROMPT 提及 self-report 判定依据 (含 done/not_done/impossible + 缺失 fallback)", async () => {
    // 验证 SYSTEM_PROMPT 文本包含 4 条判定原则 + 提到 self-report 而非 transcript.
    // 直接读 prompt: 调用 runSingleTurnLlm 时 system prompt 是第一个参数.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    await gradeGoal(VALID_INPUT);
    const systemPrompt = runSingleTurnLlmMock.mock.calls[0]![0] as string;
    expect(systemPrompt).toContain("self-report");
    expect(systemPrompt).toContain("done");
    expect(systemPrompt).toContain("not_done");
    expect(systemPrompt).toContain("impossible");
    expect(systemPrompt).toContain("D28");
    expect(systemPrompt).toContain("transcript");
  });

  it("D28: transcriptSummary 可选 (TypeScript 类型允许省略)", async () => {
    // 编译期类型检查 = 测的是接口契约. 这里通过显式 undefined 验证省略也能调通.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "ok" }),
    );
    await gradeGoal({
      goalText: VALID_INPUT.goalText,
      selfReport: "done",
      taskId: VALID_INPUT.taskId,
      taskModel: VALID_INPUT.taskModel,
      taskOwnerId: VALID_INPUT.taskOwnerId,
      taskProjectId: VALID_INPUT.taskProjectId,
      // transcriptSummary 故意省略, selfReport 非空时不会触发 fallback
    });
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    expect(userPrompt).toContain("Agent 自我报告");
    expect(userPrompt).not.toContain("对话历史摘要");
  });

  // ===== 🆕 D29: impossible 兜底放宽 (D13 收口) =====
  //   D13 旧兜底 (信息不足 → 一律 not_yet_met) 让 case3 impossible prompt
  //   ("等待永远不会发生的事件 X") 也被判 not_yet_met → 5 轮 → max_rounds →
  //   failed. D29 收紧: 只在 self-report 缺失 + goal 描述明显自相矛盾/物理不
  //   可能时才判 impossible; 反之仍走 not_yet_met (D13 精神保留).
  //   本组 3 个 case 验证 user prompt 文本变化 + 行为端到端断言.

  it("D29: user prompt 包含新的「判断原则」(impossible 严判, 自相矛盾优先)", async () => {
    // 验证 D29 prompt 替换生效 — 关键文案必须存在:
    //   - "证据优先"
    //   - "目标自相矛盾" → impossible 信号
    //   - "impossible 严判" (D13 严判精神)
    //   - "'agent 不会做' 不是 impossible" (反误判护栏)
    //   - D13 兜底保留 ("self-report 缺失 + ... → not_yet_met"), 但措辞收紧
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "impossible", reason: "目标自相矛盾" }),
    );
    await gradeGoal(VALID_INPUT);
    const userPrompt = runSingleTurnLlmMock.mock.calls[0]![1] as string;
    expect(userPrompt).toContain("证据优先");
    expect(userPrompt).toContain("目标自相矛盾");
    expect(userPrompt).toContain("impossible 严判");
    expect(userPrompt).toContain("agent 不会做");
    // D13 兜底措辞收紧 — 不再用「一律 not_yet_met (宁可多花 5 轮 ...)」 旧红框文案
    expect(userPrompt).not.toContain("宁可多花 5 轮");
  });

  it("D29 集成: 自相矛盾 goal + self-report 缺失 → 判 impossible (case 3 放宽)", async () => {
    // case 3 D28 实证: prompt = "请等待一个永远不会发生的事件 X. <goal>事件 X 已发生</goal>"
    // → grader 拿到 self-report (agent 可能写 impossible 也可能空) + transcript fallback,
    //   但 D13 兜底让 Haiku 永远判 not_yet_met → 5 轮 → failed.
    // D29 放宽: grader 看到 goal 描述「永远不会发生的事件 X 已发生」(自相矛盾) +
    //   判断原则里写明「目标自相矛盾 → impossible 即使 self-report 缺失」 →
    //   grader 真返 impossible (按新 prompt 走).
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({
        verdict: "impossible",
        reason: "目标自相矛盾 (等待永远不会发生的事件 X)",
      }),
    );
    const r = await gradeGoal({
      ...VALID_INPUT,
      goalText: "事件 X 已发生 (事件 X 是永远不会发生的)",
      selfReport: "", // agent 没写 goal_report 块, D28 会走 transcript fallback
      transcriptSummary: "agent 报告: 无法继续, 事件 X 永远不会发生",
    });
    expect(r.verdict).toBe<GoalVerdict>("impossible");
    expect(r.reason).toContain("自相矛盾");
  });

  it("D29 集成: 等不会发生的事件 → impossible (D29 放宽生效)", async () => {
    // case 3 原始 prompt 场景: goal 描述明显自相矛盾 ("永远不会发生的事件 已发生").
    // D29 让 grader 能从 goal 文本本身识别 impossible, 不依赖 self-report 完整性.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({
        verdict: "impossible",
        reason: "goal 描述自相矛盾, 等永远不会发生的事件",
      }),
    );
    const r = await gradeGoal({
      ...VALID_INPUT,
      goalText: "事件 X 已发生",
      selfReport: "impossible\n事件 X 永远不会发生, agent 无法等待",
      transcriptSummary: "agent 推理过程: 事件 X 由 prompt 自定义为不可能",
    });
    expect(r.verdict).toBe<GoalVerdict>("impossible");
  });

  it("D29 集成: 普通 goal + self-report done + 内容匹配 → met", async () => {
    // 回归保护: D29 放宽不影响普通 met 路径. case 1 D28 实证 (5 轮 → failed 根因是
    //   self-report 缺失, 不是 impossible 兜底 — D29 prompt 注入修 self-report 那条).
    //   此处断言 grader 仍能正确判 met (prompt 没改坏).
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "self-report done + 内容匹配" }),
    );
    const r = await gradeGoal({
      ...VALID_INPUT,
      goalText: "README 第一段第一个词是 bar",
      selfReport:
        "done\nWrite README.md\n路径: README.md\n内容: 第一段第一个词是 bar",
    });
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("self-report done + 内容匹配");
  });

  it("D29: 普通 goal + self-report 缺失 + 无 transcript → 仍走 not_yet_met (D13 精神保留)", async () => {
    // D29 收紧的 D13 兜底: 「self-report 缺失 + goal 无明显 impossible 信号」
    //   → not_yet_met (多花几轮, 不可错判 impossible 让 task 永久失败).
    // 模拟 grader 看到这种场景按新 prompt 走 not_yet_met.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "not_yet_met", reason: "信息不足" }),
    );
    const r = await gradeGoal({
      ...VALID_INPUT,
      goalText: "README 第一段第一个词是 bar",
      selfReport: "",
      transcriptSummary: undefined,
    });
    expect(r.verdict).toBe<GoalVerdict>("not_yet_met");
  });

  // ===== 🆕 D30: regex 强制 reason bug 修复 (兼容 grader 简化 JSON 输出) =====
  //   旧 regex 强制 JSON 含 verdict + reason 两字段, 但 grader 收到 self-report
  //   明确信号后输出简化 JSON `{"verdict": "met"}` → 不匹 → 抛 grader_json_parse_failed
  //   → caller 当 not_yet_met → 5 轮 → failed (根因 D29 case1: agent 真写了文件,
  //   仅 grader JSON regex 不匹).
  //   D30 修: regex 只要求 verdict 字段, reason 缺失由 line 240-243 兜底为空串.

  it("D30 case A: 老格式 `{\"verdict\":\"met\",\"reason\":\"...\"}` → 仍能解析 (回归测试)", async () => {
    // 旧 D6 接口契约要求 verdict + reason 同时存在. D30 不能破老格式.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met", reason: "已完成修改" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("已完成修改");
  });

  it("D30 case B: 新格式 `{\"verdict\":\"met\"}` → verdict=met, reason=\"\" (no reason provided)", async () => {
    // 根因 case: grader 收到 self-report 明确 done 信号后输出简化 JSON.
    // 旧 regex 不匹 → 抛错 → 5 轮 → failed. D30 修: 只匹 verdict 字段, reason
    // 缺失兜底 "(no reason provided)".
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "met" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("(no reason provided)");
  });

  it("D30 case C: 新格式 `{\"verdict\":\"not_yet_met\"}` → verdict=not_yet_met", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "not_yet_met" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("not_yet_met");
    expect(r.reason).toBe("(no reason provided)");
  });

  it("D30 case D: 新格式 `{\"verdict\":\"impossible\"}` → verdict=impossible", async () => {
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ verdict: "impossible" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("impossible");
    expect(r.reason).toBe("(no reason provided)");
  });

  it("D30 case E: 多余字段 `{\"goal_met\":true,\"verdict\":\"met\"}` → verdict=met", async () => {
    // D29 case1 grader 实证: 有时输出 `{"goal_met": true, "verdict": "met"}` 等变体
    // (system prompt 没强约束字段名). D30 regex 只要求 verdict 字段, 多余字段不破.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ goal_met: true, verdict: "met" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
  });

  it("D30 case F: 冲突字段 `{\"met\":true,\"verdict\":\"not_yet_met\"}` → verdict=not_yet_met (主依据 verdict)", async () => {
    // 兼容 grader 输出多余字段 + 冲突字段: 解析时主依据 verdict 字段
    // (D30 设计: 「优先信 verdict 字段」). 即使 `met=true` 也不覆盖 verdict.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      JSON.stringify({ met: true, verdict: "not_yet_met" }),
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("not_yet_met");
    expect(r.reason).toBe("(no reason provided)");
  });

  it("D30 case G: 边界值 `{\"verdict\":\"met\"}` (无空格) → 仍匹中", async () => {
    // 测试无空格紧凑 JSON, regex 仍匹中.
    runSingleTurnLlmMock.mockResolvedValueOnce('{"verdict":"met"}');
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("(no reason provided)");
  });

  it("D30 case H: markdown fence `\\n```json\\n{\"verdict\":\"met\"}\\n```\\n` → regex 仍匹中", async () => {
    // grader 输出经常含 markdown fence. 旧 regex 已支持 fence 兜底, D30 修后仍支持.
    runSingleTurnLlmMock.mockResolvedValueOnce(
      '下面是结果:\n```json\n{"verdict": "met"}\n```\n结束',
    );
    const r = await gradeGoal(VALID_INPUT);
    expect(r.verdict).toBe<GoalVerdict>("met");
    expect(r.reason).toBe("(no reason provided)");
  });
});
