// R3 平台客户端 — runner 连接注册表.
//
// 功能:
//   - 内存表 Map<runner_id, RunnerConnection>: 启动时从 DB 加载所有 runner
//     行 (含 decrypt 出来的明文 token), heartbeat tick 根据 last_heartbeat_at
//     标 offline/dead.
//   - 不主动 poll runner /v1/health (代价高); runner 端每 10s POST
//     {PLATFORM}/api/runners/:id/heartbeat 推 status, heartbeat 路由已经
//     标 status='online' + last_heartbeat_at=now + updated_at=now (见
//     src/lib/db/runners.ts updateRunnerHeartbeat). 我们只 tick 扫内存表
//     看哪些 stale, 同步把 DB 里 status 列更新成 offline/dead.
//
// 关注点:
//   - token 明文只在内存里, 不落库, 不打日志. 启动加载 + heartbeat tick
//     两处 decrypt 都 catch 失败 (ENCRYPTION_KEY 漂了的话), 走 markRunnerDead
//     + console.warn, 与 heartbeat 路由一致的语义.
//   - 线程/异步: tick 用 setInterval, 单实例 (避免 HMR 重启双重 tick); setPaused
//     标记供测试 stop. 单元测试不真起 tick, 只直接调 loadRunnersFromDb 验证
//     Map 状态.
//   - 模块级 singleton (registryLoad + tickStart). 测试用 resetForTest() 清.

import { decrypt } from "../crypto";
import { getDb } from "../db";
import {
  getRunnerById,
  listRunners,
  markRunnerDead,
  _readRunnerAuthColumns,
} from "../db/runners";
import type { RunnerConnection, RunnerStatus } from "./types";

// "last_heartbeat_at 超过这个时长没心跳就标 offline"
const OFFLINE_AFTER_MS = 30 * 1000;
// 再加一个超时标 dead
const DEAD_AFTER_MS = 60 * 1000;
// tick 间隔
const TICK_INTERVAL_MS = 30 * 1000;

// 单例内存表. 启动加载时填满, tick 期间 status 列可能在线修改 (心跳路由),
// 但 tick 同时也会同步到 Map.status (offline/dead) —— 同一份真值在两处.
const connections = new Map<string, RunnerConnection>();

let tickHandle: ReturnType<typeof setInterval> | null = null;

// 功能: 启动时一次性把 DB 里所有 runner 行加载到内存 Map. decrypt 失败
//   (ENCRYPTION_KEY 漂了) → 标 dead + console.warn, 不抛 (启动不该因为
//   token 列坏而挂).
// 关注点:
//   - 不依赖解密结果是否 throw —— 全用 try/catch 包, 任何失败都进 dead 列.
//   - 与 R1 heartbeat handler 同款语义 (decrypt_failed → markRunnerDead).
//     不在 init 时给 DB 写 status='dead', 留给 tick: 启动时全部 status
//     都是 DB 现状, 标 dead 的是真 stale (>60s 没心跳) 才动.
//   - 模块级 singleton, 调用一次足够. 重复调用覆盖前一次加载结果 (用于
//     test 重置场景).
// 功能: 从 DB 读一行 + 解密 token, 构造 RunnerConnection. 不放 Map (caller 决定).
//   失败模式:
//     - 行不存在 → null (并发删除 / id 抄错)
//     - decrypt 抛 → console.warn + markRunnerDead + 返回 null (与 heartbeat
//       路由同款语义: ENCRYPTION_KEY 漂了 / 列被改坏).
// 关注点:
//   - 与 loadRunnersFromDb 共用同一段「读行 + 解密 + 构造」逻辑, 抽出来避免
//     recordHeartbeat 走 lazy-add 路径时复制粘贴.
function loadRunnerById(id: string): RunnerConnection | null {
  const row = getRunnerById(id);
  if (!row) return null; // 行被并发删除 / id 抄错
  const cols = _readRunnerAuthColumns(id);
  if (!cols) return null; // 行还在但 auth 列被破坏 (极少)
  let authToken: string;
  try {
    authToken = decrypt(cols.encrypted, cols.iv, cols.tag);
  } catch (err) {
    console.warn(
      `[runners/registry] decrypt failed for runner ${id} (${row.name}); marking dead:`,
      (err as Error).message,
    );
    try {
      markRunnerDead(id);
    } catch {}
    return null;
  }
  return {
    runner: {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      os_type: row.os_type,
      status: row.status,
      last_heartbeat_at: row.last_heartbeat_at,
    },
    authToken,
    lastSeenAtMs: row.last_heartbeat_at
      ? Date.parse(row.last_heartbeat_at.replace(" ", "T") + "Z")
      : null,
    status: row.status,
  };
}

export function loadRunnersFromDb(): Map<string, RunnerConnection> {
  const rows = listRunners();
  connections.clear();
  const now = Date.now();
  for (const row of rows) {
    const conn = loadRunnerById(row.id);
    if (!conn) continue; // 解密失败已 markRunnerDead + warn, 这里不重复
    // 初始化时也跑一遍 staleness: 启动时间 - last_heartbeat_at > 60s → dead
    if (conn.lastSeenAtMs != null) {
      const ageMs = now - conn.lastSeenAtMs;
      if (ageMs >= DEAD_AFTER_MS) {
        conn.status = "dead";
      } else if (ageMs >= OFFLINE_AFTER_MS) {
        conn.status = "offline";
      }
    } else {
      conn.status = "offline";
    }
    connections.set(row.id, conn);
  }
  return connections;
}

