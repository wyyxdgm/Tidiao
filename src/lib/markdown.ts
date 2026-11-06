// Simple markdown → HTML (no external lib)
// Used by task-detail-client and transcript pages.
//
// 功能: markdown → HTML. projectId 非空时, 相对 .md 链接指向项目 wiki.
// 关注点: 极简正则转换, 不处理嵌套/HTML; code block 内部的 markdown 链接是边角缺陷(极罕见, 同现有 gaps).
import {
  normalizeHrefForCwdMatch,
  resolveAbsoluteProjectPath,
  type ProjectCwdRef,
} from "./wiki-links";

// 功能: 白名单 image URL —— 仅允许 https?:// 绝对 URL + 同源 /api/attachments/ 路径.
//       拦截 javascript:/data:/vbscript: 等危险 scheme, 拦截任意相对路径(防 XSS).
// 关注点: 前端 chat 流用 dangerouslySetInnerHTML 渲染, 不能信任 agent 输入;
//   data: URI 即使在 <img src> 上不执行脚本, 也按防御深度一并拦截.
export function isSafeImageUrl(url: string): boolean {
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith("/api/attachments/")) return true;
  return false;
}

export function markdownToHtml(md: string, projectId?: string | null, versionId?: string | null): string {
  let html = md
    // Escape HTML entities first (but preserve what we'll generate)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Images: ![alt](url) 或 ![alt](url "title")
  // 功能: markdown 图片语法 → <img>. 白名单 URL scheme, 危险 URL 走 escape-[/] 策略
  //       —— 既保留用户原意显示, 又防止后续 link regex 把 [alt](url) 错包成 <a href=javascript:...>
  //       (那种情况会变成真 XSS, 比单纯不渲染更危险).
  // 关注点: 必须在 link regex 之前跑, 否则 [alt](url) 会被错包成链接.
  //   url/alt 中的 " 转 &quot; 防止 attribute 注入; alt 中的 \n 替成空格(HTML attribute 不支持).
  html = html.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, alt: string, url: string) => {
      if (!isSafeImageUrl(url)) {
        // 用 HTML 实体 &#91; / &#93; 替掉 [ 和 ] —— 浏览器解码后仍显示 ![alt](url),
        // 但 server-side link regex 看不到字面 [, 不会错包成 <a href="javascript:...">.
        return `!&#91;${alt}&#93;(${url})`;
      }
      const safeAlt = alt.replace(/"/g, "&quot;").replace(/\n/g, " ");
      const safeUrl = url.replace(/"/g, "&quot;");
      return `<img src="${safeUrl}" alt="${safeAlt}" loading="lazy" />`;
    }
  );

  // Markdown links: [text](url) 或 [text](url "title")
  // 功能: 相对 .md 链接 → wiki 深链接; http/#/mailto → 新窗口外链.
  // 关注点: 在 escape 后、code block 提取前解析, 避免 <a> 被 inline code/bold 正则误伤.
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, text: string, url: string) => {
      const t = text.trim();
      if (/^https?:\/\//i.test(url) || url.startsWith("#") || url.startsWith("mailto:")) {
        return `<a href="${url}" target="_blank" rel="noopener">${t}</a>`;
      }
      if (url.toLowerCase().endsWith(".md") && projectId) {
        const p = url.replace(/^\.\//, "");
        const v = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
        // 🔴 hash 路由: href 带 /#/ 前缀, 点击/复制都落到 Vue SPA (旧壳仅兜底直访)
        return `<a href="/#/${projectId}/wiki?path=${encodeURIComponent(p)}${v}" target="_blank" rel="noopener">${t}</a>`;
      }
      return `<a href="${url}">${t}</a>`;
    }
  );

  // Code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Headings: # ... ###### (must come before inline rules to consume whole lines)
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Inline code: `...`
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold: **...** or __...__
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Unordered lists: lines starting with - or *
  // Group consecutive list lines into <ul><li>...</li></ul>
  html = html.replace(/(?:^|\n)((?:[ \t]*[-*][ \t]+.+(?:\n|$))+)/g, (block) => {
    const items = block
      .trim()
      .split(/\n/)
      .map((line: string) => line.replace(/^[ \t]*[-*][ \t]+/, ""))
      .filter(Boolean)
      .map((item: string) => `<li>${item}</li>`)
      .join("");
    return `\n<ul>${items}</ul>\n`;
  });

  // Ordered lists: lines starting with 1. 2. etc.
  html = html.replace(/(?:^|\n)((?:[ \t]*\d+\.[ \t]+.+(?:\n|$))+)/g, (block) => {
    const items = block
      .trim()
      .split(/\n/)
      .map((line: string) => line.replace(/^[ \t]*\d+\.[ \t]+/, ""))
      .filter(Boolean)
      .map((item: string) => `<li>${item}</li>`)
      .join("");
    return `\n<ol>${items}</ol>\n`;
  });

  // Line breaks (preserve pre blocks — skip content inside <pre>)
  const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
  const result = parts
    .map((part) => {
      if (part.startsWith("<pre>")) return part;
      return part.replace(/\n/g, "<br />");
    })
    .join("");

  return result;
}

