// 端口池 + 跨项目冲突检查 (R18 P2) 单测.
//
// 覆盖:
//  - normalizePorts 入参边界 (string/number[]/null/undefined/非法/超 5 个)
//  - isPortInPool 默认池 13000-13099 命中/未命中
//  - checkPortPoolConflict 出池 + 跨项目撞端口
//  - pickAvailablePorts 顺序 + 跨池段拼接
//  - PortPoolConflictError 结构化字段 + status 409
//
// 模式: 真 SQLite 临时库, 直接调 DB 层函数. 与 src/lib/db/quota.test.ts 一致.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { closeDb, getDb } from "./index";
import {
  normalizePorts,
  checkPortPoolConflict,
  pickAvailablePorts,
  createProject,
  listUsedPorts,
} from "./projects";
import {
  setPortPool,
  getPortPool,
  isPortInPool,
} from "./settings";
import { PortPoolConflictError } from "./port-pool-error";

let tmpDir: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-port-pool-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, "alice@example.com", "x", "user");

  // 强制重置端口池到默认值 (其它单测可能改过)
  setPortPool([[13000, 13099]]);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

describe("normalizePorts", () => {
  it("undefined / null → null (不分配)", () => {
    expect(normalizePorts(undefined)).toBeNull();
    expect(normalizePorts(null)).toBeNull();
  });

  it("空字符串 / 空数组 → null", () => {
    expect(normalizePorts("")).toBeNull();
    expect(normalizePorts(",, ,")).toBeNull();
    expect(normalizePorts([])).toBeNull();
  });

  it("逗号分隔 string → number[]", () => {
    expect(normalizePorts("13001, 13002, 13003")).toEqual([13001, 13002, 13003]);
  });

  it("number[] → 保持顺序 + 去重", () => {
    expect(normalizePorts([13001, 13002, 13001])).toEqual([13001, 13002]);
  });

  it("超过 5 个抛错", () => {
    expect(() => normalizePorts([1, 2, 3, 4, 5, 6])).toThrow(/最多 5 个/);
  });

  it("越界 (1023 或 65536) 抛错", () => {
    expect(() => normalizePorts([1023])).toThrow(/1024-65535/);
    expect(() => normalizePorts([65536])).toThrow(/1024-65535/);
  });

  it("非整数抛错", () => {
    expect(() => normalizePorts([13000.5])).toThrow(/1024-65535/);
    expect(() => normalizePorts("abc")).toThrow(/1024-65535/);
  });
});

describe("isPortInPool + 默认池", () => {
  it("13000-13099 命中, 12999 / 13100 未命中", () => {
    expect(isPortInPool(13000)).toBe(true);
    expect(isPortInPool(13099)).toBe(true);
    expect(isPortInPool(12999)).toBe(false);
    expect(isPortInPool(13100)).toBe(false);
  });

  it("setPortPool 改成窄池, 旧池端口不再命中", () => {
    setPortPool([[14000, 14010]]);
    expect(isPortInPool(13000)).toBe(false);
    expect(isPortInPool(14005)).toBe(true);
  });

  it("getPortPool 落库后再读回一致", () => {
    setPortPool([[14000, 14010], [15000, 15005]]);
    expect(getPortPool()).toEqual([
      [14000, 14010],
      [15000, 15005],
    ]);
  });

  it("setPortPool 非法值抛错, 库不被污染", () => {
    expect(() => setPortPool([[14000, 13999]])).toThrow();
    expect(() => setPortPool("not json" as unknown as number[][])).toThrow();
    // 库仍然是之前的 [13000,13099], 没被错误写入.
    expect(getPortPool()).toEqual([[13000, 13099]]);
  });
});

describe("checkPortPoolConflict", () => {
  it("无冲突 → null", () => {
    expect(checkPortPoolConflict([13050])).toBeNull();
  });

  it("端口在池外 → outOfPool 列出", () => {
    const c = checkPortPoolConflict([12000, 13050]);
    expect(c).not.toBeNull();
    expect(c!.outOfPool).toEqual([12000]);
  });

  it("端口已被其它项目占用 → conflicting 列出 owner", () => {
    // 先建一个项目占 13050
    createProject({ name: "alice-1", ownerId, ports: [13050] });
    const c = checkPortPoolConflict([13050]);
    expect(c).not.toBeNull();
    expect(c!.conflicting).toHaveLength(1);
    expect(c!.conflicting[0].port).toBe(13050);
    expect(typeof c!.conflicting[0].owner_project_id).toBe("string");
  });

  it("excludeProjectId 排除自己 (PATCH 自己不算冲突)", () => {
    const p = createProject({ name: "alice-2", ownerId, ports: [13051] });
    // 不排除 → 自己撞自己, 报冲突
    expect(checkPortPoolConflict([13051])).not.toBeNull();
    // 排除自己 → 不报
    expect(checkPortPoolConflict([13051], p.id)).toBeNull();
  });

  it("createProject 撞端口抛 PortPoolConflictError (status=409)", () => {
    createProject({ name: "first", ownerId, ports: [13060] });
    expect(() => createProject({ name: "second", ownerId, ports: [13060] })).toThrow(
      PortPoolConflictError,
    );
    try {
      createProject({ name: "third", ownerId, ports: [13060] });
    } catch (err) {
      const e = err as PortPoolConflictError;
      expect(e.code).toBe("PORT_POOL_CONFLICT");
      expect(e.status).toBe(409);
      expect(e.conflict.conflicting.length).toBeGreaterThan(0);
    }
  });
});

describe("pickAvailablePorts + listUsedPorts", () => {
  it("空池默认 13000-13099, 无占用时按序拿前 N 个", () => {
    expect(pickAvailablePorts(5, new Set())).toEqual([13000, 13001, 13002, 13003, 13004]);
  });

  it("占用 13000-13002 后, 跳过已用的", () => {
    expect(pickAvailablePorts(3, new Set([13000, 13001, 13002]))).toEqual([
      13003, 13004, 13005,
    ]);
  });

  it("跨池段拼接, 第一段拿完进第二段", () => {
    setPortPool([[13000, 13002], [14000, 14005]]);
    expect(pickAvailablePorts(5, new Set())).toEqual([
      13000, 13001, 13002, 14000, 14001,
    ]);
  });

  it("listUsedPorts 跨项目聚合", () => {
    createProject({ name: "a", ownerId, ports: [13070] });
    createProject({ name: "b", ownerId, ports: [13071, 13072] });
    const used = listUsedPorts();
    expect(used.has(13070)).toBe(true);
    expect(used.has(13071)).toBe(true);
    expect(used.has(13072)).toBe(true);
    expect(used.has(13073)).toBe(false);
  });

  it("n<=0 返空数组", () => {
    expect(pickAvailablePorts(0, new Set())).toEqual([]);
    expect(pickAvailablePorts(-1, new Set())).toEqual([]);
  });
});
