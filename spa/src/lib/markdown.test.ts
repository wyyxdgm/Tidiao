import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './markdown';

// R231 回归: markdown-it 默认 normalizeLink=encodeURI 会把中文 href 预编码一次,
// link_open 规则再 encodeURIComponent 就成了双重编码 (%E6 → %25E6), 点击后
// wiki query.path 拿到 %XX 字面量 → 后端 exists:false → 「访问不了」.
// 修法: link_open 里先 decodeURI 还原原文再编码一次.
describe('markdownToHtml wiki link encoding', () => {
  it('中文相对 .md 链接输出单次编码的 wiki href', () => {
    const html = markdownToHtml(
      '[docs/playbook/总纲.md](docs/playbook/淘客全职实施总纲-V1.0.md)',
      'proj-1',
    );
    const m = html.match(/href="([^"]+)"/);
    expect(m).toBeTruthy();
    const href = m![1];
    expect(href).toBe('/#/proj-1/wiki?path=docs%2Fplaybook%2F%E6%B7%98%E5%AE%A2%E5%85%A8%E8%81%8C%E5%AE%9E%E6%96%BD%E6%80%BB%E7%BA%B2-V1.0.md');
    // 不含双重编码痕迹 (%25)
    expect(href).not.toContain('%25');
    // decode 一次即还原原文
    expect(decodeURIComponent(href.split('path=')[1]!)).toBe(
      'docs/playbook/淘客全职实施总纲-V1.0.md',
    );
  });

  it('纯 ASCII 相对 .md 链接不受 decode 影响', () => {
    const html = markdownToHtml('[guide](docs/guide.md)', 'proj-1');
    expect(html).toContain('href="/#/proj-1/wiki?path=docs%2Fguide.md"');
  });

  it('非 .md / 外链不走 wiki 改写', () => {
    const html = markdownToHtml('[x](https://example.com/a.md) [y](docs/img.png)', 'proj-1');
    expect(html).toContain('href="https://example.com/a.md"');
    expect(html).toContain('href="docs/img.png"');
  });
});
