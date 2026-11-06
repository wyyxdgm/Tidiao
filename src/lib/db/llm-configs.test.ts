// v50 多 LLM 配置 CRUD + 默认 + 解析链回归测试.
// 关注点: 用 ORCHESTRATOR_DB_PATH 指向临时库, 与生产库隔开; 不污染真实数据.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";

let tmpDir: string;
let testUserId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-llm-cfg-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  closeDb();
  getDb(); // 跑全部 migrations (含 v50) 到临时库
  testUserId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(testUserId, `${testUserId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("llm-configs CRUD (v50)", () => {
  it("createLlmConfig: 第一份自动 default, 第二份非默认", async () => {
    const { createLlmConfig, listLlmConfigs } = await import("./llm-configs");
    const a = createLlmConfig("user", testUserId, { name: "first", api_key: "sk-test-1", base_url: "https://a", model: "claude-3" });
    const b = createLlmConfig("user", testUserId, { name: "second", api_key: "sk-test-2", base_url: "https://b", model: "claude-3" });
    expect(a.is_default).toBe(1);
    expect(b.is_default).toBe(0);
    const list = listLlmConfigs("user", testUserId);
    expect(list).toHaveLength(2);
    // list 排序: default 优先 + 按 name
    expect(list[0].name).toBe("first");
    expect(list[1].name).toBe("second");
  });

  it("createLlmConfig: 拒绝空 name + 重名冲突", async () => {
    const { createLlmConfig, LlmConfigError } = await import("./llm-configs");
    createLlmConfig("user", testUserId, { name: "dup", api_key: "k1" });
    expect(() => createLlmConfig("user", testUserId, { name: "dup" })).toThrow(LlmConfigError);
    expect(() => createLlmConfig("user", testUserId, { name: "" })).toThrow(/name is required/);
  });

  it("setDefaultLlmConfig: 事务切换, 原 default 清零", async () => {
    const { createLlmConfig, setDefaultLlmConfig, listLlmConfigs } = await import("./llm-configs");
    const a = createLlmConfig("user", testUserId, { name: "a" });
    const b = createLlmConfig("user", testUserId, { name: "b" });
    expect(a.is_default).toBe(1);
    expect(b.is_default).toBe(0);
    setDefaultLlmConfig("user", testUserId, b.id);
    const list = listLlmConfigs("user", testUserId);
    const a2 = list.find((c) => c.id === a.id)!;
    const b2 = list.find((c) => c.id === b.id)!;
    expect(a2.is_default).toBe(0);
    expect(b2.is_default).toBe(1);
  });

  it("deleteLlmConfigById: 默认行/最后一份也允许删 (R215)", async () => {
    const { createLlmConfig, deleteLlmConfigById, getLlmConfigById, listLlmConfigs } = await import("./llm-configs");
    const a = createLlmConfig("user", testUserId, { name: "a" });
    expect(a.is_default).toBe(1);
    // 默认行直接删 (不再要求先切默认)
    expect(deleteLlmConfigById(a.id)).toBe(true);
    expect(getLlmConfigById(a.id)).toBeNull();
    // 删到只剩 0 份也 OK (运行时走平台默认 fallback)
    const b = createLlmConfig("user", testUserId, { name: "b" });
    expect(deleteLlmConfigById(b.id)).toBe(true);
    expect(listLlmConfigs("user", testUserId)).toHaveLength(0);
  });

  it("updateLlmConfig: 改 name 校验重名", async () => {
    const { createLlmConfig, updateLlmConfig, LlmConfigError } = await import("./llm-configs");
    createLlmConfig("user", testUserId, { name: "x" });
    const b = createLlmConfig("user", testUserId, { name: "y" });
    expect(() => updateLlmConfig(b.id, { name: "x" })).toThrow(LlmConfigError);
    expect(updateLlmConfig(b.id, { name: "y2" }).name).toBe("y2");
  });

  it("updateLlmConfig: clear_api_key 清空加密字段", async () => {
    const { createLlmConfig, updateLlmConfig, getLlmConfigById, toSafeLlmConfig } = await import("./llm-configs");
    const a = createLlmConfig("user", testUserId, { name: "k", api_key: "sk-original" });
    expect(toSafeLlmConfig(a)?.has_api_key).toBe(true);
    const updated = updateLlmConfig(a.id, { clear_api_key: true });
    const raw = getLlmConfigById(a.id)!;
    expect(raw.api_key_encrypted).toBeNull();
    expect(toSafeLlmConfig(updated)?.has_api_key).toBe(false);
  });
});

describe("duplicateLlmConfig (复制配置)", () => {
  it("拷贝后新行独立, 字段一致, 加密 key 复用, is_default 强制为 0", async () => {
    const { createLlmConfig, duplicateLlmConfig, getLlmConfigById, toSafeLlmConfig } = await import("./llm-configs");
    const src = createLlmConfig("user", testUserId, {
      name: "生产",
      api_key: "sk-secret-123",
      base_url: "https://api.example.com",
      model: "claude-opus-4",
      type: "anthropic",
    });
    expect(src.is_default).toBe(1);

    const dup = duplicateLlmConfig(src.id);
    expect(dup.id).not.toBe(src.id);
    expect(dup.name).toBe("生产-拷贝");
    expect(dup.owner_type).toBe("user");
    expect(dup.owner_id).toBe(testUserId);
    expect(dup.is_default).toBe(0); // 不抢源行的默认位
    expect(dup.type).toBe("anthropic");
    expect(dup.base_url).toBe("https://api.example.com");
    expect(dup.model).toBe("claude-opus-4");
    // api_key 加密字段直接复用
    expect(dup.api_key_encrypted).toBe(src.api_key_encrypted);
    expect(dup.api_key_iv).toBe(src.api_key_iv);
    expect(dup.api_key_tag).toBe(src.api_key_tag);
    // safe 视角下两份都有 key
    expect(toSafeLlmConfig(dup)?.has_api_key).toBe(true);

    // 源行未被改动
    const srcAfter = getLlmConfigById(src.id)!;
    expect(srcAfter.is_default).toBe(1);
    expect(srcAfter.name).toBe("生产");
  });

  it("name 冲突时自动加 -2/-3 后缀", async () => {
    const { createLlmConfig, duplicateLlmConfig } = await import("./llm-configs");
    const src = createLlmConfig("user", testUserId, { name: "X", api_key: "k" });
    const dup1 = duplicateLlmConfig(src.id);
    expect(dup1.name).toBe("X-拷贝");

    // 第二次拷贝: 现在已有 "X-拷贝" 了 → 应自动 -2
    const dup2 = duplicateLlmConfig(src.id);
    expect(dup2.name).toBe("X-拷贝-2");

    // 第三次: 应 -3
    const dup3 = duplicateLlmConfig(src.id);
    expect(dup3.name).toBe("X-拷贝-3");
  });

  it("duplicateLlmConfig: 不存在的 id 抛 not_found", async () => {
    const { duplicateLlmConfig, LlmConfigError } = await import("./llm-configs");
    expect(() => duplicateLlmConfig("non-existent-id")).toThrow(LlmConfigError);
  });
});

describe("available list (v50 授权聚合)", () => {
  it("未授权用户只看到自配; 授权后看到自配 + 平台", async () => {
    const { createLlmConfig, listAvailableLlmConfigs, setAdminLlmGrant } = await import("./llm-configs");
    // admin 配置 2 份
    createLlmConfig("admin", "system", { name: "admin-1", api_key: "sk-a1" });
    createLlmConfig("admin", "system", { name: "admin-2", api_key: "sk-a2" });
    // 用户自配 1 份
    createLlmConfig("user", testUserId, { name: "self-1", api_key: "sk-self" });

    const before = listAvailableLlmConfigs(testUserId, "user");
    expect(before).toHaveLength(1);
    expect(before[0].name).toBe("self-1");
    expect(before[0].source).toBe("self");

    setAdminLlmGrant(testUserId, true);
    const after = listAvailableLlmConfigs(testUserId, "user");
    expect(after).toHaveLength(3);
    const sources = after.map((c) => c.source).sort();
    expect(sources).toEqual(["admin_grant", "admin_grant", "self"]);

    // 收回授权 = 只剩自配
    setAdminLlmGrant(testUserId, false);
    const revoked = listAvailableLlmConfigs(testUserId, "user");
    expect(revoked).toHaveLength(1);
    expect(revoked[0].source).toBe("self");
  });

  it("admin role 始终能看到 admin 列表 (即使 grant 表无行)", async () => {
    const { createLlmConfig, listAvailableLlmConfigs } = await import("./llm-configs");
    createLlmConfig("admin", "system", { name: "platform" });
    const configs = listAvailableLlmConfigs("admin-id", "admin");
    expect(configs.some((c) => c.source === "admin_grant")).toBe(true);
  });
});

describe("resolveLlmConfig (v50)", () => {
  it("task.llm_config_id 优先于 user default", async () => {
    const { createLlmConfig, resolveLlmConfig } = await import("./llm-configs");
    const userDefault = createLlmConfig("user", testUserId, { name: "user-default", api_key: "sk-u", model: "user-model" });
    const explicit = createLlmConfig("user", testUserId, { name: "explicit", api_key: "sk-e", model: "explicit-model" });
    expect(userDefault.is_default).toBe(1);

    const taskRow = {
      model: null,
      owner_id: testUserId,
      project_id: null as string | null,
      llm_config_id: explicit.id,
      template_id: null as string | null,
    };
    const resolved = resolveLlmConfig(taskRow);
    expect(resolved.model).toBe("explicit-model");
    expect(resolved.source_config_id).toBe(explicit.id);
  });

  it("admin grant: 未授权时 admin 配置不可见 (不可解析)", async () => {
    const { createLlmConfig, resolveLlmConfig } = await import("./llm-configs");
    const adminCfg = createLlmConfig("admin", "system", { name: "platform", api_key: "sk-admin", model: "admin-model" });
    const u = createLlmConfig("user", testUserId, { name: "self", api_key: "sk-self", model: "self-model" });
    const taskRow = {
      model: null,
      owner_id: testUserId,
      project_id: null as string | null,
      llm_config_id: adminCfg.id, // 即便指定了 admin 的 config
      template_id: null as string | null,
    };
    const resolved = resolveLlmConfig(taskRow);
    // 解析时 admin cfg 不在 user 可用范围 -> 跳过, 落到 user default
    expect(resolved.source_config_id).toBe(u.id);
    expect(resolved.model).toBe("self-model");
  });

  it("admin grant: 授权后 admin 配置生效", async () => {
    const { createLlmConfig, resolveLlmConfig, setAdminLlmGrant } = await import("./llm-configs");
    const adminCfg = createLlmConfig("admin", "system", { name: "platform", api_key: "sk-admin", model: "admin-model" });
    setAdminLlmGrant(testUserId, true);
    createLlmConfig("user", testUserId, { name: "self", api_key: "sk-self", model: "self-model" });
    const taskRow = {
      model: null,
      owner_id: testUserId,
      project_id: null as string | null,
      llm_config_id: adminCfg.id,
      template_id: null as string | null,
    };
    const resolved = resolveLlmConfig(taskRow);
    expect(resolved.source_config_id).toBe(adminCfg.id);
    expect(resolved.model).toBe("admin-model");
  });

  it("modelOverride tri-state: string > undefined+task.model > null(链路)", async () => {
    const { createLlmConfig, resolveLlmConfig } = await import("./llm-configs");
    const cfg = createLlmConfig("user", testUserId, { name: "self", api_key: "k", model: "default-model" });
    const base = { model: "task-model", owner_id: testUserId, project_id: null as string | null, llm_config_id: cfg.id, template_id: null as string | null };
    // undefined -> 走 task.model (用户偏好, 优先于链路默认) — 保留 v36 行为
    expect(resolveLlmConfig(base, undefined).model).toBe("task-model");
    // null -> 忽略 task.model, 用链路默认 (cfg.model)
    expect(resolveLlmConfig(base, null).model).toBe("default-model");
    // string -> 强制
    expect(resolveLlmConfig(base, "override-model").model).toBe("override-model");
  });

  it("resolveLlmConfig: env 兜底 (no owner)", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.ANTHROPIC_BASE_URL = "https://env.example";
    try {
      const { resolveLlmConfig } = await import("./llm-configs");
      const r = resolveLlmConfig({ model: null, owner_id: null, project_id: null, llm_config_id: null, template_id: null });
      expect(r.api_key).toBe("env-key");
      expect(r.base_url).toBe("https://env.example");
    } finally {
      process.env.ANTHROPIC_API_KEY = origKey;
      process.env.ANTHROPIC_BASE_URL = origUrl;
    }
  });
});

describe("v514 fallback 链 + 视觉能力 (R175)", () => {
  // 惰性拿模块 (vitest ESM 下无 require; beforeEach 已建临时库)
  async function M() {
    return await import("./llm-configs");
  }

  async function createCfg(
    name: string,
    opts: { api_key?: string; base_url?: string; model?: string; supports_vision?: boolean | null; fallback_ids?: string[] } = {}
  ) {
    const m = await M();
    return m.createLlmConfig("user", testUserId, {
      name,
      api_key: opts.api_key,
      base_url: opts.base_url,
      model: opts.model,
      supports_vision: opts.supports_vision,
      fallback_ids: opts.fallback_ids,
    });
  }

  // A(默认, 明确无视觉) --fallback--> [B(同凭证), C(异凭证, claude=有视觉)]
  async function setupChain() {
    const m = await M();
    const a = await createCfg("A-main", { api_key: "sk-1", base_url: "https://ark/api/plan", model: "glm-5-2-260617", supports_vision: false });
    const b = await createCfg("B-same-cred", { api_key: "sk-1", base_url: "https://ark/api/plan", model: "minimax-m3" });
    const c = await createCfg("C-other", { api_key: "sk-2", base_url: "https://other/api", model: "claude-3" });
    m.updateLlmConfig(a.id, { fallback_ids: [b.id, c.id] });
    m.setDefaultLlmConfig("user", testUserId, a.id);
    return { a: m.getLlmConfigById(a.id), b: m.getLlmConfigById(b.id), c: m.getLlmConfigById(c.id) };
  }

  const taskOf = () => ({
    model: null, owner_id: testUserId, project_id: null, llm_config_id: null, template_id: null,
  });

  it("fallback_ids 透传 + 清空 + 拷贝随行", async () => {
    const m = await M();
    const a = await createCfg("fa", { api_key: "k" });
    const b = await createCfg("fb", {});
    m.updateLlmConfig(a.id, { fallback_ids: [b.id] });
    expect(m.parseFallbackIds(m.getLlmConfigById(a.id).fallback_ids)).toEqual([b.id]);
    const dup = m.duplicateLlmConfig(a.id);
    expect(m.parseFallbackIds(dup.fallback_ids)).toEqual([b.id]);
    m.updateLlmConfig(a.id, { fallback_ids: [] });
    expect(m.getLlmConfigById(a.id).fallback_ids).toBeNull();
  });

  it("validateFallbackIds: 跨 owner / 自引用 / 超上限 / 非数组 拒", async () => {
    const m = await M();
    const a = await createCfg("va", {});
    const admin = m.createLlmConfig("admin", "system", { name: "admin-cfg" });
    expect(() => m.updateLlmConfig(a.id, { fallback_ids: [admin.id] })).toThrow(m.LlmConfigError);
    expect(() => m.updateLlmConfig(a.id, { fallback_ids: [a.id] })).toThrow(/itself/);
    const others: string[] = [];
    for (let i = 0; i < 6; i++) {
      others.push((await createCfg(`v${i}`, {})).id);
    }
    expect(() => m.updateLlmConfig(a.id, { fallback_ids: others })).toThrow(/max/);
    expect(() => m.updateLlmConfig(a.id, { fallback_ids: "not-array" as never })).toThrow(m.LlmConfigError);
  });

  it("resolveLlmConfig 链构建: 同凭证进 fallback_models, 异凭证只进 chain", async () => {
    const m = await M();
    const ctx = await setupChain();
    const r = m.resolveLlmConfig(taskOf(), undefined); // 走 user default = A
    expect(r.source_config_id).toBe(ctx.a.id);
    expect(r.fallback_chain.map((e) => e.config_id)).toEqual([ctx.a.id, ctx.b.id, ctx.c.id]);
    expect(r.fallback_models).toEqual(["minimax-m3"]); // B 同凭证; C 异凭证排除
    expect(r.fallback_chain[2].same_credentials).toBe(false);
  });

  it("resolveLlmConfig 链防御: 直接写库塞进越权成员被跳过", async () => {
    const m = await M();
    const ctx = await setupChain();
    const admin = m.createLlmConfig("admin", "system", { name: "sneaky", api_key: "k9", model: "m9" });
    getDb().prepare(`UPDATE llm_configs SET fallback_ids = ? WHERE id = ?`).run(JSON.stringify([admin.id]), ctx.a.id);
    const r = m.resolveLlmConfig(taskOf(), undefined);
    expect(r.fallback_chain.map((e) => e.config_id)).not.toContain(admin.id);
  });

  it("视觉启发式: claude=支持, glm/minimax=未知(null), 显式列优先", async () => {
    const m = await M();
    expect(m.inferVisionFromModelName("claude-sonnet-4")).toBe(true);
    expect(m.inferVisionFromModelName("glm-5-2-260617")).toBeNull();
    expect(m.inferVisionFromModelName("minimax-m3")).toBeNull();
    expect(m.inferVisionFromModelName("qwen3-vl-plus")).toBe(true);
    expect(m.inferVisionFromModelName(null)).toBeNull();
    expect(m.effectiveVisionSupport({ supports_vision: 0, model: "claude-3" })).toBe(false);
    expect(m.effectiveVisionSupport({ supports_vision: null, model: "claude-3" })).toBe(true);
    expect(m.effectiveVisionSupport({ supports_vision: null, model: "minimax-m3" })).toBeNull();
  });

  it("planVisionSwap: 带图 + 主模型明确无视觉 → 换到链上视觉成员并重算 fallback_models", async () => {
    const m = await M();
    const ctx = await setupChain(); // A 无视觉, B 视觉未知, C claude 推断有视觉
    const r = m.resolveLlmConfig(taskOf(), undefined);
    const swapped = m.planVisionSwap(r, true);
    expect(swapped).not.toBeNull();
    expect(swapped!.source_config_id).toBe(ctx.c.id);
    expect(swapped!.model).toBe("claude-3");
    // 换主后 B 与 C 异凭证 → fallback_models 清空
    expect(swapped!.fallback_models).toEqual([]);
    expect(swapped!.fallback_chain[0].config_id).toBe(ctx.c.id);
  });

  it("planVisionSwap: 无图 / 主模型视觉未知 / 链上无视觉成员 → 不换", async () => {
    const m = await M();
    const ctx = await setupChain();
    const r = m.resolveLlmConfig(taskOf(), undefined);
    expect(m.planVisionSwap(r, false)).toBeNull();
    // 整链无视觉成员 (B/C 都显式 false)
    m.updateLlmConfig(ctx.b.id, { supports_vision: false });
    m.updateLlmConfig(ctx.c.id, { supports_vision: false });
    const r2 = m.resolveLlmConfig(taskOf(), undefined);
    expect(m.planVisionSwap(r2, true)).toBeNull();
    // 主模型视觉未知 → 即使链上有视觉也不换 (保守)
    m.updateLlmConfig(ctx.a.id, { supports_vision: null });
    m.updateLlmConfig(ctx.c.id, { supports_vision: true });
    const r3 = m.resolveLlmConfig(taskOf(), undefined);
    expect(m.planVisionSwap(r3, true)).toBeNull();
  });
});

describe("llm-configs per-model 单价 + 成本系数基准 (R239 / v519)", () => {
  it("create/读取: 单价三档 roundtrip, 非法值 normalize 成 null", async () => {
    const { createLlmConfig, getLlmConfigById, toSafeLlmConfig } = await import("./llm-configs");
    const cfg = createLlmConfig("admin", "system", {
      name: "priced", price_in: 3, price_out: 15, price_cache_read: 0.3,
    });
    const row = getLlmConfigById(cfg.id)!;
    expect(row.price_in).toBe(3);
    expect(row.price_out).toBe(15);
    expect(row.price_cache_read).toBe(0.3);
    // 非法值 (负数 / 非有限) → null
    const bad = createLlmConfig("admin", "system", {
      name: "bad-prices", price_in: -1, price_out: Infinity, price_cache_read: "abc" as unknown as number,
    });
    const badRow = getLlmConfigById(bad.id)!;
    expect(badRow.price_in).toBeNull();
    expect(badRow.price_out).toBeNull();
    expect(badRow.price_cache_read).toBeNull();
    // safe 形态带 coefficient 占位 (单独 attach 时才填)
    expect(toSafeLlmConfig(row).price_in).toBe(3);
    expect(toSafeLlmConfig(row).coefficient).toBeNull();
  });

  it("update: undefined=保留, null/非法=清除", async () => {
    const { createLlmConfig, updateLlmConfig, getLlmConfigById } = await import("./llm-configs");
    const cfg = createLlmConfig("admin", "system", { name: "u", price_in: 3, price_out: 15 });
    updateLlmConfig(cfg.id, { model: "m2" }); // 不碰价格
    expect(getLlmConfigById(cfg.id)!.price_in).toBe(3);
    updateLlmConfig(cfg.id, { price_in: 5 });
    expect(getLlmConfigById(cfg.id)!.price_in).toBe(5);
    updateLlmConfig(cfg.id, { price_out: null });
    expect(getLlmConfigById(cfg.id)!.price_out).toBeNull();
  });

  it("duplicate: 单价跟着拷贝", async () => {
    const { createLlmConfig, duplicateLlmConfig, getLlmConfigById } = await import("./llm-configs");
    const cfg = createLlmConfig("admin", "system", { name: "src", price_in: 3, price_out: 15, price_cache_read: 0.3 });
    const copy = duplicateLlmConfig(cfg.id);
    const row = getLlmConfigById(copy.id)!;
    expect(row.price_in).toBe(3);
    expect(row.price_out).toBe(15);
    expect(row.price_cache_read).toBe(0.3);
  });

  it("基准: set/get/clear roundtrip, 指向不存在的配置报 not_found, 删除配置后读取自愈为 null", async () => {
    const {
      createLlmConfig, getCostBaselineConfigId, setCostBaselineConfigId,
      deleteLlmConfigById, LlmConfigError,
    } = await import("./llm-configs");
    expect(getCostBaselineConfigId()).toBeNull();
    const cfg = createLlmConfig("admin", "system", { name: "baseline" });
    setCostBaselineConfigId(cfg.id);
    expect(getCostBaselineConfigId()).toBe(cfg.id);
    // 换基准
    const cfg2 = createLlmConfig("admin", "system", { name: "baseline2" });
    setCostBaselineConfigId(cfg2.id);
    expect(getCostBaselineConfigId()).toBe(cfg2.id);
    // 指向不存在 → 400 not_found
    expect(() => setCostBaselineConfigId("00000000-0000-0000-0000-000000000000")).toThrow(LlmConfigError);
    // 删除基准配置 → 读取自愈 null
    deleteLlmConfigById(cfg2.id);
    expect(getCostBaselineConfigId()).toBeNull();
    // 显式清除
    setCostBaselineConfigId(cfg.id);
    setCostBaselineConfigId(null);
    expect(getCostBaselineConfigId()).toBeNull();
  });

  it("attachCoefficients: 系数=入+出比值 2 位, 基准行系数可自证, 基准未配价全 null", async () => {
    const {
      createLlmConfig, setCostBaselineConfigId, getCostBaselineConfigId,
      listLlmConfigs, toSafeLlmConfig, attachCoefficients,
    } = await import("./llm-configs");
    const base = createLlmConfig("admin", "system", { name: "b1", price_in: 3, price_out: 15 });
    const half = createLlmConfig("admin", "system", { name: "b2", price_in: 1.5, price_out: 7.5 });
    const noprice = createLlmConfig("admin", "system", { name: "b3" });
    setCostBaselineConfigId(base.id);
    const baselineId = getCostBaselineConfigId();
    const safe = attachCoefficients(
      listLlmConfigs("admin", "system").map(toSafeLlmConfig),
      baselineId,
    );
    const byId = Object.fromEntries(safe.map((c) => [c.id, c]));
    expect(byId[half.id].coefficient).toBe(0.5);
    expect(byId[base.id].coefficient).toBe(1);
    expect(byId[noprice.id].coefficient).toBeNull();
    // 基准没配价 → 全 null
    const { setCostBaselineConfigId: setB } = await import("./llm-configs");
    setB(noprice.id);
    const safe2 = attachCoefficients(
      listLlmConfigs("admin", "system").map(toSafeLlmConfig),
      getCostBaselineConfigId(),
    );
    expect(safe2.every((c) => c.coefficient === null)).toBe(true);
  });

  it("getLlmPrices: 全空 → null, 有价 → 三档结构", async () => {
    const { createLlmConfig, getLlmPrices } = await import("./llm-configs");
    const empty = createLlmConfig("admin", "system", { name: "e1" });
    expect(getLlmPrices(empty.id)).toBeNull();
    const priced = createLlmConfig("admin", "system", { name: "e2", price_out: 15 });
    expect(getLlmPrices(priced.id)).toEqual({ in: null, out: 15, cacheRead: null });
    expect(getLlmPrices(null)).toBeNull();
  });
});
