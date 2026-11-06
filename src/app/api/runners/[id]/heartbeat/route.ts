// POST /api/runners/[id]/heartbeat  ——  runner daemon 每 10s 调一次.
//
// 鉴权: Authorization: Bearer <token>. token 是 v51 注册时返回的 64-hex.
//   不走 JWT / ao_ token 体系, 因此 middleware.ts 的 isPublic() 这一层把
//   这条路由标为公开 (见 src/middleware.ts 注释), 然后鉴权下沉到这里.
//
//   401 body 的 error 字段是结构化类型 (docs/plans/runners.md 调试三件套),
//   operator 看一眼就知道该重 register 还是查 ENCRYPTION_KEY:
//     header_malformed —— Authorization 头存在但不是 "Bearer " 前缀
//     token_missing    —— 没带 Authorization 头 (或 Bearer 后面为空)
//     token_mismatch   —— token 对不上 (含 id 不存在/revoke 后还在心跳)
//     decrypt_failed   —— auth 列解不开 (ENCRYPTION_KEY 漂了/列被改坏),
//                         同时 console.warn + markRunnerDead
//   id 不存在归入 token_mismatch (同 body 不泄漏 id 存在性), 且**不**触发
//   decrypt 分支的 warn —— revoke 不是 key 漂移, 别误导 operator.
//
//   验证机制:
//     1. isRunnerDecryptable(id) —— 探针, 区分「token 错」vs「auth 列已坏」
//        verifyRunnerToken 把两者都返 false, 没信号传出; 探针就是给上层
//        一个「ENCRYPTION_KEY 漂了 / 列被改坏」的明确信号, 触发
//        console.warn + markRunnerDead, 让 admin 在 UI 看到就重 register.
//     2. verifyRunnerToken(id, presentedToken) —— SELECT auth 列 + decrypt +
//        constant-time compare, 全部失败路径 (DB 没 row / decrypt 抛 / 长度
//        不对 / 字节不等) 都返回 false, **不**抛.
//     3. true -> updateRunnerHeartbeat + recordHeartbeat; false -> 401.
//        (修 P5 e2e: heartbeat 路由调 recordHeartbeat 让 in-memory registry
//         同步; 启动后才注册的 runner 第一次心跳触发 lazy-add)

import { NextRequest, NextResponse } from "next/server";
import {
  getRunnerById,
  verifyRunnerToken,
  isRunnerDecryptable,
  updateRunnerHeartbeat,
  markRunnerDead,
} from "@/lib/db/runners";
import { recordHeartbeat } from "@/lib/runners/registry";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authHeader = request.headers.get("authorization") ?? "";
  // 注意: HTTP 层会把 "Bearer " (尾随空格) 规范化成 "Bearer", 所以「空 token」
  // 实际到达时已不含前缀空格 —— 归 header_malformed; 「没带头」才是 token_missing.
  if (!authHeader) {
    return NextResponse.json({ error: "token_missing" }, { status: 401 });
  }
  const expectedPrefix = "Bearer ";
  if (!authHeader.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "header_malformed" }, { status: 401 });
  }
  const presentedToken = authHeader.slice(expectedPrefix.length).trim();
  if (!presentedToken) {
    return NextResponse.json({ error: "token_missing" }, { status: 401 });
  }

  // 0. 行不存在 (revoke 后 daemon 还在心跳 / id 抄错): 与「token 错」同型,
  //    同回 token_mismatch —— 同 body 才不泄漏 id 存在性, 也不走下面
  //    decrypt 分支的 console.warn (revoke 不是 ENCRYPTION_KEY 漂移).
  if (!getRunnerById(id)) {
    // 🆕 0828: 这种 case 之前静默, 但其实是运维信号 (daemon 拿旧 runner_id
    // 心跳 / damo 误删 platform 行 / self-register 后旧 token 没清理). 改静默
    // 为 warn: 不带敏感信息 (没 token / 没 host), 只是 id + 时间, 足够排查.
    console.warn(
      `[runners/heartbeat] runner ${id} 行不存在 (daemon 可能用旧 runner_id / 该行已删除 / 自助注册用了不同 id). ` +
      `收到时间=${new Date().toISOString()}`,
    );
    return NextResponse.json({ error: "token_mismatch" }, { status: 401 });
  }

  // 1. 先探: 行存在 + 列能 decrypt 吗. 列坏了 (verifyOk=false, decrypt 也
  //    不行) 的情况需要在 token 校验失败前就标 dead —— 因为根本没东西可比.
  //    此时不论 presentedToken 是什么都是 401, 但需要把「列坏了」的特征
  //    **显式**告诉 admin (console.warn + UI 上的 status='dead'), 让他
  //    知道这不是 token 错, 而是 ENCRYPTION_KEY 漂了, 该重 register.
  if (!isRunnerDecryptable(id)) {
    markRunnerDead(id);
    console.warn(
      `[runners/heartbeat] runner ${id} auth columns not decryptable ` +
      `(likely ENCRYPTION_KEY rotation / corrupt columns); marking dead`
    );
    return NextResponse.json({ error: "decrypt_failed" }, { status: 401 });
  }

  // 2. 列能解, 走普通 token 比对: 不动 DB 状态, 仅 401.
  if (!verifyRunnerToken(id, presentedToken)) {
    return NextResponse.json({ error: "token_mismatch" }, { status: 401 });
  }

  // 3. 写 DB status + updated_at + last_heartbeat_at, 同时把 in-memory
  //    registry 同步上来 (lazy-add 启动后才注册的 runner; 已知 runner
  //    只刷 lastSeen + status='online'). recordHeartbeat decrypt 失败
  //    静默 no-op (心跳路由之前已 verifyRunnerToken 通过, 不会到这里).
  updateRunnerHeartbeat(id);
  recordHeartbeat(id, Date.now());
  return NextResponse.json({ ok: true });
}
