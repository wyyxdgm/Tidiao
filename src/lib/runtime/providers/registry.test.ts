// registry / mmx provider 单元测试.
// 关注点:
//   - registry: set/get/list/getDefault 行为.
//   - mmx provider: 拼 args 正确 (验证 --prompt / --aspect-ratio / --width/height /
//     --out / --download 等); 文件实际生成后 descriptor.mediaType / sizeBytes 准;
//     metadata 字段透传 (model / prompt / aspect_ratio / duration_seconds).
//   - 失败语义: stderr 含特定关键字 → 抛 ProviderError (missing_credentials /
//     quota_exceeded / vendor_unavailable / timeout).
//
// 策略: child_process 在 ESM 不可 spy, vi.mock("child_process") 也偶尔不稳
//   (vitest 4 改 hoist 行为). 改成把 MmxProvider 的 binary 注入到我们的 fake
//   shell 脚本, 让 mmx.ts 调真 shell 进程但被我们劫持 — 验证 provider 的 arg
//   拼法 + 文件落盘 + stdout 解析 + 错误分类. fake script 用 #!/usr/bin/env bash,
//   测试结束删.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { ProviderRegistry } from "./registry";
import { MmxProvider } from "./mmx";
import { ProviderError } from "./types";

function makeFakeMmxScript(args: {
  outFileContent?: Buffer | null; // null = skip writing file (test "mmx 没写出文件")
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  outFileFlag?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-mmx-"));
  const scriptPath = path.join(dir, "mmx");
  const flag = args.outFileFlag || "--out";
  const contentB64 =
    args.outFileContent !== null && args.outFileContent !== undefined
      ? args.outFileContent.toString("base64")
      : null; // null = explicit skip
  const stdout = args.stdout || `[Model: image-01]\n{ "saved": ["/dev/null"] }\n`;
  const stderr = args.stderr || "";
  const exitCode = args.exitCode ?? 0;

  const writeStep =
    contentB64 === null
      ? `# --out path provided but script explicitly skips writing (test mode)`
      : `if [ -n "$TARGET" ]; then
  echo "${contentB64}" | base64 -d > "$TARGET" 2>/dev/null || true
fi`;

  const script = `#!/usr/bin/env bash
TARGET=""
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = "${flag}" ]; then
    j=$((i+1))
    TARGET="\${!j}"
    break
  fi
done
${writeStep}
printf '%s' '${stdout.replace(/'/g, "'\\''")}'
printf '%s' '${stderr.replace(/'/g, "'\\''")}' >&2
exit ${exitCode}
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe("ProviderRegistry", () => {
  it("set / get / list / getDefault", () => {
    const reg = new ProviderRegistry();
    expect(reg.list()).toEqual([]);
    const p = { name: "fake" } as any;
    reg.set("fake", p);
    expect(reg.list()).toEqual(["fake"]);
    expect(reg.get("fake")).toBe(p);
    reg.setDefault("fake");
    expect(reg.getDefault()).toBe(p);
  });

  it("get 未注册的 provider 抛错并列出已注册", () => {
    const reg = new ProviderRegistry();
    expect(() => reg.get("nope")).toThrowError(/provider "nope" not registered/);
  });

  it("getDefault 抛错当没设默认", () => {
    const reg = new ProviderRegistry();
    expect(() => reg.getDefault()).toThrowError(/no default provider registered/);
  });

  it("setDefault 拒未注册的 provider", () => {
    const reg = new ProviderRegistry();
    expect(() => reg.setDefault("nope")).toThrowError(/unregistered/);
  });
});

describe("MmxProvider.generateImage (fake binary)", () => {
  let tmpDir: string;
  let provider: MmxProvider;
  let fakeBin: string;
  let fakeBinDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-test-out-"));
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-test-bin-"));
    fakeBin = makeFakeMmxScript({ outFileContent: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    provider = new MmxProvider({ outputDir: tmpDir, binary: fakeBin });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(fakeBin), { recursive: true, force: true });
  });

  it("基本生成: 写出 png, descriptor 字段准, providerRefs 含 prompt", async () => {
    const descriptor = await provider.generateImage("A red circle", { aspectRatio: "16:9" });

    expect(descriptor.provider).toBe("mmx");
    expect(descriptor.source).toBe("agent_generated");
    expect(descriptor.mediaType).toBe("image/png");
    expect(descriptor.sizeBytes).toBe(4);
    expect(descriptor.filename).toMatch(/\.png$/);
    expect(fs.existsSync(descriptor.storagePath)).toBe(true);
    expect((descriptor.providerRefs as any).prompt).toBe("A red circle");
    expect((descriptor.providerRefs as any).aspect_ratio).toBe("16:9");
    expect((descriptor.providerRefs as any).model).toBe("image-01");
  });

  it("mmx 没写出文件 -> vendor_unavailable", async () => {
    // Replace with a fake script that explicitly skips writing the --out file.
    fs.rmSync(fakeBin, { force: true });
    const emptyBin = makeFakeMmxScript({
      outFileContent: null, // null = skip file write
      stdout: '{ "saved": [] }\n',
      outFileFlag: "--out",
    });
    const p2 = new MmxProvider({ outputDir: tmpDir, binary: emptyBin });
    await expect(p2.generateImage("hi")).rejects.toMatchObject({
      code: "vendor_unavailable",
    });
    fs.rmSync(path.dirname(emptyBin), { recursive: true, force: true });
  });

  it("opts.outputDir 覆盖 this.outputDir (per-call 落盘目录覆盖)", async () => {
    // 这是 2026-09-04 task 91c47331 的根因回归: sdk-tools 的 MediaToolsContext.outputDir
    // 必须透传到 mmx --out, 否则文件落到 Next.js server cwd (process.cwd()), 跟
    // registerAttachmentFromPath 白名单 (task cwd / uploads dir) 不匹配 → 注册失败.
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-test-override-"));
    try {
        const descriptor = await provider.generateImage("hello", { outputDir: overrideDir });
        // 落盘文件必须在 overrideDir 子树 (而不是 this.outputDir = tmpDir).
        expect(descriptor.storagePath.startsWith(overrideDir + path.sep)).toBe(true);
        expect(descriptor.storagePath.startsWith(tmpDir)).toBe(false);
        expect(fs.existsSync(descriptor.storagePath)).toBe(true);
      } finally {
        fs.rmSync(overrideDir, { recursive: true, force: true });
      }
  });
});

describe("MmxProvider.generateImage 错误分类 (fake binary exit code)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-test-out-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stderr 含 'api key' -> missing_credentials", async () => {
    const bin = makeFakeMmxScript({
      outFileContent: Buffer.from("xx"),
      stderr: "Error: not logged in, please provide an api key",
      exitCode: 1,
    });
    const p = new MmxProvider({ outputDir: tmpDir, binary: bin });
    await expect(p.generateImage("hi")).rejects.toBeInstanceOf(ProviderError);
    await expect(p.generateImage("hi")).rejects.toMatchObject({
      code: "missing_credentials",
      provider: "mmx",
    });
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
  });

  it("stderr 含 'quota' -> quota_exceeded", async () => {
    const bin = makeFakeMmxScript({
      outFileContent: Buffer.from("xx"),
      stderr: "API error 429 quota exceeded",
      exitCode: 1,
    });
    const p = new MmxProvider({ outputDir: tmpDir, binary: bin });
    await expect(p.generateImage("hi")).rejects.toMatchObject({ code: "quota_exceeded" });
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
  });
});

describe("MmxProvider.generateVideo (fake binary)", () => {
  let tmpDir: string;
  let provider: MmxProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-test-out-"));
    // video uses --download flag, fake script reads --download
    const bin = makeFakeMmxScript({
      outFileFlag: "--download",
      outFileContent: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]), // ftyp
      stdout: `[Model: MiniMax-Hailuo-2.3]
{ "saved": ["/dev/null"] }
`,
    });
    provider = new MmxProvider({ outputDir: tmpDir, binary: bin });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("基本生成: 写出 mp4, descriptor mediaType=video/mp4, providerRefs 含 duration", async () => {
    const descriptor = await provider.generateVideo("Ocean waves", {
      aspectRatio: "16:9",
      durationSeconds: 8,
    });

    expect(descriptor.provider).toBe("mmx");
    expect(descriptor.mediaType).toBe("video/mp4");
    expect((descriptor.providerRefs as any).duration_seconds).toBe(8);
    expect((descriptor.providerRefs as any).aspect_ratio).toBe("16:9");
    expect((descriptor.providerRefs as any).prompt).toBe("Ocean waves");
    expect((descriptor.providerRefs as any).model).toBe("MiniMax-Hailuo-2.3");
  });

  it("opts.outputDir 覆盖 this.outputDir (video 同样走 per-call 覆盖)", async () => {
    // 同 image 的 2026-09-04 回归: video_gen handler 也必须把 ctx.outputDir 透传进 opts,
    // 否则视频文件落到 Next.js server cwd, registerAttachmentFromPath 拒绝.
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmx-test-vid-override-"));
    try {
      const descriptor = await provider.generateVideo("hi", { outputDir: overrideDir });
      expect(descriptor.storagePath.startsWith(overrideDir + path.sep)).toBe(true);
      expect(descriptor.storagePath.startsWith(tmpDir)).toBe(false);
      expect(fs.existsSync(descriptor.storagePath)).toBe(true);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});