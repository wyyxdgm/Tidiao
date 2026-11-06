// 功能: 按 ORCHESTRATOR_TASK_ID 从 /proc 反查任务进程树, 采集 CPU% / 内存 RSS.
// 返回 Map<taskId, TaskResourceSample>, 供 GET /api/tasks/resources 批量端点使用.
//
// 关注点:
// - 原理: active-session.ts buildEnv() 给 agent SDK 子进程注入 ORCHESTRATOR_TASK_ID,
//   子进程树 (bash / git / node 等) 继承 env → 读 /proc/<pid>/environ 即可把
//   同一 task 的所有进程聚合起来, 无需 runtime 改动或维护 pid 注册表.
// - 只在 Linux 有效 (WSL / pulu 均是). macOS / Windows 上 listDir('/proc') 为空
//   或读失败 → 返回空 Map, 调用端按「无数据」处理, 不报错.
// - CPU% 口径: Δ(jiffies) / Δ(wall) / CLK_TCK * 100, 单核口径可 >100;
//   hostCpuPercent = cpuPercent / os.cpus().length (全机占比).
//   首次采样无基线 → 用 since-start 平均 (jiffies / (now - starttime)).
// - 基线缓存在模块级 Map; 进程重启 (总 jiffies 变小) 时自动重置基线.
// - 性能: 全 /proc 扫描 = 每进程 2 次 read (environ + stat), 几百进程几 ms,
//   前端 2s 轮询无压力. environ 读取失败 (权限/僵尸) 静默跳过.

import { readdirSync, readFileSync, statfsSync } from "fs";
import os from "os";

/** Linux CLK_TCK (用户态恒 100, getconf CLK_TCK 验证过). Node 无 sysconf, 写死. */
const CLK_TCK = 100;

/** environ 里注入的 task id 变量名 (active-session.ts buildEnv 同名). */
const TASK_ID_ENV_KEY = "ORCHESTRATOR_TASK_ID";
const TASK_ID_ENV_KEY_BUF = Buffer.from(TASK_ID_ENV_KEY);

export interface TaskResourceSample {
  /** 命中的进程树 pid 列表 (含 SDK 主进程 + bash/git 等子进程). */
  pids: number[];
  /** 单核口径 CPU % (可 >100, 多线程/多进程合计). */
  cpuPercent: number;
  /** 全机口径 CPU % = cpuPercent / 核心数. */
  hostCpuPercent: number;
  /** 进程树 RSS 合计 MB. */
  memRssMB: number;
  /** 占全机内存 % (RSS 合计 / MemTotal). */
  memPercent: number;
  /** 采样时刻 epoch ms. */
  sampledAt: number;
}

/** /proc/<pid>/stat 解析结果 (只取需要的字段). */
export interface ProcStatFields {
  utime: number;
  stime: number;
  /** 进程启动时刻 (jiffies since boot). */
  starttime: number;
  /** RSS 页数. */
  rssPages: number;
}

/**
 * 解析 /proc/<pid>/stat 一行. comm 字段可能含空格和括号 → 取最后一个 ')' 之后
 * split, 之后的 token[0] = field3 (state), 依此偏移.
 */
export function parseProcStat(line: string): ProcStatFields | null {
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  const after = line.slice(close + 1).trim().split(/\s+/);
  // after[i] = field (3+i). utime=field14 → i=11, stime=15 → 12, starttime=22 → 19, rss=24 → 21.
  const utime = Number(after[11]);
  const stime = Number(after[12]);
  const starttime = Number(after[19]);
  const rssPages = Number(after[21]);
  if (![utime, stime, starttime, rssPages].every((n) => Number.isFinite(n))) return null;
  return { utime, stime, starttime, rssPages };
}

/** 从 environ buffer (NUL 分隔) 精确匹配 ORCHESTRATOR_TASK_ID=<taskId>.
    比对后必须落在 token 边界 (NUL 或 buffer 结尾), 防值前缀撞车. */
