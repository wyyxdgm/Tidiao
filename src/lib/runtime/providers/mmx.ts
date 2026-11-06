// MmxProvider — 当前唯一的 vendor 实现. 封装 mmx CLI:
//   - 图: `mmx image generate --prompt <text> --out <path>` 直接落盘到目标路径
//   - 视: `mmx video generate --prompt <text> --download <path>` 落到目标路径
//
// 关注点:
//   - 用 child_process.execFileAsync 调 mmx, 不发明新协议. mmx-auth 走 buildEnv
//     注入的 $MINIMAX_API_KEY / $MMX_CONFIG_DIR (per-user 隔离).
//   - 不复制二次落盘 (mmx --out / --download 已经写到 target), 直接返回.
//     registerAttachmentFromPath 接受 cwd 子树 或 uploads/ 子树下的路径, 我们
//     走 uploads/ 子树, 避免污染 cwd.
//   - 不写 attachment 表! Provider 只产 AssetDescriptor + HTTP 写 metadata,
//     上层 (active-session 工具实现) 拿 descriptor 调
//     POST /api/tasks/[id]/agent-attachments 落库. 这样 Provider 不依赖
//     better-sqlite3 / runtime imports, registry 单测可以裸跑.
//   - 失败 = 抛 ProviderError, code 给上层区分 (quota / missing_credentials /
//     unsupported_opt / ...), 给 agent 看 tool_result 时可渲染友好 hint.
//   - mmx 进程超时设 5min (image 一般秒级, video T2V 30s-2min); 超时不重试,
//     抛 timeout 让上层决定. 实测超过 5min 基本是 quota 或 vendor 挂了.
//
// 加新 vendor 步骤:
//   1) 新建 src/lib/runtime/providers/<vendor>.ts 实现 Provider
//   2) 在 registry.ts 里 +1 行 set + setDefault (可选)
//   3) 完. 上层工具 + 前端 + storage 不动.

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import type { AssetDescriptor, Provider } from "./base";
import type { ImageOpts, VideoOpts } from "./types";
import { ProviderError } from "./types";
import { sniffMediaType } from "./sniff";

// 注意: 不要在模块 load 时 const execFileAsync = promisify(execFile),
//   因为 vitest 的 vi.mock("child_process") 在 mmx.ts 加载前替换 execFile,
//   但 promisify 闭包捕获的是当时的引用. 改成 lazy + 走 util.promisify(execFile)
//   每次调用现拼, mock 才生效 (与 src/lib/feishu/lark-cli.ts 同款 pattern).
function execFileAsync(
  binary: string,
  args: string[],
  opts: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(binary, args, opts) as Promise<{ stdout: string; stderr: string }>;
}

// mmx image 默认输出 mime, 文件名缺省按 prompt 截关键词; 真落地 file 头
// 探测比按 --prompt 可靠, 这里用 ext 兜底. mp4 / webp / png 是 mmx 实际
// 三种形态.
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

const DEFAULT_IMAGE_EXT = "png";
const DEFAULT_VIDEO_EXT = "mp4";

const MMX_EXEC_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

// mmx stdout 在 --quiet 下也是 "saved": [path] 形式; 非 --quiet 多了 [Model: ...]
// 提示行. file_id 主要是 video 才需要. 这里解析两件事:
//   1) saved 路径 (image 生成后会回写, 兜底用)
//   2) 拿到 task_id / file_id (video 用, 放 providerRefs)
function parseMmxStdout(stdout: string): { saved?: string; taskId?: string; fileId?: string; model?: string } {
  const out: { saved?: string; taskId?: string; fileId?: string; model?: string } = {};
  // saved 字段: "saved": ["/path/..."] 或 "saved" : [ "..." ]
  const savedMatch = stdout.match(/"saved"\s*:\s*\[\s*"([^"]+)"/);
  if (savedMatch) out.saved = savedMatch[1];

  // [Model: image-01] or [Model: MiniMax-H3]
  const modelMatch = stdout.match(/\[Model:\s*([^\]]+)\]/);
  if (modelMatch) out.model = modelMatch[1].trim();

  // 视频异步产物: task_id / file_id
  const taskMatch = stdout.match(/"task[_-]?id"\s*:\s*"(\d+)"/i) || stdout.match(/task[_-]?id=(\d+)/i);
  if (taskMatch) out.taskId = taskMatch[1];
  const fileMatch = stdout.match(/"file[_-]?id"\s*:\s*"(\d+)"/i) || stdout.match(/file[_-]?id=(\d+)/i);
  if (fileMatch) out.fileId = fileMatch[1];

  return out;
}

