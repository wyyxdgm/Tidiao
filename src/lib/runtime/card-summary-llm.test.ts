import { describe, expect, it } from 'vitest';
import { parseCardSummaryText } from './card-summary-llm';

/* parseCardSummaryText 纯函数单测 (SDK 路径已由 llm-summarize.test.ts 契约覆盖,
   这里只锁「模型输出 → 两行摘要」的解析容错). R177 迭代7, damo 1004 拍板. */

describe('parseCardSummaryText', () => {
  it('标准两行直取', () => {
    expect(parseCardSummaryText('干啥: 把线上服务升级到最新代码\n有啥用: 新功能对用户生效')).toEqual({
      what: '把线上服务升级到最新代码',
      why: '新功能对用户生效',
    });
  });

  it('容忍 markdown 噪音 (加粗/引号/编号)', () => {
    const raw = '**1. 干啥: 「更新部署13000」**\n- 有啥用: "让线上跑上 mermaid 渲染"';
    const out = parseCardSummaryText(raw);
    expect(out?.what).toBe('更新部署13000');
    expect(out?.why).toBe('让线上跑上 mermaid 渲染');
  });

  it('同义行头 (做什么/干了啥/价值) 也认', () => {
    const out = parseCardSummaryText('做什么: 修复登录限流\n价值: 防暴力破解');
    expect(out?.what).toBe('修复登录限流');
    expect(out?.why).toBe('防暴力破解');
  });

  it('超 96 字截断 (R190: 展示允许两行, cap 48→96)', () => {
    const out = parseCardSummaryText(`干啥: ${'长'.repeat(120)}\n有啥用: 测试`);
    expect(out?.what?.length).toBe(96);
    const ok = parseCardSummaryText(`干啥: ${'长'.repeat(90)}\n有啥用: 测试`);
    expect(ok?.what?.length).toBe(90); // 两行内不截
  });

  it('「(信息不足)」行当空, 两行全空 → null', () => {
    expect(parseCardSummaryText('干啥: (信息不足)\n有啥用: (信息不足)')).toBeNull();
  });

  it('解析不出两行 / 空输入 → null', () => {
    expect(parseCardSummaryText('模型跑题输出了一大段没有行头的话')).toBeNull();
    expect(parseCardSummaryText(null)).toBeNull();
    expect(parseCardSummaryText('')).toBeNull();
  });
});
