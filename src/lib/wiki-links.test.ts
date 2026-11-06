// wiki 跨项目链接解析 —— 纯函数测试.
//
// 风险点(改动此文件或 wiki-links.ts 前必读):
//   1. 语法改/加字段必须同步更新 parseCrossProjectHref 与 buildCrossProjectHref, 否则
//      round-trip 断言失败. 测试断言「构造出来的能被解析回来」就是守这条.
//   2. parseCrossProjectHref 失败必须返 null 不能抛 —— 这是 UI 拦截器能继续走 fallback
//      (外链新窗口) 的前提. 任何「无效输入抛 Error」改动会让前端把坏链接当破图渲染.
//   3. path 里出现 .. 段或前导 / 必须拒 —— 这条防线减少「目标项目里读不到」的失败请求,
//      后端 safeResolve 是兜底, 客户端这一层只是省一次往返.

import { describe, it, expect } from "vitest";
import {
  buildCrossProjectHref,
  CROSS_PROJECT_PREFIX,
  decideAbsolutePathRedirect,
  normalizeHrefForCwdMatch,
  parseCrossProjectHref,
  resolveAbsoluteProjectPath,
} from "./wiki-links";

const VALID_UUID = "3fa2ad29-8669-4cbb-876c-fc65c4f57a49";

describe("parseCrossProjectHref", () => {
  it("拒绝非 project: 前缀", () => {
    expect(parseCrossProjectHref("")).toBeNull();
    expect(parseCrossProjectHref("https://example.com")).toBeNull();
    expect(parseCrossProjectHref("/abc/wiki?path=x.md")).toBeNull();
    expect(parseCrossProjectHref("./foo.md")).toBeNull();
    // 大小写敏感: "Project:" 不是协议前缀, 一律拒绝.
    expect(parseCrossProjectHref(`Project:${VALID_UUID}?path=INDEX.md`)).toBeNull();
  });

  it("合法输入解析出 projectId/path/version", () => {
    const r = parseCrossProjectHref(
      `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=docs/INDEX.md&version=v1.0`
    );
    expect(r).toEqual({
      projectId: VALID_UUID,
      path: "docs/INDEX.md",
      version: "v1.0",
    });
  });

  it("version 可省略, 返回 null", () => {
    const r = parseCrossProjectHref(
      `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=INDEX.md`
    );
    expect(r?.projectId).toBe(VALID_UUID);
    expect(r?.path).toBe("INDEX.md");
    expect(r?.version).toBeNull();
  });

  it("projectId 大小写不敏感(全部接受)", () => {
    const upper = VALID_UUID.toUpperCase();
    const r = parseCrossProjectHref(
      `${CROSS_PROJECT_PREFIX}${upper}?path=INDEX.md`
    );
    expect(r?.projectId).toBe(upper);
  });

  it("projectId 缺失/非 UUID 返 null", () => {
    expect(
      parseCrossProjectHref(`${CROSS_PROJECT_PREFIX}?path=INDEX.md`)
    ).toBeNull();
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}not-a-uuid?path=INDEX.md`
      )
    ).toBeNull();
    // 长度对但字符错.
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz?path=x.md`
      )
    ).toBeNull();
  });

  it("path 缺失返 null", () => {
    expect(
      parseCrossProjectHref(`${CROSS_PROJECT_PREFIX}${VALID_UUID}`)
    ).toBeNull();
    expect(
      parseCrossProjectHref(`${CROSS_PROJECT_PREFIX}${VALID_UUID}?`)
    ).toBeNull();
    expect(
      parseCrossProjectHref(`${CROSS_PROJECT_PREFIX}${VALID_UUID}?version=v1`)
    ).toBeNull();
  });

  it("path 含 .. 段返 null(防穿越)", () => {
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=../etc/passwd`
      )
    ).toBeNull();
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=foo/../../bar.md`
      )
    ).toBeNull();
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=foo/..`
      )
    ).toBeNull();
  });

  it("path 前导 / 返 null(必须是相对路径)", () => {
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=/etc/passwd`
      )
    ).toBeNull();
  });

  it("path 里的 .. 段在 URL 解码后才检查(%2F 等)", () => {
    // 编码后的 .. 也要拒: URLSearchParams 会解码, 解码后再段级检查.
    expect(
      parseCrossProjectHref(
        `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=foo%2F..%2Fbar.md`
      )
    ).toBeNull();
  });

  it("fragment 被丢弃", () => {
    const r = parseCrossProjectHref(
      `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=INDEX.md#some-anchor`
    );
    expect(r?.path).toBe("INDEX.md");
    // fragment 后的内容被截断, version 应取不到.
    expect(r?.version).toBeNull();
  });

  it("query 里的未知 key 被忽略", () => {
    const r = parseCrossProjectHref(
      `${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=INDEX.md&foo=bar&baz=qux`
    );
    expect(r?.path).toBe("INDEX.md");
    expect(r?.version).toBeNull();
  });

  it("空字符串与 null/undefined 安全", () => {
    // @ts-expect-error 故意测运行时容忍度
    expect(parseCrossProjectHref(null)).toBeNull();
    // @ts-expect-error 故意测运行时容忍度
    expect(parseCrossProjectHref(undefined)).toBeNull();
  });
});

