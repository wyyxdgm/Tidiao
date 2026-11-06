// 功能: R15 sub-2 自动重命名 + sub-3 手动优先 + R122 T5-A LLM 兜底.
// 设计要点:
//   - sub-3: metadata.title_lock 决定是否覆盖.
//     - 'manual' = 用户已通过 PATCH /api/tasks/[id] 改过 → 跳过, 永不覆盖
//     - 'auto'   = 已经自动改过一次 → 跳过, 避免反复触发
//     - undefined/其他 = 初始态, 允许自动改一次, 改完置 'auto'
//   - 改名前生成 newTitle (走 generateAutoTitle 两档策略, 见下).
//     newTitle 与当前 title 相同 → 不写库, 不动 lock (避免误锁 + 浪费事件).
//
// R122 T5-A 两档策略 (generateAutoTitle 内部; R200 turn2 撤掉 checkpoint 短路档,
//   damo 1006 chat 反馈 checkpoints 质量不好、不可控, 切片标题常是半句黑话):
//   1. LLM 提炼 (source='llm', 唯一主档): prompt 头 + checkpoint summaries +
//      result 拼成 prompt, 走统一 summary 链 (summary-llm.ts, 系统 summary 模型
//      + fallback 链) 提炼一句标题. 撞 429 / 鉴权失败 / SDK 异常 → 静默回退到
//      第 2 档, 不污染外层调用栈.
//   2. 原 prompt 提取 (source='prompt'): 与 R15 sub-2 完全一致的纯函数逻辑,
//      作为最终回退.
//
// 关注点:
//   - 本函数是 rule-engine 异步 fire-and-forget 的回调内部, 任何异常必须 throw
//     给外层 catch, 不能 swallow (claude/agent-runtime 都靠 rule_failed event
//     排查问题). generateAutoTitle 内部的 LLM 异常要 swallow + 回退, 但 apply-
//     AutoRename 自身异常仍要 throw.
//   - 不走 API PATCH 路径, 直接 updateTask: 走 API 会触发 awaiting_owner_review
//     等额外副作用, 同时 metadata.title_lock 也要顺手落库 (mutateTaskMetadata),
//     与 API 路径解耦更稳.
//   - generateAutoTitle 是 async (原 sync), 因为第 1 档要 await LLM. caller
//     applyAutoRename 已 async, 跟 rule-engine 的 await runAction() 自然衔接.
//   - generateAutoTitle 返回结构 { title, source } 让 source 在两档间精确传
//     递 (而不是 applyAutoRename 处粗标 'llm' 的 hack).

import { getTaskById, mutateTaskMetadata, updateTask } from "../db/tasks";
import { getCheckpointsByTaskId } from "../db/checkpoints";
import { summarizeTitle } from "./llm-summarize";
import type { Task } from "../db/tasks";

const MAX_TITLE_LEN = 60; // 与 task title 上限对齐, 给 prefix + 余量
const PROMPT_HEAD_CHARS = 400; // 从用户内容 ([task] 后) 起取 400 字符, 覆盖第一句/第一段 (R188 起不再含 preflight 块)

// 已知「太通用, 自动改没价值」的标题前缀 — 命中直接跳过 (避免把
// "untitled" 改成 "untitled (auto)" 这种纯噪音).
const GENERIC_TITLE_RE = /^(untitled|new task|新任务|新建任务|test|测试|空)$/i;

// LLM 兜底时, checkpoint summaries 取最近 N 条. 与 llm-summarize.ts 内部常量
// 一致; 显式声明便于单测 mock 验证调用次数.
const LLM_CHECKPOINT_FETCH_LIMIT = 5;

// R166: sheetwatch 自动派发 prompt 的固定模板尾巴. prompt 档直接拿首行当标题,
//   会把「更新，请处理下。」这种派发噪音原样带进标题 (实测:
//   「飞书 GDM-v0.2 R71 更新，请处理下。」). 命中就剥掉, 保留前半的信息量部分.
const DISPATCH_TEMPLATE_TAIL_RE = /\s*(?:[，,]\s*)?(?:更新|变更)?[，,]?\s*请处理下[。.!！]?\s*$/;

