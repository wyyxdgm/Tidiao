// Feishu (Lark) Sheets sync layer for orchestrator tasks.
//
// Wraps the `lark-cli` binary (see https://github.com/larksuite/cli) with a
// typed interface that returns per-row Feishu sheet entries, then maps those
// entries to orchestrator task prompts. Also writes back orchestrator
// metadata (S/T/W/X/Y/Z columns) so the Feishu sheet becomes the single source
// of truth for an anflow v1.6 workflow: user input A-I → agent processes →
// orchestrator writes back S/T/W/X/Y/Z + agent writes L/M/N/O/U/V (template层
// DEFAULT_COLUMN_MAPPING 推荐, 协议层 AGENT_WRITABLE damo 0829 已放开 26 列).
//
// Column layout (anflow v1.6 + orchestrator extension):
//   A feedback_date      - user
//   B serial             - user
//   C module              - user
//   D type                - user (bug/optimization/...)
//   E problem             - user
//   F screenshot_1        - user
//   G screenshot_2        - user
//   H expected            - user (what the user wants)
//   I ai_supplement       - AI read-only context
//   J memo                - user (备注, damo/AI 都可以写)
//   K priority            - user
//   L handler             - AI write (处理人, damo 认领时填或 AI 自动补充)
//   M result              - AI write (处理结果, 完成后简述怎么做的)
//   N qna                 - AI 与 damo/甲方多轮问答现场; **清空 = 疑问归零可执行**
//   O fixed               - AI write (0/1)
//   P release             - **只留发布日期**(damo 写, 可触发 diff)
//                            damo 0829 协议层放开后 agent 也可写 P, 但 prompt 硬编码
//                            「不要写 P 列」(sheets.ts:525) 防 §15.5 死循环.
//   Q test_passed         - 人工测试反馈
//   R reply               - damo 写 (damo 在飞书上的回复/追问现场)
//                            damo 二次澄清 (2026-09-06): "R 就是我的回复", session_id 不在 R.
//   S task_id             - orchestrator write (this task's DB id).
//                            damo 0829 后 agent 也可写, 但 orchestrator 写回覆盖.
//   T session_id          - orchestrator write (SDK session UUID 镜像, 可从 DB tasks.session_id 反查).
//                            damo 二次澄清 (2026-09-06): session_id 在 T 列.
//                            damo 0829 后 agent 也可写, 但 orchestrator 写回覆盖.
//   U commit_ids          - AI write ([vue,node,anflow] CSV)
//   V customer_summary    - **AI 写给甲方的两三句提炼** (2026-08-12 从 P 迁来, 保留)
//                            damo 二次澄清 (2026-09-06): 给甲方的提炼保留在 V, 不要改回 base_commit.
//   W head_commit         - orchestrator write (HEAD at task end).
//                            damo 0829 后 agent 也可写, 但 orchestrator 写回覆盖.
//   X forks               - orchestrator write (count of derived tasks).
//                            damo 0829 后 agent 也可写, 但 orchestrator 写回覆盖.
//   Y checkpoints         - orchestrator write (count of checkpoints).
//                            damo 0829 后 agent 也可写, 但 orchestrator 写回覆盖.
//   Z status              - orchestrator write (DB task status).
//                            damo 0829 后 agent 也可写, 但 orchestrator 写回覆盖.
//
// 2026-09-06 按 R104 spec 重对齐: J=note_for_customer→memo, L=owner→handler,
//   M=effort_hours→result. (R/T/V 不动: damo 二次澄清 R=reply/T=session_id/
//   V=customer_summary 与 08-12 当前现状一致). 撤销 77bd54c (08-10 L 漂移 + J 弃用)
// 三个决策中 J/L 两处.

import { runLarkCli } from "./lark-cli";
import { formatRequirementId } from "./requirement-id";

