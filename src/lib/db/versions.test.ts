// versions.test.ts — v512 enable 列单测 (sheetwatch 开关).
//
// 覆盖:
//   - migration v512 把 enable 列加到 versions, 默认 1
//   - createVersion 不传 enable → 1 (兼容老 binding)
//   - createVersion({ enable: false }) → 0
//   - updateVersion 显式 enable=false 落 0, enable=true 落 1
//   - updateVersion 不传 enable → 不改 (跟 feishu_sheet 等同)
//   - getVersionById / listVersions 返回 enable 字段为 0|1
//
// 跟同仓 src/lib/db/accounts.test.ts 共用 tmp DB 模式.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb, closeDb } from "./index";
import {
  createVersion,
  getVersionById,
  listVersions,
  updateVersion,
} from "./versions";
import { createProject } from "./projects";

let tmpDir: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-versions-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  getDb(); // 跑全部 migrations (含 v512)
  // 准备一个 project 装 version (createVersion 要求 project_id 存在 + owner_id != NULL 时校验)
  // 测试里直接 bypass owner: 走 createProject({ name }) 即可 (owner_id 默认 NULL, 测试场景足够).
  const p = createProject({
    name: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: null,
  });
  projectId = p.id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("versions enable (v512 sheetwatch 开关)", () => {
  it("createVersion 不传 enable → 默认 1 (兼容老 binding)", () => {
    const v = createVersion({
      project_id: projectId,
      name: "no-enable-arg",
      feishu_url: "https://example/wiki/abc",
      feishu_sheet: "SheetA",
    });
    expect(v.enable).toBe(1);
  });

  it("createVersion 显式 enable: true → 1", () => {
    const v = createVersion({
      project_id: projectId,
      name: "explicit-true",
      feishu_url: null,
      feishu_sheet: null,
      enable: true,
    });
    expect(v.enable).toBe(1);
  });

  it("createVersion 显式 enable: false → 0", () => {
    const v = createVersion({
      project_id: projectId,
      name: "explicit-false",
      feishu_url: "https://example/wiki/abc",
      feishu_sheet: "SheetB",
      enable: false,
    });
    expect(v.enable).toBe(0);
  });

  it("updateVersion 显式 enable=false 落 0, enable=true 落 1", () => {
    const v = createVersion({
      project_id: projectId,
      name: "toggle-me",
      feishu_url: null,
      feishu_sheet: null,
    });
    expect(v.enable).toBe(1);

    const off = updateVersion(v.id, { enable: false });
    expect(off?.enable).toBe(0);

    const on = updateVersion(v.id, { enable: true });
    expect(on?.enable).toBe(1);
  });

  it("updateVersion 不传 enable → 其他字段改动时 enable 保持原值", () => {
    const v = createVersion({
      project_id: projectId,
      name: "untouched-enable",
      feishu_url: "https://example/wiki/abc",
      feishu_sheet: "SheetC",
      enable: false,
    });
    expect(v.enable).toBe(0);

    const updated = updateVersion(v.id, {
      feishu_sheet: "SheetC-new",
    });
    expect(updated?.enable).toBe(0);
    expect(updated?.feishu_sheet).toBe("SheetC-new");
  });

  it("getVersionById / listVersions 返回 enable 字段 (0|1)", () => {
    createVersion({ project_id: projectId, name: "v1", feishu_url: null, feishu_sheet: null, enable: false });
    createVersion({ project_id: projectId, name: "v2", feishu_url: null, feishu_sheet: null });

    const list = listVersions(projectId);
    expect(list).toHaveLength(2);
    const byName = Object.fromEntries(list.map((v) => [v.name, v.enable]));
    expect(byName.v1).toBe(0);
    expect(byName.v2).toBe(1);

    const fetched = getVersionById(list[0].id);
    expect(fetched?.enable).toBe(0);
  });
});
describe("versions description (v513 飞书 R172)", () => {
  it("createVersion 传 description → 落库可读; 不传 → null", () => {
    const withDesc = createVersion({
      project_id: projectId,
      name: "desc-v1",
      description: "追踪 GDM 需求",
    });
    expect(withDesc.description).toBe("追踪 GDM 需求");

    const withoutDesc = createVersion({ project_id: projectId, name: "desc-v2" });
    expect(withoutDesc.description).toBeNull();
  });

  it("updateVersion 改 description / 传 null 清空", () => {
    const v = createVersion({
      project_id: projectId,
      name: "desc-edit",
      description: "初稿",
    });
    const changed = updateVersion(v.id, { description: "改成追踪 yidao" });
    expect(changed?.description).toBe("改成追踪 yidao");
    const cleared = updateVersion(v.id, { description: null });
    expect(cleared?.description).toBeNull();
  });

  it("updateVersion 不传 description → 保持原值 (undefined 即不改)", () => {
    const v = createVersion({
      project_id: projectId,
      name: "desc-keep",
      description: "别动我",
    });
    const untouched = updateVersion(v.id, { feishu_sheet: "SheetX" });
    expect(untouched?.description).toBe("别动我");
  });
});
