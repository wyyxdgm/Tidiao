import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BASE_PAGE_TITLE, getPageTitle } from "./page-title";

// 标题按环境区分 (飞书 AO-DEV R26): pulu 不动, prod 加 [PROD], dev 加 [DEV].
// 关注点: 复用了 deploy-guard 的 detectCurrentEnv, 这里只测映射 + 兜底.
describe("page-title: getPageTitle", () => {
  const originalUser = process.env.USER;
  const originalPort = process.env.PORT;
  const originalOrchUser = process.env.ORCHESTRATOR_USER;

  beforeEach(() => {
    delete process.env.USER;
    delete process.env.ORCHESTRATOR_USER;
    delete process.env.PORT;
  });
  afterEach(() => {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalOrchUser === undefined) delete process.env.ORCHESTRATOR_USER;
    else process.env.ORCHESTRATOR_USER = originalOrchUser;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it("BASE_PAGE_TITLE 是原始标题 (飞书 R26 要求 pulu 不动)", () => {
    expect(BASE_PAGE_TITLE).toBe("Agent Task Orchestrator");
  });

  it("pulu (USER=orchestrator) → 原标题不加前缀", () => {
    process.env.USER = "orchestrator";
    expect(getPageTitle()).toBe("Agent Task Orchestrator");
  });

  it("prod (PORT=13000) → [PROD] 前缀", () => {
    process.env.USER = "damo";
    process.env.PORT = "13000";
    expect(getPageTitle()).toBe("[PROD] Agent Task Orchestrator");
  });

  it("dev (PORT=13001) → [DEV] 前缀", () => {
    process.env.USER = "damo";
    process.env.PORT = "13001";
    expect(getPageTitle()).toBe("[DEV] Agent Task Orchestrator");
  });

  it("Mac 本地 / CI (认不出) → 原标题不动, 不报错", () => {
    process.env.USER = "damo";
    expect(getPageTitle()).toBe("Agent Task Orchestrator");
  });

  it("USER 和 PORT 都没设 → 原标题", () => {
    expect(getPageTitle()).toBe("Agent Task Orchestrator");
  });
});