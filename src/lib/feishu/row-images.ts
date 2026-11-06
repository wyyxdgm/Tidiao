// 把飞书表格里某些行的图片取回来, 落成对应 task 的 attachments.
//
// 为什么单独一层: images.ts 只管"怎么跟飞书说话"(纯 lark-cli), db/attachments.ts
// 只管"文件怎么存/怎么 symlink". 这里是唯一知道两边的地方, 让 sync route 一行调用.

import fs from "fs";
import path from "path";
import { listRowImages, downloadImage, imageBasename, type FeishuImage } from "./images";
import { createAttachment, resolveTaskCwd, linkIntoTaskCwd } from "../db/attachments";
import { ORCHESTRATOR_HOME } from "../constants";

export interface FetchedImage {
  filename: string;    // task cwd 下 attachments/ 里的名字
  localPath: string;   // agent 直接能 Read 的绝对路径
}

/**
 * 功能: 一次列出多行的图, 返回 `{ byRow, error }`. 取图失败时 byRow 为空且 error 有值.
 *
 * 关注点: 必须**一次问多行**, 不要每行调一次 —— `+float-image-list` 每次都返回
 *   整个 sheet 的浮动图(无分页/无行过滤), 按行调 N 次就是 N 次整表拉取.
 *   整体 best-effort: lark-cli 未登录 / 不在 PATH / 网络 / 权限问题都不抛 —— 图是
 *   补充材料, 不该让整个 sync 500.
 *   🔴 但**必须把 error 回传给调用方**, 不能只 console.warn: 否则"取图挂了"和
 *   "这行确实没图"都表现为 `images: 0`, 完全无法区分. 实测踩过 —— WSL 上 lark-cli
 *   装在另一个 node 版本的 bin 下, 取图全挂, 而接口一切正常返回 images:0.
 */
export async function listImagesByRow(opts: {
  rows: number[];
  sheetUrl: string;
  sheetName: string;
}): Promise<{ byRow: Map<number, FeishuImage[]>; error?: string }> {
  const byRow = new Map<number, FeishuImage[]>();
  if (opts.rows.length === 0) return { byRow };
  let images: FeishuImage[];
  try {
    images = await listRowImages({
      rows: opts.rows,
      sheetName: opts.sheetName,
      sheetUrl: opts.sheetUrl,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[feishu] listRowImages failed for rows ${opts.rows.join(",")}: ${msg}`);
    return { byRow, error: msg };
  }
  for (const img of images) {
    const list = byRow.get(img.row);
    if (list) list.push(img);
    else byRow.set(img.row, [img]);
  }
  return { byRow };
}

/**
 * 功能: 下载给定的图 → 存盘 + symlink 进 task cwd + 写 attachments 表,
 *   返回可直接写进 prompt 的本地绝对路径列表.
 *
 * 关注点: 单张失败只跳过那一张(warn), 其余继续 —— 一张图坏掉不该让整个需求点没图.
 *   一格多张(浮动图允许)靠 imageBasename 的 seq 后缀区分; symlink 撞名时
 *   linkIntoTaskCwd 还会再加 _1, 所以**最终名以它的返回值为准**, 不是 basename.
 */
export async function saveImagesToTask(opts: {
  images: FeishuImage[];
  taskId: string;
  ownerId: string;
  task: { cwd: string | null; project_id: string | null; id: string };
}): Promise<FetchedImage[]> {
  if (opts.images.length === 0) return [];

  const storageDir = path.join(ORCHESTRATOR_HOME, "uploads", opts.ownerId, opts.taskId);
  fs.mkdirSync(storageDir, { recursive: true });
  const cwd = resolveTaskCwd(opts.task);

  const out: FetchedImage[] = [];
  let prevKey = "";
  let seq = 0;
  for (const img of opts.images) {
    // 同一格多张时给 seq 后缀. listRowImages 已按 行→列→贴法 排序, prevKey 计数够用.
    const key = `${img.row}-${img.column}`;
    if (key === prevKey) seq += 1;
    else { prevKey = key; seq = 1; }

    try {
      const { filePath, mediaType, sizeBytes } = await downloadImage({
        imageToken: img.imageToken,
        destDir: storageDir,
        basename: imageBasename(img, seq),
      });
      const linkName = linkIntoTaskCwd(cwd, path.basename(filePath), filePath);
      createAttachment({
        task_id: opts.taskId,
        owner_id: opts.ownerId,
        filename: linkName,
        media_type: mediaType,
        size_bytes: sizeBytes,
        storage_path: filePath,
        source: "reference",   // 不是用户上传, 是从飞书拉回来的
      });
      out.push({ filename: linkName, localPath: path.join(cwd, "attachments", linkName) });
    } catch (err) {
      console.warn(`[feishu] download ${img.imageToken} (R${img.row}${img.column}) failed: ${(err as Error).message}`);
    }
  }
  return out;
}
