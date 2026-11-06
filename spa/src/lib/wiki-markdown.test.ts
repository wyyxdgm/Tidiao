// spa/src/lib/wiki-markdown.ts — 链接解析与渲染规则单测.
//
// 关注点 (每条对应一种链接形态):
//  - 跨项目 `project:{UUID}?path=` → 跨项目 wiki hash 链接
//  - 绝对路径命中项目 cwd → 该项目 wiki
//  - `task:{id}` → 任务详情
//  - 相对 .md → 同项目 wiki
//  - 外链 → 留原样 (markdown-it 默认 target=_blank)
//  - 中文 href 不双重编码 (R231 回归: decodeURI → encodeURIComponent 单次)
//
// 语义对齐 master src/lib/wiki-links.ts —— 改语法时两边都要改.

import { describe, it, expect } from 'vitest';
import {
  createMarkdownRenderer,
  decodeSafeHref,
  extOf,
  isMarkdownLink,
  isRelativeWikiLink,
  parseCrossProjectHref,
  parseTaskHref,
  resolveAbsoluteProjectPath,
  resolveMdPath,
} from './wiki-markdown';

const PROJECT_ID = '080af705-59dc-4a27-9b13-e0e1de3f9a50';
const OTHER_PROJECT_ID = '37c28ff5-d8c5-448d-9bbb-499709e01f82';

const projects = [
  { id: PROJECT_ID, cwd: '/home/user/workspace/agent-orchestrator-dev' },
  { id: OTHER_PROJECT_ID, cwd: '/home/user/workspace/partner' },
];

function render(
  md: string,
  opts: {
    currentPath?: string;
    projectsWithCwd?: typeof projects;
    allowed?: string[];
    projectId?: string;
  } = {},
): string {
  const md5 = createMarkdownRenderer({
    getCurrentPath: () => opts.currentPath ?? 'INDEX.md',
    getProjectsWithCwd: () => opts.projectsWithCwd ?? projects,
    getAllowedExts: () => new Set(opts.allowed ?? ['md']),
    getProjectId: () => opts.projectId ?? PROJECT_ID,
  });
  return md5.render(md);
}

describe('extOf', () => {
  it('取小写扩展名', () => {
    expect(extOf('a.MD')).toBe('md');
    expect(extOf('docs/x.tar.gz')).toBe('gz');
  });

  it('无扩展名 / 隐藏文件 → ""', () => {
    expect(extOf('README')).toBe('');
    expect(extOf('.env')).toBe('');
  });
});

describe('parseCrossProjectHref', () => {
  it('解析标准形态', () => {
    const r = parseCrossProjectHref(`project:${OTHER_PROJECT_ID}?path=docs/a.md`);
    expect(r).toEqual({ projectId: OTHER_PROJECT_ID, path: 'docs/a.md', version: null });
  });

  it('带 version', () => {
    const r = parseCrossProjectHref(
      `project:${OTHER_PROJECT_ID}?path=a.md&version=v1`,
    );
    expect(r?.version).toBe('v1');
  });

  it('非法 projectId / path 含 .. / 前导 / → null', () => {
    expect(parseCrossProjectHref('project:not-a-uuid?path=a.md')).toBe(null);
    expect(parseCrossProjectHref(`project:${OTHER_PROJECT_ID}?path=../a.md`)).toBe(null);
    expect(parseCrossProjectHref(`project:${OTHER_PROJECT_ID}?path=/abs/a.md`)).toBe(null);
  });

  it('非 project: 前缀 → null', () => {
    expect(parseCrossProjectHref('https://example.com')).toBe(null);
  });
});

describe('parseTaskHref', () => {
  it('完整 UUID + 8 位短 id', () => {
    expect(parseTaskHref('task:2c364593-fc21-4f65-990f-77b571bf38c8')?.taskId).toBe(
      '2c364593-fc21-4f65-990f-77b571bf38c8',
    );
    expect(parseTaskHref('task:2c364593')?.taskId).toBe('2c364593');
  });

  it('非法 id → null', () => {
    expect(parseTaskHref('task:xyz')).toBe(null);
    expect(parseTaskHref('task:')).toBe(null);
    expect(parseTaskHref('https://example.com')).toBe(null);
  });
});

describe('resolveMdPath', () => {
  it('相对当前目录', () => {
    expect(resolveMdPath('docs/INDEX.md', 'a.md')).toBe('docs/a.md');
  });

  it('.. 段按目录弹出', () => {
    expect(resolveMdPath('docs/sub/INDEX.md', '../a.md')).toBe('docs/a.md');
  });

  it('同目录 (base 无 /)', () => {
    expect(resolveMdPath('INDEX.md', 'a.md')).toBe('a.md');
  });
});

