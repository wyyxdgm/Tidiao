// chat 流后解析路径链接化测试 —— v53 R14 跨项目跳转兜底.
//
// 风险点(改动 linkifyDocPaths 前必读):
//   1. v53 之前的行为是「硬编码跳当前项目」—— 即使是 mac / ~/ / shorthand 形态也跳当前项目,
//      服务端 decideAbsolutePathRedirect 再 redirect 到目标项目 (UX 多一跳).
//      v53 优化: chat 流里命中目标项目就直跳, 服务端兜底保留.
//      不要为了优化把「降级到当前项目」这条路径删了 —— 项目 cwd 列表为空 / 输入是相对路径
//      时仍要走这条, 否则会变成「显示裸路径没有链接」更糟.
//   2. 必须跳过 <pre> 块 (代码块里的 .md 不应被链接化 —— 会破坏代码示例),
//      跳过已有 <a> 内部文本 (避免嵌套 <a><a>). 这两条是 linkifyDocPaths 的老约束,
//      新加的跨项目跳转逻辑不能破.
//   3. process.env.HOME 默认 /home/user. 在 mac runner / pulu 上测试时
//      normalizeHrefForCwdMatch 会按 homeDir 决定是否补前缀, 测试场景都假设 WSL,
//      所以这里用 monkey-patch 锁死 HOME=/home/user 让断言可重复.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linkifyDocPaths, linkifyTaskPrefixes, markdownToHtml, isSafeImageUrl } from "./markdown";
import type { ProjectCwdRef } from "./wiki-links";

// 三个虚拟项目: ao-dev / yidao / partner, 模拟用户可见列表.
const AO_DEV = "3fa2ad29-8669-4cbb-876c-fc65c4f57a49";
const YIDAO = "4fa2ad29-8669-4cbb-876c-fc65c4f57a50";
const PARTNER = "5fa2ad29-8669-4cbb-876c-fc65c4f57a51";
const projects: ProjectCwdRef[] = [
  { id: AO_DEV, cwd: "/home/user/workspace/agent-orchestrator-dev" },
  { id: YIDAO, cwd: "/home/user/workspace/yidao" },
  { id: PARTNER, cwd: "/home/user/workspace/partner" },
];

