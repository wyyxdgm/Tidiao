/* 功能: 任务卡片「有啥用」摘要提取 — 从登记字段 (value_significance /
   description) 到 prompt 目标句逐级兜底, 截断成一行. 另含 clip 清洗截断.
   ConsoleCanvas.vue 只调用, 判定规则锁死本文件 (单测覆盖).

   关注点:
   - 噪声源 (damo 2026-10-03 反馈「看不出来啥」后立的规则):
     ① agent 汇报正文里的 checkpoint XML 原文 (<checkpoint step=N summary="…"/>)
     ② system-reminder 块
   - 历史: 曾有「为什么等我」提取 (extractWhy + 锚点/结构词规则), R177 迭代9
     (damo 1004) 「为什么」整行撤、语义由「有啥用」覆盖, 连同其专用 helper
     (STRUCT_HEAD_RE / WAIT_ANCHOR_RE / DONE_LINE_RE / firstSentences) 一并拆除. */

/** checkpoint / awaiting / git commit / system-reminder 标记原文 (agent 偶尔把
 *  marker 写进汇报正文; 存量任务 DB result 里也混着这些管线符号). */
const NOISE_RES: RegExp[] = [
  /<checkpoint[^>]*>/gi,
  /<awaiting[^>]*>/gi,
  /<git[^>]*>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
];

function stripNoise(s: string): string {
  let out = s;
  for (const re of NOISE_RES) out = out.replace(re, ' ');
  return out;
}

/** 剥运行时标记 + 压掉剥完产生的空行 — 弹窗原文/兜底展示用 (保留换行结构,
 *  与 clip 的空白折叠不同). damo 1007: 管线符号不进任何面向用户的表面. */
export function stripRuntimeMarkers(s: string): string {
  return stripNoise(s)
    .replace(/^[ \t]+$/gm, '') // 标签被剥成空格的行清成空行, 再统一折叠
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 轻清 markdown 记号 (## 标题 / **加粗** / 行内代码 / 列表符) — 摘要行是纯文本渲染. */
function cleanMd(s: string): string {
  return s
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '');
}

/** 折叠空白 + 截断 (超长静默截断, 不加省略号 — damo 1007: 结尾「…」= 总结不到位).
 *  视图 toast/标题复用. */
export function clip(s: string, n: number): string {
  const clean = cleanMd(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) : clean;
}

/** 「有啥用」提取 — 优先现成登记字段, 最后才从 prompt 猜:
 *  ① value_significance (v132 派发时前置登记的为什么做 = 权威)
 *  ② description (派发模板「一句话, 给列表展示用」)
 *  ③ prompt 目标行 — 先跳 boilerplate (身份行/标记行/命令行/checkpoint 约定),
 *     再优先取与任务标题呼应的行 (damo 指令通常复述标题; 13001 线上实测:
 *     派发模板把 checkpoint 约定注在指令前, 裸取首行会抓到套话), 都不像才取首行. */
export function extractGain(
  opts: { valueSignificance?: string | null; description?: string | null; prompt?: string | null; title?: string | null },
  max = 80,
): string {
  if (opts.valueSignificance?.trim()) return clip(opts.valueSignificance, max);
  if (opts.description?.trim()) return clip(opts.description, max);
  const p = opts.prompt?.trim();
  if (!p) return '';
  const GOAL_RE = /^(?:任务目标|目标|做什么|要做的事|需求|目的)[:：]\s*(.+)$/;
  // [role: default] bracket 配置行 + checkpoint 约定套话 = 13001 线上实测泄漏
  const SKIP_RE =
    /^(你是|<|```|==|--|#|\||\[[^\]]*\]\s*$|(?:工作目录|环境变量|环境|当前环境|身份|背景|依据|改造点|关键约定|已知坑|验证标准|工作流|收尾|checkpoint)\s*[:：]?(\s|$))/;
  const BOILERPLATE_RE =
    /步的任务|里程碑|checkpoint|系统约定|不要另开|从 1 自增|最终步|面板空白/i;
  // 平台模板注入的约定节区 (## 通用约定 / ## 强制要求 / == 验证标准 == 等) 下的
  // 行全部跳过 — 13001 实测: 「- 写操作前 git pull --ff-only」这类约定行当了指令
  const CONVENTION_SECTION_RE =
    /通用约定|强制要求|系统约定|验证标准|关键约定|已知坑|工作流|工作目录|环境|背景|平台 ?API|端点|参考文件|注意事项/i;
  // 命令行通常是真指令 (deploy-helper 任务整条 prompt 就一条 bash 命令), 但
  // 长命令放主候选会压过短指令 → 进二级兜底, 候选为空才取
  const CMD_RE =
    /^(?:\d+[.、)]?\s*)?(?:git|bash|curl|ssh|npm|node|npx|pnpm|jiti|cd|source|export)\b/;
  const candidates: string[] = [];
  const cmdCandidates: string[] = [];
  let section = '';
  for (const raw of stripNoise(p).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(?:#{1,6}\s*|={2,}\s*)(.+?)(?:\s*={2,})?$/.exec(line);
    if (h) {
      section = h[1];
      continue;
    }
    if (SKIP_RE.test(line) || BOILERPLATE_RE.test(line)) continue;
    // 约定节区里只跳列表项 (约定内容都是 bullet/编号); 节区尾部紧跟的真指令
    // (如 R51 卡 bash 命令行 / 「更新布署13000」) 不是列表项, 保留为候选
    if (section && CONVENTION_SECTION_RE.test(section) && /^\s*(?:[-*•]|\d+[.、)])\s+/.test(line)) {
      continue;
    }
    const m = GOAL_RE.exec(line);
    if (m) return clip(m[1], max);
    (CMD_RE.test(line) ? cmdCandidates : candidates).push(line);
  }
  // 标题呼应行优先: 规范化后 6 字窗口命中即取 (标题与指令通常共享 6+ 连续字)
  const norm = (s: string) =>
    s.replace(/[\s`'"“”（）()【】,，。.:：;；!！?？\-_/\\|*#\[\]{}]+/g, '');
  const tn = norm(opts.title ?? '');
  if (tn.length >= 6) {
    for (const list of [candidates, cmdCandidates]) {
      for (const line of list) {
        const ln = norm(line);
        for (let i = 0; i + 6 <= tn.length; i++) {
          if (ln.includes(tn.slice(i, i + 6))) return clip(line, max);
        }
      }
    }
  }
  // 兜底取最长候选行 — 真指令通常比约定碎行长 (命令行二级兜底: 候选为空才取)
  const pick = (arr: string[]): string =>
    arr.length ? clip(arr.reduce((a, b) => (b.length > a.length ? b : a)), max) : '';
  return pick(candidates) || pick(cmdCandidates);
}
