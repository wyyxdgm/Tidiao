// 内存闸门: 调度器出队前检查可用内存, 不够就不派新任务 (任务留在 queued,
// 内存恢复后下轮 schedule() 自动继续, 无需人工 resume).
//
// 背景: WSL 16G 三连卡死 (2026-10-08 + 2026-10-31) 根因 = 任务起的 dev server
// 吃光内存 + swap 打满. 平台层兜底 = 派发前看 MemAvailable, 低于阈值不再
// 出队, 同时给排队任务 owner 发一封预警邮件 (去重: 持续低内存只发一次,
// 恢复时发一条恢复通知并重置).
//
// 阈值: env AO_MEM_GUARD_MB (MB), 默认 2048. WSL 可用基线 ~4-5G, agent 任务
// 峰值 300-600M/个 + 测试进程可到 1-2G, 2G = 留够一个任务的安全余量.

import os from "os";
import { readFileSync } from "fs";

const DEFAULT_THRESHOLD_MB = 2048;

// 功能: 读当前可用内存(MB). Linux 优先 /proc/meminfo 的 MemAvailable
//   (含可回收 page cache, 比 free 准); 读不到 (macOS) 回落 os.freemem().
// 关注点: macOS freemem 不含可回收 cache, 偏保守 (更容易触发闸门) —— dev 机
//   可用 AO_MEM_GUARD_MB=0 关掉.
export function getMemAvailableMb(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) return parseInt(m[1], 10) / 1024;
  } catch {
    // macOS / 异常环境: 走 fallback
  }
  return os.freemem() / (1024 * 1024);
}

// 功能: 解析阈值 env. 非数字/负数一律回退平台默认.
// 关注点: darwin 平台默认 0 (关闸) —— os.freemem() 只算纯空闲页 (大头在
//   file cache), 实测常年个位数~几十 MB, 闸门会永远触发且永不恢复 (2026-10-31
//   Mac 实例实证: freemem=21MB, cron 任务卡 queued). 显式设 AO_MEM_GUARD_MB
//   仍可在 Mac 上启用.
export function getMemGuardThresholdMb(): number {
  const raw = process.env.AO_MEM_GUARD_MB;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (process.platform === "darwin") return 0;
  return DEFAULT_THRESHOLD_MB;
}

export interface MemCheckResult {
  ok: boolean; // true = 内存够, 可以出队
  memMb: number;
  thresholdMb: number;
  // 状态翻转标记 (通知去重用): 本次检查让预警从无到有 / 恢复从有到无才为 true,
  // 持续低内存期间反复 check 不会重复触发.
  alertJustTriggered: boolean;
  recovered: boolean;
}

// 功能: 有状态闸门. 每次 check 读一次内存, 维护 alertActive 翻转沿.
// 关注点: check() 内部捕不了 readFileSync 之外的错 —— getMemAvailableMb 已
//   全路径降级, 这里不再包 try (调度器 while 循环外有 try/finally).
export class MemGate {
  private alertActive = false;
  private thresholdMb: number;

  constructor(thresholdMb?: number) {
    this.thresholdMb = thresholdMb ?? getMemGuardThresholdMb();
  }

  check(memMb: number = getMemAvailableMb()): MemCheckResult {
    const ok = memMb >= this.thresholdMb;
    const alertJustTriggered = !ok && !this.alertActive;
    const recovered = ok && this.alertActive;
    this.alertActive = !ok;
    return {
      ok,
      memMb: Math.round(memMb),
      thresholdMb: this.thresholdMb,
      alertJustTriggered,
      recovered,
    };
  }
}