describe("buildCrossProjectHref", () => {
  it("与 parse 必须 round-trip", () => {
    const href = buildCrossProjectHref(VALID_UUID, "docs/INDEX.md", "v1.0");
    const parsed = parseCrossProjectHref(href);
    expect(parsed).toEqual({
      projectId: VALID_UUID,
      path: "docs/INDEX.md",
      version: "v1.0",
    });
  });

  it("无 version 时不写 version 段", () => {
    const href = buildCrossProjectHref(VALID_UUID, "INDEX.md");
    expect(href).toBe(`${CROSS_PROJECT_PREFIX}${VALID_UUID}?path=INDEX.md`);
    expect(href).not.toContain("version=");
  });

  it("path 含特殊字符时 URL 编码", () => {
    const href = buildCrossProjectHref(VALID_UUID, "docs/中文 #1.md");
    const parsed = parseCrossProjectHref(href);
    expect(parsed?.path).toBe("docs/中文 #1.md");
  });
});

describe("resolveAbsoluteProjectPath", () => {
  const PROJ_A = "3fa2ad29-8669-4cbb-876c-fc65c4f57a49";
  const PROJ_B = "8b1c5f02-1234-4cbb-9abc-def012345678";
  const PROJ_C = "2c9a1f08-aaaa-bbbb-cccc-dddddddddddd";

  it("非 / 开头返 null(相对路径不归它管)", () => {
    expect(
      resolveAbsoluteProjectPath("docs/INDEX.md", [
        { id: PROJ_A, cwd: "/ws/a" },
      ])
    ).toBeNull();
    expect(
      resolveAbsoluteProjectPath("https://example.com/x", [
        { id: PROJ_A, cwd: "/ws/a" },
      ])
    ).toBeNull();
    expect(
      resolveAbsoluteProjectPath("project:xxx?path=x", [
        { id: PROJ_A, cwd: "/ws/a" },
      ])
    ).toBeNull();
  });

  it("绝对路径落在某项目 cwd 子树内, 返回该项目 + 相对路径", () => {
    const r = resolveAbsoluteProjectPath("/ws/a/docs/design/v0.1.md", [
      { id: PROJ_A, cwd: "/ws/a" },
    ]);
    expect(r).toEqual({ projectId: PROJ_A, path: "docs/design/v0.1.md" });
  });

  it("多个项目 cwd 都可能命中时, 取最长前缀匹配(具体项目赢)", () => {
    // /ws/aa 长度 > /ws/a, 应赢.
    const r = resolveAbsoluteProjectPath("/ws/aa/foo.md", [
      { id: PROJ_A, cwd: "/ws/a" },
      { id: PROJ_B, cwd: "/ws/aa" },
    ]);
    expect(r?.projectId).toBe(PROJ_B);
    expect(r?.path).toBe("foo.md");
  });

  it("cwd 后必须有 '/' 边界: /ws/a 不截胡 /ws/abc/foo", () => {
    const r = resolveAbsoluteProjectPath("/ws/abc/foo.md", [
      { id: PROJ_A, cwd: "/ws/a" },
    ]);
    expect(r).toBeNull();
  });

  it("路径正好等于 cwd(无下级) 返 null —— 没东西可读", () => {
    expect(
      resolveAbsoluteProjectPath("/ws/a", [{ id: PROJ_A, cwd: "/ws/a" }])
    ).toBeNull();
  });

  it("cwd 为 null 的项目跳过, 不参与匹配", () => {
    const r = resolveAbsoluteProjectPath("/ws/a/x.md", [
      { id: PROJ_A, cwd: null },
      { id: PROJ_B, cwd: null },
    ]);
    expect(r).toBeNull();
  });

  it("全部项目都没命中返 null, 不静默重写到错误项目", () => {
    expect(
      resolveAbsoluteProjectPath("/elsewhere/x.md", [
        { id: PROJ_A, cwd: "/ws/a" },
      ])
    ).toBeNull();
  });

  it("跨项目 cwd 重叠时取最长前缀(三个项目嵌套示例)", () => {
    const r = resolveAbsoluteProjectPath("/root/a/b/c/x.md", [
      { id: PROJ_A, cwd: "/root" },
      { id: PROJ_B, cwd: "/root/a" },
      { id: PROJ_C, cwd: "/root/a/b/c" },
    ]);
    expect(r?.projectId).toBe(PROJ_C);
    expect(r?.path).toBe("x.md");
  });

  it("项目列表顺序不影响结果(内部按长度排序)", () => {
    // 故意把最长的放第一个, 看是否还按最长前缀匹配.
    const r = resolveAbsoluteProjectPath("/ws/aa/foo.md", [
      { id: PROJ_B, cwd: "/ws/aa" },
      { id: PROJ_A, cwd: "/ws/a" },
    ]);
    expect(r?.projectId).toBe(PROJ_B);
  });

  it("Windows 风格路径返 null(部署面全是 POSIX, 不为假想场景加复杂度)", () => {
    expect(
      resolveAbsoluteProjectPath("C:/Users/foo/x.md", [
        { id: PROJ_A, cwd: "/ws/a" },
      ])
    ).toBeNull();
    expect(
      resolveAbsoluteProjectPath("//server/share/x.md", [
        { id: PROJ_A, cwd: "/ws/a" },
      ])
    ).toBeNull();
  });

  it("空字符串与 null/undefined 安全", () => {
    // @ts-expect-error 故意测运行时容忍度
    expect(resolveAbsoluteProjectPath(null, [{ id: PROJ_A, cwd: "/ws/a" }])).toBeNull();
    // @ts-expect-error 故意测运行时容忍度
    expect(resolveAbsoluteProjectPath(undefined, [{ id: PROJ_A, cwd: "/ws/a" }])).toBeNull();
    expect(resolveAbsoluteProjectPath("/ws/a/x.md", [])).toBeNull();
    // @ts-expect-error 故意测运行时容忍度
    expect(resolveAbsoluteProjectPath("/ws/a/x.md", null)).toBeNull();
  });

  it("项目列表里含隐藏字符的 cwd 也按字符串比对处理(不规范化)", () => {
    // cwd 末尾带 '/': /ws/a/ + '/' = /ws/a//, href /ws/a//foo.md 命中, 相对路径
    // 从第 7 位起 = 'foo.md'(cwd 末尾的 '/' 已被算进边界).
    const r = resolveAbsoluteProjectPath("/ws/a//foo.md", [
      { id: PROJ_A, cwd: "/ws/a/" },
    ]);
    expect(r).toEqual({ projectId: PROJ_A, path: "foo.md" });
  });

  it("mac 形态 /Users/user/X → /home/user/X 后命中 WSL cwd (homeDir=/home/user)", () => {
    // 复制粘贴时漏 mac→WSL 映射, 之前会直接返 null 静默挂掉.
    const r = resolveAbsoluteProjectPath(
      "/Users/user/ws/a/docs/mac.md",
      [{ id: PROJ_A, cwd: "/home/user/ws/a" }],
      "/home/user"
    );
    expect(r).toEqual({ projectId: PROJ_A, path: "docs/mac.md" });
  });

  it("shorthand /workspace/X (漏 /home/user 前缀) → homeDir/workspace/X 后命中", () => {
    // 这就是 damo 0823 提的 case: URL 是 /workspace/ao-dev/docs/...,
    // DB cwd 是 /home/user/workspace/ao-dev, 之前匹配失败.
    const r = resolveAbsoluteProjectPath(
      "/workspace/agent-orchestrator-dev/docs/claude-config/docs/mac-runner.md",
      [{ id: PROJ_A, cwd: "/home/user/workspace/agent-orchestrator-dev" }],
      "/home/user"
    );
    expect(r).toEqual({
      projectId: PROJ_A,
      path: "docs/claude-config/docs/mac-runner.md",
    });
  });

  it("shorthand 仅当 homeDir=/home/user 时生效, pulu 上 (homeDir=/home/orchestrator) 不补前缀", () => {
    // pulu 上 projects.cwd 是 /home/orchestrator/workspace/x,
    // 拿到 shorthand /workspace/x/foo.md 不应该错配到 pulu 自己项目.
    // 在 pulu homeDir 下, normalize 透传原值, 后续匹配按字面前缀继续.
    const r = resolveAbsoluteProjectPath(
      "/workspace/ao-dev/x.md",
      [{ id: PROJ_A, cwd: "/home/orchestrator/workspace/ao-dev" }],
      "/home/orchestrator"
    );
    expect(r).toBeNull();
  });

  it("normalize 后跨项目 cwd 嵌套仍取最长前缀", () => {
    const r = resolveAbsoluteProjectPath(
      "/workspace/ao-dev/foo.md",
      [
        { id: PROJ_A, cwd: "/home/user/workspace" },
        { id: PROJ_B, cwd: "/home/user/workspace/ao-dev" },
      ],
      "/home/user"
    );
    expect(r?.projectId).toBe(PROJ_B);
    expect(r?.path).toBe("foo.md");
  });
});

