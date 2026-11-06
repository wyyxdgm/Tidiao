// Agent SDK 工具: image_gen / video_gen (capability 语义, 不绑 vendor).
//
// 通过 SDK 的 createSdkMcpServer 注入. 实际 tool 名 = "mcp__media__image_gen" /
// "mcp__media__video_gen" (SDK 命名约定). 上层 (active-session 的 query options)
// 把本 server 加进 mcpServers.
//
// 关注点:
//   - 工具名走 capability (image_gen / video_gen), 不用 vendor (mmx_image) —
//     换 vendor 时上层 + 前端 + storage 全不动, 只改 registry + 新文件 (见
//     docs/plans/projects/asset-gallery-and-chat-media.md §"解耦设计").
//   - handler 在 platform Node.js 进程内跑 (跟 active-session 同进程), 闭包
//     拿 taskId / userId / cwd / projectId. 调 registry.get('mmx') 拿当前
//     provider. 不管未来换 sora, 这里仍然 registry.get('mmx') — 默认 vendor.
//   - output dir = $ORCHESTRATOR_HOME/uploads/{owner}/{task}/, 兼容
//     registerAttachmentFromPath 的子树白名单.
//   - 落 attachment 用直接 registerAttachmentFromPath (同进程, 不走 HTTP);
//     落完调 getRuntime().emitAttachment 让 chat timeline 立刻刷出来.
//   - 失败 = 抛 ProviderError, handler 包成 isError:true tool_result, 让模型
//     看到清晰 hint (quota / 没配 key / ...). 不静默崩.
//   - 这些工具不在 ALL_TOOLS (built-in) 集合里, canUseTool 的 configurable
//     gate 自然放过, 但仍在 autoApprove 检查: !WRITE_TOOLS.has(toolName) →
//     allow. 即非 autoApprove 任务也能直接调出图 (image 产出非破坏写).

import { z } from "zod";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { registry } from "./registry";
import type { Provider, AssetDescriptor } from "./base";
import type { ImageOpts, VideoOpts } from "./types";
import { ProviderError } from "./types";

// MCP tool_result 形态直接用 SDK 的 CallToolResult, 避免手写类型不兼容.
type ToolResult = CallToolResult;

export interface MediaToolsContext {
  taskId: string;
  userId: string | null;
  cwd: string;
  /** mmx --out / --download 落盘目录. 通常 = uploads/{owner}/{task}. */
  outputDir: string;
  /** 写 attachment 注册结果到 task SSE 流. */
  emitAttachment: (info: { id: string; filename: string; media_type: string; size_bytes: number }) => void;
  /** 把 AssetDescriptor 注册成本任务 attachment, 返回 row id 或失败 reason. */
  registerAttachment: (descriptor: AssetDescriptor, tool: string) => Promise<
    { ok: true; attachmentId: string } | { ok: false; reason: string }
  >;
}

const imageInputSchema = {
  prompt: z.string().min(1).describe("图片描述, 用中文/英文都行. 高细节建议加 '高细节, 8K, 摄影质感' 等风格关键词."),
  aspect_ratio: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional()
    .describe("宽高比, e.g. '16:9', '1:1', '9:16'. 不传默认 1:1."),
  seed: z.number().int().optional().describe("同 seed + prompt = 同结果, 复现用."),
  width: z.number().int().min(512).max(2048).optional().describe("mmx image-01 支持, 必须是 8 的倍数."),
  height: z.number().int().min(512).max(2048).optional().describe("mmx image-01 支持, 必须是 8 的倍数."),
};

const videoInputSchema = {
  prompt: z.string().min(1).describe("视频描述, mmx 会自动选模型."),
  aspect_ratio: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional()
    .describe("H3 支持 adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16."),
  duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe("H3 支持 4-15s 整数, 默认 5s."),
};

// ProviderError 包成 MCP tool_result 友好形态. SDK 期望 CallToolResult = { content, isError? }
// content 是 [{type:'text', text:'...'}]. 出错时加 isError:true 让 tool_result 显示红字.
function toolErrorResult(err: unknown): ToolResult {
  if (err instanceof ProviderError) {
    const hint = err.hint ? `\n处理建议: ${err.hint}` : "";
    return {
      content: [{ type: "text", text: `[mmx ${err.code}] ${err.message}${hint}` }],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `[image/video gen 失败] ${msg}` }],
    isError: true,
  };
}

