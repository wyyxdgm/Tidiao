// 功能: 验证 session 中的用户是否仍存在于数据库.
// 关注点: middleware 只验 JWT 签名不查库, 已删用户的 token 仍能通过;
// 写操作(INSERT 带 owner_id FK)会因此 FK 失败. 调用方在写操作前
// 调此函数, 返回 401 响应让前端跳登录页.

import { NextResponse } from "next/server";
import { getUserById } from "@/lib/db/users";

export function requireExistingUser(userId: string): NextResponse | null {
  if (!getUserById(userId)) {
    return NextResponse.json(
      { error: "用户不存在，请重新登录" },
      { status: 401 }
    );
  }
  return null;
}
