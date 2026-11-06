// Feishu sheet URL 归一化 — 把粘贴时带的 ?sheet=xxx 等 query 抽离,
// 写库前一次性处理成「干净 wiki URL」+ 可选 sheet_id.
//
// 关注点:
//   - 只动写路径（projects-client + API route）,不动读路径
//     （sheetwatch / runLarkCli 拿到的是干净 URL,零改动）.
//   - ?sheet=xxx 是飞书「带 sheet 标签」复制链接的常见形态——
//     不兼容 = 用户粘贴被静默截断/拒绝,体验降级.
//   - 直接 sheets/xxxxx 形态不强制转 wiki(强转换容易翻车,
//     lark-cli 对两种 URL 识别能力不同),原样返让 lark-cli 自己判断.

import { URL } from "node:url";

export interface NormalizedSheetUrl {
  /** 干净 URL：wiki 形态去 ?sheet=,其它 query 保留,非飞书域名原样返 */
  wikiUrl: string;
  /** 从 ?sheet= 或 /sheets/ 路径抽出的 sheet_id(可选,派生勿当主键) */
  sheetIdFromQuery: string | null;
}

/**
 * 功能: 接受任意飞书 sheet URL 形态,返回干净 URL + 抽出的 sheet_id.
 * 支持:
 *   - https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d
 *   - https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?sheet=1XzOKi
 *   - https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?sheet=1XzOKi&range=A1:Z
 *   - https://my.feishu.cn/sheets/1XzOKi  (直接 sheet 链接,原样返)
 *
 * 关注点:
 *   - 非飞书域名(自定义内网域名等)→ 原样返,sheetIdFromQuery=null.
 *     lark-cli 兼容性未知,强转换风险大于收益.
 *   - URL parse 抛错(手贴乱码)→ 抛 Error,调用方决定 reject form 或静默忽略.
 *   - query 参数中只有 ?sheet= 被显式抽离;其它(?range= / ?view= 等)保留在 URL,
 *     lark-cli 仍可识别(实测 OK).
 */
export function normalizeSheetUrl(raw: string): NormalizedSheetUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { wikiUrl: "", sheetIdFromQuery: null };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`Invalid sheet URL: ${trimmed.slice(0, 80)}`);
  }

  // 非飞书域名(自定义内网/larksuite 域外测试域名) → 原样返,不强行猜
  const isFeishu = /(?:^|\.)feishu\.cn$|(?:^|\.)larksuite\.com$/i.test(u.hostname);
  if (!isFeishu) {
    return { wikiUrl: trimmed, sheetIdFromQuery: null };
  }

  // 直接 sheet 形态 /sheets/xxx → 原样返,sheet_id 从 path 抽
  const sheetsMatch = u.pathname.match(/^\/sheets\/([A-Za-z0-9_-]+)/);
  if (sheetsMatch) {
    return { wikiUrl: u.toString(), sheetIdFromQuery: sheetsMatch[1] };
  }

  // wiki 形态:抽 ?sheet= 再剥
  const sheetIdFromQuery = u.searchParams.get("sheet");
  u.searchParams.delete("sheet");

  // 重建 URL —— path 永远保留,query 仅当有非空参数时才拼
  const remainingQuery = u.searchParams.toString();
  const wikiUrl = remainingQuery
    ? `${u.origin}${u.pathname}?${remainingQuery}`
    : `${u.origin}${u.pathname}`;

  return { wikiUrl, sheetIdFromQuery };
}