// 功能: 拿一个 runner 的 Connection. registry 没有该 id → null (heartbeat
//   路由之前已验证存在, 这里只是双重保险).
export function getConnection(runnerId: string): RunnerConnection | null {
  return connections.get(runnerId) ?? null;
}

// 功能: 给 client / exec 用 —— 列出所有 online runner. routing.ts 需要按
//   runner_id 字典序取第一个, 在这里现取现排; 也可以调用方自己 Array.from +
//   sort.
// 关注点:
//   - 返回数组快照, 不引用内部 Map —— 调用方 iter 时即使 tick 修改 status
//     也不会影响本次结果.
//   - 不带 lastSeenAtMs 字段, 只暴露 routing 决策需要的子集 (id + name +
//     host + port + status + authToken). 测试时也只验这些字段.
export function listOnlineConnections(): RunnerConnection[] {
  return Array.from(connections.values()).filter((c) => c.status === "online");
}

// 功能: 列出所有 connections (任何 status). 测试用, 上线代码不依赖此函数.
export function _listAllConnections(): RunnerConnection[] {
  return Array.from(connections.values());
}

// 功能: 收到一次心跳后, 更新对应 connection 的 status / lastSeenAtMs. 由
//   heartbeat handler (route 层) 在 verify 成功后调; 不在 heartbeat 路由
//   直接操作 Map, 走这里集中 status/lastSeen 同步.
// 关注点:
//   - lastSeenAtMs 用调用方传入 (避免 registry 内部 Date.now 与心跳 "now"
//     不一致). 测试时可以传假 timestamp 模拟 stale 心跳.
//   - lastSeenAtMs 不带进来 → 静默 no-op (heartbeat 路由本就该传 now).
//   - lazy-add: 平台启动后才注册的 runner 不在内存 Map 里; 第一次心跳触发
//     一次 DB 读 + decrypt, 加进 Map 后正常用. 修 P5 e2e (2026-08-28):
//     heartbeat route 不调本函数 → Map 永远没有新 runner → routing deny.
export function recordHeartbeat(runnerId: string, lastSeenAtMs: number): void {
  let conn = connections.get(runnerId);
  if (!conn) {
    // 启动后才注册的 runner: 走一次 DB 读 + decrypt 把它加进来. 失败模式
    // (行没了 / decrypt 错) 与 loadRunnersFromDb 同款: null → 静默 return,
    // 让下次 heartbeat 重试 (DB 可能刚加行, decrypt 错也已 markDead).
    conn = loadRunnerById(runnerId) ?? undefined;
    if (!conn) return;
    connections.set(runnerId, conn);
  }
  conn.lastSeenAtMs = lastSeenAtMs;
  conn.status = "online";
}

// 功能: 启动后台 tick —— 周期扫所有 connections, 根据 lastSeenAtMs 把
//   超时的 status 字段同步 (offline/dead). tick 同时把 DB 行也更新 (DB
//   status 列是 UI/admin 列表的来源).
// 关注点:
//   - 单例, 重复调会先 clearInterval 旧的 —— 测试 reset 时不会泄漏 handle.
//   - tick 里如果某 runner 已经在 DB 标 dead (decrypt 失败那类), 不再写回
//     online. 避免逻辑回环.
//   - tick 内 DB 写失败 (DB 关了) 只 console.warn, 不抛; 内存 Map 已经
//     标记, 下个 tick 再尝试.
export function startHeartbeatTick(): void {
  if (tickHandle) clearInterval(tickHandle);
  // 立即跑一次 (启动后第 0 秒就有 stale runner 标了); 之后每 30s 一次.
  void sweepStaleConnections();
  tickHandle = setInterval(() => {
    void sweepStaleConnections();
  }, TICK_INTERVAL_MS);
}

export function stopHeartbeatTick(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

// 功能: tick 内的核心逻辑, 暴露给测试直接调 (避免 setInterval 时钟).
async function sweepStaleConnections(): Promise<void> {
  const now = Date.now();
  const db = getDb();
  for (const conn of connections.values()) {
    if (conn.lastSeenAtMs == null) {
      // 永远没心跳过, status 维持 offline; 但如果 DB 里已经是 dead (decrypt
      // 失败那类) 就不同步. 内存 status 与 DB 一致: 都不动.
      continue;
    }
    const ageMs = now - conn.lastSeenAtMs;
    let nextStatus: RunnerStatus = conn.status;
    if (ageMs >= DEAD_AFTER_MS) {
      nextStatus = "dead";
    } else if (ageMs >= OFFLINE_AFTER_MS) {
      nextStatus = "offline";
    } else {
      nextStatus = "online";
    }
    if (nextStatus !== conn.status) {
      conn.status = nextStatus;
      try {
        if (nextStatus === "dead") {
          db.prepare(
            `UPDATE runners SET status = 'dead', updated_at = datetime('now') WHERE id = ?`,
          ).run(conn.runner.id);
        } else if (nextStatus === "offline") {
          db.prepare(
            `UPDATE runners SET status = 'offline', updated_at = datetime('now') WHERE id = ?`,
          ).run(conn.runner.id);
        }
      } catch (err) {
        // DB 写失败 (DB 关了/被换) 不阻断 tick; 下个 tick 再试.
        console.warn(
          `[runners/registry] failed to sync stale status for ${conn.runner.id}:`,
          (err as Error).message,
        );
      }
    }
  }
}

// 功能: 测试辅助 — 把单例状态全部清掉. 不重置 DB, 只清 Map + tick. 模块
//   级测试用, 上线代码不调.
export function resetForTest(): void {
  connections.clear();
  stopHeartbeatTick();
}