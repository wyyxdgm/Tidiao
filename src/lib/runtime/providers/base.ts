// Provider abstraction — 把"调什么 vendor 生成图/视频"这件事从 agent SDK 工具
// 里抽出来, 让前端 + 存储 + Agent 工具都不知道具体 vendor 是谁.
//
// 三层职责切清 (见 docs/plans/projects/asset-gallery-and-chat-media.md §"解耦设计"):
//   ① Provider (本目录) - 调 vendor, 输出标准 AssetDescriptor (vendor 无关)
//   ② Storage (attachments 表 + /api/attachments/[id]) - 不变, 只认 media_type
//   ③ Renderer (前端) - 只认 media_type 前缀, 不读 metadata, 不绑 provider
//
// 加新 vendor = +1 个新文件 (providers/sora.ts) + registry 里 +1 行 set('sora').
//   前端 + 存储 + Agent 工具名都不动 (工具名走 capability 语义 image_gen/video_gen).
//
// 关注点:
//   - Provider 接受 STDIN 上是 prompt, 输出是 AssetDescriptor (本地路径 + 文件名 +
//     mime + size + provider 命名空间 metadata). 上层 (active-session 里的工具)
//     负责拿 descriptor 走 registerAttachmentFromPath 落库 (entrypoint 用 HTTP
//     POST /api/tasks/[id]/agent-attachments, 不是直接调 DB).
//   - Provider 不知道 task, 不知道 attachment 表; 让它知道的越少越好, 换 vendor
//     时零修改.

import type { ImageOpts, VideoOpts } from "./types";

// AssetDescriptor 是 Provider 与上层 (register attachment / emit SSE) 之间的
// 契约形状. 上层会把 provider/providerRefs 命名空间化塞进 attachments.metadata,
// 顶层 schema 不动, 给将来加 sora 留位.
export interface AssetDescriptor {
  /** 本地落盘路径. 调用方负责把文件落到任务 cwd 子树或 uploads 子树
   *  (registerAttachmentFromPath 会做 realpath 防越界校验). */
  storagePath: string;
  /** 友好文件名 (不带路径). */
  filename: string;
  /** IANA media type, e.g. "image/png", "video/mp4". */
  mediaType: string;
  sizeBytes: number;
  /** 必须是 "agent_generated". 前端不区分 vendor. */
  source: "agent_generated";
  /** vendor 标识, 写进 attachments.metadata.provider (顶层). */
  provider: string;
  /** vendor 特定的引用集合, 写进 attachments.metadata.provider_refs[provider],
   *  命名空间化 (e.g. mmx_file_id / sora_task_id / sora_url). */
  providerRefs: Record<string, unknown>;
}

// Provider 接口 — vendor 实现这个就行. 实现可以加私有方法 (buildCommand /
// curlRemote / ...), 但只要这两个 public 方法签名不变, 换 vendor 时上层不动.
export interface Provider {
  readonly name: string;
  generateImage(prompt: string, opts?: ImageOpts): Promise<AssetDescriptor>;
  generateVideo(prompt: string, opts?: VideoOpts): Promise<AssetDescriptor>;
}
