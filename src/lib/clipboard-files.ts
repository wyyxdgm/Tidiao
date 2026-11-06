// 功能: 从剪贴板 / 拖拽的 DataTransfer 抽出 File 列表, 并给无名字的 blob 补一个可上传名.
// 关注点: 这是前端 helper — 不做媒体类型白名单校验, 由 /api/tasks/[id]/attachments
//   后端按 src/lib/db/attachments.ts 的 ATTACHMENT_ALLOWED_TYPES 兜底. 这里只负责
//   "拿出来"+"起个名字", 让用户能在 pendingFiles chip 上看到刚粘的东西.

const PASTED_EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/html": "html",
  "text/markdown": "md",
  "application/pdf": "pdf",
};

export function nameForPastedFile(file: File, fallback: string): File {
  if (file.name) return file;
  const ext = PASTED_EXT_BY_MIME[file.type] ?? "bin";
  return new File([file], `pasted-${Date.now()}-${fallback}.${ext}`, {
    type: file.type,
  });
}

// 功能: 从 DataTransfer (粘贴板 / 拖拽) 抽出 File 列表.
// 关注点: items 路径优先 (粘贴板图片用 kind="file"), 没 items 时回退到 files (拖拽).
//   dt.items + dt.files 在浏览器里都是只读 DataTransferItemList / FileList 视图,
//   调用方负责 e.preventDefault() 决定是否接管粘贴/拖拽 (纯文字粘贴要走默认行为).
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const items = dt.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(nameForPastedFile(f, String(i)));
      }
    }
    if (out.length) return out;
  }
  if (dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      out.push(nameForPastedFile(dt.files[i], String(i)));
    }
  }
  return out;
}