// 功能: task-resources 采集器测试 — 纯解析函数单测 + self-scan 集成 smoke.
// 关注点: self-scan 依赖本进程 /proc (Linux-only); CI 非 Linux 环境下 smoke 段跳过.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { parseProcStat, matchTaskIdEnviron, scanTaskResources, parseProcStatCpuLine, scanHostSummary } from "./task-resources";

describe("parseProcStat", () => {
  it("解析常规 stat 行 (comm 无括号)", () => {
    // fields: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime vsize rss
    const line = "1234 (bash) S 1 1234 1234 0 -1 4194560 100 0 0 0 50 30 0 0 20 0 1 0 987654 5000000 250";
    const r = parseProcStat(line);
    expect(r).not.toBeNull();
    expect(r!.utime).toBe(50);
    expect(r!.stime).toBe(30);
    expect(r!.starttime).toBe(987654);
    expect(r!.rssPages).toBe(250);
  });

  it("comm 含空格和括号时取最后一个 ) 之后解析", () => {
    const line = "42 (node:agent (v2) ) R 1 0 0 0 -1 0 0 0 0 0 100 200 0 0 20 0 2 0 111222 8000000 400";
    const r = parseProcStat(line);
    expect(r).not.toBeNull();
    expect(r!.utime).toBe(100);
    expect(r!.stime).toBe(200);
    expect(r!.starttime).toBe(111222);
    expect(r!.rssPages).toBe(400);
  });

  it("缺字段 / 无 ) → null", () => {
    expect(parseProcStat("12 (x) S 1")).toBeNull();
    expect(parseProcStat("no parens here 1 2 3")).toBeNull();
  });
});

describe("matchTaskIdEnviron", () => {
  const enc = (s: string) => Buffer.from(s, "utf8");

  it("精确命中 token", () => {
    const buf = Buffer.concat([enc("PATH=/usr/bin"), enc("\0"), enc("ORCHESTRATOR_TASK_ID=abc-123"), enc("\0")]);
    expect(matchTaskIdEnviron(buf, "abc-123")).toBe(true);
  });

  it("前缀相似但不相等 → false (防 UUID 前缀撞车)", () => {
    const buf = Buffer.concat([enc("ORCHESTRATOR_TASK_ID=abc-123-longer"), enc("\0")]);
    expect(matchTaskIdEnviron(buf, "abc-123")).toBe(false);
  });

  it("无关变量 → false", () => {
    const buf = Buffer.concat([enc("ORCHESTRATOR_TASK_ID_X=abc-123"), enc("\0")]);
    expect(matchTaskIdEnviron(buf, "abc-123")).toBe(false);
  });

  it("无终止 NUL 时也命中 (内核截断场景)", () => {
    const buf = enc("A=1\0ORCHESTRATOR_TASK_ID=xyz");
    expect(matchTaskIdEnviron(buf, "xyz")).toBe(true);
  });
});

describe("scanTaskResources (集成 smoke, Linux-only)", () => {
  it("后台存活进程带 task id env → 扫描命中", async () => {
    if (process.platform !== "linux") {
      console.log("skip: 非 Linux 无 /proc");
      return;
    }
    // 🔴 /proc/<pid>/environ 是进程启动时的快照 — 改本进程 process.env 无效,
    // 必须 spawn 一个 env 从启动就带 task id 的子进程 (与 agent 子进程同场景).
    const { spawn } = await import("child_process");
    const tid = "bg-proc-scan-test-id";
    const child = spawn("sleep", ["5"], {
      env: { ...process.env, ORCHESTRATOR_TASK_ID: tid },
      stdio: "ignore",
      detached: false,
    });
    try {
      // 等子进程真正起来 (environ 快照可读).
      let sample: ReturnType<typeof scanTaskResources> extends Map<string, infer S> ? S | undefined : never;
      for (let i = 0; i < 20; i++) {
        const map = scanTaskResources(new Set([tid]));
        sample = map.get(tid);
        if (sample) break;
        spawnSync("sleep", ["0.1"]);
      }
      expect(sample).toBeDefined();
      expect(sample!.memRssMB).toBeGreaterThanOrEqual(0);
      expect(sample!.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(sample!.pids).toContain(child.pid!);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("不存在的 task id → 空 Map (不报错)", () => {
    if (process.platform !== "linux") return;
    const map = scanTaskResources(new Set(["no-such-task-0000"]));
    expect(map.has("no-such-task-0000")).toBe(false);
  });
});

/* ---------------- R232 追加: 系统级总览 ---------------- */

describe("parseProcStatCpuLine", () => {
  it("常规行: busy = total - idle - iowait", () => {
    // user100 nice0 system200 idle700 iowait50 irq0 softirq0 steal0 guest0 guest_nice0
    const r = parseProcStatCpuLine("cpu  100 0 200 700 50 0 0 0 0 0");
    expect(r).not.toBeNull();
    expect(r!.total).toBe(1050);
    expect(r!.busy).toBe(1050 - 750); // idle(700)+iowait(50)
  });

  it("非 cpu 汇总行 (cpu0/垃圾) → null", () => {
    expect(parseProcStatCpuLine("cpu0  100 0 200 700")).toBeNull();
    expect(parseProcStatCpuLine("garbage")).toBeNull();
    expect(parseProcStatCpuLine("")).toBeNull();
  });

  it("字段过少 (<4) → null", () => {
    expect(parseProcStatCpuLine("cpu  100 0")).toBeNull();
  });
});

describe("scanHostSummary (集成 smoke; Linux 走 /proc, mac 走 os API 兜底)", () => {
  it("返回真实总览: 内存>0, CPU% 落 0~100, 任务合计 = Σ样本", () => {
    const samples = scanTaskResources();
    const host = scanHostSummary(samples);
    // 环境异常拿不到就跳过 (不硬造失败).
    if (!host) return;
    expect(host.cpuCores).toBeGreaterThan(0);
    expect(host.cpuUsedPercent).toBeGreaterThanOrEqual(0);
    expect(host.cpuUsedPercent).toBeLessThanOrEqual(100);
    expect(host.memTotalMB).toBeGreaterThan(0);
    expect(host.memUsedMB).toBeGreaterThan(0);
    expect(host.memUsedMB).toBeLessThanOrEqual(host.memTotalMB);
    // R235: 负载 (load1/核数, 可 >100) + 磁盘 statfs.
    expect(host.loadPercent).toBeGreaterThanOrEqual(0);
    if (host.disk) {
      expect(host.disk.totalGB).toBeGreaterThan(0);
      expect(host.disk.usedGB).toBeGreaterThan(0);
      expect(host.disk.usedGB).toBeLessThanOrEqual(host.disk.totalGB);
      expect(host.disk.usedPercent).toBeGreaterThan(0);
      expect(host.disk.usedPercent).toBeLessThanOrEqual(100);
    }
    const sumCpu = [...samples.values()].reduce((a, s) => a + s.hostCpuPercent, 0);
    expect(host.taskCpuPercent).toBeCloseTo(sumCpu, 1);
    const sumMem = [...samples.values()].reduce((a, s) => a + s.memRssMB, 0);
    expect(host.taskMemMB).toBeCloseTo(sumMem, 1);
  });
});
