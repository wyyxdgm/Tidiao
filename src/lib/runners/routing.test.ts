// R3 路由纯函数测试. 无 DB / 无网络 — 全 mock.
//
// 测什么 (rollout §5 P3 验收):
//   - 命中白名单 → 取第一个 online runner (字典序)
//   - 不命中 → null (走本地)
//   - 多 runner 候选 → 字典序取第一个
//   - 候选 runner 都 offline → { runner: null, reason: "runner offline" }
//   - 空 project / 没 runners 列 / 坏 JSON / 空数组 → null
//   - pattern 含 regex meta char (.) → escape 后正确匹配
//   - pattern 大小写敏感 (Bash 命令本身大小写敏感)

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveRunnerRoute,
  patternToRegExp,
} from "./routing";
import type { RunnerConnection } from "./types";

// Mock connection factory. 唯一需要的字段是 runner.id (字典序关键) +
// status. authToken 不参与 routing 决策, 给个固定值即可.
function conn(
  id: string,
  name: string = id,
  status: "online" | "offline" | "dead" = "online",
  os_type: "macos" | "windows" | "linux" = "macos",
): RunnerConnection {
  return {
    runner: {
      id,
      name,
      host: "192.168.3.243",
      port: 8081,
      os_type,
      status,
      last_heartbeat_at: null,
    },
    authToken: "test-token",
    lastSeenAtMs: null,
    status,
  };
}

// lookups 的两个函数都注入 mock, 默认返回值是空. 每个 test 自己 push.
function makeLookups(opts: {
  online?: RunnerConnection[];
  all?: RunnerConnection[];
} = {}) {
  const all = opts.all ?? opts.online ?? [];
  const online = opts.online ?? [];
  return {
    allConnections: () => all,
    onlineConnections: () => online,
  };
}

// 标准 project 配置: 一条 entry, 白名单 ["echo"], 映射到 runner-1.
function projectWith(
  entries: Array<{
    runner_id: string;
    purpose?: string;
    cwd_mapping?: string;
    command_patterns: string[];
    os_type?: "macos" | "windows" | "linux";
  }>,
): { runners: string } {
  return {
    runners: JSON.stringify(
      entries.map((e) => {
        const out: Record<string, unknown> = {
          runner_id: e.runner_id,
          purpose: e.purpose ?? "test",
          cwd_mapping: e.cwd_mapping ?? "/Users/user/workspace",
          command_patterns: e.command_patterns,
        };
        if (e.os_type !== undefined) out.os_type = e.os_type;
        return out;
      }),
    ),
  };
}

describe("resolveRunnerRoute: 命中路径", () => {
  it("白名单命中 + 单 runner online → 走该 runner", () => {
    const r = conn("r-1", "mac-build");
    const project = projectWith([
      { runner_id: "r-1", command_patterns: ["echo"] },
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [r] }),
    );
    expect(route).not.toBeNull();
    expect(route).toMatchObject({
      cwdMapping: "/Users/user/workspace",
    });
    // runner 在 route 里是 RunnerConnection, 内层 runner 才是 RunnerRow.
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-1");
    } else {
      throw new Error("expected runner in route");
    }
  });

  it("白名单不命中 → null (走本地)", () => {
    const r = conn("r-1");
    const project = projectWith([
      { runner_id: "r-1", command_patterns: ["cargo tauri build"] },
    ]);
    expect(
      resolveRunnerRoute(project, "echo hello", makeLookups({ online: [r] })),
    ).toBeNull();
  });

  it("project 为 null → null", () => {
    expect(resolveRunnerRoute(null, "echo hello")).toBeNull();
  });

  it("project 存在但 runners 列空 → null", () => {
    expect(
      resolveRunnerRoute({ runners: null }, "echo hello"),
    ).toBeNull();
  });

  it("runners 是空数组 → null", () => {
    expect(
      resolveRunnerRoute({ runners: "[]" }, "echo hello"),
    ).toBeNull();
  });

  it("runners JSON 损坏 → null (走本地, 不 deny)", () => {
    // PATCH 校验已挡过, 这里只守最后一道; 走本地比 deny 安全 (防 PATCH
    // 配置错 = 整项目全部命令无法执行)
    expect(
      resolveRunnerRoute({ runners: "not-json" }, "echo hello"),
    ).toBeNull();
  });

  it("runners JSON 是对象而非数组 → null", () => {
    expect(
      resolveRunnerRoute({ runners: '{"foo":1}' }, "echo hello"),
    ).toBeNull();
  });
});