// 需求点 ID 的生成/反解住在 requirement-id.ts(纯函数, 无 node 依赖, 前端可 import).
// 这里 re-export 是为了让既有的 `from "@/lib/feishu/sheets"` 导入继续可用.
export { formatRequirementId, parseRequirementRow } from "./requirement-id";

// Hardcoded fallbacks — used only when no sheetUrl/sheetName is passed.
// Preferred path: callers should look up the Version's bound sheet config
// (via getSheetConfigFromVersion in src/lib/db/versions.ts) and pass it
// explicitly so the correct sheet is used per project/version.
const DEFAULT_SHEET_URL = "https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d";
const DEFAULT_SHEET_NAME = "Sheet2";

// Column letter → field name. Order matters: must align with the A1
// column index (A=1, B=2, ..., Z=26). Used by readRow to assign values
// to their fields without relying on comma-position arithmetic.
const COLUMN_HEADERS: Record<string, string> = {
  A: "feedback_date",
  B: "serial",
  C: "module",
  D: "type",
  E: "problem",
  F: "screenshot_1",
  G: "screenshot_2",
  H: "expected",
  I: "ai_supplement",
  J: "memo",
  K: "priority",
  L: "handler",
  M: "result",
  N: "qna",
  O: "fixed",
  P: "release",
  Q: "test_passed",
  R: "reply",
  S: "task_id",
  T: "session_id",
  U: "commit_ids",
  V: "customer_summary",
  W: "head_commit",
  X: "forks",
  Y: "checkpoints",
  Z: "status",
};

// Which columns the orchestrator itself writes (vs the agent, vs the user).
// Used by writeBackTaskToSheet() to know what it's allowed to set.
//
// ⚠️ V 已移出: 它现在是 agent 写的"给甲方的提炼"(见下方 AGENT_WRITABLE).
//    原用途 base_commit 是只写不读的镜像, 可从 DB tasks.base_commit 反查.
//
// damo 0829 协议层放开后 S/T/W/X/Y/Z 同时落在 AGENT_WRITABLE —— agent 写后会被
// orchestrator 写回覆盖 (orchestrator 是权威). damo 显式接受此权衡.
const ORCHESTRATOR_WRITABLE = new Set(["S", "T", "W", "X", "Y", "Z"]);
// Which columns the agent may write.
//
// 关注点: 这个集合**不做拦截** —— writeField 只校验列名存在(见 :213), agent 拿
//   lark-cli 能写任何列. 它唯一的作用是渲染进 prompt 的"允许写入的列"提示
//   (见 feishuRowToTaskPrompt). 所以集合写错的表现是「agent 写错列」而不是
//   「写入被拒」, 更难发现 —— 改这里必须同步改 prompt 里的写回指令.
//
// damo 0829 拍板「允许所有列」(CLI 层 c583aa9 已落地), 本协议层同步放开
//   26 列全允许 — 与 c583aa9 删 WRITABLE_COLS 同方向, 仅作"agent 域"信号.
//
// 关注点: 集合放开后, 两条历史结构性保护被**多层级防护替代**:
//
//   1. P 列 diff 死循环(§15.5 已定): 原本由 AGENT_WRITABLE 排除 P 来结构上保证
//      (P 一列两义拆开后, P=发布日期, 仍在需求本体 diff 白名单; agent 写 P 会触发
//      重派 → agent 又写 P → 死循环). 现在 Set 含 P, 但防护栈还有三层兜住:
//        - **O 列四态**: agent 完工写 O=1 → partner sheetwatch check_skip_dispatch
//          (partner/scripts/sheetwatch:587) 判定「任务已关闭 + O∈DONE_VALUES → 跳过派发」
//          → 无重派.
//        - **DISPATCH_COOLDOWN = 300s**: 同 (project, sheet, hash) 5 分钟内不重派.
//        - **prompt 硬编码警告**: feishuRowToTaskPrompt 的「⚠️ 不要写 P 列」(sheets.ts:525).
//      即「结构层 Set」被「运行时 O=1 + cooldown + prompt」替代, 不是 prompt-only.
//
//   2. AGENT_WRITABLE ∩ ORCHESTRATOR_WRITABLE 不相交: 原本保证两边不互相覆盖.
//      现在 S/T/W/X/Y/Z 同时在两边, agent 写后会被 orchestrator 写回覆盖
//      (writeBackFeishu 是 orchestrator 写回权威). damo 0829 显式接受这个
//      权衡, 不再是 bug.
//
//   与 damo 实际用表习惯对齐(2026-08-09, 见 requirement-as-entity.md §15):
//   L 名义是 owner, **实际写测试用例**; N 是 damo 与 agent 的多轮问答列.
const AGENT_WRITABLE = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));

