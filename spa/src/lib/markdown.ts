// Simple markdown → HTML helpers for the chat transcript.
//
// 功能: 镜像 master src/lib/markdown.ts 的三件套 markdownToHtml / linkifyDocPaths /
// linkifyTaskPrefixes. SPA 用 markdown-it 库 (spa/package.json 已依赖 ^15.0.2),
// master 走自家极简正则 — SPA 选 markdown-it 是因为:
//   1. 支持表格 / 嵌套列表 / 代码块 fence 等 master 极简版不支持的语法
//      (R56-A5+ 留作优化面, 本轮只接主流程);
//   2. token-by-token API 让 highlightHtml/linkifyTaskPrefixes 可以安全插桩
//      (跳过 <pre>/<a>/<code> 内部).
//
// 关注点:
//   - 默认开启 linkify 让裸 URL 自动变链接 (master 的 markdownToHtml 没做,
//     仅处理 [text](url) 形态).
//   - HTML 转义靠 markdown-it 默认行为 (它对 unsafe HTML 走 escape 策略).
//   - renderTranscriptMessage 是高层封装: md → linkify → highlight, 与
//     master tdc.tsx MessageView 同款三段管线.
//   - 安全: 白名单 image URL scheme (http/https/相对 /api/attachments/),
//     拦截 javascript:/data: 等 XSS scheme.
//   - 不引外部 wiki-links 跨项目解析 (SPA ProjectWiki.vue 自有简化版,
//     chat 流里仅做当前项目 wiki 跳转).

import MarkdownIt, { type Token, type MarkdownItOptions, type Renderer, type Env } from 'markdown-it';

// 功能: 安全 image URL 白名单. http/https + 同源 /api/attachments/.
// 关注点: markdown-it 默认 img token src 不做白名单, 这里走 linkify=false +
//        自定义 html_inline 渲染拦截.
function isSafeImageUrl(url: string): boolean {
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith('/api/attachments/')) return true;
  return false;
}

const md = new MarkdownIt({
  html: false, // 拒绝原始 HTML, 防 XSS (master 同款 conservative).
  linkify: true, // 自动把裸 URL 转成链接.
  typographer: false,
  breaks: true, // \n → <br> (master markdownToHtml 行为).
});

// linkify 后的链接默认 target=_blank + rel=noopener.
// 关注点: markdown-it Renderer.renderToken 要求 Required<MarkdownItOptions>,
// 我们的 options 来自 MarkdownIt 实例的 md.options 已是 Required 形态
// (构造函数默认值已合并). 直接传 self (Renderer) 让默认实现取 self.options.
const defaultLinkRender =
  md.renderer.rules.link_open ||
  function defaultLink(
    tokens: Token[],
    idx: number,
    options: MarkdownItOptions,
    env: Env | undefined,
    self: Renderer,
  ): string {
    return self.renderToken(tokens, idx, options as Required<MarkdownItOptions>);
  };