describe("resolveRunnerRoute: 多 runner 候选", () => {
  it("两个 runner 都 online + 都命中 → 按 runner_id 字典序取第一个", () => {
    const a = conn("r-aaa");
    const b = conn("r-bbb");
    // 两个 runner 都白名单命中 (pattern = "echo" 全包含)
    const project = projectWith([
      { runner_id: "r-aaa", command_patterns: ["echo"] },
      { runner_id: "r-bbb", command_patterns: ["echo"] },
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [b, a] }), // 故意乱序传入
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-aaa");
    } else {
      throw new Error("expected runner in route");
    }
  });

  it("UUID id 也按字典序取 — 不依赖配置顺序", () => {
    // 两个 runner id 字典序: 000 < fff
    const a = conn("ffffffff-1111");
    const b = conn("00000000-2222");
    const project = projectWith([
      { runner_id: "ffffffff-1111", command_patterns: ["echo"] },
      { runner_id: "00000000-2222", command_patterns: ["echo"] },
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [a, b] }),
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("00000000-2222");
    } else {
      throw new Error("expected runner in route");
    }
  });

  it("多个 entry 命中但只有部分 runner online → 选 online 的那个", () => {
    const online = conn("r-online");
    const offline = conn("r-offline", "r-offline", "offline");
    const project = projectWith([
      { runner_id: "r-offline", command_patterns: ["echo"] },
      { runner_id: "r-online", command_patterns: ["echo"] },
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [online], all: [online, offline] }),
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-online");
    } else {
      throw new Error("expected runner in route");
    }
  });

  it("两个 runner 都 offline → {runner:null, reason}", () => {
    const a = conn("r-a", "r-a", "offline");
    const b = conn("r-b", "r-b", "dead");
    const project = projectWith([
      { runner_id: "r-a", command_patterns: ["echo"] },
      { runner_id: "r-b", command_patterns: ["echo"] },
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [], all: [a, b] }),
    );
    expect(route).not.toBeNull();
    expect(route).toMatchObject({ runner: null });
    if (route && "reason" in route) {
      expect(route.reason).toMatch(/runner offline/);
      expect(route.reason).toMatch(/r-a/);
      expect(route.reason).toMatch(/r-b/);
    }
  });

  it("候选 runner_id 在 registry 里完全不存在 → deny 'not registered'", () => {
    // 配置里写了 r-missing, registry 里只有 r-other (都没命中). 这种
    // 配置错走 deny — 不 fallback (rollout §2 红线: 不静默 fallback).
    const project = projectWith([
      { runner_id: "r-missing", command_patterns: ["echo"] },
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [], all: [conn("r-other")] }),
    );
    expect(route).not.toBeNull();
    expect(route).toMatchObject({ runner: null });
    if (route && "reason" in route) {
      expect(route.reason).toMatch(/r-missing/);
      expect(route.reason).toMatch(/not registered/);
    }
  });
});

