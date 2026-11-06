// 项目概览 (overview) —— 单文件 markdown 看板, 存 project_configs (AES-256-GCM 加密).
//
// 定位: 每个项目一份 md, 放「当前状态 + 常用链接 + 凭据备注」. 人读的, 不是给
// agent 消费的自动化配置 —— 所以真相源是**给人看的页面**, 不是 DB.
//
// 为什么存 DB 而不是放 cwd 里的文件:
//   1. 凭据不进 git —— cwd 是仓库目录, 写文件等于把密码提交进版本库. 存
//      project_configs 走 AES-256-GCM 加密 (复用 src/lib/crypto.ts), 密钥来自
//      ENCRYPTION_KEY / JWT_SECRET, 不落盘明文.
//   2. 不依赖 agent 写过这个文件 —— 新建项目即可用, 不必先建仓.
//   3. 项目删了配置自动清 (FK ON DELETE CASCADE, v511 schema).
//
// 为什么复用 project_configs 表而不是新建一张表:
//   表已经在 (v511), 加密模式现成, CASCADE 现成. 概览就是「per-project 的一个
//   KV 项」, 语义完全吻合 —— 新建表是重复造轮子 + 多一处迁移风险.
//
// 关注点:
//   - key 固定 OVERVIEW_CONFIG_KEY. 别的一堆 key (bank_card_no 等) 与它同表,
//     互不干扰 (PK = (project_id, key)).
//   - 大小上限 MAX_OVERVIEW_BYTES: 这是要渲染进浏览器的 markdown, 不是数据文件.
//     超限直接拒 (400), 不静默截断 —— 截断会让用户以为存全了.
//   - 解密失败一律当「不存在」(404), 不抛 500 —— ENCRYPTION_KEY 漂移不应该让
//     整个项目页挂掉. 与 project-configs.ts 的既有口径一致.

import { getDb } from "./index";
import { encrypt, decrypt } from "@/lib/crypto";

/** project_configs 表里存概览正文的 key. */
export const OVERVIEW_CONFIG_KEY = "overview_md";

/** 概览正文大小上限 (字节). 64 KiB 足够写一屏看板, 又能挡住误粘大文件. */
export const MAX_OVERVIEW_BYTES = 64 * 1024;

export interface ProjectOverview {
  /** markdown 正文 (未加密态). */
  markdown: string;
  /** 最后更新时间 (ISO 串). */
  updated_at: string;
  /** 最后写入者 user_id (null = 历史数据/未知). */
  updated_by: string | null;
}

/**
 * 功能: 读某项目的概览正文. 不存在 / 解密失败一律返 null.
 * 关注点:
 *  - 解密失败静默降级成 null (视作「没写过」), 与 project-configs.ts 口径一致.
 *  - 只查这一个 key, 不扫全表 —— 全表扫 + 逐条解密在 key 多时会白烧 CPU.
 */
export function getProjectOverview(projectId: string): ProjectOverview | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT encrypted_value, iv, tag, updated_at, updated_by FROM project_configs WHERE project_id = ? AND key = ?"
    )
    .get(projectId, OVERVIEW_CONFIG_KEY) as
    | {
        encrypted_value: string;
        iv: string;
        tag: string;
        updated_at: string;
        updated_by: string | null;
      }
    | undefined;
  if (!row) return null;
  try {
    const markdown = decrypt(row.encrypted_value, row.iv, row.tag);
    return {
      markdown,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  } catch (err) {
    console.warn(
      `[project-overview] decrypt failed for ${projectId}:`,
      (err as Error).message
    );
    return null;
  }
}

/**
 * 功能: 写某项目的概览正文 (upsert). 返回落库后的元信息.
 * 关注点:
 *  - 正文先过大小校验 (超限 throw), 避免把超大内容写进 DB 再在读取时才发现.
 *  - updated_by 记当前操作者, 让页面上能看出「谁最后写的」.
 *  - upsert (ON CONFLICT DO UPDATE) —— 二次写是覆盖语义, 不报错.
 */
export function setProjectOverview(
  projectId: string,
  markdown: string,
  updatedBy: string
): ProjectOverview {
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_OVERVIEW_BYTES) {
    throw new Error(
      `概览内容过大: ${bytes} 字节 (上限 ${MAX_OVERVIEW_BYTES} 字节)`
    );
  }
  const db = getDb();
  const { encrypted, iv, tag } = encrypt(markdown);
  db.prepare(
    `INSERT INTO project_configs (project_id, key, encrypted_value, iv, tag, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(project_id, key) DO UPDATE SET
       encrypted_value = excluded.encrypted_value,
       iv = excluded.iv,
       tag = excluded.tag,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`
  ).run(projectId, OVERVIEW_CONFIG_KEY, encrypted, iv, tag, updatedBy);
  const row = db
    .prepare(
      "SELECT updated_at, updated_by FROM project_configs WHERE project_id = ? AND key = ?"
    )
    .get(projectId, OVERVIEW_CONFIG_KEY) as
    | { updated_at: string; updated_by: string | null }
    | undefined;
  return {
    markdown,
    updated_at: row?.updated_at ?? new Date().toISOString(),
    updated_by: row?.updated_by ?? updatedBy,
  };
}

/**
 * 功能: 删掉某项目的概览. 返 true = 真删了, false = 本来就没有.
 */
export function deleteProjectOverview(projectId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM project_configs WHERE project_id = ? AND key = ?")
    .run(projectId, OVERVIEW_CONFIG_KEY);
  return result.changes > 0;
}