describe("linkifyDocPaths", () => {
  const ORIGINAL_HOME = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = "/home/user";
  });
  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
  });

  describe("基础", () => {
    it("projectId 为空时原样返回", () => {
      const html = "<p>see /Users/user/workspace/yidao/CLAUDE.md</p>";
      expect(linkifyDocPaths(html, null, null, projects)).toBe(html);
    });

    it("projects 为空时降级当前项目 (兼容 v53 前行为)", () => {
      const html = "<p>see /Users/user/workspace/yidao/CLAUDE.md</p>";
      // projects 空 → 不尝试跨项目, 降级到 ao-dev (currentProjectId)
      const out = linkifyDocPaths(html, AO_DEV, null, []);
      expect(out).toContain(`href="/#/${AO_DEV}/wiki?path=`);
      expect(out).toContain(encodeURIComponent("/Users/user/workspace/yidao/CLAUDE.md"));
    });

    it("projects 未传 (undefined) 时也降级当前项目", () => {
      const html = "<p>see /Users/user/workspace/yidao/CLAUDE.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, undefined);
      expect(out).toContain(`href="/#/${AO_DEV}/wiki?path=`);
    });

    it("http URL 不被包成 wiki 链接", () => {
      const html = "<p>see https://example.com/foo.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      expect(out).not.toContain("wiki?path=");
      expect(out).toContain("https://example.com/foo.md");
    });

    it("已有 <a> 内部不再被包成链接 (避免嵌套 <a>)", () => {
      const html = `<p>see <a href="/already/wrapped.md">/Users/user/workspace/yidao/CLAUDE.md</a></p>`;
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      expect(out.match(/<a /g)?.length).toBe(1); // 只有原来的 1 个 <a>
    });

    it("<pre> 代码块内的 .md 不被链接化", () => {
      const html = "<pre><code>see /Users/user/workspace/yidao/CLAUDE.md</code></pre>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      expect(out).not.toContain("wiki?path=");
      expect(out).toContain("/Users/user/workspace/yidao/CLAUDE.md");
    });
  });

  describe("跨项目跳转兜底 (v53 R14)", () => {
    it("mac 形态 /Users/user/X/foo.md 命中跨项目", () => {
      const html = "<p>see /Users/user/workspace/yidao/CLAUDE.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      // 应直跳 yidao 项目, 不是当前 ao-dev
      expect(out).toContain(`href="/#/${YIDAO}/wiki?path=`);
      expect(out).toContain(encodeURIComponent("CLAUDE.md"));
      expect(out).not.toContain(`href="/#/${AO_DEV}/wiki?path=`);
    });

    it("WSL 形态 /home/user/X/foo.md 命中跨项目", () => {
      const html = "<p>see /home/user/workspace/partner/docs/CHANNEL-RECON.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      expect(out).toContain(`href="/#/${PARTNER}/wiki?path=`);
      expect(out).toContain(encodeURIComponent("docs/CHANNEL-RECON.md"));
    });

    it("shorthand /workspace/X/foo.md (漏前缀) 命中跨项目", () => {
      const html = "<p>see /workspace/yidao/CLAUDE.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      expect(out).toContain(`href="/#/${YIDAO}/wiki?path=`);
      expect(out).toContain(encodeURIComponent("CLAUDE.md"));
    });

    it("~/workspace/X/foo.md 命中跨项目 (整段被吃, 不留裸 ~)", () => {
      const html = "<p>see ~/workspace/yidao/CLAUDE.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      // 关键: ~ 应被包在 <a>...</a> 里, 不应该单独留在外面被原样显示.
      // 链接文本保留 ~/workspace/yidao/CLAUDE.md 原文 (让用户看到原表述).
      expect(out).toContain(`href="/#/${YIDAO}/wiki?path=`);
      expect(out).toContain(encodeURIComponent("CLAUDE.md"));
      // 剥掉 <a>...</a> 后不应该还有 ~/ 开头的孤立 token
      const withoutLinks = out.replace(/<a [^<]*<\/a>/g, "");
      expect(withoutLinks).not.toContain("~/workspace");
    });

    it("同项目相对路径 foo.md 降级到当前项目", () => {
      const html = "<p>see docs/foo.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      // docs/foo.md 不以 / 开头 → resolveAbsoluteProjectPath 返 null → 降级当前
      expect(out).toContain(`href="/#/${AO_DEV}/wiki?path=`);
      expect(out).toContain(encodeURIComponent("docs/foo.md"));
    });

    it("项目 cwd 嵌套时取最长前缀 (具体项目赢)", () => {
      // 加一个嵌套项目, 验证 partner/docs/foo.md 命中嵌套项目而不是 partner 本身
      const nested: ProjectCwdRef[] = [
        ...projects,
        { id: "6fa2ad29-8669-4cbb-876c-fc65c4f57a52", cwd: "/home/user/workspace/partner/docs" },
      ];
      const html = "<p>see /home/user/workspace/partner/docs/CHANNEL-RECON.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, nested);
      expect(out).toContain(`href="/#/6fa2ad29-8669-4cbb-876c-fc65c4f57a52/wiki?path=`);
    });

    it("不在任何项目 cwd 下 → 降级当前项目", () => {
      const html = "<p>see /home/user/some-random-path/foo.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, null, projects);
      expect(out).toContain(`href="/#/${AO_DEV}/wiki?path=`);
    });

    it("跨项目跳转不带 version suffix (目标项目版本可能不同)", () => {
      const html = "<p>see /Users/user/workspace/yidao/CLAUDE.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, "abc-123", projects);
      // 跨项目链接不应带 &version=... (目标项目决定自己的 version)
      expect(out).toMatch(/href="\/#\/4fa2ad29[^"]+"/);
      expect(out.split(/href="\/#\/4fa2ad29[^"]+"/)[1]).not.toMatch(/&?version=/);
    });

    it("降级当前项目时保留 version suffix", () => {
      const html = "<p>see docs/foo.md</p>";
      const out = linkifyDocPaths(html, AO_DEV, "abc-123", projects);
      expect(out).toContain(`href="/#/${AO_DEV}/wiki?path=`);
      expect(out).toContain("version=abc-123");
    });
  });
});