describe('resolveAbsoluteProjectPath', () => {
  it('命中 cwd 子树', () => {
    const r = resolveAbsoluteProjectPath(
      '/home/user/workspace/partner/CLAUDE.md',
      projects,
    );
    expect(r).toEqual({ projectId: OTHER_PROJECT_ID, path: 'CLAUDE.md' });
  });

  it('mac 形态路径归一化后命中', () => {
    const r = resolveAbsoluteProjectPath(
      '/Users/user/workspace/partner/CLAUDE.md',
      projects,
    );
    expect(r?.projectId).toBe(OTHER_PROJECT_ID);
  });

  it('cwd 本身不算命中', () => {
    expect(
      resolveAbsoluteProjectPath('/home/user/workspace/partner', projects),
    ).toBe(null);
  });

  it('兄弟目录不截胡 (边界 /)', () => {
    const p = [{ id: 'x', cwd: '/home/user/ws/a' }];
    expect(resolveAbsoluteProjectPath('/home/user/ws/abc/a.md', p)).toBe(null);
  });
});

describe('isRelativeWikiLink / isMarkdownLink', () => {
  it('放行集合内的相对链接', () => {
    expect(isRelativeWikiLink('a.md', new Set(['md']))).toBe(true);
    expect(isRelativeWikiLink('a.png', new Set(['md']))).toBe(false);
  });

  it('外链 / 锚点 / mailto 不算相对链接', () => {
    const s = new Set(['md']);
    expect(isRelativeWikiLink('https://x.com/a.md', s)).toBe(false);
    expect(isRelativeWikiLink('#section', s)).toBe(false);
    expect(isRelativeWikiLink('mailto:a@b.c', s)).toBe(false);
  });
});

describe('render — 链接改写', () => {
  it('跨项目链接 → /#/other/wiki?path=', () => {
    const html = render(`[p](project:${OTHER_PROJECT_ID}?path=docs/a.md)`);
    expect(html).toContain(`/#/${OTHER_PROJECT_ID}/wiki?path=docs%2Fa.md`);
    expect(html).toContain('md-link-cross');
  });

  it('绝对路径命中 → 项目 wiki', () => {
    const html = render('[p](/home/user/workspace/partner/CLAUDE.md)');
    expect(html).toContain(`#/${OTHER_PROJECT_ID}/wiki?path=CLAUDE.md`);
  });

  it('task: 链接 → #/tasks/', () => {
    const html = render('[t](task:2c364593)');
    expect(html).toContain('#/tasks/2c364593');
    expect(html).toContain('md-link-task');
  });

  it('相对 .md → 同项目 wiki', () => {
    const html = render('[a](docs/a.md)');
    expect(html).toContain(`#/${PROJECT_ID}/wiki?path=docs%2Fa.md`);
    expect(html).toContain('is-md');
  });

  it('外链保持原 href', () => {
    const html = render('[x](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('md-link-external');
  });

  it('裸 URL 自动 linkify (飞书链接直接贴 URL 能点)', () => {
    const html = render('见 https://my.feishu.cn/sheets/abc 拿表');
    expect(html).toContain('href="https://my.feishu.cn/sheets/abc"');
  });

  it('中文 href 不双重编码', () => {
    const html = render('[中文](docs/中文.md)');
    expect(html).toContain(encodeURIComponent('docs/中文.md'));
    expect(html).not.toContain('%25E4');
  });

  it('raw HTML 被转义 (XSS 防线)', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('表格 / 代码块 / 列表 支持', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n\n- x\n- y');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre>');
    expect(html).toContain('<ul>');
  });
});

describe('render — 纯文本引用 linkify', () => {
  it('纯文本 task:8位短id → 可点', () => {
    const html = render('任务: task:2c364593 等这个');
    expect(html).toContain('href="#/tasks/2c364593"');
    expect(html).toContain('md-link-task');
  });

  it('纯文本 task:完整UUID → 可点', () => {
    const html = render('任务: task:2c364593-fc21-4f65-990f-77b571bf38c8');
    expect(html).toContain('href="#/tasks/2c364593-fc21-4f65-990f-77b571bf38c8"');
  });

  it('纯文本 project:UUID?path= → 可点', () => {
    const html = render(`见 project:${OTHER_PROJECT_ID}?path=INDEX.md`);
    expect(html).toContain(`/#/${OTHER_PROJECT_ID}/wiki?path=INDEX.md`);
  });

  it('非法 id 不被链接化 (原样保留)', () => {
    const html = render('任务: task:xyz 不是 id');
    expect(html).not.toContain('md-link-task');
    expect(html).toContain('task:xyz');
  });

  it('已是 markdown 链接的不重复包 <a> (无嵌套 a)', () => {
    const html = render('[t](task:2c364593)');
    // 一个 <a ...> 一个 </a> —— 不能嵌套
    const opens = (html.match(/<a /g) || []).length;
    const closes = (html.match(/<\/a>/g) || []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it('代码块里的 task: 不被链接化', () => {
    const html = render('```\ntask:2c364593\n```');
    expect(html).not.toContain('md-link-task');
  });

  it('幂等: 同一段 HTML 处理两次结果一致 (无 lastIndex 残留)', () => {
    const once = render('任务: task:2c364593');
    const twice = render('任务: task:2c364593');
    expect(once).toBe(twice);
  });
});

describe('decodeSafeHref', () => {
  it('还原预编码 href', () => {
    expect(decodeSafeHref('%E4%B8%AD%E6%96%87.md')).toBe('中文.md');
  });

  it('畸形编码序列保持原串 (不抛)', () => {
    expect(decodeSafeHref('%zz')).toBe('%zz');
  });
});
