// Attachment CRUD + file/symlink cleanup
//
// An attachment is a user-uploaded file scoped to either a task or a
// requirement (v69 polymorphic — 飞书 R71). The bytes live on disk at:
//
//   - task attachment:        $ORCHESTRATOR_HOME/uploads/{owner}/{task}/{uuid}.{ext}
//                             (历史路径, 不要改, 已有 DB 行 storage_path 引用着)
//   - requirement attachment: $ORCHESTRATOR_HOME/uploads/{owner}/requirements/{requirement_id}/{uuid}.{ext}
//
//   - task attachment: a friendly symlink is created in the task cwd so the
//     agent can reference the file by its original filename.
//   - requirement attachment: no symlink (requirements have no agent cwd);
//     files are surfaced via GET /api/attachments/[id] only.
//
// deleteAttachment() removes the file, the symlink (task only), and the DB
// row together so no orphaned bytes remain.

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import { getTaskById } from "./tasks";
import { ORCHESTRATOR_HOME } from "../constants";
import type { Attachment } from "../runtime/types";

/** v69 polymorphic attachment input — task_id 或 requirement_id, 必须恰好传一个. */
export type AttachmentInput = Omit<
  Attachment,
  "id" | "created_at" | "metadata" | "task_id" | "requirement_id"
> & {
  task_id?: string | null;
  requirement_id?: string | null;
  /** R121: agent-generated attachment 的 JSON 元数据 (nullable). 兼容老 attachment (upload/fork) 不传. */
  metadata?: string | null;
};

/** saveAttachmentFromFile 的 parent 入参. 飞书 R71 polymorphic. */
export type AttachmentParent =
  | {
      kind: "task";
      id: string;
      owner_id: string | null;
      cwd: string | null;
      project_id: string | null;
    }
  | {
      kind: "requirement";
      id: string;
      owner_id: string | null;
    };

// Ext -> media type for the (common) case where the browser sends no file.type.
// Lets text files, archives, and Office documents still pass the whitelist by
// extension. Keys must stay lowercase.
export const ATTACHMENT_EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  pdf: "application/pdf", zip: "application/zip",
  tar: "application/x-tar", gz: "application/gzip", tgz: "application/gzip",
  json: "application/json",
  jsonl: "text/plain",
  txt: "text/plain", md: "text/markdown", csv: "text/csv",
  html: "text/html", xml: "text/xml", log: "text/plain",
  js: "text/javascript", ts: "text/plain", py: "text/plain",
  yml: "text/plain", yaml: "text/plain", sh: "text/plain",
  // Office — modern (OOXML) + legacy. White-list is open to more if a use
  // case shows up; the agent can't read the binary content regardless, so
  // these are stored for the user/operator to inspect, not for the agent.
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  dot: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
};

// 关注点: prefix-match 放在前面避免漏掉 application/x-tar+gzip 等组合。
// 加新格式要三处同步：ATTACHMENT_EXT_MIME (扩展名) + 这里的白名单 + 上传路由的
// size 限制（Office 文档通常很小, 不需要单独调）。
export const ATTACHMENT_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
]);

// 功能: 定出上传文件的 media type, 供白名单校验.
// 关注点: application/octet-stream 视同"没告诉我类型" —— curl -F 上传时默认就是它,
//   若直接采信, 合法的 .md/.jsonl/.xlsx 会被白名单挡成 415 (ao-session.sh import 踩过).
//   用 `-F "file=@x.md;type=text/markdown"` 显式给类型最稳.
export function resolveAttachmentMediaType(fileType: string, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (fileType && fileType !== "application/octet-stream") return fileType;
  return ATTACHMENT_EXT_MIME[ext] || fileType || "";
}

export function isAllowedAttachmentMediaType(mt: string): boolean {
  if (!mt) return false;
  if (mt.startsWith("image/")) return true;
  if (mt.startsWith("text/")) return true;
  if (mt.startsWith("application/x-tar")) return true;
  return ATTACHMENT_ALLOWED_TYPES.has(mt);
}

export function createAttachment(att: AttachmentInput): Attachment {
  // v69 polymorphic: task_id / requirement_id 必须恰好一个 (DB 层 CHECK 兜底,
  // 应用层显式校验, 报错更友好).
  const taskId = att.task_id ?? null;
  const requirementId = att.requirement_id ?? null;
  if ((taskId === null) === (requirementId === null)) {
    throw new Error("createAttachment: exactly one of task_id / requirement_id must be set");
  }
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO attachments (id, task_id, owner_id, filename, media_type, size_bytes, storage_path, source, metadata, requirement_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    att.owner_id,
    att.filename,
    att.media_type,
    att.size_bytes,
    att.storage_path,
    att.source || "upload",
    att.metadata ?? null,
    requirementId,
  );
  const row = getAttachmentById(id);
  if (!row) throw new Error("createAttachment: failed to read back row");
  return row;
}