// ---- 协议层 vs 模板层 (v42+) ----
//
// 协议层 (上面两个 Set): 列权限分组. 不变.
// 模板层 (下面 ColumnMapping): 列的具体含义, 按 version 配置覆盖.
//
// 为什么分层: damo 2026-08-14 强调 "列含义不要完全固化, 尤其初期还在迭代时".
// 不同项目 / 不同 version 可配自己的列含义 (L 是测试用例? 是 QA? 是别的?),
// 不改平台代码. 一份默认 mapping 兜底, 不配置时跑通.
export interface ColumnMeaning {
  purpose: string;        // 简短描述 (如 "测试用例清单, 标 must-pass")
  format_hint?: string;   // 格式提示 (如 "[vue],[node],[anflow]" 或 "2-3 句")
  when?: string;          // 何时写 (如 "完成后必填" / "有疑点时填")
}

export interface ColumnMapping {
  agent_writable: Record<string, ColumnMeaning>;
  orchestrator_writable: Record<string, ColumnMeaning>;
  human_writable: Record<string, ColumnMeaning>;
}

// 默认 mapping —— R104 spec (2026-09-06 重对齐, 撤销 77bd54c 08-10 L 漂移 + J 弃用).
// R/T/V 三个镜像列保持 damo 二次澄清后的现状:
//   R = reply (damo 写, 反馈回复现场)          → human_writable
//   T = session_id (orchestrator 写 SDK UUID)   → orchestrator_writable
//   V = customer_summary (agent 写给甲方的提炼) → agent_writable (08-12 从 P 迁来保留)
// 这是**模板**, 不绑死项目; version 可通过 feishu_column_mapping 覆盖任何字段.
export const DEFAULT_COLUMN_MAPPING: ColumnMapping = {
  agent_writable: {
    L: { purpose: "处理人 (谁认领这个需求, damo/AI 都可以写)", when: "认领时填" },
    M: { purpose: "处理结果 (处理后简述怎么做的)", when: "完成后必填" },
    N: { purpose: "问答列: 与 damo/甲方的多轮对话; 有疑点就在这里追问", when: "有疑点时填; 不要自己清空" },
    O: { purpose: "修复标记: 完成后写 1", when: "完成后必填" },
    U: { purpose: "commit_ids 列表, 格式 [vue],[node],[anflow]" },
    V: { purpose: "给甲方的两三句提炼 (人话友好, 不要长篇)" },
  },
  orchestrator_writable: {
    S: { purpose: "task_id (点开跳到平台 task 详情)" },
    T: { purpose: "session_id (SDK session UUID 镜像, 可从 DB tasks.session_id 反查)" },
    W: { purpose: "head_commit (该 task 结束时的 git HEAD)" },
    X: { purpose: "forks 数 (基于该 task 派出去的下游 task 数量)" },
    Y: { purpose: "checkpoints 数" },
    Z: { purpose: "DB task 状态 (镜像)" },
  },
  human_writable: {
    A: { purpose: "反馈日期" },
    B: { purpose: "序号" },
    C: { purpose: "模块 (自由文本, 同模块多行可只写一次)" },
    D: { purpose: "类型" },
    E: { purpose: "问题描述" },
    H: { purpose: "用户原话/期望行为" },
    I: { purpose: "AI 补充描述" },
    J: { purpose: "备注" },
    K: { purpose: "优先级" },
    P: { purpose: "发布日期 (人写; agent 写会触发需求变更 diff 重派)" },
    Q: { purpose: "人工测试反馈" },
    R: { purpose: "damo 反馈回复 / 追问现场" },
  },
};

