import { describe, it, expect } from "vitest";
import {
  formatRequirementId,
  feishuRowToTaskPrompt,
  columnIndexToLetter,
  parseAnnotatedRow,
  splitAnnotatedRows,
  COLUMN_HEADERS,
  ORCHESTRATOR_WRITABLE,
  AGENT_WRITABLE,
  type FeishuRow,
  DEFAULT_COLUMN_MAPPING,
  resolveColumnMapping,
  type ColumnMapping,
} from "./sheets";
import { parseRequirementRow } from "./requirement-id";

// 必须与 active-session.ts 的 CHECKPOINT_RE 保持一致 —— 这里复刻一份，
// 用来证明生成的 prompt 里的 checkpoint marker 真的能被运行时解析到。
// v46: step 接受字符串 tag ([A-Za-z0-9_-]{1,64}), 数字或语义词 (e.g. "final")。
const CHECKPOINT_RE =
  /<checkpoint\s+step="?([A-Za-z0-9_-]{1,64})"?(?:\s+summary="([^"]*)")?\s*\/?>/g;

function makeRow(row: number): FeishuRow {
  return {
    row,
    fields: { module: "订单管理", problem: "导出乱码", expected: "导出正常" },
  };
}

describe("formatRequirementId", () => {
  it("prefixes the version name when present", () => {
    expect(formatRequirementId(12, "v1.6")).toBe("v1.6-R12");
  });

  it("falls back to a bare row id when no version is given", () => {
    // sync 允许只传 project_id（version_id 为空）——此时行为必须与改动前一致。
    expect(formatRequirementId(12, null)).toBe("R12");
    expect(formatRequirementId(12, undefined)).toBe("R12");
    expect(formatRequirementId(12, "   ")).toBe("R12");
  });

  it("slugifies version names that would break commit messages or git log --grep", () => {
    const id = formatRequirementId(12, '预览 版/2 "beta"');
    expect(id).toBe("预览-版-2-beta-R12");
    expect(id).not.toMatch(/[\s/\\"']/);
  });

  it("disambiguates the same row number across versions", () => {
    // 一版一张飞书表后 row 号各自从 1 开始，这是本次改动要解决的碰撞。
    expect(formatRequirementId(12, "v1.5")).not.toBe(formatRequirementId(12, "v1.6"));
  });
});

describe("feishuRowToTaskPrompt", () => {
  it("uses the version-prefixed id in the prompt and checkpoint summary", () => {
    // v42+: prompt 不再硬编码 feat(${reqId}) commit 协议 (那是 anflow Role 的事).
    // 版本前缀现在出现在飞书行标识 + checkpoint summary, 仍可定位.
    const prompt = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo", "v1.6");
    expect(prompt).toContain("**飞书表格行 v1.6-R12**");
    expect(prompt).toContain('summary="v1.6-R12 done"');
  });

  it("keeps the bare id when no version is given", () => {
    const prompt = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo");
    expect(prompt).toContain("**飞书表格行 R12**");
  });

  // 回归测试: prompt 生成的 <checkpoint step=...> marker 必须能被运行时
  // CHECKPOINT_RE 解析。v46 起 step 是字符串 tag (数字或语义词), 数字 step
  // 仍 OK 但允许 `final` 等语义词 —— 反向断言 step 必须是纯数字那条已废。
  it("emits a numeric-step checkpoint marker the runtime regex can still parse", () => {
    const prompt = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo", "v1.6");
    CHECKPOINT_RE.lastIndex = 0;
    const match = CHECKPOINT_RE.exec(prompt);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("12");
    // 版本信息只允许出现在 summary 里
    expect(match![2]).toBe("v1.6-R12 done");
  });

  // v46: 运行时 regex 接受 step=final 等语义词 (数字→1-64 字符 [A-Za-z0-9_-]).
  // prompt 这里没生成语义 step, 但断言"如果生成了也能被解析"——守住退路,
  // 防止哪天 agent 想用 step=final 写完成锚点被静默吃掉。
  // 用 match 而非 test: regex 带 /g 时 test() 会改 lastIndex, 跨断言需重置.
  it("runtime regex accepts a semantic step tag (e.g. final)", () => {
    expect('<checkpoint step="final" summary="done" />'.match(CHECKPOINT_RE)).not.toBeNull();
    expect('<checkpoint step=milestone-1 summary="..." />'.match(CHECKPOINT_RE)).not.toBeNull();
    // 仍拒绝非法字符 (防止 prompt injection 写入 step 列)
    expect('<checkpoint step="final; DROP TABLE" />'.match(CHECKPOINT_RE)).toBeNull();
    expect('<checkpoint step="" />'.match(CHECKPOINT_RE)).toBeNull();
  });
});

// 这组测试守的是一个真实回归: D6 把 tag 从 `R12` 改成 `v1.6-R12` 后,
// 写回路由和前端按钮里的 /^R\d+$/ 就再也匹配不上了 —— 而且是静默的
// (按钮不渲染 / API 400), 不会有任何报错指向 D6.
describe("parseRequirementRow", () => {
  it("认带版本前缀的 tag(D6 之后新建的 task)", () => {
    expect(parseRequirementRow(["feishu", "v1.6-R12"])).toBe(12);
  });

  it("认裸 tag(D6 之前建的 task, 会长期共存)", () => {
    expect(parseRequirementRow(["feishu", "R12"])).toBe(12);
  });

  it("版本名 slug 自身含 `-` 时仍取末段行号", () => {
    expect(parseRequirementRow(["feishu", "预览-版-2-beta-R7"])).toBe(7);
  });

  it("没有需求点 tag 时返回 null(非飞书 task 不该显示写回按钮)", () => {
    expect(parseRequirementRow(["feishu", "urgent"])).toBeNull();
    expect(parseRequirementRow([])).toBeNull();
  });

  it("formatRequirementId 的输出必须能被 parseRequirementRow 反解回原 row", () => {
    for (const v of ["v1.6", null, "预览 版/2 \"beta\"", ""]) {
      const tag = formatRequirementId(42, v);
      expect(parseRequirementRow([tag])).toBe(42);
    }
  });
});

// 这组测试守的是「prompt 里的列 ≠ damo 实际在用的列」这个 bug.
// 表现形式很坑: writeField 不校验 AGENT_WRITABLE(只校验列名存在), agent 用
// lark-cli 能写任何列 —— 所以写错列不会报错, 只会让 damo 在提炼列看不到东西.
// 实际语义见 docs/plans/requirement-as-entity.md §15.
describe("prompt 的写回列与 damo 实际用法对齐", () => {
  const prompt = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo", "v1.6");

  it("不再硬编码项目名/架构提示 — prompt 是协议层, 项目段在 Role", () => {
    // v42+: prompt 不绑死项目. 检查是否还残留 "anflow" / "CLAUDE.md 提示" 等
    // 项目特定的硬编码. 默认 mapping 里 U.format_hint 提到 [vue],[node],[anflow]
    // 是 damo 配的 default, 项目 A 用 default mapping 时能看到; 配自定义 mapping
    // 时覆盖. 这不是 prompt 硬编码, 是数据层.
    expect(prompt).toContain("你是项目反馈处理 agent。");
    expect(prompt).not.toContain("你是 anflow v1.6"); // 旧版 anflow 身份硬编码已删
    expect(prompt).not.toContain("Read 项目的 CLAUDE.md 了解 anflow"); // 旧版 anflow 架构硬编码已删
    expect(prompt).not.toContain("anflow-v1.6.md"); // 旧版 doc 引用已删
  });

  it("prompt 必须显式告诉 agent 别写 P —— 否则它按旧习惯写 P 就重新触发死循环", () => {
    expect(prompt).toContain("不要写 P 列");
  });

  it("N/L 有内容时必须回填进 prompt, 否则 agent 会重复提问 / 漏掉已认领信息", () => {
    const row: FeishuRow = {
      row: 12,
      fields: { module: "订单", problem: "x", qna: "问: 要不要分页? 答: 要", handler: "alice" },
    };
    const p = feishuRowToTaskPrompt(row, "/tmp/repo", "v1.6");
    expect(p).toContain("要不要分页");
    expect(p).toContain("不要重复提问");
    expect(p).toContain("alice");
  });

  it("N/L 为空时不产生空行噪音", () => {
    expect(prompt).not.toContain("(问答记录");
    expect(prompt).not.toContain("(处理人");
  });
});

// v42+: ColumnMapping 模板化. 这一组测试守住:
//   - DEFAULT_COLUMN_MAPPING 含所有关键列含义
//   - resolveColumnMapping 缺失字段 fallback 到 default
//   - 自定义 mapping 覆盖生效
//   - prompt 按 mapping 渲染 (改 mapping 即改 prompt 内容)
describe("ColumnMapping 模板层 (v42+)", () => {
  it("DEFAULT_COLUMN_MAPPING 覆盖 L/M/N/O/U/V agent 列 + S/T/W/X/Y/Z orchestrator 列", () => {
    const m = DEFAULT_COLUMN_MAPPING;
    // 2026-09-06 R104 重对齐: V=customer_summary 保留 agent 写; T=session_id (orchestrator 镜像).
    // R=reply (damo 写). 没新增 orchestrator 列.
    expect(Object.keys(m.agent_writable).sort()).toEqual(["L", "M", "N", "O", "U", "V"]);
    expect(Object.keys(m.orchestrator_writable).sort()).toEqual(["S", "T", "W", "X", "Y", "Z"]);
  });

  it("resolveColumnMapping(null) 返回 DEFAULT_COLUMN_MAPPING 拷贝", () => {
    const m = resolveColumnMapping(null);
    expect(m.agent_writable.V?.purpose).toBeTruthy();
  });

  it("resolveColumnMapping 损坏 JSON 回落 default 而不抛错", () => {
    const m = resolveColumnMapping("{invalid json");
    expect(m.agent_writable.L?.purpose).toContain("处理人");
  });

  it("resolveColumnMapping 部分配置覆盖, 缺失字段 fallback 到 default", () => {
    const partial = JSON.stringify({
      agent_writable: { V: { purpose: "自定义: 阶段总结" } },
    });
    const m = resolveColumnMapping(partial);
    expect(m.agent_writable.V?.purpose).toBe("自定义: 阶段总结");
    // L 缺失 → fallback default
    expect(m.agent_writable.L?.purpose).toContain("处理人");
  });

  it("prompt 按自定义 mapping 渲染 (改 mapping 即改 agent 看到的指令)", () => {
    const customMapping: ColumnMapping = {
      ...DEFAULT_COLUMN_MAPPING,
      agent_writable: {
        ...DEFAULT_COLUMN_MAPPING.agent_writable,
        V: { purpose: "我的项目: 阶段完成标记" },
      },
    };
    const prompt = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo", "v1.6", customMapping);
    expect(prompt).toContain("阶段完成标记");
    expect(prompt).not.toContain("给甲方的两三句提炼"); // 默认文案被覆盖
  });
});

// F/G(截图)以前被 readRow 读进 fields 却从没拼进 prompt —— agent 一年多来
// 从没见过任何截图, 只处理纯文字版需求. 这组测试守住"读到 = 进 prompt".
// 见 docs/plans/requirement-as-entity.md §16.2
describe("附件/截图进 prompt", () => {
  it("F/G 有内容时必须出现在 prompt 里", () => {
    const row: FeishuRow = {
      row: 12,
      fields: {
        module: "订单",
        problem: "列表错位",
        screenshot_1: "https://feishu.example/img/aaa.png",
        screenshot_2: "第二张图: 手机端截图",
      },
    };
    const p = feishuRowToTaskPrompt(row, "/tmp/repo", "v1.6");
    expect(p).toContain("https://feishu.example/img/aaa.png");
    expect(p).toContain("第二张图: 手机端截图");
    expect(p).toContain("附件/截图 (2 项, 一格一张)");
  });

  it("Z 之后的额外列(damo 往 AA/AB 随意补的图)也要带上", () => {
    const row: FeishuRow = {
      row: 12,
      fields: {
        problem: "x",
        screenshot_1: "img1",
        // readRow 支持超过 Z 之后, 这些键会以列字母形式出现
        AA: "img3",
        AB: "img4",
      },
    };
    const p = feishuRowToTaskPrompt(row, "/tmp/repo", "v1.6");
    expect(p).toContain("img3");
    expect(p).toContain("img4");
    expect(p).toContain("附件/截图 (3 项, 一格一张)");
  });

  it("已知列(如 qna/status)不能被误当成附件", () => {
    const row: FeishuRow = {
      row: 12,
      fields: { problem: "x", qna: "问答内容", status: "running", commit_ids: "abc" },
    };
    const p = feishuRowToTaskPrompt(row, "/tmp/repo", "v1.6");
    expect(p).not.toContain("附件/截图");
  });

  it("无附件时不产生空的附件段", () => {
    const p = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo", "v1.6");
    expect(p).not.toContain("附件/截图");
  });

  it("空白值不计入数量", () => {
    const row: FeishuRow = {
      row: 12,
      fields: { problem: "x", screenshot_1: "img1", screenshot_2: "   " },
    };
    const p = feishuRowToTaskPrompt(row, "/tmp/repo", "v1.6");
    expect(p).toContain("附件/截图 (1 项, 一格一张)");
  });
});

// A1 列字母不是普通 26 进制: A..Z 里没有代表 0 的数字, 所以 Z 的下一个是 AA
// 而不是 BA. 用朴素的 n%26 会在这里错位.
describe("columnIndexToLetter", () => {
  it("单字母边界", () => {
    expect(columnIndexToLetter(0)).toBe("A");
    expect(columnIndexToLetter(25)).toBe("Z");
  });

  it("Z -> AA 的进位(最容易写错的一处)", () => {
    expect(columnIndexToLetter(26)).toBe("AA");
    expect(columnIndexToLetter(27)).toBe("AB");
    expect(columnIndexToLetter(51)).toBe("AZ");
    expect(columnIndexToLetter(52)).toBe("BA");
  });

  it("双字母 -> 三字母的进位", () => {
    expect(columnIndexToLetter(701)).toBe("ZZ");
    expect(columnIndexToLetter(702)).toBe("AAA");
  });

  it("与固定列表对齐: 前 26 个必须等于 COLUMN_HEADERS 的键", () => {
    const keys = Object.keys(COLUMN_HEADERS);
    keys.forEach((k, i) => expect(columnIndexToLetter(i)).toBe(k));
  });
});

// 端到端(解析层): 证明"贴在 AA 之后的图能一路走到 prompt".
// 以前这条链断在两处: readRow 只循环 26 次丢弃超出值 + readRows 的 range 只到 Z.
// 见 docs/plans/requirement-as-entity.md §16.3
describe("parseAnnotatedRow: Z 之后的附件列", () => {
  // 26 个固定列 + 3 个附件列(AA/AB/AC). 一格一张图.
  const row26 = [
    "2026-08-09", "1", "订单管理", "bug", "列表错位", "img-F", "img-G", "希望修好", "",
    "", "P0", "case1", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  ];
  const csv = `[row=12] ${[...row26, "img-AA", "img-AB", "img-AC"].join(",")}`;

  it("AA/AB/AC 以列字母为键进入 fields", () => {
    const { fields } = parseAnnotatedRow(csv);
    expect(fields.AA).toBe("img-AA");
    expect(fields.AB).toBe("img-AB");
    expect(fields.AC).toBe("img-AC");
  });

  it("A-Z 仍按字段名映射, 不受影响", () => {
    const { row, fields } = parseAnnotatedRow(csv);
    expect(row).toBe(12);
    expect(fields.module).toBe("订单管理");
    expect(fields.screenshot_1).toBe("img-F");
  });

  it("F/G + AA/AB/AC 共 5 张图全部进 prompt(端到端)", () => {
    const p = feishuRowToTaskPrompt(parseAnnotatedRow(csv), "/tmp/repo", "v1.6");
    expect(p).toContain("附件/截图 (5 项, 一格一张)");
    for (const img of ["img-F", "img-G", "img-AA", "img-AB", "img-AC"]) {
      expect(p).toContain(img);
    }
  });

  it("附件列按列序排, 不是字符串序(AZ 必须排在 BA 前)", () => {
    const long = [...row26];
    // 补到 AZ(index 51) 和 BA(index 52)
    while (long.length < 51) long.push("");
    const csv2 = `[row=12] ${[...long, "img-AZ", "img-BA"].join(",")}`;
    const { fields } = parseAnnotatedRow(csv2);
    expect(fields.AZ).toBe("img-AZ");
    expect(fields.BA).toBe("img-BA");
    const p = feishuRowToTaskPrompt(parseAnnotatedRow(csv2), "/tmp/repo", "v1.6");
    expect(p.indexOf("img-AZ")).toBeLessThan(p.indexOf("img-BA"));
  });

  it("空的附件格不建键, 不计入张数", () => {
    const csv3 = `[row=12] ${[...row26, "", "img-AB", "  "].join(",")}`;
    const { fields } = parseAnnotatedRow(csv3);
    expect(fields.AA).toBeUndefined();
    expect(fields.AC).toBeUndefined();
    // F/G 各一张 + AB 一张
    const p = feishuRowToTaskPrompt(parseAnnotatedRow(csv3), "/tmp/repo", "v1.6");
    expect(p).toContain("附件/截图 (3 项, 一格一张)");
  });
});

// 多行单元格: 这批测试的形状取自真实的 1.6期 表(实测 70 行里 55 行含多行单元格,
// row=3 在修复前只解出 5 列 / 应 19 列, N/O/S 全丢). 修复前的实现是
// `split("\n").filter(Boolean)` 然后取 lines[0].
describe("splitAnnotatedRows / parseAnnotatedRow: 单元格内含换行", () => {
  // E 列(需求描述)含换行且**含空行** —— 真实表里就是这样, 所以不能 filter(Boolean).
  const multiline = [
    `[row=3] ,,产品详情页,example,"这里加上最新净值日期；`,
    ``,
    `再加上“策略”、“基准指数”；`,
    ``,
    `（+排版）",,,,,J列内容,,,,N列追问内容,1,,,,S列内容`,
  ].join("\n");

  it("按 [row=N] 前缀聚合, 一个真实行只切出一段", () => {
    const segs = splitAnnotatedRows(multiline);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toContain("（+排版）");
  });

  it("🔴 回归: 换行之后的列不再丢失(修复前 N/O/S 全是 undefined)", () => {
    const { row, fields } = parseAnnotatedRow(multiline);
    expect(row).toBe(3);
    // 这三个是 D2(N 问答门)/O(已修复标记)/S(task 追溯) 依赖的列.
    expect(fields.qna).toBe("N列追问内容");
    expect(fields.fixed).toBe("1");
    expect(fields.task_id).toBe("S列内容");
  });

  it("多行单元格的内容完整保留, 含中间的空行", () => {
    const { fields } = parseAnnotatedRow(multiline);
    expect(fields.problem).toContain("这里加上最新净值日期");
    expect(fields.problem).toContain("再加上“策略”");
    expect(fields.problem).toContain("（+排版）");
    // 空行必须保住: filter(Boolean) 会把它吃掉从而把两段粘在一起.
    expect(fields.problem).toContain("\n\n");
  });

  it("多个真实行按前缀各自成段, 续行归属正确", () => {
    const two = `[row=4] a,"x\ny",c\n[row=5] d,e,f`;
    const segs = splitAnnotatedRows(two);
    expect(segs).toHaveLength(2);
    expect(parseAnnotatedRow(segs[0]).fields.serial).toBe("x\ny");
    expect(parseAnnotatedRow(segs[1]).row).toBe(5);
  });

  it("单行读取接口拿到多行时报错, 而不是静默取第一行", () => {
    // 静默取第一行正是本次修掉的行为 —— 宁可炸也不要悄悄少读几列.
    const two = `[row=4] a,b,c\n[row=5] d,e,f`;
    expect(() => parseAnnotatedRow(two)).toThrow(/expected a single row but got 2/);
  });

  it("没有 [row=N] 前缀时仍然报错", () => {
    expect(() => parseAnnotatedRow("just,some,csv")).toThrow(/did not start with \[row=N\]/);
  });
});

// 🔴 这组原本守的是「P 列 diff 死循环」的**结构性**前提, 不是某句文案.
// 死循环成因(requirement-as-entity.md §15.4 与 §14.2 的两条已定结论互斥):
//   P 一列两义(发布日期 + 给甲方的提炼) × P 在 AGENT_WRITABLE ×
//   §15.4 把 P 归为"需求本体 → 应触发 diff"
//   → agent 写 P → diff 认为需求变了 → 派新 task → agent 又写 P → ...
// 2026-08-12 damo 定: 提炼迁到 V(§14.2 空出来备用的列), P 只留发布日期.
// 修法的本质是**集合不相交**: agent 能写的列一律落在 diff 白名单之外,
// 于是死循环从结构上不可能, 而不是靠"解析 P 的日期部分"这种脆弱约定挡住.
//
// 🔴 2026-08-29 damo 「允许所有列」(CLI c583aa9 + 协议层本 commit) 把
// AGENT_WRITABLE 放开到全 26 列 —— 上面的「集合不相交」结构性保护被**退化为
// prompt-only 防护**. 这组测试从「守不变量」改成「记录新状态 + 守住 prompt
// 那条不写 P 的硬编码警告」. 若要恢复结构性保护, 改 writeField 加 P 校验
// (runtime 拦截) —— 但 damo 0829 没授权, 不擅加.
//
// §15.4 的"需求本体"列: 人写、需求变了就该重派. 这是 diff 的显式白名单.
// 注意必须是**显式白名单**而非"排除平台列": L(测试用例)/N(问答) 也是人写的,
// 却不该触发重派 —— damo 在 N 回一句就重派 task 会疯.
const REQUIREMENT_BODY = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "K", "P"];

describe("damo 0829「允许所有列」协议层放开后状态(docs/plans/requirement-as-entity.md §15.5)", () => {
  it("AGENT_WRITABLE 现在含全部 26 列 — damo 0829 拍板, CLI 层 c583aa9 已落地", () => {
    expect(AGENT_WRITABLE.size).toBe(26);
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      expect(AGENT_WRITABLE.has(letter)).toBe(true);
    }
  });

  it("P 列已包含在 AGENT_WRITABLE(死循环结构性保护从 Set 退化为 prompt)", () => {
    expect(AGENT_WRITABLE.has("P")).toBe(true);
    // P 仍在需求本体白名单: 发布日期变更是真实需求变更, 不能踢出 diff.
    expect(REQUIREMENT_BODY).toContain("P");
  });

  it("AGENT_WRITABLE 与需求本体白名单有交集(死循环防护只剩 prompt 层)", () => {
    const overlap = [...AGENT_WRITABLE].filter((c) => REQUIREMENT_BODY.includes(c));
    // 预期就是 REQUIREMENT_BODY 全部 11 列 —— 结构性保护已退化为 prompt 防护.
    expect(overlap.sort()).toEqual([...REQUIREMENT_BODY].sort());
  });

  it("agent 与 orchestrator 的可写列有交集 — damo 0829 接受 agent 写 S/T/W/X/Y/Z 后被覆盖", () => {
    const both = [...AGENT_WRITABLE].filter((c) => ORCHESTRATOR_WRITABLE.has(c));
    expect(both.sort()).toEqual([...ORCHESTRATOR_WRITABLE].sort());
  });

  it("V 仍是 agent 写的「给甲方的提炼」 — 平台不写它(否则覆盖提炼)", () => {
    expect(AGENT_WRITABLE.has("V")).toBe(true);
    expect(ORCHESTRATOR_WRITABLE.has("V")).toBe(false);
  });

  it("V 字段名仍是 customer_summary — 留着 base_commit 会让读取方拿错语义", () => {
    expect(COLUMN_HEADERS.V).toBe("customer_summary");
  });

  // prompt 那条「不要写 P 列」硬编码警告是防护栈的**一层** (不是唯一层):
  //   - partner sheetwatch check_skip_dispatch (partner/scripts/sheetwatch:587)
  //     任务已关闭 + O∈DONE_VALUES → 跳过派发
  //   - DISPATCH_COOLDOWN = 300s 同 hash 不重派
  //   - prompt 硬编码警告 (sheets.ts:525) ← 这是其中一层
  // 守护这一层 prompt 文案, 避免「agent 故意写 P」违反跨项目协作约定.
  it("prompt 仍硬编码「不要写 P 列」警告 —— P 列死循环防护栈的一层", () => {
    const prompt = feishuRowToTaskPrompt(makeRow(12), "/tmp/repo", "v1.6");
    expect(prompt).toContain("不要写 P 列");
    expect(prompt).toContain("写 P 会触发需求变更 diff 重派任务");
  });
});
