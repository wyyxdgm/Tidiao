// 飞书表格图片取回层 —— 把「表格里贴的图」变成「agent 能 Read 的本地文件」.
//
// 为什么单独一个文件: 取图和 csv 读写完全不同的三条链路(cells-get / float-image-list /
// medias download), 混进 sheets.ts 会让那个已经 500 行的文件更难读.
//
// 🔴 三个必须知道的事实(都是实测出来的, 见 docs/plans/requirement-as-entity.md §16.8):
//   1. `+csv-get` 对图片一律返回**空字符串**. 想靠读 CSV 拿图 = 白忙, 且静默无报错.
//   2. 两种贴法要两个命令: cell 内嵌图走 `+cells-get`(rich_text[].type=="embed-image"),
//      浮动图走 `+float-image-list`(可一格多张, 不占列位).
//   3. 下载**只能**走 `lark-cli api GET /open-apis/drive/v1/medias/{token}/download`.
//      `drive +download` 会 403 —— 那是给 Drive "文件"用的, 图片是 media(素材).
//      **403 在飞书这里常常是接口选错, 不是缺权限.**

import fs from "fs";
import path from "path";
import { runLarkCli } from "./lark-cli";

export interface FeishuImage {
  row: number;          // 1-based 行号(与需求点 R{row} 对齐)
  column: string;       // 列字母, 如 "F"
  imageToken: string;
  kind: "embed" | "float";
}

/**
 * 功能: 从 `+cells-get --include value` 的 JSON 里抽出所有 cell 内嵌图.
 *
 * 关注点: 行号/列字母**必须**取 `row_indices[i]` / `col_indices[j]`, 不能按数组
 *   下标自己数 —— lark-cli 自己的 warning_message 就在强调这点: 结果被截断或
 *   skip_hidden 时下标会错位. 静默错位这个项目已经踩过两次.
 */
export function parseEmbedImages(stdout: string): FeishuImage[] {
  const obj = JSON.parse(stdout);
  const out: FeishuImage[] = [];
  for (const rg of obj?.data?.ranges ?? []) {
    const rowIdx: number[] = rg.row_indices ?? [];
    const colIdx: string[] = rg.col_indices ?? [];
    (rg.cells ?? []).forEach((cells: unknown[], i: number) => {
      cells.forEach((cell: unknown, j: number) => {
        const richText = (cell as { rich_text?: unknown[] })?.rich_text;
        if (!Array.isArray(richText)) return;
        for (const seg of richText as { type?: string; image_token?: string }[]) {
          if (seg.type !== "embed-image" || !seg.image_token) continue;
          out.push({
            row: rowIdx[i],
            column: colIdx[j],
            imageToken: seg.image_token,
            kind: "embed",
          });
        }
      });
    });
  }
  return out;
}

/**
 * 功能: 从 `+float-image-list` 的 JSON 里抽出浮动图, 按 `address` 定位.
 *
 * 关注点: ⚠️ 用 `address`("G3", 1-based), **不要**用 `position.row` —— 后者是
 *   0-based(G3 返回 row:2), 拿它拼行号会整体错一行.
 *   另: 这个接口一次返回**整个 sheet** 的所有浮动图, 没有分页参数. 调用方按行过滤.
 */
export function parseFloatImages(stdout: string, sheetName?: string): FeishuImage[] {
  const obj = JSON.parse(stdout);
  const out: FeishuImage[] = [];
  for (const sheet of obj?.data?.sheets ?? []) {
    if (sheetName && sheet.sheet_name !== sheetName) continue;
    for (const img of sheet.float_images ?? []) {
      const m = /^([A-Z]+)(\d+)$/.exec(String(img.address || ""));
      if (!m || !img.image_token) continue;
      out.push({
        row: parseInt(m[2], 10),
        column: m[1],
        imageToken: img.image_token,
        kind: "float",
      });
    }
  }
  return out;
}

/**
 * 功能: 列出指定行的所有图片(两种贴法都覆盖), 按 列 → 贴法 排序.
 *
 * 关注点: 两个命令都要发, 少发一个就漏一半图, 且表现是"少了几张"而非报错.
 *   浮动图那次拉的是整表, 行多时这一次调用的响应会变大(无分页).
 */