// 解析 version 的 column_mapping, 缺失字段 fallback 到 default.
// version.feishu_column_mapping 是 JSON 字符串, 结构与 ColumnMapping 兼容.
// 合并策略: 对每个 letter, version 配置优先; 没配置的部分用 default 补全.
// 这样 v0 版本只配一个字段也能跑 (其他用 default 兜底).
export function resolveColumnMapping(
  versionColumnMapping: string | null | undefined,
): ColumnMapping {
  if (!versionColumnMapping) return DEFAULT_COLUMN_MAPPING;
  let parsed: Partial<ColumnMapping>;
  try {
    parsed = JSON.parse(versionColumnMapping) as Partial<ColumnMapping>;
  } catch {
    // JSON 损坏 → 用 default, 不抛错 (配置错了不该让 sync 挂掉).
    return DEFAULT_COLUMN_MAPPING;
  }
  return {
    agent_writable: { ...DEFAULT_COLUMN_MAPPING.agent_writable, ...parsed.agent_writable },
    orchestrator_writable: {
      ...DEFAULT_COLUMN_MAPPING.orchestrator_writable,
      ...parsed.orchestrator_writable,
    },
    human_writable: { ...DEFAULT_COLUMN_MAPPING.human_writable, ...parsed.human_writable },
  };
}

// 渲染 mapping 段, 给 prompt 用. 列出哪些列是 agent 可写 + 各自含义.
export function renderColumnMappingSection(mapping: ColumnMapping): string {
  const lines: string[] = [];
  lines.push("**agent 可写入的列 (其他列只读):**");
  const agentLetters = Object.keys(mapping.agent_writable).sort();
  for (const letter of agentLetters) {
    const m = mapping.agent_writable[letter]!;
    let line = `  - 列 ${letter} — ${m.purpose}`;
    if (m.format_hint) line += ` [格式: ${m.format_hint}]`;
    if (m.when) line += ` (${m.when})`;
    lines.push(line);
  }
  return lines.join("\n");
}

export interface FeishuRow {
  row: number;
  fields: Record<string, string>;
}

/**
 * Parse a single CSV line respecting double-quoted fields.
 * e.g. `a,"b,c",d` → ["a", "b,c", "d"]
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parse lark-cli +csv-get output. Newer lark-cli versions return JSON with
 * `data.annotated_csv`; older versions emit raw `[row=N]` lines to stdout.
 * This helper handles both formats and always returns the annotated_csv text.
 */
function extractAnnotatedCsv(stdout: string): string {
  const trimmed = stdout.trim();
  // Try JSON format first (lark-cli >= 1.0.68 with --format json)
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.data?.annotated_csv) return obj.data.annotated_csv;
    } catch { /* not JSON, fall through */ }
  }
  // Fallback: raw annotated_csv lines
  return trimmed;
}

/**
 * Read a single row from a Feishu sheet. Returns parsed column → value map.
 *
 * The `range` should be one row in A1 notation. Accepts `A<n>:I<n>` for
 * the 9 user-input columns or `A<n>:Z<n>` for the full 26-column layout.
 */
export async function readRow(opts: {
  range: string;
  sheetName?: string;
  sheetUrl?: string;
}): Promise<FeishuRow> {
  const sheetName = opts.sheetName || DEFAULT_SHEET_NAME;
  const sheetUrl = opts.sheetUrl || DEFAULT_SHEET_URL;

  const stdout = await runLarkCli([
    "sheets", "+csv-get",
    "--url", sheetUrl,
    "--sheet-name", sheetName,
    "--range", opts.range,
    "--format", "json",
  ]);

  const annotatedCsv = extractAnnotatedCsv(stdout);
  try {
    return parseAnnotatedRow(annotatedCsv);
  } catch (err) {
    // 补上 range 上下文: parseAnnotatedRow 不知道自己在读哪一行.
    throw new Error(`${(err as Error).message} (range ${opts.range})`);
  }
}

