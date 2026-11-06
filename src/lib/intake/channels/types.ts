// 渠道插件接口 + 注册表类型 (飞书 R184).
//
// 插件化边界 (damo 拍板「从简单的先搞, 能插件化最好」):
//   一个渠道 = 一个文件实现 ChannelAdapter + registry 注册一行.
//   不做第三方运行时插件加载 (安全沙箱 + 分发机制, 个人自部署平台不需要).

import type { ChannelConfig } from "@/lib/db/channel-configs";
import type { IntakeChannel } from "@/lib/db/intake-threads";

/** 渠道入站消息的规范形态 (从各渠道 payload 归一化而来). */
export interface InboundMessage {
  /** IM 侧会话/用户 ID (thread 的 external_user_id) */
  externalUserId: string;
  externalUserName?: string;
  /** 会话 ID (与 externalUserId 不同的渠道填自己的, 如群 ID; Telegram private chat = chat.id) */
  threadKey: string;
  text: string;
}

/** 出站发送目标 (从 thread 反查而来). */
export interface OutboundTarget {
  externalUserId: string;
}

/**
 * 渠道插件接口. 新渠道三步:
 *   1. 新建 `<channel>.ts` 实现 ChannelAdapter
 *   2. registry.ts 注册一行
 *   3. INTAKE_CHANNELS (db/intake-threads.ts) 加枚举 + webhook 路由挂 /api/intake/<channel>
 */
export interface ChannelAdapter {
  readonly type: IntakeChannel;
  /** 渠道显示名 (prompt/日志用) */
  readonly label: string;
  /** 从 webhook payload 解析入站消息; 不感兴趣的事件返回 null */
  parseInbound(payload: unknown): InboundMessage | null;
  /** 验证入站请求合法性 (Telegram: secret_token 头比对; 其他渠道各自验签) */
  verifyRequest(request: Request, config: ChannelConfig): boolean;
  /** 发文本消息给外部用户 */
  sendMessage(config: ChannelConfig, target: OutboundTarget, text: string): Promise<void>;
  /**
   * 出站前门禁 (可选). wecom 有 48h/5 条硬窗口; Telegram 无限制不实现.
   * 返回 string = 拒发原因; null = 放行.
   */
  outboundGate?(thread: {
    last_inbound_at: string | null;
    msg_sent_in_window: number;
  }): string | null;
  /** 新 thread 的提问节奏模板 (buildIntakePrompt 的 channel 参数) */
  readonly askStyleChannel: "wecom" | "h5";
}