md.renderer.rules.link_open = function (
  tokens: Token[],
  idx: number,
  options: MarkdownItOptions,
  env: Env | undefined,
  self: Renderer,
): string {
  const token = tokens[idx];
  const hrefIdx = token.attrIndex('href');
  if (hrefIdx >= 0) {
    const href = String(token.attrs![hrefIdx][1]);
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener');
    // 相对 .md 链接 → wiki 跳转 (master linkifyDocPaths 简化版,
    // 不做跨项目解析 — SPA chat 流够用).
    if (href.toLowerCase().endsWith('.md') && !/^https?:\/\//i.test(href)) {
      const projectId = (env as { projectId?: string | null } | undefined)?.projectId ?? null;
      if (projectId) {
        // 🔴 markdown-it normalizeLink(encodeURI) 已把中文 href 预编码一次,
        //    不 decode 就 encodeURIComponent = 双重编码 → wiki 404 (R231).
        let decoded = href;
        try {
          decoded = decodeURI(href);
        } catch {
          // 畸形编码序列保持原串
        }
        const p = decoded.replace(/^\.\//, '');
        // 🔴 hash 路由: 带 /#/ 前缀, 点击/新开 tab 都落 SPA wiki (否则跳旧壳)
        token.attrSet(
          'href',
          `/#/${projectId}/wiki?path=${encodeURIComponent(p)}`,
        );
      }
    }
  }
  return defaultLinkRender(tokens, idx, options as Required<MarkdownItOptions>, env, self);
};

// 自定义 image 渲染: src 非白名单时丢 src attribute, 让浏览器显示 alt 文案.
// master 用 escape-[/] 策略保留字面文本; markdown-it 这里走 img attr 摘除更干净.
md.renderer.rules.image = function (
  tokens: Token[],
  idx: number,
  options: MarkdownItOptions,
  env: Env | undefined,
  self: Renderer,
): string {
  const token = tokens[idx];
  const srcIdx = token.attrIndex('src');
  if (srcIdx >= 0) {
    const src = String(token.attrs![srcIdx][1]);
    if (!isSafeImageUrl(src)) {
      token.attrs!.splice(srcIdx, 1);
    } else {
      token.attrSet('loading', 'lazy');
    }
  }
  return self.renderToken(tokens, idx, options as Required<MarkdownItOptions>);
};

// 简化版的 inline: 跳过 <pre>/<code>/<a> 内部, 防止嵌套非法标签.
// 关注点: master 用 split(/(<[^>]+>)/) 拆标签 + 状态机. markdown-it
// 已把 HTML escape 处理好, 这里只需要保护已经生成的 <a>/<pre>/<code> 内嵌
// 形态不被 linkify 二次套娃.
function partsByTags(html: string): { part: string; inPre: boolean; inA: boolean; inCode: boolean }[] {
  const out: { part: string; inPre: boolean; inA: boolean; inCode: boolean }[] = [];
  let inPre = false;
  let inA = false;
  let inCode = false;
  const re = /<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) {
      out.push({ part: html.slice(last, m.index), inPre, inA, inCode });
    }
    const tag = m[0].toLowerCase();
    if (/^<pre[\s>]/.test(tag)) inPre = true;
    else if (/^<\/pre[\s>]/.test(tag)) inPre = false;
    else if (/^<a[\s>]/.test(tag)) inA = true;
    else if (/^<\/a[\s>]/.test(tag)) inA = false;
    else if (/^<code[\s>]/.test(tag)) inCode = true;
    else if (/^<\/code[\s>]/.test(tag)) inCode = false;
    out.push({ part: m[0], inPre, inA, inCode });
    last = m.index + m[0].length;
  }
  if (last < html.length) {
    out.push({ part: html.slice(last), inPre, inA, inCode });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Markdown → HTML. projectId 非空时把相对 .md 链接转成 wiki 深链.
 * 镜像 master markdownToHtml 但底层换 markdown-it (完整语法).
 */
export function markdownToHtml(mdText: string, projectId: string | null = null): string {
  return md.render(mdText, { projectId });
}

/**
 * 在已渲染的 HTML 上把裸 .md 路径包成当前项目 wiki 链接.
 * 镜像 master linkifyDocPaths 简化版 (无跨项目解析).
 */
export function linkifyDocPaths(html: string, projectId: string | null): string {
  if (!projectId) return html;
  // 🔴 hash 路由: /#/ 前缀 (与 linkifyTaskPrefixes 的 #/tasks/ 同一形态族)
  const wikiBase = `/#/${projectId}/wiki?path=`;
  const re = /((?:~\/)?[\w./-]+\.md)/g;
  const parts = partsByTags(html);
  return parts
    .map(({ part, inPre, inA }) => {
      if (part.startsWith('<') && part.endsWith('>')) return part;
      if (inPre || inA) return part;
      return part.replace(re, (m) => {
        const p = m.replace(/^\.\//, '');
        return `<a href="${wikiBase}${encodeURIComponent(p)}" target="_blank" rel="noopener">${m}</a>`;
      });
    })
    .join('');
}

/**
 * 8 位 hex UUID prefix → task 链接. 镜像 master linkifyTaskPrefixes.
 * 跳过 <pre>/<a>; 内联 <code> 仅当整段是 8-hex 才 linkify.
 */
export function linkifyTaskPrefixes(html: string): string {
  const re = /(?<![0-9a-f-])\b[0-9a-f]{8}\b(?![0-9a-f-])/gi;
  const parts = partsByTags(html);
  return parts
    .map(({ part, inPre, inA, inCode }) => {
      if (part.startsWith('<') && part.endsWith('>')) return part;
      if (inPre || inA) return part;
      if (inCode && !/^\s*[0-9a-f]{8}\s*$/i.test(part)) return part;
      return part.replace(re, (m) => {
        const lowered = m.toLowerCase();
        return `<a href="#/tasks/${lowered}" data-task-prefix-link="1">${m}</a>`;
      });
    })
    .join('');
}

/**
 * 搜索高亮 — 在 plain text 或 HTML 文本节点上包 <mark>.
 * 镜像 master highlightText + highlightHtml: 拆标签, 跳过 <pre>/<a> 内.
 */
export function highlightText(text: string, query: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return highlightHtml(escaped, query);
}

export function highlightHtml(html: string, query: string): string {
  if (!query) return html;
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  const parts = partsByTags(html);
  return parts
    .map(({ part, inPre, inA }) => {
      if (part.startsWith('<') && part.endsWith('>')) return part;
      if (inPre || inA) return part;
      return part.replace(regex, '<mark>$1</mark>');
    })
    .join('');
}

/**
 * 高层封装 — 文本走 master 同款三段管线:
 *   markdown → linkifyDocPaths → linkifyTaskPrefixes → highlight
 * 不传 projectId 时跳过 wiki 路径 linkify (适合 transcript 文本).
 */
export function renderTranscriptMessage(
  text: string,
  query: string,
  projectId: string | null,
): string {
  if (!text) return '';
  const html = markdownToHtml(text, projectId);
  const withDocs = linkifyDocPaths(html, projectId);
  const withTasks = linkifyTaskPrefixes(withDocs);
  return highlightHtml(withTasks, query);
}