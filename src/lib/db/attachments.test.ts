// Tests for attachment media-type whitelist + extension fallback.
// 覆盖 2026-08-20 的白名单扩展 (xlsx/docx/pptx 等 Office 格式).
// 跑法: npx vitest run src/lib/db/attachments.test.ts

import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_EXT_MIME,
  ATTACHMENT_ALLOWED_TYPES,
  isAllowedAttachmentMediaType,
  resolveAttachmentMediaType,
} from "./attachments";

describe("ATTACHMENT_EXT_MIME", () => {
  it("包含 Office 现代 (OOXML) 三件套", () => {
    expect(ATTACHMENT_EXT_MIME.xlsx).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(ATTACHMENT_EXT_MIME.docx).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(ATTACHMENT_EXT_MIME.pptx).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("包含 Office 旧版 (xls/doc/ppt)", () => {
    expect(ATTACHMENT_EXT_MIME.xls).toBe("application/vnd.ms-excel");
    expect(ATTACHMENT_EXT_MIME.doc).toBe("application/msword");
    expect(ATTACHMENT_EXT_MIME.ppt).toBe("application/vnd.ms-powerpoint");
  });

  it("包含 OpenDocument + rtf", () => {
    expect(ATTACHMENT_EXT_MIME.odt).toBe("application/vnd.oasis.opendocument.text");
    expect(ATTACHMENT_EXT_MIME.ods).toBe("application/vnd.oasis.opendocument.spreadsheet");
    expect(ATTACHMENT_EXT_MIME.rtf).toBe("application/rtf");
  });

  it("key 全部小写 (与 ext 解析保持一致)", () => {
    for (const k of Object.keys(ATTACHMENT_EXT_MIME)) {
      expect(k).toBe(k.toLowerCase());
    }
  });
});

describe("isAllowedAttachmentMediaType", () => {
  it("通过 Office OOXML", () => {
    expect(isAllowedAttachmentMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
  });

  it("通过 Office 旧版 + OpenDocument + rtf", () => {
    expect(isAllowedAttachmentMediaType("application/vnd.ms-excel")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/msword")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/vnd.ms-powerpoint")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/vnd.oasis.opendocument.text")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/rtf")).toBe(true);
  });

  it("通过 image/*", () => {
    expect(isAllowedAttachmentMediaType("image/png")).toBe(true);
    expect(isAllowedAttachmentMediaType("image/jpeg")).toBe(true);
    expect(isAllowedAttachmentMediaType("image/svg+xml")).toBe(true);
  });

  it("通过 text/*", () => {
    expect(isAllowedAttachmentMediaType("text/plain")).toBe(true);
    expect(isAllowedAttachmentMediaType("text/markdown")).toBe(true);
    expect(isAllowedAttachmentMediaType("text/csv")).toBe(true);
  });

  it("通过 application/x-tar 前缀 (覆盖 .tar / .tar.gz / .tgz)", () => {
    expect(isAllowedAttachmentMediaType("application/x-tar")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/x-tar+gzip")).toBe(true);
  });

  it("通过 application/pdf / zip / gzip / json", () => {
    for (const mt of ["application/pdf", "application/zip", "application/gzip", "application/json"]) {
      expect(isAllowedAttachmentMediaType(mt)).toBe(true);
    }
  });

  it("拒掉空 / 未知类型", () => {
    expect(isAllowedAttachmentMediaType("")).toBe(false);
    expect(isAllowedAttachmentMediaType("application/x-msdownload")).toBe(false); // 旧 .exe
    expect(isAllowedAttachmentMediaType("video/mp4")).toBe(false);
    expect(isAllowedAttachmentMediaType("audio/mpeg")).toBe(false);
    expect(isAllowedAttachmentMediaType("application/octet-stream")).toBe(false);
  });

  it("ATTACHMENT_ALLOWED_TYPES 与白名单判断一致 (无遗漏)", () => {
    // 任何在白名单里标了的具体 mime 都应被 isAllowedAttachmentMediaType 接受
    for (const mt of ATTACHMENT_ALLOWED_TYPES) {
      expect(isAllowedAttachmentMediaType(mt)).toBe(true);
    }
  });
});

describe("resolveAttachmentMediaType", () => {
  it("客户端给真实 type 时直接用, 不查扩展名", () => {
    expect(resolveAttachmentMediaType("application/pdf", "fake.png")).toBe("application/pdf");
    expect(resolveAttachmentMediaType("image/png", "fake.jpg")).toBe("image/png");
  });

  it("application/octet-stream 视同'没说', 落回扩展名表 (含 Office)", () => {
    expect(resolveAttachmentMediaType("application/octet-stream", "data.xlsx"))
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(resolveAttachmentMediaType("application/octet-stream", "report.docx"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(resolveAttachmentMediaType("application/octet-stream", "deck.pptx"))
      .toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    // 同时 .md 仍要能兜住 (回归: ao-session.sh import 踩过)
    expect(resolveAttachmentMediaType("application/octet-stream", "notes.md"))
      .toBe("text/markdown");
  });

  it("大写扩展名也兜得住 (EXT_MIME 全部小写 key)", () => {
    expect(resolveAttachmentMediaType("", "DATA.XLSX"))
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("扩展名查不到时回落到 file.type / 空串", () => {
    expect(resolveAttachmentMediaType("application/octet-stream", "blob.bin"))
      .toBe("application/octet-stream"); // 兜底失败, 仍保留 client 原始值供上层诊断
    expect(resolveAttachmentMediaType("", "blob.bin")).toBe("");
  });
});

// v69 polymorphic (飞书 R71): createAttachment 强制 task_id / requirement_id 二选一
// (DB CHECK XOR 兜底, 应用层显式校验报错更友好).
describe("createAttachment polymorphic (v69)", () => {
  it("两个都设 → 抛错", async () => {
    const { createAttachment } = await import("./attachments");
    expect(() =>
      createAttachment({
        owner_id: "u1",
        filename: "x.png",
        media_type: "image/png",
        size_bytes: 1,
        storage_path: "/tmp/x",
        source: "upload",
        task_id: "t1",
        requirement_id: "r1",
      }),
    ).toThrow(/exactly one of task_id \/ requirement_id/);
  });

  it("两个都不设 → 抛错", async () => {
    const { createAttachment } = await import("./attachments");
    expect(() =>
      createAttachment({
        owner_id: "u1",
        filename: "x.png",
        media_type: "image/png",
        size_bytes: 1,
        storage_path: "/tmp/x",
        source: "upload",
      }),
    ).toThrow(/exactly one of task_id \/ requirement_id/);
  });
});