describe("normalizeHrefForCwdMatch", () => {
  it("WSL 形态原样透传", () => {
    expect(normalizeHrefForCwdMatch("/home/user/ws/a/x.md", "/home/user"))
      .toBe("/home/user/ws/a/x.md");
  });

  it("mac → WSL (homeDir=/home/user)", () => {
    expect(normalizeHrefForCwdMatch("/Users/user/ws/a/x.md", "/home/user"))
      .toBe("/home/user/ws/a/x.md");
    // 边界: 输入已是 WSL 形态 (匹配 /Users/user/ 但 homeDir 也含它就?) 不会双重转换
    // → 这里特意测: 输入 /Users/user/x.md, homeDir=/home/user, 期望直接规范化
    expect(normalizeHrefForCwdMatch("/Users/user/x.md", "/home/user"))
      .toBe("/home/user/x.md");
    // 路径就停在 /Users/user (没有 / 后还有东西) → 当成外链, 不映射
    expect(normalizeHrefForCwdMatch("/Users/user", "/home/user"))
      .toBe("/Users/user");
  });

  it("mac 在 pulu (homeDir≠/home/user) 上不映射, 透传", () => {
    // pulu 上 DB cwd 是 /home/orchestrator/ws/a, 拿 /Users/user/ws/a/x.md 不应该被改写.
    expect(normalizeHrefForCwdMatch("/Users/user/ws/a/x.md", "/home/orchestrator"))
      .toBe("/Users/user/ws/a/x.md");
  });

  it("~ 形态展开", () => {
    expect(normalizeHrefForCwdMatch("~/ws/a/x.md", "/home/user"))
      .toBe("/home/user/ws/a/x.md");
    expect(normalizeHrefForCwdMatch("~/x.md", "/Users/user"))  // mac runner homeDir
      .toBe("/Users/user/x.md");
  });

  it("shorthand /workspace/X 仅 homeDir=/home/user 时补前缀", () => {
    expect(normalizeHrefForCwdMatch("/workspace/ao-dev/x.md", "/home/user"))
      .toBe("/home/user/workspace/ao-dev/x.md");
    expect(normalizeHrefForCwdMatch("/workspace/ao-dev/x.md", "/home/orchestrator"))
      .toBe("/workspace/ao-dev/x.md");
  });

  it("已是 homeDir/workspace/X 的不重复加前缀", () => {
    expect(normalizeHrefForCwdMatch("/home/user/workspace/ao-dev/x.md", "/home/user"))
      .toBe("/home/user/workspace/ao-dev/x.md");
  });

  it("不支持的形态原样透传 (相对 / UNC / Windows)", () => {
    expect(normalizeHrefForCwdMatch("docs/x.md", "/home/user")).toBe("docs/x.md");
    expect(normalizeHrefForCwdMatch("//server/share/x.md", "/home/user"))
      .toBe("//server/share/x.md");
    expect(normalizeHrefForCwdMatch("/C:/Users/x.md", "/home/user"))
      .toBe("/C:/Users/x.md");
  });

  it("空 homeDir 时不做事 (兜底)", () => {
    expect(normalizeHrefForCwdMatch("/Users/user/x.md", "")).toBe("/Users/user/x.md");
    expect(normalizeHrefForCwdMatch("~/x.md", "")).toBe("~/x.md");
  });

  it("空 href / 非字符串安全 (兜底)", () => {
    expect(normalizeHrefForCwdMatch("", "/home/user")).toBe("");
    // @ts-expect-error 故意测运行时容忍度
    expect(normalizeHrefForCwdMatch(undefined, "/home/user")).toBe(undefined);
    // @ts-expect-error 故意测运行时容忍度
    expect(normalizeHrefForCwdMatch(null, "/home/user")).toBe(null);
  });
});