export async function listRowImages(opts: {
  rows: number[];
  lastColumn?: string;       // 内嵌图扫到哪列, 默认 BZ(与 sheets.ts READ_LAST_COLUMN 对齐)
  sheetName: string;
  sheetUrl: string;
}): Promise<FeishuImage[]> {
  const lastCol = opts.lastColumn || "BZ";
  const base = ["--url", opts.sheetUrl, "--sheet-name", opts.sheetName, "--format", "json"];

  const embed: FeishuImage[] = [];
  for (const row of opts.rows) {
    const stdout = await runLarkCli([
      "sheets", "+cells-get",
      ...base,
      "--range", `A${row}:${lastCol}${row}`,
      "--include", "value",
    ]);
    embed.push(...parseEmbedImages(stdout));
  }

  const floatStdout = await runLarkCli(["sheets", "+float-image-list", ...base]);
  const wanted = new Set(opts.rows);
  const floats = parseFloatImages(floatStdout, opts.sheetName).filter((i) => wanted.has(i.row));

  return [...embed, ...floats].sort(
    (a, b) =>
      a.row - b.row ||
      a.column.length - b.column.length ||
      a.column.localeCompare(b.column) ||
      a.kind.localeCompare(b.kind),
  );
}

/**
 * 功能: 下载一张图到 destDir, 返回落盘的绝对路径和字节数.
 *
 * 关注点: lark-cli 的 `-o` 只接受**相对当前目录**的路径, 所以这里把 cwd 设成
 *   destDir 再传裸文件名 —— 传绝对路径会被它拒绝(validation error).
 *   Content-Type 从它返回的 JSON 拿, 用来定扩展名; 拿不到就按 png(实测两种贴图
 *   都是 png, 但飞书也可能给 jpeg, 所以不硬编码).
 */
export async function downloadImage(opts: {
  imageToken: string;
  destDir: string;
  basename: string;          // 不带扩展名
}): Promise<{ filePath: string; mediaType: string; sizeBytes: number }> {
  fs.mkdirSync(opts.destDir, { recursive: true });

  // 先按 png 落盘, 拿到真实 content_type 后再按需改名, 避免下两次.
  const tmpName = `${opts.basename}.download`;
  const stdout = await runLarkCli(
    ["api", "GET", `/open-apis/drive/v1/medias/${opts.imageToken}/download`, "-o", tmpName],
    { cwd: opts.destDir },
  );

  let mediaType = "image/png";
  let sizeBytes = 0;
  try {
    const obj = JSON.parse(stdout.trim());
    if (obj?.ok === false) throw new Error(obj?.error?.message || stdout.trim().slice(0, 300));
    mediaType = obj?.content_type || mediaType;
    sizeBytes = obj?.size_bytes || 0;
  } catch (err) {
    // JSON 解析失败也当失败处理: 拿不到 content_type 说明这次调用不正常.
    throw new Error(`medias download failed for ${opts.imageToken}: ${(err as Error).message}`);
  }

  const ext = mediaTypeToExt(mediaType);
  const tmpPath = path.join(opts.destDir, tmpName);
  const filePath = path.join(opts.destDir, `${opts.basename}${ext}`);
  fs.renameSync(tmpPath, filePath);
  if (!sizeBytes) sizeBytes = fs.statSync(filePath).size;

  return { filePath, mediaType, sizeBytes };
}

// 功能: image/png → ".png". 认不出的类型回退 .png(飞书表格图实测都是 png/jpeg).
export function mediaTypeToExt(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
  };
  return map[mediaType.toLowerCase()] || ".png";
}

/**
 * 功能: 给图片起一个能看出来源的文件名, 如 `R3-F-1`. agent 看到文件名就知道
 *   这图贴在哪一行哪一列, 不需要再回表里对.
 */
export function imageBasename(img: FeishuImage, seqInCell: number): string {
  return `R${img.row}-${img.column}${seqInCell > 1 ? `-${seqInCell}` : ""}`;
}