// 公共逻辑: descriptor → attachment row → SSE emit. 返回 ChatGPT-style 文案 + id.
async function registerAndEmit(
  ctx: MediaToolsContext,
  descriptor: AssetDescriptor,
  tool: string,
): Promise<ToolResult> {
  const reg = await ctx.registerAttachment(descriptor, tool);
  if (!reg.ok) {
    return {
      content: [{ type: "text", text: `[register failed] ${reg.reason}` }],
      isError: true,
    };
  }
  ctx.emitAttachment({
    id: reg.attachmentId,
    filename: descriptor.filename,
    media_type: descriptor.mediaType,
    size_bytes: descriptor.sizeBytes,
  });

  const sizeKb = (descriptor.sizeBytes / 1024).toFixed(1);
  return {
    content: [
      {
        type: "text",
        text: `已生成 ${descriptor.mediaType} (${sizeKb} KB), 入资产池 id=${reg.attachmentId}, filename=${descriptor.filename}. chat timeline 立刻可见, 也可在 /assets 页面找到.`,
      },
    ],
  };
}

// 工具工厂: 给一个 MediaToolsContext 就生成 2 个工具. 同一 server 跑多 task 时
// 每次 buildImageVideoTools(ctx) 拿一组; 但 SDK mcpServers 是 query 选项, 一般
// 一个 session 一个 ctx, 反复 build 也不重 (handler 闭包里的 ctx 是新对象).
//
// ⚠️ 但是! createSdkMcpServer 内部有 instance, 不应该同进程反复 new + close.
// 实际创建放在 createMediaServer(ctx) 一次性, 多次 start/resume 用同 server.
// 设计: createMediaServer 返回 McpSdkServerConfigWithInstance (带 instance), 闭
// 包里有 ctx; 同一个 ActiveSession 多次调 start/resume 也复用.

let _lastServerInstance: { server: McpSdkServerConfigWithInstance; ctx: MediaToolsContext } | null = null;

export function createMediaServer(ctx: MediaToolsContext): McpSdkServerConfigWithInstance {
  // ActiveSession 一次构造只用一份 ctx, 复用同一 instance; 保险起见 ctx 变了就
  // 关掉旧 instance 重起.
  if (_lastServerInstance && _lastServerInstance.ctx !== ctx) {
    _lastServerInstance = null;
  }

  if (_lastServerInstance) {
    return _lastServerInstance.server;
  }

  const provider: Provider = registry.getDefault();
  const server = createSdkMcpServer({
    name: "media",
    version: "1.0.0",
    instructions:
      "media MCP server: 用 minimax mmx 全模态 API 生成图像 / 视频. 工具自动入资产池 + chat inline 预览.",
    tools: [
      {
        name: "image_gen",
        description:
          "根据文本描述生成一张静态图片. 入资产池后可在 chat 内 inline 预览, 也可在 /assets 页面管理. 失败时返回 [mmx <code>] + 处理建议.",
        inputSchema: imageInputSchema,
        // SDK handler 签名是 (args: {[k:string]: unknown}) => Promise<CallToolResult>;
        // zod schema 在 createSdkMcpServer 内部做类型校验, 这里手 cast 让 TS 编译过.
        handler: (async (rawArgs: Record<string, unknown>) => {
          const args = rawArgs as z.infer<z.ZodObject<typeof imageInputSchema>>;
          const opts: ImageOpts = {
            aspectRatio: args.aspect_ratio,
            seed: args.seed,
            width: args.width,
            height: args.height,
            // 把 ctx.outputDir 透传进 ImageOpts, 让 mmx --out 写到
            // $ORCHESTRATOR_HOME/uploads/{owner}/{task}/ 子树.
            // 这是让 registerAttachmentFromPath 白名单过的关键 (不然走
            // provider 的 this.outputDir = process.cwd() = Next.js server cwd,
            // 通常 = /home/user/workspace/agent-orchestrator/, 跟 task cwd 不同).
            outputDir: ctx.outputDir,
          };
          try {
            const descriptor = await provider.generateImage(args.prompt, opts);
            return await registerAndEmit(ctx, descriptor, "image_gen");
          } catch (err) {
            return toolErrorResult(err);
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
      {
        name: "video_gen",
        description:
          "根据文本描述生成一段短视频. mmx 默认模型 MiniMax-Hailuo-2.3 (T2V). 入资产池后 chat inline 渲染, /assets 页面管理.",
        inputSchema: videoInputSchema,
        handler: (async (rawArgs: Record<string, unknown>) => {
          const args = rawArgs as z.infer<z.ZodObject<typeof videoInputSchema>>;
          const opts: VideoOpts = {
            aspectRatio: args.aspect_ratio,
            durationSeconds: args.duration_seconds,
            // 同 image_gen: 把 ctx.outputDir 透传, 写到 uploads 子树让注册白名单过.
            outputDir: ctx.outputDir,
          };
          try {
            const descriptor = await provider.generateVideo(args.prompt, opts);
            return await registerAndEmit(ctx, descriptor, "video_gen");
          } catch (err) {
            return toolErrorResult(err);
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
    ],
  });

  _lastServerInstance = { server, ctx };
  return server;
}

/** 重置缓存的 server instance (测试场景). */
export function _resetMediaServerForTesting(): void {
  _lastServerInstance = null;
}
