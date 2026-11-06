// Asset generation option shapes shared across all Provider implementations.
// Kept in a separate file from base.ts so that registry / consumers can
// import the options without pulling in the full Provider interface.
//
// 关注点:
//   - 字段名用 capability 语义 (aspectRatio / durationSeconds) 而非 vendor
//     语义, 每个 Provider 内部翻译成自家 CLI / SDK 形态.
//   - 后续加 sora / runway / dalle 时, 给它们各自一份 opts 类型, 在 base
//     里加 union 即可.

export interface ImageOpts {
  aspectRatio?: string; // "16:9" | "1:1" | ...
  width?: number;        // 只部分 provider (mmx image-01) 支持
  height?: number;
  seed?: number;
  n?: number;
  promptOptimizer?: boolean;
  model?: string;
  /** 落盘目录. mmx --out 直接写到这. 不传走 provider 构造时的 this.outputDir.
   *  传了就覆盖 — 用于 per-task 上传资产时把图写到
   *  $ORCHESTRATOR_HOME/uploads/{owner}/{task}/, 让 registerAttachmentFromPath
   *  白名单过 (skill: image-gen / docs/clans/asset-gallery-and-chat-media.md). */
  outputDir?: string;
}

export interface VideoOpts {
  aspectRatio?: string;
  durationSeconds?: number; // 秒
  model?: string;
  /** 同 ImageOpts.outputDir — 视频落盘目录. */
  outputDir?: string;
}

// 上游 "未配 / 失败 / 超限" 等异常分类, 供上层 (active-session tool_result)
// 渲染友好错误给 agent 看. reason 字段写人类可读 hint, code 给机器消费.
export type ProviderErrorCode =
  | "missing_credentials"
  | "quota_exceeded"
  | "invalid_prompt"
  | "unsupported_opt"
  | "timeout"
  | "vendor_unavailable"
  | "unknown";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly hint?: string;

  constructor(provider: string, code: ProviderErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.hint = hint;
  }
}