export type AutoRenameOutcome =
  | { ok: true; from: string; to: string; source: "prompt" | "llm" | "unchanged" }
  | { ok: false; reason: "manual_lock" | "auto_lock" | "no_prompt" | "missing" };

// 功能: 从 task.prompt 提炼一个比当前 title 更有信息量的新标题 (R122 T5-A
//   两档策略入口, R200 turn2 起撤掉 checkpoint 短路档). 两档依次尝试: LLM 提炼
//   (统一 summary 链) → 原 prompt 提取. 任一档返回有效标题即采用, 否则返 null
//   (caller 当作 no_prompt 处理).
// 返回: { title, source } — source 告诉 caller 标题是哪一档产出, 便于 events
//   表 result 字段精确呈现.
// 规则 (applyAutoRename 调用前已确认 lock 不是 manual / auto):
//   1. LLM 提炼 (唯一主档): 拼 promptHead + checkpointSummaries + 最新
//      transcript (R144) + result (damo 1004) 调 summarizeTitle (内部走统一
//      summary 链, summary-llm.ts). 撞 429 / 鉴权失败 / SDK 异常 → swallow +
//      落到第 2 档. 标 source='llm'.
//   2. 原 prompt 提取: 与 R15 sub-2 完全一致. 标 source='prompt'.
// 关注点:
//   - async (原 sync), caller applyAutoRename 必须 await.
//   - 任何 LLM 异常必须 swallow, 不要 throw (外层 applyAutoRename 仍会抛自己
//     真正的异常给 rule-engine 的 try/catch 链, 但 generateAutoTitle 这一层
//     的失败是「降级」而非「错误」).
//   - 第 2 档保持纯函数语义, 单测 mock summarizeTitle 即可覆盖.
export async function generateAutoTitle(
  task: Task,
): Promise<{ title: string; source: "prompt" | "llm" } | null> {
  if (!task.prompt) {
    // prompt 为空 → 两档都没数据, 直落 prompt 提取早返.
    return null;
  }

  // R188: [task] 标记在全量 prompt 里定位, head 窗口从用户内容起算.
  //   修的是: preflight 注入块 (~380 字符) 把 400 窗口吃满, 用户首行被拦腰截断
  //   (实测: 「飞书 GDM-v0.2 R71 更新，请处理」少了「下。」→ 尾巴剥不掉 → 标题
  //   报废), LLM 档拿到的 promptHead 也一直是 preflight 套话而非用户需求.
  //   无标记 (preflight 关 / 自定义 prompt) 时保持原行为从头取.
  const fullPrompt = task.prompt;
  const markerIdx = fullPrompt.indexOf("[task]\n");
  const headStart = markerIdx !== -1 ? markerIdx + "[task]\n".length : 0;
  const head = fullPrompt.slice(headStart, headStart + PROMPT_HEAD_CHARS);

  // R200 turn2 (damo 1006 chat): 原「第 1 档 checkpoint summary 切片短路」整档
  //   撤除 — damo 反馈 checkpoints 质量不好、不可控, 标题同样受累 (切片出来的
  //   标题常是半句黑话). 现在标题 = LLM 提炼 (统一 summary 链) 一档 + prompt
  //   提取兜底, 质量稳定可控. checkpoint summaries 仍作为 LLM 输入之一.
  const checkpoints = getCheckpointsByTaskId(task.id);
  const recentSummaries = checkpoints
    .slice(-LLM_CHECKPOINT_FETCH_LIMIT)
    .map((cp) => (cp.summary || "").trim())
    .filter((s) => s.length > 0);

  // ---- LLM 提炼 (唯一主档) ----
  // R144: 把「最后一个 checkpoint 的 transcript_slice」也喂给 LLM, 让标题反映
  //   「实际做了什么」而不是「开头问了什么」. 空 / null 都安全 (model 自己判断).
  const latestTranscript = checkpoints.length > 0
    ? checkpoints[checkpoints.length - 1]?.transcript_slice ?? null
    : null;
  // damo 1004 (task 7b921e1b): result 喂给 LLM. 时序已核 (active-session.ts:
  // 自然完成路径先 updateTaskStatus(..., result) 落库, 后 emitEvent reviewing →
  // rule-engine 才跑到这里), 所以 reviewing 时 result 一定已可读.
  try {
    const llmTitle = await summarizeTitle({
      task,
      promptHead: head,
      checkpointSummaries: recentSummaries,
      latestTranscript,
      taskResult: task.result ?? null,
    });
    if (llmTitle) return { title: truncateTitle(llmTitle), source: "llm" };
  } catch (err) {
    // swallow: summarizeTitle 内部已 catch, 这里只是 double-safety. 落第 2 档.
    console.warn(
      `[auto-rename] summarizeTitle threw for task ${task.id}:`,
      (err as Error).message,
    );
  }

  // ---- 第 2 档: 原 prompt 提取 (R15 sub-2 完整逻辑) ----
  const extracted = extractTitleFromPrompt(head);
  if (extracted) return { title: extracted, source: "prompt" };
  return null;
}