// chat 流 8 位 UUID 短前缀自动链接 —— v58 R38 damo 0830 立.
// 关注点(改动 linkifyTaskPrefixes 之前先看):
//   1. \b 边界不能漏: 9/10/16 位 hex 串内嵌的 8 位子串不该匹配, 否则会把长的 commit SHA
//      错链成 task. 比如 "abcd1234ef" (10 位) 中间的 "cd1234ef" 8 位不能匹配.
//   2. 跳过 <pre>/<code> 块: 代码片段里的 hex 不该被链接 (与 linkifyDocPaths 同约束).
//   3. 跳过已有 <a> 内部: 避免嵌套 <a><a>.
//   4. 7 位 hex 不动: git short SHA 默认长度, damo R38 明确不 link (没对应文件变化).
//   5. 大小写不敏感: UUID 是小写, 但 chat 里也可能粘大写. /api/tasks/[id]/route.ts:32 同口径.
describe("linkifyTaskPrefixes", () => {
  describe("基础", () => {
    it("8 位 hex 被包成 /tasks/<prefix> 链接", () => {
      const html = "<p>see bd0ac7c4 for detail</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).toContain(`<a href="/#/tasks/bd0ac7c4"`);
      expect(out).toContain('data-task-prefix-link="1"');
      expect(out).toContain(">bd0ac7c4</a>");
    });

    it("大写 8 位 hex 同样命中 (case-insensitive, 与 server 解析一致)", () => {
      const html = "<p>see BD0AC7C4 for detail</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).toContain(`<a href="/#/tasks/bd0ac7c4"`); // URL 用小写
      expect(out).toContain(">BD0AC7C4</a>"); // 显示文本保留原大小写
    });

    it("7 位 hex 不动 (git short SHA, damo R38 不要 link)", () => {
      const html = "<p>commit bd0ac7c</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain("<a");
      expect(out).toContain("bd0ac7c"); // 原样保留
    });

    it("9/10/16 位 hex 内部 8 位子串不动 (\\b 边界守住)", () => {
      // 10 位 hex "abcd1234ef" 中含子串 "cd1234ef" —— \b 必须不匹配
      const html = "<p>hash abcd1234ef referenced</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain("<a");
      // 完整保留原 hex
      expect(out).toContain("abcd1234ef");
    });

    it("完整 32 位 UUID (含连字符 36 位) 不被当作 8 位 prefix 误链", () => {
      // 32 位 hex: 没有 \b 边界的 8 位子串能匹配 (因为 \b 也认 hex 字符间断)
      // 这里测的是: 36 位带连字符的 UUID 不该出 <a> —— 没 \b 边界.
      const html = "<p>task bd0ac7c4-1234-5678-9abc-def012345678</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain(`href="/#/tasks/bd0ac7c4"`); // 不该把 8 位 prefix 当 link
      expect(out).toContain("bd0ac7c4-1234-5678-9abc-def012345678"); // 原文保留
    });
  });

  describe("边界跳过", () => {
    it("已有 <a> 内部 8 位 hex 不被再包成链接 (避免嵌套)", () => {
      const html = `<p>see <a href="/#/tasks/already">bd0ac7c4</a></p>`;
      const out = linkifyTaskPrefixes(html);
      // 关键: 只有 1 个 <a> (原有的)
      expect(out.match(/<a /g)?.length).toBe(1);
      expect(out).not.toContain(`href="/#/tasks/bd0ac7c4"`);
    });

    it("<pre> 代码块内 8 位 hex 不动", () => {
      const html = "<pre><code>var x = 'bd0ac7c4';</code></pre>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain("<a");
      expect(out).toContain("bd0ac7c4");
    });

    it("内联 <code> 里混着别的字符时 8 位 hex 不动", () => {
      const html = "<p>call <code>bd0ac7c4()</code> in test</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain('<a href="/#/tasks/bd0ac7c4"');
      expect(out).toContain("bd0ac7c4");
    });

    // R117 (damo 0908): agent 习惯写 `1b746da4` 指代任务, 反引号形态要能点.
    it("内联 <code> 整段就是 8 位 hex 时 linkify", () => {
      const html = "<p>see <code>1b746da4</code> for detail</p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).toContain('<a href="/#/tasks/1b746da4"');
      expect(out).toContain('data-task-prefix-link="1"');
    });

    it("markdown 反引号形态端到端: `1b746da4` 可点", () => {
      const out = linkifyTaskPrefixes(markdownToHtml("聊天中 `1b746da4` 这种"));
      expect(out).toContain('<a href="/#/tasks/1b746da4"');
    });

    it("<pre><code> 内整段 8 位 hex 仍不动 (代码块优先)", () => {
      const html = "<pre><code>bd0ac7c4</code></pre>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain("<a");
    });

    it("内联 <code> 整段 7 位 hex 不动", () => {
      const html = "<p>see <code>bd0ac7c</code></p>";
      const out = linkifyTaskPrefixes(html);
      expect(out).not.toContain("<a");
    });
  });

  describe("与 linkifyDocPaths 链式", () => {
    it("8 位 hex 与 .md 路径共存时不互相干扰", () => {
      // 模拟真实 chat: task prefix + doc path 都在一段文本里
      const html = "<p>see bd0ac7c4 and CLAUDE.md</p>";
      const intermediate = linkifyDocPaths(html, AO_DEV, null, []);
      const out = linkifyTaskPrefixes(intermediate);
      // task prefix 已包成 <a>
      expect(out).toContain(`href="/#/tasks/bd0ac7c4"`);
    });
  });
});