export function matchTaskIdEnviron(buf: Buffer, taskId: string): boolean {
  const needle = `${TASK_ID_ENV_KEY}=${taskId}`;
  const nLen = needle.length;
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0, start);
    if (end < 0) end = buf.length;
    if (end - start === nLen) {
      let same = true;
      for (let i = 0; i < nLen; i++) {
        if (buf[start + i] !== needle.charCodeAt(i)) { same = false; break; }
      }
      if (same) return true;
    }
    start = end + 1;
  }
  return false;
}

/** /proc/meminfo 第一行 MemTotal kB (模块级缓存, 开机后不变). */
let memTotalKb: number | null = null;
function getMemTotalKb(): number | null {
  if (memTotalKb != null) return memTotalKb;
  try {
    const first = readFileSync("/proc/meminfo", "utf8").split("\n")[0];
    const m = first.match(/^MemTotal:\s+(\d+)\s+kB/);
    if (m) memTotalKb = Number(m[1]);
  } catch {
    /* 非 Linux → null */
  }
  return memTotalKb;
}

/** CPU 基线: taskId → 上次采样 {总 jiffies, 墙钟 ms}. */
const cpuBaseline = new Map<string, { jiffies: number; ts: number }>();

/** 单次 /proc 扫描: 聚合每个 task 的进程树资源. taskIds 过滤可选 (不传 = 全量). */
export function scanTaskResources(taskIds?: Set<string>): Map<string, TaskResourceSample> {
  const result = new Map<string, TaskResourceSample>();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return result; // 非 Linux
  }
  const memTotalKbNow = getMemTotalKb();
  // os.pageSize() 在 Node 18.14+ 才有; 类型定义旧的运行时用 fallback 4096 (Linux 常规页).
  const osLike = os as unknown as { pageSize?: () => number };
  const pageSize = typeof osLike.pageSize === "function" ? osLike.pageSize() : 4096;
  const now = Date.now();
  const ncores = Math.max(1, os.cpus().length);

  // 第一遍: environ 匹配 task → pids + stat 聚合.
  const perTask = new Map<string, { pids: number[]; utime: number; stime: number; starttime: number; rssPages: number }>();
  for (const pid of pids) {
    let envBuf: Buffer;
    try {
      envBuf = readFileSync(`/proc/${pid}/environ`);
    } catch {
      continue; // 内核线程 / 权限 / 刚退出
    }
    // 快速预筛: buffer 里没有 key 字节串就直接跳过 (绝大多数进程不命中).
    if (!envBuf.includes(TASK_ID_ENV_KEY_BUF)) continue;

    let stat: ProcStatFields | null = null;
    try {
      stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      continue;
    }
    if (!stat) continue;

    // 逐 task 精确匹配 (扫描模式下命中任意一个目标 task 都算).
    let matchedTaskId: string | null = null;
    if (taskIds) {
      for (const tid of taskIds) {
        if (matchTaskIdEnviron(envBuf, tid)) { matchedTaskId = tid; break; }
      }
    } else {
      // 全量模式: 直接从 environ 解出 task id 值.
      const val = extractTaskIdValue(envBuf);
      if (val) matchedTaskId = val;
    }
    if (!matchedTaskId) continue;

    let agg = perTask.get(matchedTaskId);
    if (!agg) {
      agg = { pids: [], utime: 0, stime: 0, starttime: stat.starttime, rssPages: 0 };
      perTask.set(matchedTaskId, agg);
    }
    agg.pids.push(Number(pid));
    agg.utime += stat.utime;
    agg.stime += stat.stime;
    agg.rssPages += stat.rssPages;
    // starttime 取最早 (进程树最老成员), 仅用于首次基线兜底.
    if (stat.starttime < agg.starttime) agg.starttime = stat.starttime;
  }

  // 第二遍: 算 CPU% (基线差分) + 内存.
  const uptimeJiffies = getUptimeJiffies(now);
  for (const [taskId, agg] of perTask) {
    const totalJiffies = agg.utime + agg.stime;
    const prev = cpuBaseline.get(taskId);
    let cpuPercent: number;
    if (prev && totalJiffies >= prev.jiffies && now > prev.ts) {
      cpuPercent = ((totalJiffies - prev.jiffies) / ((now - prev.ts) / 1000) / CLK_TCK) * 100;
    } else {
      // 首次采样或进程重启 (jiffies 回退) → since-start 平均.
      const wallJiffies = Math.max(1, uptimeJiffies - agg.starttime);
      cpuPercent = (totalJiffies / wallJiffies) * 100;
    }
    cpuBaseline.set(taskId, { jiffies: totalJiffies, ts: now });

    const rssKb = (agg.rssPages * pageSize) / 1024;
    const memPercent = memTotalKbNow ? (rssKb / memTotalKbNow) * 100 : 0;
    result.set(taskId, {
      pids: agg.pids.sort((a, b) => a - b),
      cpuPercent: round1(cpuPercent),
      hostCpuPercent: round1(cpuPercent / ncores),
      memRssMB: Math.round(rssKb / 1024 * 10) / 10,
      memPercent: round1(memPercent),
      sampledAt: now,
    });
  }

  // 清理已消失 task 的基线 (防 Map 无限膨胀).
  for (const tid of cpuBaseline.keys()) {
    if (!perTask.has(tid)) cpuBaseline.delete(tid);
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  R232 追加: 系统级总览 (全机 CPU / 内存), 供管理员总条使用.          */
/* ------------------------------------------------------------------ */

export interface HostResourceSummary {
  cpuCores: number;
  /** 全机 CPU 已用 % (所有进程, 含非平台进程), 0~100. */
  cpuUsedPercent: number;
  /** 平台任务合计 CPU % (全机口径, Σ hostCpuPercent). */
  taskCpuPercent: number;
  memTotalMB: number;
  /** 全机已用内存 MB = MemTotal - MemAvailable (含 cache 扣除, 比.free 准). */
  memUsedMB: number;
  /** 平台任务合计 RSS MB. */
  taskMemMB: number;
  /** 1 分钟负载 ÷ 核心数 ×100 (宝塔同口径), 可 >100 (过载不截断). */
  loadPercent: number;
  /** 根分区磁盘总览; statfs 不可用时 null. */
  disk: DiskSummary | null;
  sampledAt: number;
}

/** 磁盘总览. used = total - bavail (含 ext4 root 保留块, 对齐宝塔显示口径). */
export interface DiskSummary {
  totalGB: number;
  usedGB: number;
  usedPercent: number;
}

/** /proc/stat 首行 (cpu  user nice system idle iowait irq softirq steal ...) 解析:
    busy = total - idle - iowait. guest 已计入 user, 不重复扣. */
export function parseProcStatCpuLine(line: string): { busy: number; total: number } | null {
  const m = line.match(/^cpu\s+(\d[\d\s]*)$/);
  if (!m) return null;
  const fields = m[1].trim().split(/\s+/).map(Number);
  if (fields.length < 4 || !fields.every((n) => Number.isFinite(n))) return null;
  const total = fields.reduce((a, b) => a + b, 0);
  const idle = fields[3] + (fields[4] ?? 0); // idle + iowait
  return { busy: total - idle, total };
}

/** 全机 CPU 差分基线 (模块级, 与 per-task 基线同生命周期策略). */
let hostCpuBaseline: { busy: number; total: number; ts: number } | null = null;

/** 读全机内存: MemTotal / MemAvailable (kB → MB). */
function getHostMemKb(): { total: number; available: number } | null {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const total = Number(text.match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1]);
    const available = Number(text.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]);
    if (Number.isFinite(total) && Number.isFinite(available)) return { total, available };
  } catch {
    /* 非 Linux → null */
  }
  return null;
}