// 功能: 在已转义的 HTML 上把裸 .md 路径包成 wiki 链接, projectId 为空时原样返回.
// 关注点: 镜像 highlightHtml 的拆标签模式; 跳过 <pre> 块和已有 <a> 内部文本(避免嵌套非法 <a>); http URL 段原样保留不误链.
//
// v53 跨项目跳转兜底(R14, damo 0823 partner R45): agent 在 chat 流里输出的 4 类路径形态
//   /Users/user/ws/a/foo.md  (mac)
//   ~/workspace/yidao/CLAUDE.md  (~ 展开)
//   /home/user/ws/a/foo.md  (WSL, 已是规范形态)
//   /workspace/yidao/CLAUDE.md  (shorthand 漏前缀)
// 都尝试按 cwd 前缀命中其他项目 —— 命中则直跳目标项目 wiki, 否则降级当前项目.
// 服务端 decideAbsolutePathRedirect 仍是兜底防线(URL 直访场景); 这里只是优化 UX(避免
// 一次「跳当前项目 → 服务端 redirect」的往返).
export function linkifyDocPaths(
  html: string,
  projectId: string | null | undefined,
  versionId?: string | null,
  projects?: ProjectCwdRef[] | null
): string {
  if (!projectId) return html;
  const versionSuffix = versionId ? `&version=${encodeURIComponent(versionId)}` : "";
  // 🔴 hash 路由: 对外 wiki 链接统一 /#/ 前缀 (SPA), 不再拼旧壳 path 形态
  const wikiBase = `/#/${projectId}/wiki?path=`;
  // alternation: 先吃 http(s) URL(原样返回), 否则匹配 .md 路径 token.
  // 可选 ~/ 前缀让 ~/workspace/.../foo.md 整体被吃, 而不是只吃 workspace/.../foo.md
  // 留下裸 ~/. 必须非锚定 \\b —— .md 前缀里 - 是合法的文件名一部分.
  const re = /(https?:\/\/\S+)|((?:~\/)?[\w./-]+\.md)/g;
  const parts = html.split(/(<[^>]+>)/);
  let inPre = false;
  let inA = false;
  // homeDir 在每个 token 上 normalize 时用 —— 与服务端 decideAbsolutePathRedirect / wiki-links.ts 共用语义.
  const homeDir = process.env.HOME || "/home/user";
  return parts
    .map((part) => {
      if (part.startsWith("<") && part.endsWith(">")) {
        const tag = part.toLowerCase();
        if (/^<pre[\s>]/.test(tag)) inPre = true;
        else if (/^<\/pre[\s>]/.test(tag)) inPre = false;
        else if (/^<a[\s>]/.test(tag)) inA = true;
        else if (/^<\/a[\s>]/.test(tag)) inA = false;
        return part;
      }
      if (inPre || inA) return part;
      return part.replace(re, (m, url: string, mdPath: string) => {
        if (url) return m; // http URL, 保留原样
        // 命中跨项目 cwd? 把 ~/ 形态先 normalize 到 WSL, 再调共用 resolveAbsoluteProjectPath.
        // 只在 projects 非空时尝试 —— 没有项目列表时直接降级当前项目, 行为同 v53 之前.
        if (projects && projects.length > 0) {
          const normalized = normalizeHrefForCwdMatch(mdPath, homeDir);
          const resolved = resolveAbsoluteProjectPath(normalized, projects, homeDir);
          if (resolved) {
            // 跨项目直跳目标项目 wiki —— 不带 version suffix (目标项目版本可能不同, 让目标决定).
            return `<a href="/#/${resolved.projectId}/wiki?path=${encodeURIComponent(resolved.path)}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">${mdPath}</a>`;
          }
        }
        // 降级: 跳当前项目. ./X 去掉前导 ./ 与现有语义对齐.
        const p = mdPath.replace(/^\.\//, "");
        return `<a href="${wikiBase}${encodeURIComponent(p)}${versionSuffix}" target="_blank" rel="noopener" class="text-blue-600 hover:underline">${mdPath}</a>`;
      });
    })
    .join("");
}

// 功能: 在已转义的 HTML 上把 8 位 hex (UUID 短前缀) 包成 task 链接.
// 关注点:
//   - 仅匹配 8 位 [0-9a-f], 与现有 shortId = id.slice(0,8) 约定一致
//     (src/lib/runtime/parent-notify.ts:200 + src/lib/notify/task-timeout.ts:90).
//     7 位 hex (git short SHA 默认长度) 不动 —— 没对应文件变化不该 linkify
//     (damo 0830 R38 立).
//   - 8 位串长度上也可能是 git short SHA (core.abbrev=8); 服务端按 hex 接受,
//     用户点错链接会落到 /tasks/[id]/page.tsx:62 的 prefix 解析, 0 匹配 → 404,
//     不再额外判.
//   - 跳过 <pre> 块 + 已有 <a> 内部 (避免嵌套 <a><a>), 与 linkifyDocPaths 同套拆标签模式.
//   - 内联 <code>: 整段内容恰好是 8 位 hex 才 linkify (damo 0908 R117 立) ——
//     agent 习惯写 `1b746da4` 指代任务, 反引号形态过去被一律跳过 = 用户点不到.
//     含其他字符的代码片段 (如 `bd0ac7c4()` / `x = bd0ac7c4;`) 仍不动, 保留
//     「代码里的 hex 不是任务引用」原意.
//   - 链接指 /tasks/<prefix>; /tasks/[id]/page.tsx:60 server 端自动 redirect
//     到完整 UUID, 匹配唯一时 1 跳, 0/多匹配降级 404 (沿用现有行为).
//   - 不预解析 prefix → full id (避免每条 message 渲染都查 DB); URL 上保留
//     前缀更易复用 (用户手抄链接也认).
export function linkifyTaskPrefixes(html: string): string {
  // 8 位 hex 边界匹配: \b 确保前/后不是别的 hex 字符(否则会匹配到 9/10/16 位中的 8 子串).
  // 两侧额外 (?<![0-9a-f-]) / (?![0-9a-f-]) 排除:
  //   - 完整 UUID (32 位 hex) 中嵌入的 8 位 prefix 子串: 例如 "bd0ac7c4-1234-..." 第一段
  //     会被 \b 边界识别为 8-hex, 但用户贴完整 UUID 时不该出局部链接. - 在 \b 不算
  //     非 word 字符边界 (其实 \b 边界在 4↔- 成立, 但 lookahead 阻止子串误匹配).
  //   - 长 hex 串 (10/16 位) 任何连续 8 子串: 同样靠后置 lookahead 阻止.
  // case-insensitive 与 /api/tasks/[id]/route.ts:32 同口径.
  const re = /(?<![0-9a-f-])\b[0-9a-f]{8}\b(?![0-9a-f-])/gi;
  const parts = html.split(/(<[^>]+>)/);
  let inPre = false;
  let inA = false;
  let inCode = false;
  return parts
    .map((part) => {
      if (part.startsWith("<") && part.endsWith(">")) {
        const tag = part.toLowerCase();
        if (/^<pre[\s>]/.test(tag)) inPre = true;
        else if (/^<\/pre[\s>]/.test(tag)) inPre = false;
        else if (/^<code[\s>]/.test(tag)) inCode = true;
        else if (/^<\/code[\s>]/.test(tag)) inCode = false;
        else if (/^<a[\s>]/.test(tag)) inA = true;
        else if (/^<\/a[\s>]/.test(tag)) inA = false;
        return part;
      }
      if (inPre || inA) return part;
      // 内联 code: 只有「整段就是一个 8 位 hex」才 linkify (R117). 其余代码片段照旧跳过.
      if (inCode && !/^\s*[0-9a-f]{8}\s*$/i.test(part)) return part;
      return part.replace(re, (m) => {
        const lowered = m.toLowerCase();
        return `<a href="/#/tasks/${lowered}" class="text-blue-600 hover:underline" data-task-prefix-link="1">${m}</a>`;
      });
    })
    .join("");
}