// 图片渲染测试 —— markdownToHtml 支持 ![alt](url) 语法.
// 关注点(改 markdownToHtml 之前先看):
//   1. 必须跑在 link regex 之前, 否则 ![alt](url) 里的 [alt](url) 会被错包成 <a> 链接.
//   2. URL 白名单: 仅 http(s):// + 同源 /api/attachments/. javascript:/data:/vbscript:
//      和任意相对路径必须拦截(防 XSS, 前端 dangerouslySetInnerHTML 渲染).
//   3. 危险 URL 走「原样保留」策略 —— 不渲染但不静默吞, 用户至少能看到原 markdown 文本.
//   4. alt 里的 " 转 &quot; 防止 attribute 注入; alt 里的 \n 替成空格(HTML attribute 不支持).
describe("markdownToHtml images", () => {
  describe("isSafeImageUrl", () => {
    it("https URL 允许", () => {
      expect(isSafeImageUrl("https://example.com/foo.png")).toBe(true);
    });
    it("http URL 允许", () => {
      expect(isSafeImageUrl("http://example.com/foo.png")).toBe(true);
    });
    it("大小写不敏感的 scheme 仍允许", () => {
      expect(isSafeImageUrl("HTTPS://example.com/foo.png")).toBe(true);
      expect(isSafeImageUrl("Http://example.com/foo.png")).toBe(true);
    });
    it("同源 /api/attachments/ 允许", () => {
      expect(isSafeImageUrl("/api/attachments/abc-123")).toBe(true);
    });
    it("javascript: scheme 拦截", () => {
      expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    });
    it("data: URI 拦截(防御深度, 即使 <img src=data:> 不执行脚本)", () => {
      expect(isSafeImageUrl("data:image/png;base64,iVBORw0KG")).toBe(false);
    });
    it("vbscript: scheme 拦截", () => {
      expect(isSafeImageUrl("vbscript:msgbox(1)")).toBe(false);
    });
    it("任意相对路径拦截", () => {
      expect(isSafeImageUrl("./foo.png")).toBe(false);
      expect(isSafeImageUrl("foo.png")).toBe(false);
      expect(isSafeImageUrl("../foo.png")).toBe(false);
    });
    it("其他同源路径拦截(只允许 /api/attachments/)", () => {
      expect(isSafeImageUrl("/api/foo.png")).toBe(false);
      expect(isSafeImageUrl("/uploads/foo.png")).toBe(false);
    });
  });

  describe("渲染", () => {
    it("基础 ![alt](url) → <img>", () => {
      const out = markdownToHtml("![a horse](https://example.com/horse.png)");
      expect(out).toContain('<img src="https://example.com/horse.png" alt="a horse" loading="lazy" />');
    });

    it("空 alt 也能渲染 ![](url)", () => {
      const out = markdownToHtml("![](https://example.com/x.png)");
      expect(out).toContain('<img src="https://example.com/x.png" alt="" loading="lazy" />');
    });

    it("同源 /api/attachments/ 允许", () => {
      const out = markdownToHtml("![截图](/api/attachments/abc-123)");
      expect(out).toContain('<img src="/api/attachments/abc-123"');
    });

    it("javascript: 原样保留不渲染, 且不形成 <a href=javascript:>", () => {
      const md = "![xss](javascript:alert(1))";
      const out = markdownToHtml(md);
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<a ");
      // [ 和 ] 转 HTML 实体(浏览器解码后仍显示原 markdown, 但 link regex 看不到字面 [)
      expect(out).toContain("!&#91;xss&#93;(javascript:alert(1))");
    });

    it("data: 原样保留不渲染", () => {
      const md = "![inline](data:image/png;base64,iVBOR)";
      const out = markdownToHtml(md);
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<a ");
      expect(out).toContain("!&#91;inline&#93;(data:image/png;base64,iVBOR)");
    });

    it("相对路径原样保留不渲染", () => {
      const md = "![本地](./foo.png)";
      const out = markdownToHtml(md);
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<a ");
      expect(out).toContain("!&#91;本地&#93;(./foo.png)");
    });

    it("alt 里的 \" 转 &quot; 防止 attribute 注入", () => {
      const md = `![say "hi"](https://example.com/x.png)`;
      const out = markdownToHtml(md);
      expect(out).toContain(`alt="say &quot;hi&quot;"`);
      // 关键: 不能让 alt 属性提前闭合 —— 否则后续内容会被当成新 attribute
      expect(out).toMatch(/<img src="https:\/\/example\.com\/x\.png" alt="say &quot;hi&quot;"/);
    });

    it("url 里的 \" 转 &quot;", () => {
      const md = `![x](https://example.com/foo"?bar.png)`;
      const out = markdownToHtml(md);
      // 因为 URL 含 ? 和 ", 我们的正则 [^)\s]+ 允许 " 但不允许 ), 因此 URL 捕获为
      // https://example.com/foo"?bar.png. 转义后属性安全.
      expect(out).toContain('src="https://example.com/foo&quot;?bar.png"');
    });

    it("alt 里的换行替成空格(HTML attribute 不支持换行)", () => {
      const md = "![line1\nline2](https://example.com/x.png)";
      const out = markdownToHtml(md);
      expect(out).toContain('<img src="https://example.com/x.png" alt="line1 line2" loading="lazy" />');
    });

    it("图片和链接在同一行互不干扰", () => {
      const md = "![pic](https://example.com/p.png) and [link](https://example.com)";
      const out = markdownToHtml(md);
      expect(out).toContain('<img src="https://example.com/p.png"');
      expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">link</a>');
    });

    it("图片不会被 link regex 错包成链接(image regex 先跑)", () => {
      const md = "![pic](https://example.com/p.png)";
      const out = markdownToHtml(md);
      // 关键: 没有 <a> 标签(只有 <img>)
      expect(out).not.toContain("<a ");
      expect(out).toContain("<img");
    });

    it("title 属性暂不渲染(避免引入更多 HTML 注入面, 但语法不报错)", () => {
      const md = `![alt](https://example.com/x.png "title text")`;
      const out = markdownToHtml(md);
      // 不渲染 title 属性, 但仍渲染 <img>
      expect(out).toContain('<img src="https://example.com/x.png" alt="alt" loading="lazy" />');
      expect(out).not.toContain("title=");
    });

    it("内联在文本中正常工作", () => {
      const md = "看这张图 ![示意](https://example.com/x.png) 这是说明";
      const out = markdownToHtml(md);
      expect(out).toContain("看这张图");
      expect(out).toContain('<img src="https://example.com/x.png" alt="示意" loading="lazy" />');
      expect(out).toContain("这是说明");
    });
  });
});
