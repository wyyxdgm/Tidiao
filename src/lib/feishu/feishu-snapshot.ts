// feishu-snapshot.ts — 飞书 sheet 行的本地 JSON 快照层 (R92 path J, 2026-09-08).
//
// 设计动机 (damo 0908 拍板):
//   - damo admin 有 20 个 feishu-enabled version × ~30s/version × lark-cli 串行拉
//     → refresh-cache 单 user 总耗时 10 min, 撞 schedule-runner 10 min 上限 → cron 反复 cooldown.
//   - 飞书 sheet 内容不会秒变, 1h TTL 内的"读旧数据"可接受 (cron 每 15 min 触发, 实际
//     fetch 频率 = 每 version 每 1h 才打一次 lark-cli, 平时读本地毫秒级).
//   - 实时性损失: 飞书 sheet 改动后最长 1h 才反映到 cache (经需求点编号跳转可接受).
//
// 设计要点:
//   - 路径: $ORCHESTRATOR_HOME/feishu-snapshots/<version_id>.json
//     (per-instance, 跨 deploy 持久, 不在 /tmp 因 pm2 restart 不丢).
//   - 原子写: .tmp + rename 避免读到半写文件 (refresh + 并发场景).
//   - TTL 0 = 永远命中 (调试); TTL -1 = 永远失效 (强制重拉).
//   - 损坏 JSON: 删文件 + 返回 null, 调用方降级到 lark-cli 重拉 (自愈).
//
// 关注点:
//   - 不在 snapshot 里存 sheet 元数据 (sheetName/sheetUrl/versionId 等) ——
//     cache DB 已经存了 sheet_url / sheet_name, snapshot 只存行内容, 避免 schema drift.
//   - 不做并发写保护: 写文件用 rename 是原子的; 同 version 并发读 + 写都是 OK 的
//     (refreshRequirementCache 已是串行 + per-version lock 由调用方负责).
//   - 不清理过期文件: 由后续手动 cron 或 ao knowledge --gc-snapshots 兜底
//     (v1 先不写, 等真有磁盘压力再说).
//   - 与 row-images.ts 同路径风格 (ORCHESTRATOR_HOME/<subdir>/<id>), 不混 /tmp.

import fs from "node:fs";
import path from "node:path";
import { ORCHESTRATOR_HOME } from "../constants";
import type { FeishuRow } from "./sheets";

const SNAPSHOT_SUBDIR = "feishu-snapshots";

export interface SnapshotEnvelope {
  version_id: string;
  fetched_at: string;      // ISO 8601 (写入时定)
  rows: FeishuRow[];
}

// ---- 路径 ----

function snapshotDir(): string {
  return path.join(ORCHESTRATOR_HOME, SNAPSHOT_SUBDIR);
}

export function snapshotPath(versionId: string): string {
  return path.join(snapshotDir(), `${versionId}.json`);
}

// ---- 读 (TTL 检查 + JSON 解析 + 损坏自愈) ----

/**
 * 功能: 读 snapshot, 若存在且 mtime 在 ttlSeconds 内则返回 rows; 否则返回 null.
 *
 * 关注点:
 *   - 用 stat mtime 判断新鲜度, 不必解析 JSON 才知道过期.
 *   - JSON 损坏 → 删文件 + console.warn + 返回 null (调用方降级到 lark-cli 重拉).
 *   - ttlSeconds = 0 → 永远命中 (调试用, 用于强制本地路径)
 *   - ttlSeconds < 0 → 永远失效 (强制重拉)
 */
export function getSnapshot(
  versionId: string,
  ttlSeconds: number
): FeishuRow[] | null {
  if (ttlSeconds < 0) return null;
  const p = snapshotPath(versionId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    // 文件不存在 → miss, 不算错
    return null;
  }
  const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
  if (ttlSeconds !== 0 && ageSeconds > ttlSeconds) return null;

  let env: SnapshotEnvelope;
  try {
    env = JSON.parse(fs.readFileSync(p, "utf-8")) as SnapshotEnvelope;
  } catch (e) {
    // 损坏 JSON → 删 + warn + miss (调用方降级重拉, 自愈)
    console.warn(
      `[feishu-snapshot] snapshot 损坏, 删 + 重拉: ${p} (${(e as Error).message})`
    );
    try {
      fs.unlinkSync(p);
    } catch {
      // 删失败也无所谓, 下次覆盖写
    }
    return null;
  }
  // 防御: envelope 形状校验, 避免空对象/缺字段导致下游崩
  if (!env || !Array.isArray(env.rows)) return null;
  return env.rows;
}

// ---- 写 (原子) ----

/**
 * 功能: 写 snapshot (原子 rename). 失败抛错但不阻断主流程 (调用方 catch 后走老路径).
 *
 * 关注点:
 *   - 先 .tmp 再 rename, 中途崩溃不会留半写文件.
 *   - mkdir -p 兜底 (ORCHESTRATOR_HOME 一定存在, subdir 可能不存在).
 */
export function saveSnapshot(versionId: string, rows: FeishuRow[]): void {
  const p = snapshotPath(versionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const env: SnapshotEnvelope = {
    version_id: versionId,
    fetched_at: new Date().toISOString(),
    rows,
  };
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(env), "utf-8");
  fs.renameSync(tmp, p);
}

// ---- 清 (手动失效 / 测试用) ----

/**
 * 功能: 删 snapshot. 失败 (文件不存在) 不抛错.
 * 用: 测试 fixture 清理; 未来 `ao knowledge --invalidate <version>` 手清.
 */
export function clearSnapshot(versionId: string): void {
  try {
    fs.unlinkSync(snapshotPath(versionId));
  } catch {
    // 不存在 = 没事
  }
}