// mmx 错误信息粗分类. 拿 stderr 文本做模糊匹配, 不做硬错误码映射 (mmx 错误格式
// 没有标准化, 改 mmx 版本就漂了). 上层拿到 ProviderError 看 code 决定如何
// 提示用户.
function classifyMmxError(stderr: string, code: string | number): ProviderError {
  const msg = stderr.trim() || `mmx CLI exited with code ${code}`;
  const lower = stderr.toLowerCase();
  if (lower.includes("not logged in") || lower.includes("api key") || lower.includes("unauthorized") || lower.includes("401")) {
    return new ProviderError(
      "mmx",
      "missing_credentials",
      msg,
      "在「设置」→「媒体 API Key」配置 per-user mmx API Key (mmx auth login).",
    );
  }
  if (lower.includes("quota") || lower.includes("insufficient") || lower.includes("429") || lower.includes("rate limit")) {
    return new ProviderError(
      "mmx",
      "quota_exceeded",
      msg,
      "minimax mmx 配额已满. 查 quota: mmx quota; 或等下个账期.",
    );
  }
  if (lower.includes("invalid") || lower.includes("prompt") || lower.includes("400")) {
    return new ProviderError(
      "mmx",
      "invalid_prompt",
      msg,
      "prompt 不通过 mmx 校验, 调整描述后重试.",
    );
  }
  if (lower.includes("not found") || lower.includes("404")) {
    return new ProviderError(
      "mmx",
      "vendor_unavailable",
      msg,
      "mmx endpoint 上没找到该 vendor/model. 查 mmx image generate --help 列支持项.",
    );
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return new ProviderError("mmx", "timeout", msg, "mmx 进程超时 (5min), 任务过大 / vendor 暂不可用.");
  }
  return new ProviderError("mmx", "unknown", msg);
}

export interface MmxProviderOpts {
  /** mmx 二进制绝对路径. 默认 "mmx" (从 PATH 找). 测试场景可注入 stub. */
  binary?: string;
  /** $ORCHESTRATOR_HOME 子目录, mmx --out / --download 直接写到这里.
   *  默认 $ORCHESTRATOR_HOME/uploads (rootProvider), 由调用方决定 path 形状. */
  outputDir?: string;
  /** execFile 的 cwd. 默认 process.cwd(). */
  execCwd?: string;
}

export class MmxProvider implements Provider {
  readonly name = "mmx";
  private binary: string;
  private outputDir: string;
  private execCwd: string;

  constructor(opts: MmxProviderOpts = {}) {
    this.binary = opts.binary || "mmx";
    this.outputDir = opts.outputDir || process.cwd();
    this.execCwd = opts.execCwd || process.cwd();
  }