export function getAttachmentById(id: string, userId?: string): Attachment | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Attachment | undefined;
  if (!row) return null;
  // owner isolation: a non-owner gets null (404 at the route layer) so
  // existence is never leaked cross-tenant.
  if (userId !== undefined && row.owner_id !== userId) return null;
  return row;
}

export function listAttachmentsByTaskId(taskId: string, userId?: string): Attachment[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as Attachment[];
  if (userId !== undefined) return rows.filter((r) => r.owner_id === userId);
  return rows;
}

/** v69 polymorphic (飞书 R71): 列 requirement 附件. 与 listAttachmentsByTaskId 同口径. */
export function listAttachmentsByRequirementId(
  requirementId: string,
  userId?: string,
): Attachment[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM attachments WHERE requirement_id = ? ORDER BY created_at ASC",
    )
    .all(requirementId) as Attachment[];
  if (userId !== undefined) return rows.filter((r) => r.owner_id === userId);
  return rows;
}

// Resolve a task's working directory using the same fallback chain as
// ActiveSession (task.cwd > $HOME/projects/{pid}/{tid} > workspace/{tid}).
// Duplicated here to keep the DB module free of a runtime import; exported so
// the upload route can build the friendly symlink in the same cwd.
export function resolveTaskCwd(task: { cwd: string | null; project_id: string | null; id: string }): string {
  return task.cwd || (task.project_id
    ? path.join(ORCHESTRATOR_HOME, "projects", task.project_id, task.id)
    : path.join(ORCHESTRATOR_HOME, "workspace", task.id));
}

/**
 * 功能: 在 task cwd 的 attachments/ 下建一个友好名 symlink 指向实际存储路径,
 *   返回**最终使用的文件名**(可能带 _1/_2 后缀).
 *
 * 关注点: 返回值必须被当成 attachment.filename 存进 DB, **不能存原始文件名** ——
 *   否则同名上传时 deleteAttachment 和 prompt 里的路径会指向另一个附件的 link,
 *   而那个 link 自己变成孤儿.
 *   WSL/Windows 无 dev mode 时 symlink 会失败, 降级为 copy(仍可读, 只是不同步).
 */
export function linkIntoTaskCwd(cwd: string, filename: string, storagePath: string): string {
  const linkDir = path.join(cwd, "attachments");
  fs.mkdirSync(linkDir, { recursive: true });
  let linkName = filename;
  let linkPath = path.join(linkDir, linkName);
  if (fs.existsSync(linkPath)) {
    const parsed = path.parse(filename);
    let i = 1;
    do {
      linkName = `${parsed.name}_${i}${parsed.ext}`;
      linkPath = path.join(linkDir, linkName);
      i++;
    } while (fs.existsSync(linkPath));
  }
  try {
    fs.symlinkSync(storagePath, linkPath);
  } catch {
    try {
      fs.copyFileSync(storagePath, linkPath);
    } catch {
      /* best-effort: file is still reachable via storage_path */
    }
  }
  return linkName;
}

export function deleteAttachment(id: string, userId?: string): boolean {
  const att = getAttachmentById(id, userId);
  if (!att) return false;
  const db = getDb();

  // Remove the stored file (best-effort; may already be gone).
  try {
    fs.unlinkSync(att.storage_path);
  } catch {
    /* ignore */
  }

  // v69 polymorphic: 只有 task attachment 才有 cwd symlink 要清理.
  // requirement attachment 直接走 GET /api/attachments/[id] 下载, 不需要 symlink.
  if (att.task_id) {
    const task = getTaskById(att.task_id, userId);
    if (task) {
      const linkPath = path.join(resolveTaskCwd(task), "attachments", att.filename);
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* symlink may not exist */
      }
    }
  }

  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  return true;
}