describe("resolveRunnerRoute: command_pattern 语义", () => {
  let project: { runners: string };
  beforeEach(() => {
    project = projectWith([
      { runner_id: "r-1", command_patterns: ["echo"] },
    ]);
  });

  it("pattern 含 regex meta char (.) → escape 后按字面匹配", () => {
    const proj = projectWith([
      { runner_id: "r-1", command_patterns: ["npm.cmd"] },
    ]);
    // "npm.cmd" pattern escape 后 = "npm\\.cmd" → 只匹配字面 "npm.cmd".
    // "npmxcmd" (含 x 替 .) 不应命中.
    const r = conn("r-1");
    expect(
      resolveRunnerRoute(proj, "npm.cmd run dev", makeLookups({ online: [r] })),
    ).not.toBeNull();
    expect(
      resolveRunnerRoute(proj, "npmxcmd run dev", makeLookups({ online: [r] })),
    ).toBeNull();
  });

  it("pattern 大小写敏感 — Bash 命令本身大小写敏感", () => {
    const r = conn("r-1");
    expect(
      resolveRunnerRoute(project, "echo hello", makeLookups({ online: [r] })),
    ).not.toBeNull();
    expect(
      resolveRunnerRoute(project, "Echo hello", makeLookups({ online: [r] })),
    ).toBeNull();
  });

  it("pattern 'prefix' 也能匹配命令中段 (前缀包含)", () => {
    // "echo" pattern 应当匹配 "echo hello world" 这种带 args 的.
    const r = conn("r-1");
    expect(
      resolveRunnerRoute(project, "echo", makeLookups({ online: [r] })),
    ).not.toBeNull();
    expect(
      resolveRunnerRoute(
        project,
        "echo hello world",
        makeLookups({ online: [r] }),
      ),
    ).not.toBeNull();
    // 但不能匹配 "echoback" 这种没空格的 (前缀包含语义, 是字面子串匹配).
    // rollout §5 R3 说 "前缀包含" — 我们的实现是 .*escape.*, 等价子串.
    // "echo" 应该匹配 "echoback" 吗? Bash 命令里 `echoback` 是一个不同的
    // 命令; 但我们的子串匹配不能区分. 这是设计取舍 (rollout §7 风险3
    // 引号变体 MVP 不挡 — 同样道理), 不在测试层挡. 仅记录当前行为:
    expect(
      resolveRunnerRoute(project, "echoback", makeLookups({ online: [r] })),
    ).not.toBeNull();
  });

  it("多条 pattern 任一命中即算命中 (OR 语义)", () => {
    const proj = projectWith([
      { runner_id: "r-1", command_patterns: ["foo", "echo"] },
    ]);
    const r = conn("r-1");
    expect(
      resolveRunnerRoute(proj, "echo hello", makeLookups({ online: [r] })),
    ).not.toBeNull();
    expect(
      resolveRunnerRoute(proj, "foo bar", makeLookups({ online: [r] })),
    ).not.toBeNull();
    expect(
      resolveRunnerRoute(proj, "ls -la", makeLookups({ online: [r] })),
    ).toBeNull();
  });

  it("空 pattern 跳过 (不算命中)", () => {
    const proj = projectWith([
      { runner_id: "r-1", command_patterns: ["", "echo"] },
    ]);
    const r = conn("r-1");
    // 空 pattern 被跳过, "echo" 仍命中.
    expect(
      resolveRunnerRoute(proj, "echo hello", makeLookups({ online: [r] })),
    ).not.toBeNull();
    // 但若全是空 pattern → 视为无命中.
    const emptyProj = projectWith([
      { runner_id: "r-1", command_patterns: [""] },
    ]);
    expect(
      resolveRunnerRoute(
        emptyProj,
        "echo hello",
        makeLookups({ online: [r] }),
      ),
    ).toBeNull();
  });

  it("command_patterns 不是数组 (配置异常) → 该 entry 跳过", () => {
    const json = JSON.stringify([
      { runner_id: "r-1", purpose: "p", cwd_mapping: "/x", command_patterns: null },
    ]);
    expect(
      resolveRunnerRoute({ runners: json }, "echo hello"),
    ).toBeNull();
  });
});

describe("patternToRegExp (escape helper)", () => {
  it("escape regex meta characters", () => {
    // ".+*?^$()[]{}|" 全部 escape
    const re = patternToRegExp("a.b+c*d");
    expect(re.test("a.b+c*d")).toBe(true);
    expect(re.test("axbxxcxd")).toBe(false); // . 不再是 any char
  });

  it("普通字符串原样作为前缀包含正则", () => {
    const re = patternToRegExp("cargo tauri build");
    expect(re.test("cargo tauri build")).toBe(true);
    expect(re.test("cargo tauri build --release")).toBe(true);
    expect(re.test("cargo build tauri")).toBe(false);
  });
});

