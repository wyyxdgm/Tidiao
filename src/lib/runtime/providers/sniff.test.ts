// sniff.ts magic-byte 嗅探单测. 拼真实 magic bytes 验所有 6 种格式 + 不匹配兜底.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { sniffMediaType } from "./sniff";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sniff-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, bytes: number[] | Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

describe("sniffMediaType", () => {
  it("识别 PNG (89 50 4E 47 0D 0A 1A 0A)", () => {
    const p = write("a.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(sniffMediaType(p)).toEqual({ mediaType: "image/png", ext: "png" });
  });

  it("识别 JPEG (FF D8 FF)", () => {
    // JFIF: FF D8 FF E0 .... (SOI + APP0). Exif 也能识别 (FF D8 FF E1).
    const p = write("a.jpg", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffMediaType(p)).toEqual({ mediaType: "image/jpeg", ext: "jpg" });
  });

  it("识别 WebP (RIFF ... WEBP)", () => {
    const p = write(
      "a.webp",
      [
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size
        0x57, 0x45, 0x42, 0x50, // WEBP
      ],
    );
    expect(sniffMediaType(p)).toEqual({ mediaType: "image/webp", ext: "webp" });
  });

  it("识别 GIF89a", () => {
    const p = write("a.gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
    expect(sniffMediaType(p)).toEqual({ mediaType: "image/gif", ext: "gif" });
  });

  it("识别 MP4 (ftyp box + isom brand)", () => {
    const p = write(
      "a.mp4",
      [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], // ....ftypisom
    );
    expect(sniffMediaType(p)).toEqual({ mediaType: "video/mp4", ext: "mp4" });
  });

  it("识别 MP4 (qt brand → MOV 仍归 video/mp4)", () => {
    const p = write(
      "a.mov",
      [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20], // ....ftypqt
    );
    expect(sniffMediaType(p)).toEqual({ mediaType: "video/mp4", ext: "mp4" });
  });

  it("识别 WebM (1A 45 DF A3)", () => {
    const p = write("a.webm", [0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);
    expect(sniffMediaType(p)).toEqual({ mediaType: "video/webm", ext: "webm" });
  });

  it("未知格式返回 null (不抛错)", () => {
    const p = write("a.bin", [0x00, 0x01, 0x02, 0x03]);
    expect(sniffMediaType(p)).toBeNull();
  });

  it("ENOENT 返回 null (不抛)", () => {
    expect(sniffMediaType(path.join(tmpDir, "nope.bin"))).toBeNull();
  });

  it("空文件返回 null", () => {
    const p = write("empty.bin", []);
    expect(sniffMediaType(p)).toBeNull();
  });
});