// 功能: 把任意字符串截到 MAX_TITLE_LEN, 过长则加省略号. 防御性 helper.
// 关注点:
//   - 与 R15 sub-2 的 truncate 行为一致, 不引入新清洗规则.
//   - MAX_TITLE_LEN = 60 是 DB 侧安全网 (task title 字段理论上限), 实际展示的标题
//     应由 LLM 控制在 8-20 字符 (R144 改 prompt), 走到这里 > 60 才说明 caller 完全
//     没约束, 兜底截断.
function truncateTitle(s: string): string {
  if (s.length <= MAX_TITLE_LEN) return s;
  return s.slice(0, MAX_TITLE_LEN - 1).trimEnd() + "…";
}

// 功能: 原 R15 sub-2 的 prompt 提取逻辑, 作为 LLM 兜底的回退. 与改造前完全
//   一致, 单测 case 可直接复用.
// 关注点:
//   - 不读 DB, 不读 task (除 head 字符串外), 单测时构造 prompt 字符串即可.
//   - createTask 注入顺序在 `src/lib/db/tasks.ts:buildPreflightBlock` +
//   `buildDispatchedByBlock` + role preamble, 统一都是 "[tag]\n...\n\n" 形态. 用
//   while 循环依次剥, 比正则一次扫到底更稳 ([tag] 内容可能跨行, 嵌套也常见).
function extractTitleFromPrompt(head: string): string | null {
  // createTask 把 prompt 拼成「平台注入 [preflight check]...\[task]\n + 用户 prompt」
  // (见 src/lib/db/tasks.ts:buildPreflightBlock). 用户实际写的 prompt 跟在
  // "[task]\n" 之后. 走「先切 [task]」语义比「跳过 [tag] 块」更稳 ——
  // preflight 块内有 prose + code fence + 警示段, 任何「第一个非 [tag] 段」启发
  // 都会被 code fence 或警示段截胡.
  const taskMarkerIdx = head.indexOf("[task]\n");
  let userContent: string;
  if (taskMarkerIdx !== -1) {
    userContent = head.slice(taskMarkerIdx + "[task]\n".length);
  } else {
    // 没有 [task] marker (preflight 关掉 / 自定义 prompt) — 退回原策略: 按段
    // 落, 跳过开头是 [tag] 的.
    const paragraphs = head.split(/\n\n|\r\n\r\n/);
    const firstNonTag = paragraphs.find((p) => !/^\s*\[[^\]\n]+\]/.test(p));
    userContent = firstNonTag ?? "";
  }
  if (!userContent) return null;
  const firstPara = userContent.split(/\n\n|\r\n\r\n/)[0] ?? userContent;
  const firstLine = firstPara.split(/\n/)[0] ?? firstPara;
  // 去 markdown 噪音.
  let cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/`/g, "")
    .replace(/^>\s*/, "")
    .trim();
  // R166: 剥列表编号前缀. LLM 档的 cleanResultText 早就剥了, prompt 档一直漏 ——
  //   实测 task c7ca8ab6 的标题被定成「1. 列出平台所有项目」, 编号是噪音.
  cleaned = cleaned.replace(/^[\-\*•]\s+/, "").replace(/^\d+[.、)]\s*/, "").trim();
  // R166: 剥 sheetwatch 派发模板尾巴. prompt 档拿的就是派发文案首行, 尾巴
  //   「更新，请处理下。」对人是纯噪音 (实测 task 198a62fc).
  cleaned = cleaned.replace(DISPATCH_TEMPLATE_TAIL_RE, "").trim();
  if (!cleaned) return null;
  return truncateTitle(cleaned);
}

// 功能: 把 task 当前 metadata.title_lock 解析成可比较的字面量.
// 关注点: metadata 是任意 JSON 字符串, 脏值 (非 string/拼错字) 一律视为未锁
//   (= 允许自动改名), 别把脏数据当 manual 误锁死. 这是 fail-open, 失败宁
//   可被自动改一次也别让用户永远改不动.
export function readTitleLock(metadata: string | null | undefined): "manual" | "auto" | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { title_lock?: unknown };
    const lock = meta.title_lock;
    if (lock === "manual" || lock === "auto") return lock;
    return null;
  } catch {
    return null;
  }
}

// 功能: 在 reviewing 转换时尝试自动改 title 一次 (R122 T5-A).
// 返回: AutoRenameOutcome (ok + from/to/source) 或 (ok=false + reason). rule-engine
//   据此判断要不要插 rule_fired event + result 字段.
// 关注点:
//   - 缺失/已删 task 返回 missing (不应发生, 防御).
//   - title_lock === 'manual' → 跳过 (sub-3 用户手动优先).
//   - title_lock === 'auto' → 跳过 (已经改过一次, 反复 running→reviewing 不覆盖).
//   - 当前 title 是通用占位 ("untitled" 等) 但 prompt 也没信息量 → no_prompt
//     跳过, 不浪费 lock.
//   - generateAutoTitle 返回的标题与当前 title 完全相同 → 不写库, source =
//     "unchanged", lock 维持原状.
//   - async (原 sync): generateAutoTitle 现在可能调 LLM, await 必要. rule-
//     engine.runAction() 已 await runAction, 自然衔接.
export async function applyAutoRename(
  taskId: string,
  opts: { force?: boolean } = {},
): Promise<AutoRenameOutcome> {
  const task = getTaskById(taskId);
  if (!task) return { ok: false, reason: "missing" };

  const lock = readTitleLock(task.metadata);
  if (lock === "manual") return { ok: false, reason: "manual_lock" };
  // force = 批量回填场景 (R200 turn2): 允许覆盖旧 auto lock (checkpoint 时代
  // 的低质量标题用新 LLM 链重刷一次); manual lock 任何情况下都不覆盖.
  if (lock === "auto" && !opts.force) return { ok: false, reason: "auto_lock" };

  // 占位标题但 prompt 没信息量 → 直接跳过, 别给"untitled"挂 "auto" lock.
  if (GENERIC_TITLE_RE.test((task.title || "").trim()) && !task.prompt) {
    return { ok: false, reason: "no_prompt" };
  }

  const result = await generateAutoTitle(task);
  if (!result) {
    // 两档都没产出 (空 prompt / 全是 markdown 噪音 / LLM 返 null + prompt 提
    // 取失败) — 一律 no_prompt.
    return { ok: false, reason: "no_prompt" };
  }
  const { title: newTitle, source } = result;

  if (newTitle === task.title) {
    // 内容已够好 — 仅置 lock, 避免下次 reviewing 再次走全流程.
    mutateTaskMetadata(taskId, (meta) => {
      meta.title_lock = "auto";
    });
    return { ok: true, from: task.title, to: newTitle, source: "unchanged" };
  }

  updateTask(taskId, { title: newTitle });
  mutateTaskMetadata(taskId, (meta) => {
    meta.title_lock = "auto";
  });
  return { ok: true, from: task.title, to: newTitle, source };
}