# 测试规范

> 状态：v1.0 — 2026-07-30

## 测试分层

| 层 | 工具 | 范围 | 运行方式 | 保留 |
|---|---|---|---|---|
| **单元测试** | vitest | DB 操作、纯逻辑、工具函数 | `npm test` | ✅ 进 git |
| **集成测试** | vitest + 临时 DB | API 路由（含 DB + 中间件） | `npm test` | ✅ 进 git |
| **E2E 测试** | vitest + 启动真实服务 | 完整 HTTP 请求→响应链 | `npm run test:e2e` | ✅ 进 git |
| **手动自测** | curl / 浏览器 | agent 自测用 | 一次性 | ❌ 不保留 |

## 单元测试

**已有模式**（参考 `src/lib/db/roles-unique.test.ts`）：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb, closeDb } from "./index";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑所有 migration
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

**规则**：
- 每个测试用临时 DB（`ORCHESTRATOR_DB_PATH`），不碰生产数据
- 测试文件放在被测文件同目录：`src/lib/db/attachments.ts` → `src/lib/db/attachments.test.ts`
- 不需要网络/API Key — 只测 DB 逻辑

## 集成测试

测试 API 路由的完整处理链（认证 → 校验 → DB 操作 → 响应），但**不启动 HTTP 服务器**。

**模式**：用 Next.js 的 route handler 直接调用：

```typescript
import { POST } from "@/app/api/tasks/[id]/attachments/route";
import { NextRequest } from "next/server";

// 构造 Request 对象
const req = new NextRequest("http://localhost/api/tasks/xxx/attachments", {
  method: "POST",
  headers: { "x-user-id": userId },
  body: formData,
});
const res = await POST(req, { params: { id: taskId } });
expect(res.status).toBe(200);
```

**规则**：
- 同样用临时 DB
- 手动注入 `x-user-id` header 模拟认证
- 不需要真实 JWT / cookie

## E2E 测试

**启动真实 Next.js 服务，发 HTTP 请求，断言完整响应**。

### 架构

```
vitest (test:e2e)
  ├── beforeAll: 启动 next start (临时端口 + 临时 DB)
  ├── 测试用例: fetch() → 断言
  └── afterAll: 停止服务 + 清理
```

### 辅助模块：`src/test/e2e-helpers.ts`

```typescript
import { execSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

let tmpDir: string;
let baseUrl: string;
let serverProcess: ReturnType<typeof spawn>;

export async function setupE2E(): Promise<{ baseUrl: string; tmpDir: string }> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-"));
  const dbPath = path.join(tmpDir, "e2e.db");
  const port = 13099; // 固定 E2E 端口，避免冲突

  // 先 build（确保最新代码）
  execSync("npx next build", { stdio: "pipe" });

  // 启动 next start
  serverProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    env: {
      ...process.env,
      ORCHESTRATOR_HOME: tmpDir,
      ORCHESTRATOR_DB_PATH: dbPath,
      PORT: String(port),
      COOKIE_SECURE: "0",
      JWT_SECRET: "e2e-test-secret",
      // 用真实 API Key 或 mock（见下）
    },
    stdio: "pipe",
  });

  // 等待服务就绪
  await waitForPort(port, 15000);
  baseUrl = `http://localhost:${port}`;
  return { baseUrl, tmpDir };
}

export async function teardownE2E(): Promise<void> {
  serverProcess?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 辅助：注册 + 登录，返回 session cookie
export async function registerAndLogin(
  baseUrl: string,
  email: string,
  password = "test123456"
): Promise<string> {
  await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]; // session=xxx
}

// 辅助：带认证的 fetch
export function authFetch(baseUrl: string, cookie: string) {
  return (path: string, init?: RequestInit) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, cookie },
    });
}
```

### E2E 测试示例：`src/test/e2e/attachments.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupE2E, teardownE2E, registerAndLogin } from "../e2e-helpers";
import fs from "fs";
import path from "path";

let baseUrl: string;
let cookie: string;
let taskId: string;

beforeAll(async () => {
  const env = await setupE2E();
  baseUrl = env.baseUrl;
  cookie = await registerAndLogin(baseUrl, "e2e@test.com");
  // 创建一个 project + task
  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e-proj" }),
  });
  const proj = await projRes.json();
  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "e2e-task", prompt: "test", project_id: proj.project.id }),
  });
  taskId = (await taskRes.json()).id;
});

afterAll(async () => {
  await teardownE2E();
});

describe("Attachments API", () => {
  it("uploads an image", async () => {
    const form = new FormData();
    const blob = new Blob([Buffer.alloc(100)], { type: "image/png" });
    form.append("file", blob, "test.png");

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.filename).toBe("test.png");
    expect(data.media_type).toBe("image/png");
  });

  it("rejects files > 10MB", async () => {
    const form = new FormData();
    const big = new Blob([Buffer.alloc(11 * 1024 * 1024)], { type: "image/png" });
    form.append("file", big, "big.png");

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(413);
  });

  it("rejects non-whitelisted types", async () => {
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "application/x-msi" }), "evil.msi");

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(415);
  });

  it("non-owner gets 404", async () => {
    // 注册另一个用户
    const otherCookie = await registerAndLogin(baseUrl, "other@test.com");
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/attachments`, {
      headers: { cookie: otherCookie },
    });
    expect(res.status).toBe(404);
  });
});
```

### E2E 测试中的 LLM 调用

E2E 测试**不触发真实 LLM 调用**。attachments 功能的 E2E 只测上传/下载/删除/权限，不测 agent 执行。需要 agent 执行的测试属于集成测试层（mock SDK）。

### 运行方式

```bash
# package.json scripts
"test": "vitest run --exclude '**/e2e/**'",        # 单元 + 集成
"test:e2e": "vitest run --config vitest.e2e.config.ts src/test/e2e/",  # E2E
"test:watch": "vitest --exclude '**/e2e/**'",
```

E2E 配置 `vitest.e2e.config.ts`：

```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    timeout: 60000,       // E2E 需要更长超时
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

## Agent 任务验证标准

派发任务时，验证标准按以下优先级：

1. **tsc 通过**：`./node_modules/.bin/tsc --noEmit`
2. **单元测试通过**：`npm test`（新增代码必须有对应测试）
3. **API 自测**：curl 到 13001（ao-dev watch），验证核心断言
4. **E2E 测试**（可选）：如果功能涉及新 API 端点，写 E2E 测试

## Checkpoint 规范

| 场景 | 是否加 checkpoint |
|------|-----------------|
| 改动点 > 5 个 | ✅ 加 |
| 多步骤有依赖（如先 migration 再 API 再 UI） | ✅ 加 |
| 单点 fix / 小改动 | ❌ 不加 |

checkpoint 标记：`<checkpoint step=N summary="一句话描述">`

## 新增功能测试要求

| 功能类型 | 最少测试 |
|---------|---------|
| 新 DB 表/操作 | 单元测试（CRUD + owner 隔离） |
| 新 API 端点 | 集成测试（认证 + 校验 + 权限） |
| 新 SSE 事件 | 集成测试（事件格式 + 流式） |
| UI 改动 | 手动自测（暂无自动化 UI 测试） |