// 功能: 把一个上传文件落到 $ORCHESTRATOR_HOME/uploads/{owner}/{parent_kind}/{parent_id}/{uuid}.{ext},
//   task parent 还会在 cwd 下建友好名 symlink, requirement parent 不需要 symlink (没 cwd),
//   落 DB 行, 返回 attachment 记录.
// 关注点: 不校验 media type —— 调用方要先过 isAllowedAttachmentMediaType(),
//   这样 fork/chat/new-task/new-requirement 四处都能复用同一段写盘逻辑而不互相耦合白名单策略.
//   source 类型扩展了 "agent_generated" (R121) 让 agent 端走同一段写盘逻辑,
//   metadata 字段由 agent 端 JSON.stringify 后传入, NULL 表示无元数据.
//   v69 polymorphic (飞书 R71): parent.kind 决定存哪个目录 + 建不建 symlink.
export async function saveAttachmentFromFile(
  parent: AttachmentParent,
  ownerId: string,
  file: { name: string; type?: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  opts: { source?: "upload" | "fork" | "agent_generated"; mediaType?: string; metadata?: string } = {},
): Promise<Attachment> {
  const filename = file.name || "upload";
  // 调用方可传显式 mediaType (例如已校验过 resolveAttachmentMediaType),
  // 缺省时回退到通用解析. 不强制依赖 file.type —— 浏览器/curl 行为差异太大.
  const mediaType = opts.mediaType ?? resolveAttachmentMediaType(file.type || "", filename);
  const ext = path.extname(filename); // ".png" or ""
  const storedName = `${uuidv4()}${ext}`;
  // task 用历史扁平路径 (uploads/{owner}/{task}/{uuid}.{ext}) 不动, 避免破坏
  // 已有 DB 行 storage_path. requirement 走 requirements/ 子目录避免与 task 撞 hash.
  const storageDir =
    parent.kind === "task"
      ? path.join(ORCHESTRATOR_HOME, "uploads", ownerId, parent.id)
      : path.join(ORCHESTRATOR_HOME, "uploads", ownerId, "requirements", parent.id);
  fs.mkdirSync(storageDir, { recursive: true });
  const storagePath = path.join(storageDir, storedName);
  fs.writeFileSync(storagePath, Buffer.from(await file.arrayBuffer()));

  let linkName: string | null = null;
  if (parent.kind === "task") {
    const cwd = resolveTaskCwd(parent as any);
    linkName = linkIntoTaskCwd(cwd, filename, storagePath);
  }

  return createAttachment({
    task_id: parent.kind === "task" ? parent.id : null,
    requirement_id: parent.kind === "requirement" ? parent.id : null,
    owner_id: ownerId,
    filename: linkName ?? filename,
    media_type: mediaType,
    size_bytes: file.size,
    storage_path: storagePath,
    source: opts.source || "upload",
    metadata: opts.metadata ?? null,
  });
}

// 功能: agent 端把已写好的本地文件注册成 task attachment (R121).
//   - sourcePath 必须在 task cwd 子树 或 $ORCHESTRATOR_HOME/uploads/{owner}/{task}
//     子树下, realpath 校验防 symlink escape.
//   - 不接受 multipart — agent 端用 JSON body 一行 curl 注册即可, 避免 10MB base64
//     浪费带宽. 内部 fs.copyFileSync 复制到 storageDir, 复用 linkIntoTaskCwd 落
//     friendly symlink, 复用 createAttachment 落 DB 行 (含 metadata 字段).
// 关注点: 与 saveAttachmentFromFile 对称, 但源是磁盘路径不是 FormData File.
//   size 取自 fs.statSync (不是请求 body), 上限同 10MB (复用 MAX_SIZE).
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

export interface RegisterAttachmentOpts {
  filename: string;
  mediaType: string;
  source?: "agent_generated";
  metadata?: string;
}

export function registerAttachmentFromPath(
  task: { id: string; owner_id: string | null; cwd: string | null; project_id: string | null },
  ownerId: string,
  sourcePath: string,
  opts: RegisterAttachmentOpts,
): { ok: true; attachment: Attachment } | { ok: false; reason: string } {
  // 1. 解析 sourcePath, realpath 防 symlink escape
  let realSource: string;
  try {
    realSource = fs.realpathSync(sourcePath);
  } catch {
    return { ok: false, reason: `source file not found: ${sourcePath}` };
  }
  if (!fs.existsSync(realSource) || !fs.statSync(realSource).isFile()) {
    return { ok: false, reason: `source path is not a regular file: ${sourcePath}` };
  }

  // 2. 越界校验: realSource 必须在 cwd 子树 或 uploads 子树下
  const cwd = resolveTaskCwd(task as any);
  const uploadsDir = path.join(ORCHESTRATOR_HOME, "uploads", ownerId, task.id);
  const allowedDirs = [path.resolve(cwd), path.resolve(uploadsDir)];
  const allowed = allowedDirs.some(
    (d) => realSource.startsWith(d + path.sep) || realSource === d,
  );
  if (!allowed) {
    return {
      ok: false,
      reason: `file_path must be inside task cwd or uploads dir (got: ${realSource})`,
    };
  }

  // 3. size 上限
  const stat = fs.statSync(realSource);
  if (stat.size > MAX_ATTACHMENT_SIZE) {
    return { ok: false, reason: `file too large (max ${MAX_ATTACHMENT_SIZE} bytes)` };
  }

  // 4. media type 白名单
  if (!isAllowedAttachmentMediaType(opts.mediaType)) {
    return { ok: false, reason: `unsupported media type: ${opts.mediaType}` };
  }

  // 5. 复制到 storageDir + 建 symlink + 落 DB
  const ext = path.extname(opts.filename); // ".png" or ""
  const storedName = `${uuidv4()}${ext}`;
  const storageDir = path.join(ORCHESTRATOR_HOME, "uploads", ownerId, task.id);
  fs.mkdirSync(storageDir, { recursive: true });
  const storagePath = path.join(storageDir, storedName);
  fs.copyFileSync(realSource, storagePath);
  const linkName = linkIntoTaskCwd(cwd, opts.filename, storagePath);
  const attachment = createAttachment({
    task_id: task.id,
    owner_id: ownerId,
    filename: linkName,
    media_type: opts.mediaType,
    size_bytes: stat.size,
    storage_path: storagePath,
    source: opts.source || "agent_generated",
    metadata: opts.metadata ?? null,
  });
  return { ok: true, attachment };
}