/**
 * 采集系统级总览. taskSamples 传入同轮 scanTaskResources 的结果, 用于汇总任务占比.
 * Linux 主路径走 /proc; macOS 开发机走 os API 兜底 (R235, 数值 = Mac 本机真实值,
 * 让 5173 本地也能看到汇总圈/资源条); 其余平台返回 null.
 */
export function scanHostSummary(
  taskSamples?: Map<string, TaskResourceSample>,
): HostResourceSummary | null {
  const now = Date.now();
  const cores = Math.max(1, os.cpus().length);

  // 内存 + CPU 累计值: Linux 从 /proc 取, Mac 从 os API 取, 之后统一差分/汇总.
  let memKb: { total: number; available: number } | null = null;
  let busy = 0;
  let totalJiffies = 0;
  let haveCpu = false;

  let statLine: string | null = null;
  try {
    statLine = readFileSync("/proc/stat", "utf8").split("\n")[0];
  } catch {
    /* 非 Linux */
  }
  const procMem = getHostMemKb();
  if (procMem && statLine) {
    memKb = procMem;
    const cur = parseProcStatCpuLine(statLine);
    if (cur) {
      busy = cur.busy;
      totalJiffies = cur.total;
      haveCpu = true;
    }
  } else if (process.platform === "darwin") {
    // freemem 偏保守 (macOS 无 MemAvailable 等价物), dev 环境够用.
    const totalBytes = os.totalmem();
    if (totalBytes <= 0) return null;
    memKb = { total: totalBytes / 1024, available: os.freemem() / 1024 };
    for (const c of os.cpus()) {
      const t = c.times;
      const tot = t.user + t.nice + t.sys + t.idle + t.irq;
      totalJiffies += tot;
      busy += tot - t.idle;
    }
    haveCpu = true;
  } else {
    return null;
  }

  let cpuUsedPercent = 0;
  if (haveCpu) {
    const prev = hostCpuBaseline;
    if (prev && totalJiffies > prev.total && now > prev.ts) {
      cpuUsedPercent = ((busy - prev.busy) / (totalJiffies - prev.total)) * 100;
    }
    // 首次采样无基线 → 给 0 (下一轮起差分). 不用 since-start: 全机平均
    // 会被开机以来的历史拉低, 对「当前消耗」误导.
    hostCpuBaseline = { busy, total: totalJiffies, ts: now };
  }

  let taskCpu = 0;
  let taskMem = 0;
  if (taskSamples) {
    for (const s of taskSamples.values()) {
      taskCpu += s.hostCpuPercent;
      taskMem += s.memRssMB;
    }
  }

  // 负载: 1 分钟 loadavg 归一化到核心数 (宝塔「负载 %」口径). 可 >100 = 过载.
  const loadPercent = round1((os.loadavg()[0] / cores) * 100);

  // 磁盘: statfs('/') 一次 syscall, 3s 轮询无压力. 失败 → null (前端显示 --).
  let disk: DiskSummary | null = null;
  try {
    const st = statfsSync("/");
    const total = st.blocks * st.bsize;
    const avail = st.bavail * st.bsize;
    if (total > 0) {
      const used = Math.max(0, total - avail);
      disk = {
        totalGB: round1(total / 1024 ** 3),
        usedGB: round1(used / 1024 ** 3),
        usedPercent: round1((used / total) * 100),
      };
    }
  } catch {
    /* statfs 不可用 → null */
  }

  return {
    cpuCores: cores,
    cpuUsedPercent: round1(Math.min(100, Math.max(0, cpuUsedPercent))),
    taskCpuPercent: round1(taskCpu),
    memTotalMB: Math.round(memKb.total / 1024),
    memUsedMB: Math.round((memKb.total - memKb.available) / 1024),
    taskMemMB: Math.round(taskMem * 10) / 10,
    loadPercent,
    disk,
    sampledAt: now,
  };
}

/** 从 environ buffer 解出 ORCHESTRATOR_TASK_ID 的值 (全量模式用). */
function extractTaskIdValue(buf: Buffer): string | null {
  const key = `${TASK_ID_ENV_KEY}=`;
  const idx = buf.indexOf(Buffer.from(key));
  if (idx < 0) return null;
  let end = buf.indexOf(0, idx);
  if (end < 0) end = buf.length;
  const val = buf.slice(idx + key.length, end).toString("utf8").trim();
  return val || null;
}

/** 当前 uptime 对应的 jiffies (boot 至今秒数 × CLK_TCK). */
function getUptimeJiffies(nowMs: number): number {
  try {
    const up = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (Number.isFinite(up)) return up * CLK_TCK;
  } catch {
    /* fallthrough */
  }
  // 兜底: os.uptime() 秒.
  return os.uptime() * CLK_TCK;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