/**
 * Write a single field to a Feishu sheet row. Used by the agent (L/M/N/O/P/U)
 * and by the orchestrator's write-back endpoint (S/Z).
 *
 * 关注点: 只接受 A-Z 单字母, **故意的** —— AA 之后是 damo 手工贴图的附件列
 *   (一格一张), 平台永远不该写那里. 读是 A..BZ(见 readRows), 写只到 Z, 不对称
 *   是设计而非遗漏.
 *   另: 这里**不校验** AGENT_WRITABLE/ORCHESTRATOR_WRITABLE, 只校验列名存在 ——
 *   agent 拿 lark-cli 能绕过去写任何列, 所以那两个集合只是 prompt 提示, 不是权限.
 */
export async function writeField(opts: {
  row: number;
  field: string;       // single-letter A-Z (attachment columns past Z are read-only)
  value: string;
  sheetName?: string;
  sheetUrl?: string;
}): Promise<void> {
  const sheetName = opts.sheetName || DEFAULT_SHEET_NAME;
  const sheetUrl = opts.sheetUrl || DEFAULT_SHEET_URL;
  const col = opts.field.toUpperCase();
  if (!COLUMN_HEADERS[col]) throw new Error(`Unknown column letter: ${col}`);

  await runLarkCli([
    "sheets", "+csv-set",
    "--url", sheetUrl,
    "--sheet-name", sheetName,
    "--row", String(opts.row),
    `--field`, `${col}=${opts.value}`,
  ]);
}

/**
 * 功能: 把 lark-cli 的 annotated_csv 按 `[row=N]` 前缀切成「每个真实行一段」.
 *   单元格内含换行时飞书返回多个物理行, 只有真实行的第一个物理行带 `[row=N]`,
 *   续行不带 —— 所以必须按前缀聚合, 不能按 `\n` 切.
 *
 * 关注点: **不要 filter(Boolean)**. 多行单元格里就有空行(实测 1.6期 表大量存在),
 *   丢掉空行会把单元格内容拼错. 空行只在「还没遇到第一个 [row=N]」时才丢弃.
 *   lark-cli 的 warning_message 自己也写了「不要自己数行」.
 */