// α (damo 0829): os_type 过滤. entry 可选声明目标 OS; routing 校验
//   entry.os_type 与 runner.os_type 严格匹配 (entry 未设 = 不限, 向后兼容).
//   多 OS 项目里白名单按 OS 互斥配, routing 按 entry.runner_id 字典序选
//   第一个 os_type 匹配的 candidate.
describe("resolveRunnerRoute: α os_type 过滤", () => {
  it("entry.os_type=windows + runner.os_type=windows → 命中", () => {
    const win = conn("r-win", "win-build", "online", "windows");
    const project = projectWith([
      {
        runner_id: "r-win",
        command_patterns: ["cargo tauri build"],
        os_type: "windows",
      },
    ]);
    const route = resolveRunnerRoute(
      project,
      "cargo tauri build --target x86_64-pc-windows-msvc",
      makeLookups({ online: [win] }),
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-win");
      expect(route.runner.runner.os_type).toBe("windows");
    } else {
      throw new Error("expected runner in route");
    }
  });

  it("entry.os_type=windows 但 runner.os_type=macos → deny offline", () => {
    // entry 想跑 windows, 但只有 mac runner online —— 该 runner 不在 candidate 集合里
    // (os_type 不匹配). 走 deny (走本地 = 绕过白名单 = 错).
    const mac = conn("r-mac", "mac-build", "online", "macos");
    const project = projectWith([
      {
        runner_id: "r-mac",
        command_patterns: ["cargo tauri build"],
        os_type: "windows",
      },
    ]);
    const route = resolveRunnerRoute(
      project,
      "cargo tauri build",
      makeLookups({ online: [], all: [mac] }),
    );
    expect(route).not.toBeNull();
    expect(route).toMatchObject({ runner: null });
    if (route && "reason" in route) {
      expect(route.reason).toMatch(/runner offline/);
    }
  });

  it("entry.os_type 未设 + 任何 runner.os_type → 命中 (向后兼容)", () => {
    // 旧 entry 没有 os_type 字段 = 不限 OS = 现有行为不变.
    const win = conn("r-win", "win-build", "online", "windows");
    const project = projectWith([
      { runner_id: "r-win", command_patterns: ["echo"] }, // 无 os_type
    ]);
    const route = resolveRunnerRoute(
      project,
      "echo hello",
      makeLookups({ online: [win] }),
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-win");
    }
  });

  it("多 OS 项目: mac + windows entry 都命中 pattern → 字典序选 r-mac", () => {
    // 同 pattern 同时配 mac entry 和 windows entry (白名单按 OS 互斥失败场景,
    // 这里测的是 routing 行为: 字典序选第一个 os_type 匹配的 candidate).
    // 实际配置应避免这种 pattern 复用, 但 routing 不应崩溃.
    const mac = conn("r-mac", "mac-build", "online", "macos");
    const win = conn("r-win", "win-build", "online", "windows");
    const project = projectWith([
      {
        runner_id: "r-mac",
        command_patterns: ["cargo tauri build"],
        os_type: "macos",
      },
      {
        runner_id: "r-win",
        command_patterns: ["cargo tauri build"],
        os_type: "windows",
      },
    ]);
    const route = resolveRunnerRoute(
      project,
      "cargo tauri build",
      makeLookups({ online: [win, mac] }), // 故意乱序传入
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-mac"); // 字典序 r-mac < r-win
      expect(route.runner.runner.os_type).toBe("macos");
    }
  });

  it("多 OS 项目: runner_id 字典序 r-zzz > r-aaa, 但 r-zzz windows 在前 → 选 r-aaa mac", () => {
    // 验证排序稳定性: 乱序传入 connections, routing 按 runner_id 字典序选.
    const zzz = conn("r-zzz", "win-build", "online", "windows");
    const aaa = conn("r-aaa", "mac-build", "online", "macos");
    const project = projectWith([
      {
        runner_id: "r-aaa",
        command_patterns: ["cargo tauri build"],
        os_type: "macos",
      },
      {
        runner_id: "r-zzz",
        command_patterns: ["cargo tauri build"],
        os_type: "windows",
      },
    ]);
    const route = resolveRunnerRoute(
      project,
      "cargo tauri build",
      makeLookups({ online: [zzz, aaa] }),
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-aaa");
    }
  });

  it("同一 runner_id 多 entry: 一条 os_type 匹配即满足", () => {
    // 同一 runner 上挂两条 entry, 一条 macos 一条 windows. 该 runner 在线时
    // 任意 OS 的白名单命中都能选它 (取第一条 os_type 兼容 entry 的 cwd_mapping).
    const win = conn("r-win", "win-build", "online", "windows");
    const project = projectWith([
      {
        runner_id: "r-win",
        purpose: "windows-build",
        cwd_mapping: "C:\\Users\\damo\\workspace",
        command_patterns: ["cargo tauri build"],
        os_type: "windows",
      },
      {
        runner_id: "r-win",
        purpose: "windows-test",
        cwd_mapping: "C:\\Users\\damo\\workspace",
        command_patterns: ["cargo test"],
        os_type: "windows",
      },
    ]);
    const route = resolveRunnerRoute(
      project,
      "cargo tauri build",
      makeLookups({ online: [win] }),
    );
    expect(route).not.toBeNull();
    if (route && "runner" in route && route.runner) {
      expect(route.runner.runner.id).toBe("r-win");
      expect(route.cwdMapping).toBe("C:\\Users\\damo\\workspace");
    }
  });
});