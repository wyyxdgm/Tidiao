// Magic-byte 文件头嗅探: 给定本地路径, 返回真实 media_type + 对应 ext.
// 用途: Provider (mmx) 默认按 --model / --format 推 mediaType, 但 mmx image-01
//   实际产出 JPEG 字节而我们以为是 PNG —— 浏览器能渲染 (sniff), 但下载文件
//   扩展名错 / media_type 错会让 video 标签静默失败. 所以落盘后立刻头嗅,
//   跟实际不符就改 mediaType + 重命名文件 (用真实 ext).
//
// 关注点:
//   - 仅读前 16 字节 (大头 PNG 8B / JPEG 2B / MP4 ftyp 在 offset 4 / WebP "RIFF"
//     14B). 不读全文件, 大文件零开销.
//   - 失败 = 返回 null. 上层 fallback 到 caller 提供的默认值, 不抛错.
//   - 命名空间化在 providers/ 内, 给未来 sora / runway 复用 (不同 vendor 的
//     mediaType 兜底同样适用).

import fs from "fs";

export interface SniffResult {
  mediaType: string;  // e.g. "image/jpeg"
  ext: string;        // e.g. "jpg", no leading dot
}

// 各格式 magic + mediaType + 推荐 ext 映射表.
// 顺序敏感 (RIFF/WebP 需 RIFF 头 + WEBP 签名).
  const SIGNATURES: Array<{
    mediaType: string;
    ext: string;
    match: (head: Buffer) => boolean;
  }> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    mediaType: "image/png",
    ext: "png",
    match: (h) =>
      h.length >= 8 &&
      h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47 &&
      h[4] === 0x0d && h[5] === 0x0a && h[6] === 0x1a && h[7] === 0x0a,
  },
  // JPEG: FF D8 FF (JFIF / Exif / RAW 都同开头)
  {
    mediaType: "image/jpeg",
    ext: "jpg",
    match: (h) => h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  },
  // WebP: "RIFF" .... "WEBP"
  {
    mediaType: "image/webp",
    ext: "webp",
    match: (h) =>
      h.length >= 12 &&
      h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && // "RIFF"
      h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50,   // "WEBP"
  },
  // GIF: "GIF87a" / "GIF89a"
  {
    mediaType: "image/gif",
    ext: "gif",
    match: (h) =>
      h.length >= 6 &&
      h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38 &&
      (h[4] === 0x37 || h[4] === 0x39) && h[5] === 0x61,
  },
  // MP4 / MOV: ftyp box at offset 4, brand = isom / mp42 / mp41 / qt (MOV).
  // 读 brand = bytes[8..11]. 不区分 mov/mp4 (mmx 都产 mp4, ext 都走 mp4).
  {
    mediaType: "video/mp4",
    ext: "mp4",
    match: (h) => {
      if (h.length < 12) return false;
      if (h[4] !== 0x66 || h[5] !== 0x74 || h[6] !== 0x79 || h[7] !== 0x70) return false; // "ftyp"
      const brand =
        String.fromCharCode(h[8], h[9], h[10], h[11]);
      return ["isom", "mp42", "mp41", "dash", "avc1", "qt  "].includes(brand);
    },
  },
  // 兜底: WebM
  {
    mediaType: "video/webm",
    ext: "webm",
    match: (h) =>
      h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3,
  },
];

// 功能: 嗅探本地文件真实 media_type + 扩展名. 失败返回 null.
// 关注点: 只读前 16 字节 (足够覆盖所有已知格式 magic, 大文件零开销).
//   ENOENT / EACCES 返回 null (而不是抛) — 让调用方走自己的默认值 + warn.
export function sniffMediaType(filePath: string): SniffResult | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, head, 0, 16, 0);
    if (bytesRead === 0) return null;
    const trimmed = head.subarray(0, bytesRead);
    for (const sig of SIGNATURES) {
      if (sig.match(trimmed)) {
        return { mediaType: sig.mediaType, ext: sig.ext };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