  async generateImage(prompt: string, opts: ImageOpts = {}): Promise<AssetDescriptor> {
    const args: string[] = ["image", "generate", "--prompt", prompt];

    // aspectRatio / width / height / seed / n / optimizer 全翻译成 mmx flag.
    // mmx --width / --height 优先级 > --aspect-ratio (mmx 文档: 同时给 width+
    // height 时 aspect-ratio 被忽略). 我们想让 width/height 单独给上层用.
    if (typeof opts.width === "number" && typeof opts.height === "number") {
      args.push("--width", String(opts.width));
      args.push("--height", String(opts.height));
    } else if (opts.aspectRatio) {
      args.push("--aspect-ratio", opts.aspectRatio);
    }
    if (typeof opts.seed === "number") args.push("--seed", String(opts.seed));
    if (typeof opts.n === "number" && opts.n > 1) args.push("--n", String(opts.n));
    if (opts.promptOptimizer) args.push("--prompt-optimizer");
    if (opts.model) args.push("--model", opts.model);

    const ext = opts.model === "image-01-live" || opts.model === "image-live"
      ? "jpeg"
      : DEFAULT_IMAGE_EXT;
    const filename = `${promptSlug(prompt)}-${uuidv4().slice(0, 8)}.${ext}`;
    // opts.outputDir 优先: per-call 透传 (e.g. 上层 MediaToolsContext.outputDir),
    // 否则用构造时的 this.outputDir. 这样 handler 不必自己 new provider.
    const outDir = opts.outputDir || this.outputDir;
    const outPath = path.join(outDir, filename);
    args.push("--out", outPath);

    let stdout: string;
    try {
      const result = await execFileAsync(this.binary, args, {
        cwd: this.execCwd,
        timeout: MMX_EXEC_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      const e = err as Error & { stderr?: string; code?: string | number; killed?: boolean };
      if (e.killed || e.code === "ETIMEDOUT") {
        throw new ProviderError("mmx", "timeout", `mmx image generate 超时 (${MMX_EXEC_TIMEOUT_MS}ms)`);
      }
      throw classifyMmxError(e.stderr || e.message, e.code ?? "unknown");
    }

    const parsed = parseMmxStdout(stdout);
    // mmx --out 写入成功路径在 stdout 里有回显, 但我们用本地的 outPath 兜底:
    // mmx 崩了没写出来时立刻发现, 不留空 descriptor.
    if (!fs.existsSync(outPath)) {
      const savedAlt = parsed.saved && fs.existsSync(parsed.saved) ? parsed.saved : null;
      if (!savedAlt) {
        throw new ProviderError(
          "mmx",
          "vendor_unavailable",
          `mmx image generate 未产出文件: ${outPath}`,
          "stdout 里也没 saved 路径, 检查 mmx 是否正常运行 / 配额 / 网络.",
        );
      }
      // 用 mmx 自己回写的路径顶替, 真实文件名也不同, 调整 filename 跟上.
      fs.copyFileSync(savedAlt, outPath);
    }
    const stat = fs.statSync(outPath);

    // 嗅探真实 mediaType (mmx image-01 实际返 JPEG 字节, 默认按 PNG 写错).
    // sniff 失败 → 走原 ext 兜底; 嗅到不同 ext → 物理重命名 + 修正 mediaType.
    // 不重命名 storagePath 目录, 仅 basename 跟 sniff ext 对齐.
    const sniffed = sniffMediaType(outPath);
    let finalPath = outPath;
    let finalMediaType = EXT_TO_MIME[ext] || "image/png";
    if (sniffed) {
      finalMediaType = sniffed.mediaType;
      if (sniffed.ext !== ext) {
        const dir = path.dirname(outPath);
        const newPath = path.join(dir, `${path.parse(filename).name}.${sniffed.ext}`);
        fs.renameSync(outPath, newPath);
        finalPath = newPath;
      }
    }

    return {
      storagePath: finalPath,
      filename: path.basename(finalPath),
      mediaType: finalMediaType,
      sizeBytes: stat.size,
      source: "agent_generated",
      provider: "mmx",
      providerRefs: {
        model: parsed.model || opts.model || "image-01",
        prompt,
        ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
        ...(typeof opts.width === "number" ? { width: opts.width } : {}),
        ...(typeof opts.height === "number" ? { height: opts.height } : {}),
        ...(typeof opts.seed === "number" ? { seed: opts.seed } : {}),
        ...(typeof opts.n === "number" ? { n: opts.n } : {}),
        ...(opts.promptOptimizer ? { prompt_optimizer: true } : {}),
      },
    };
  }

  async generateVideo(prompt: string, opts: VideoOpts = {}): Promise<AssetDescriptor> {
    const args: string[] = ["video", "generate", "--prompt", prompt];
    if (opts.aspectRatio) args.push("--ratio", opts.aspectRatio);
    if (typeof opts.durationSeconds === "number") {
      args.push("--duration", String(opts.durationSeconds));
    }
    if (opts.model) args.push("--model", opts.model);

    const ext = DEFAULT_VIDEO_EXT;
    const filename = `${promptSlug(prompt)}-${uuidv4().slice(0, 8)}.${ext}`;
    // opts.outputDir 优先 (per-call 透传), 否则 this.outputDir.
    const outDir = opts.outputDir || this.outputDir;
    const outPath = path.join(outDir, filename);
    // --download 直接落盘到 outPath (相比 --out 是 video 专用).
    args.push("--download", outPath);

    let stdout: string;
    try {
      const result = await execFileAsync(this.binary, args, {
        cwd: this.execCwd,
        timeout: MMX_EXEC_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      const e = err as Error & { stderr?: string; code?: string | number; killed?: boolean };
      if (e.killed || e.code === "ETIMEDOUT") {
        throw new ProviderError("mmx", "timeout", `mmx video generate 超时 (${MMX_EXEC_TIMEOUT_MS}ms)`);
      }
      throw classifyMmxError(e.stderr || e.message, e.code ?? "unknown");
    }

    const parsed = parseMmxStdout(stdout);
    if (!fs.existsSync(outPath)) {
      throw new ProviderError(
        "mmx",
        "vendor_unavailable",
        `mmx video generate 未产出文件: ${outPath}`,
        `stdout: ${stdout.slice(0, 200)}`,
      );
    }
    const stat = fs.statSync(outPath);

    // 视频同样 sniff: mmx 默认按 mp4 ext 写, 但偶发输出 webm / mov. 修正 mediaType + ext.
    const sniffed = sniffMediaType(outPath);
    let finalPath = outPath;
    let finalMediaType = EXT_TO_MIME[ext] || "video/mp4";
    if (sniffed) {
      finalMediaType = sniffed.mediaType;
      if (sniffed.ext !== ext) {
        const dir = path.dirname(outPath);
        const newPath = path.join(dir, `${path.parse(filename).name}.${sniffed.ext}`);
        fs.renameSync(outPath, newPath);
        finalPath = newPath;
      }
    }

    return {
      storagePath: finalPath,
      filename: path.basename(finalPath),
      mediaType: finalMediaType,
      sizeBytes: stat.size,
      source: "agent_generated",
      provider: "mmx",
      providerRefs: {
        model: parsed.model || opts.model || "MiniMax-Hailuo-2.3",
        task_id: parsed.taskId ?? null,
        file_id: parsed.fileId ?? null,
        prompt,
        ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
        ...(typeof opts.durationSeconds === "number" ? { duration_seconds: opts.durationSeconds } : {}),
      },
    };
  }
}

// 用 prompt 前几个非 ascii 词生成安全 slug. 仅作文件名 hint, 真唯一性靠 uuid 后缀.
function promptSlug(prompt: string): string {
  const cleaned = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned || "asset";
}
