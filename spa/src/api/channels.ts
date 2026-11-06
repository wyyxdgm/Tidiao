// Channels API — 渠道角色管理 UI (docs/plans/channel-role-ui.md D2).
// 与 master /api/channels 对齐: GET(列表, 连带 project/role 名)/POST/PATCH/DELETE.
// secret 不回传 (has_secret 布尔); PATCH secret 留空 = 不改.

import { get, post, patch, del } from './http';

export interface ChannelConfig {
  id: string;
  channel: string;
  name: string;
  bound_project_id: string;
  project_name: string | null;
  bound_version_id: string | null;
  version_name: string | null; // null = 跟随项目 current_version
  bind_code: string;
  role_id: string | null;
  role_name: string | null;
  enabled: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
}

export function listChannels(): Promise<ChannelConfig[]> {
  return get<ChannelConfig[]>('/api/channels');
}

export interface CreateChannelBody {
  channel: string;
  name: string;
  secret?: string;
  bound_project_id: string;
  /** v529: 渠道绑定版本, null/不传 = 跟随项目 current_version */
  bound_version_id?: string | null;
  role_id?: string | null;
}

export function createChannel(body: CreateChannelBody): Promise<ChannelConfig> {
  return post<ChannelConfig>('/api/channels', body);
}

/** PATCH 允许部分更新: 字段不传 = 不改; secret 留空/不传 = 不改; role_id 传 null = 清除默认角色. */
export interface UpdateChannelBody extends Partial<CreateChannelBody> {
  enabled?: boolean;
  role_id?: string | null;
}

export function updateChannel(id: string, body: UpdateChannelBody): Promise<ChannelConfig> {
  return patch<ChannelConfig>(`/api/channels/${id}`, body);
}

export function deleteChannel(id: string): Promise<void> {
  return del<void>(`/api/channels/${id}`);
}

/** 扫码绑定 (docs/plans/channel-qr-bind.md D1): qr_svg 是服务端生成的静态 SVG 字符串. */
export interface BindQr {
  qr_content: string | null;
  qr_svg: string | null;
  hint: string;
  copy_text: string | null;
}

export function getBindQr(id: string): Promise<BindQr> {
  return get<BindQr>(`/api/channels/${id}/bind-qr`);
}

/* 微信扫码登录 (D3): 平台代调 iLink get_bot_qrcode, 服务端把 liteapp URL 编成 SVG.
   qr_svg 直接 v-html 渲染; login_id 用于 status 轮询. */
export interface WeixinQrLogin {
  login_id: string;
  qr_svg: string;
  qr_url: string;
  expires_in: number;
}

export function weixinQrLogin(body: {
  bound_project_id: string;
  role_id?: string | null;
  bound_version_id?: string | null;
}): Promise<WeixinQrLogin> {
  return post<WeixinQrLogin>('/api/channels/weixin/qr-login', body);
}

/* status 轮询: pending 等待扫码 / scanned 已扫待手机确认 / success 建好渠道行 /
   expired 二维码过期需重新生成 / error iLink 报错. */
export interface WeixinQrLoginStatus {
  status: 'pending' | 'scanned' | 'success' | 'expired' | 'error';
  channel?: ChannelConfig;
  message?: string;
}

export function weixinQrLoginStatus(loginId: string): Promise<WeixinQrLoginStatus> {
  return get<WeixinQrLoginStatus>(
    `/api/channels/weixin/qr-login/status?login_id=${encodeURIComponent(loginId)}`,
  );
}