describe("decideAbsolutePathRedirect", () => {
  const PROJ_A = "3fa2ad29-8669-4cbb-876c-fc65c4f57a49";
  const PROJ_B = "4fa2ad29-8669-4cbb-876c-fc65c4f57a50";
  const projects = [
    { id: PROJ_A, cwd: "/ws/a" },
    { id: PROJ_B, cwd: "/ws/b" },
  ];

  it("非绝对路径(无前导 /)直接 pass", () => {
    expect(decideAbsolutePathRedirect("docs/foo.md", PROJ_A, projects, undefined))
      .toEqual({ kind: "pass" });
    expect(decideAbsolutePathRedirect("INDEX.md", PROJ_A, projects, undefined))
      .toEqual({ kind: "pass" });
    expect(decideAbsolutePathRedirect(undefined, PROJ_A, projects, undefined))
      .toEqual({ kind: "pass" });
    expect(decideAbsolutePathRedirect("", PROJ_A, projects, undefined))
      .toEqual({ kind: "pass" });
  });

  it("绝对路径命中 URL 里的 projectId(同项目)→ redirect 到相对路径形态", () => {
    const d = decideAbsolutePathRedirect("/ws/a/foo.md", PROJ_A, projects, undefined);
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_A}/wiki?path=foo.md`,
    });
  });

  it("绝对路径命中其他用户项目(跨项目)→ redirect 到目标项目", () => {
    const d = decideAbsolutePathRedirect("/ws/b/foo.md", PROJ_A, projects, undefined);
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_B}/wiki?path=foo.md`,
    });
  });

  it("精确命中 cwd 本身(无文件)→ 重写到 INDEX.md", () => {
    const d = decideAbsolutePathRedirect("/ws/a", PROJ_A, projects, undefined);
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_A}/wiki?path=INDEX.md`,
    });
  });

  it("绝对路径不在任何用户项目 cwd 下 → pass(交给 API 404)", () => {
    expect(decideAbsolutePathRedirect("/nowhere/foo.md", PROJ_A, projects, undefined))
      .toEqual({ kind: "pass" });
  });

  it("URL 带 ?version= → redirect 时保留", () => {
    const d = decideAbsolutePathRedirect(
      "/ws/b/foo.md",
      PROJ_A,
      projects,
      "v1.0"
    );
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_B}/wiki?path=foo.md&version=v1.0`,
    });
  });

  it("URL 没 ?version= → redirect 时也不带", () => {
    const d = decideAbsolutePathRedirect("/ws/a/foo.md", PROJ_A, projects, undefined);
    expect(d.kind).toBe("redirect");
    if (d.kind === "redirect") {
      expect(d.targetUrl).not.toContain("version=");
    }
  });

  it("version 含特殊字符会被 URL 编码", () => {
    const d = decideAbsolutePathRedirect(
      "/ws/b/foo.md",
      PROJ_A,
      projects,
      "v 1.0 & more"
    );
    expect(d.kind).toBe("redirect");
    if (d.kind === "redirect") {
      expect(d.targetUrl).toBe(
        `/#/${PROJ_B}/wiki?path=foo.md&version=v%201.0%20%26%20more`
      );
    }
  });

  it("path 含特殊字符会被 URL 编码", () => {
    const d = decideAbsolutePathRedirect(
      "/ws/a/docs/has space.md",
      PROJ_A,
      projects,
      undefined
    );
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_A}/wiki?path=docs%2Fhas%20space.md`,
    });
  });

  it("嵌套 cwd 时最长前缀命中(防止祖辈截胡)", () => {
    const nested = [
      { id: PROJ_A, cwd: "/ws/a" },
      { id: PROJ_B, cwd: "/ws/aa" }, // 兄弟, 比 /ws/a 长, 应优先命中
    ];
    const d = decideAbsolutePathRedirect("/ws/aa/x.md", PROJ_A, nested, undefined);
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_B}/wiki?path=x.md`,
    });
  });

  it("用户没项目(空数组)→ pass", () => {
    expect(decideAbsolutePathRedirect("/ws/a/foo.md", PROJ_A, [], undefined))
      .toEqual({ kind: "pass" });
  });

  it("用户只有 cwd=null 的项目 → pass", () => {
    const noCwd = [{ id: PROJ_A, cwd: null }];
    expect(decideAbsolutePathRedirect("/ws/a/foo.md", PROJ_A, noCwd, undefined))
      .toEqual({ kind: "pass" });
  });

  it("跨用户隔离: 调用方只传当前用户的 projects, 函数不会跳到别人项目", () => {
    // 当前用户只有项目 A. 即使绝对路径 /ws/x/foo.md 命中别人的项目 cwd,
    // 因为别人项目不在 projects 列表里, 函数仍返 pass(不会跨用户跳).
    const onlyMine = [{ id: PROJ_A, cwd: "/ws/a" }];
    expect(decideAbsolutePathRedirect("/ws/x/foo.md", PROJ_A, onlyMine, undefined))
      .toEqual({ kind: "pass" });
  });

  it("damo 0823 case: shorthand /workspace/X + DB cwd /home/user/workspace/X → 跨项目跳转", () => {
    // damo 实际场景: partner wiki URL = ?path=/workspace/agent-orchestrator-dev/docs/...
    // DB ao-dev cwd = /home/user/workspace/agent-orchestrator-dev
    // 之前: pass (不跳转, 静默挂掉). 现在: redirect 到 ao-dev 项目.
    const d = decideAbsolutePathRedirect(
      "/workspace/agent-orchestrator-dev/docs/claude-config/docs/mac-runner.md",
      PROJ_A,
      [
        { id: PROJ_A, cwd: "/home/user/workspace/partner" },
        { id: "080af705-59dc-4a27-9b13-e0e1de3f9a50", cwd: "/home/user/workspace/agent-orchestrator-dev" },
      ],
      "2c358aeb-93ff-4141-b8cf-02aec4598b0a",
      "/home/user"
    );
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/080af705-59dc-4a27-9b13-e0e1de3f9a50/wiki?path=docs%2Fclaude-config%2Fdocs%2Fmac-runner.md&version=2c358aeb-93ff-4141-b8cf-02aec4598b0a`,
    });
  });

  it("mac 形态 /Users/user/X 也能正确跨项目跳转", () => {
    const d = decideAbsolutePathRedirect(
      "/Users/user/ws/a/foo.md",
      PROJ_B,
      [{ id: PROJ_A, cwd: "/home/user/ws/a" }],
      undefined,
      "/home/user"
    );
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_A}/wiki?path=foo.md`,
    });
  });

  it("exactHit 命中 (cwd 本身 / shorthand) → 跳 INDEX.md", () => {
    // 用户访问 ?path=/workspace/ao-dev  (shorthand, 没文件名) → normalize 后等于 cwd.
    const d = decideAbsolutePathRedirect(
      "/workspace/agent-orchestrator-dev",
      PROJ_A,
      [{ id: PROJ_A, cwd: "/home/user/workspace/agent-orchestrator-dev" }],
      undefined,
      "/home/user"
    );
    expect(d).toEqual({
      kind: "redirect",
      targetUrl: `/#/${PROJ_A}/wiki?path=INDEX.md`,
    });
  });
});