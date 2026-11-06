// 渠道插件注册表 (飞书 R184).
// 新渠道 = 新 adapter 文件 + 此处一行. wecom 收编进 registry 是 P1 (动线上链路, 需测试保护先行).

import type { ChannelAdapter } from "./types";
import { telegramAdapter } from "./telegram";

const REGISTRY = new Map<string, ChannelAdapter>([["telegram", telegramAdapter]]);

export function getChannelAdapter(channel: string): ChannelAdapter | null {
  return REGISTRY.get(channel) ?? null;
}

export function listChannelAdapters(): ChannelAdapter[] {
  return [...REGISTRY.values()];
}