export function splitAnnotatedRows(annotatedCsv: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const line of annotatedCsv.split("\n")) {
    if (/^\[row=\d+\]/.test(line)) {
      if (cur !== null) out.push(cur);
      cur = line;
    } else if (cur !== null) {
      cur += "\n" + line;
    }
    // cur === null 且非 [row=N]: 前导噪声, 丢弃.
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * 功能: 把 lark-cli 的 annotated_csv 单行解析成 FeishuRow. 与 IO 分离便于测试.
 *
 * 关注点: A-Z 按 COLUMN_HEADERS 映射成字段名; **Z 之后的列按列字母原样保留**
 *   (damo 往 AA/AB... 一格一张图地贴附件, 数量不定, 没有固定语义).
 *   以前这里只循环 26 次, 超出的值被静默丢弃 —— 那时 range 也只读到 Z, 两处
 *   共同导致"贴了也读不到". 空值不建键, 避免 buildAttachmentLines 数出空项.
 *
 * 关注点(多行单元格): 入参必须是**一个真实行**(可含换行). 以前这里做
 *   `split("\n").filter(Boolean)` 然后只取 `lines[0]`, 于是任何含换行的单元格
 *   (N 列多轮问答、L 列测试用例、E 列需求描述都常含换行) 都会把该行**截断在
 *   第一个换行处**, 后面所有列静默变成 undefined —— 实测 1.6期 表 70 行里 55 行
 *   受影响, row=3 只解出 5 列(应 19), N/O/S 全丢. 现在改为: 多行输入交给
 *   splitAnnotatedRows 处理, 这里若发现不止一个 [row=N] 直接抛错, 不再猜.
 */
export function parseAnnotatedRow(annotatedCsv: string): FeishuRow {
  const segments = splitAnnotatedRows(annotatedCsv);
  if (segments.length === 0) {
    throw new Error(
      `lark-cli output did not start with [row=N]: ${annotatedCsv.slice(0, 200)}`,
    );
  }
  // 单行读取接口拿到多行 = 调用方给的 range 不是一行, 属于用错; 静默取第一行
  // 正是本次要修掉的行为, 所以显式报错.
  if (segments.length > 1) {
    throw new Error(
      `expected a single row but got ${segments.length} rows; use splitAnnotatedRows for multi-row ranges`,
    );
  }
  const rowMatch = segments[0].match(/^\[row=(\d+)\]\s*([\s\S]*)$/);
  if (!rowMatch) throw new Error(`lark-cli output did not start with [row=N]: ${segments[0].slice(0, 200)}`);
  const row = parseInt(rowMatch[1], 10);

  // Parse CSV respecting quoted fields (cells may contain commas inside quotes)
  const values = parseCsvLine(rowMatch[2]);
  const columns = Object.keys(COLUMN_HEADERS);
  const fields: Record<string, string> = {};
  for (let i = 0; i < columns.length && i < values.length; i++) {
    fields[COLUMN_HEADERS[columns[i]]] = values[i].trim();
  }
  for (let i = columns.length; i < values.length; i++) {
    const v = values[i].trim();
    if (v) fields[columnIndexToLetter(i)] = v;
  }
  return { row, fields };
}

/**
 * 功能: 0-based 列序号 -> A1 列字母(0->A, 25->Z, 26->AA, 27->AB, 701->ZZ, 702->AAA).
 *
 * 关注点: 不是简单的字符 +1 —— A1 记法是**无零的 26 进制**(A..Z 没有代表 0 的
 *   数字), 所以每轮要先 `n-1` 再取余, 用普通 26 进制会在 Z->AA 处错位成 BA.
 */
export function columnIndexToLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 功能: 把行里的附件/截图列的**文字内容**拼成 prompt 行. 无内容时返回空数组.
 *
 * 关注点: 这里只处理"格子里是文字"的情形 —— F/G 里是图片 URL, 或 damo 手写的图片
 *   说明, 或 Z 之后额外列的内容(damo 往 AA/AB... 一格一张地贴, 见 §16.3).
 *   🔴 **真图片走不到这里**: 格子里贴的真图 `csv-get` 读回来是**空字符串**(§16.8),
 *   要靠 row-images.ts 取回落盘 + buildImagePromptBlock 追加路径.
 *   额外列由 readRow 以**列字母**为键存入 fields, 这里靠"键名不在 COLUMN_HEADERS
 *   的值集合里"识别. ⚠️ 排序必须按列字母的**自然列序**(AA < AB < ... < AZ < BA).
 */
function buildAttachmentLines(f: Record<string, string>): string[] {
  const known = new Set(Object.values(COLUMN_HEADERS));
  const extras = Object.keys(f)
    .filter((k) => !known.has(k))
    .sort((a, b) => (a.length - b.length) || a.localeCompare(b))
    .map((k) => f[k]);

  const items = [f.screenshot_1, f.screenshot_2, ...extras]
    .filter((v) => v && v.trim());

  if (items.length === 0) return [];
  return [
    // 一格一张图是 damo 定的表格约定(图片必须贴在单元格里, 不能一格塞多张),
    // 所以这里每项就是一张图/一条说明, 编号即张数.
    `- 附件/截图 (${items.length} 项, 一格一张). 是链接就尝试取回并看图, 是文字说明就当补充需求读:`,
    ...items.map((v, i) => `  ${i + 1}. ${v.trim()}`),
  ];
}

/**
 * 功能: 把已取回落盘的甲方贴图路径拼成一段 prompt, **追加**到 task prompt 末尾.
 *
 * 关注点: 为什么是"追加"而不是拼进 feishuRowToTaskPrompt 的需求描述段 —— 图片落盘
 *   路径含 task id, 必须 createTask 之后才知道, 那时 prompt 已经生成了.
 *   文件名形如 `R3-F.png` = 贴在第 3 行 F 列, 让 agent 一眼知道图的来源位置.
 */
export function buildImagePromptBlock(localPaths: string[]): string {
  return [
    `**甲方贴的图** (${localPaths.length} 张, 已从飞书取回本地). **用 Read 逐张看**,`,
    `图里的信息是需求的一部分, 不看图很可能做错. 文件名 \`R{行}-{列}\` = 图贴在表格哪个格子:`,
    ...localPaths.map((p, i) => `  ${i + 1}. ${p}`),
  ].join("\n");
}

/**
 * Convert a Feishu row into an orchestrator task prompt.
 * The resulting string is structured to be self-contained — an agent can
 * pick it up and act on it without ever seeing the original sheet.
 *
 * Reference to columns uses COLUMN_HEADERS keys so the prompt stays valid
 * if the sheet's column layout shifts (e.g. someone reorders).
 *
 * 关注点: 甲方贴的**真图片**不在这里 —— 它们的本地路径含 task id, 只能在
 *   createTask 之后由 buildImagePromptBlock 追加(见 api/feishu/sync/route.ts).
 */
export function feishuRowToTaskPrompt(
  row: FeishuRow,
  projectHint = "/tmp/anflow-repo",
  versionName?: string | null,
  // 新增: 列含义模板. 默认用 DEFAULT_COLUMN_MAPPING.
  // sync route 会从 version.feishu_column_mapping 解析后传入.
  mapping: ColumnMapping = DEFAULT_COLUMN_MAPPING,
): string {
  const f = row.fields;
  const cols = COLUMN_HEADERS;
  const reqId = formatRequirementId(row.row, versionName);

  // 渲染写回指令段: 从 mapping.agent_writable 遍历生成, 不再硬编码 V/L/O/U/M/N.
  // 这是 v42 模板化的关键: 改 version.feishu_column_mapping 即改 agent 看到的写回指令.
  const writebackLines: string[] = [];
  const agentLetters = Object.keys(mapping.agent_writable).sort();
  for (const letter of agentLetters) {
    const m = mapping.agent_writable[letter]!;
    let line = `   - 列 ${letter} — ${m.purpose}`;
    if (m.format_hint) line += ` (格式: ${m.format_hint})`;
    if (m.when) line += ` [${m.when}]`;
    writebackLines.push(line);
  }

  return [
    `你是项目反馈处理 agent。`,
    ``,
    `**飞书表格行 ${reqId}** (来源: 飞书 Sheet)`,
    ``,
    `- ${cols.A} (反馈日期): ${f.feedback_date || "(无)"}`,
    `- ${cols.B} (序号): ${f.serial || "(无)"}`,
    `- ${cols.C} (模块): ${f.module || "(继承上一行)"}`,
    `- ${cols.D} (类型): ${f.type || "(无)"}`,
    `- ${cols.E} (问题描述): ${f.problem || "(无)"}`,
    `- ${cols.H} (用户原话/应该是怎么样): ${f.expected || "(无)"}`,
    f.ai_supplement ? `- ${cols.I} (AI 补充描述): ${f.ai_supplement}` : ``,
    // F/G 是甲方贴的截图列. 这两列以前**被读进 fields 但从没拼进 prompt** ——
    // 即 agent 从来没见过任何截图, 一直只处理纯文字版需求(见 §16.2).
    // 这里出的只是"格子里的文字"(URL / damo 手写说明); 真图片走 buildImagePromptBlock.
    ...buildAttachmentLines(f),
    // N 列是多轮问答现场: 有内容说明上一轮已经问过、人已经回过, agent 必须先读
    // 再续问, 否则会重复提同一个疑点. L 是已有测试用例, 同理不要从零重写.
    f.qna ? `- N (问答记录, **先读再续问, 不要重复提问**): ${f.qna}` : ``,
    f.handler ? `- L (处理人): ${f.handler}` : ``,
    ``,
    `**任务**:`,
    `1. Read 项目的 CLAUDE.md 了解架构 + 协议 (项目特定细节见 Role system_prompt)`,
    `2. 在 \`${projectHint}\` 工作目录实现该需求`,
    `3. 完成后用 \`lark-cli sheets +csv-set\` 把以下结果写回飞书表格:`,
    // ⚠️ 不要写 P 列 (diff 死循环防护, 见 requirement-as-entity.md §15.5).
    `   ⚠️ **不要写 P 列** —— P 只放发布日期, 由人写. 写 P 会触发需求变更 diff 重派任务.`,
    ...writebackLines,
    // step 是字符串 tag (v46): 数字或语义词 (e.g. "final") 都行, 长度 1-64,
    // 字符集 [A-Za-z0-9_-]. active-session.ts 的 CHECKPOINT_RE 用 [A-Za-z0-9_-]
    // 而不是 \d+, 所以 step=1 仍 OK, step=final 也 OK. 版本信息仍放 summary.
    `4. 输出 \`<checkpoint step=${row.row} summary="${reqId} done">\` 作为完成锚点`,
    ``,
    renderColumnMappingSection(mapping),
  ].filter(Boolean).join("\n");
}

// 读取范围的右边界. A-Z 是有语义的固定列, AA 之后是 damo 一格一张图贴的附件.
// 取到 BZ = 26 固定列 + 52 个附件位, 远超"甲方一次给 8 张图"的实际用量.
// 关注点: 不能只读到 Z —— 那样 AA 之后的图**读都读不到**(§16.3). 也不宜无上限:
//   lark-cli 要一个具体 range, 且过宽会拉回大量空列拖慢每行一次的串行读取.
export const READ_LAST_COLUMN = "BZ";

/**
 * Bulk helper: read multiple rows by index, returning FeishuRow[].
 * Reads A..BZ so write-back gets all 26 semantic columns *and* any
 * attachment columns damo appended past Z (one image per cell).
 */
export async function readRows(rowIndices: number[], opts?: {
  sheetName?: string;
  sheetUrl?: string;
}): Promise<FeishuRow[]> {
  const out: FeishuRow[] = [];
  for (const idx of rowIndices) {
    const row = await readRow({
      range: `A${idx}:${READ_LAST_COLUMN}${idx}`,
      sheetName: opts?.sheetName,
      sheetUrl: opts?.sheetUrl,
    });
    // 跳过"无需求内容"行: 飞书 sheet 末尾的 padding row + 仅有 metadata
    // (反馈日期/序号) 但无 C/E/H 等实际需求描述的行 —— 都不算真实数据行.
    // 判定键: C (module) / E (problem) / H (expected) 三个内容列至少一个非空.
    // 关注点: 这条判定基于 anflow 列含义; 配了 version.feishu_column_mapping 的
    // 项目可能不一样 —— 真实需求列可能改. 但目前 DEFAULT_COLUMN_MAPPING 默认就是
    // 反馈日期/序号不在 human_writable 内容键里, 该判定对多数 sheet 成立.
    const hasRealContent = !!(row.fields.module || row.fields.problem || row.fields.expected);
    if (hasRealContent) out.push(row);
  }
  return out;
}

export { COLUMN_HEADERS, ORCHESTRATOR_WRITABLE, AGENT_WRITABLE };