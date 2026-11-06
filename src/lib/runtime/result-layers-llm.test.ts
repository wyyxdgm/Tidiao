import { describe, expect, it } from 'vitest';
import { parseResultLayersText } from './result-layers-llm';

/* parseResultLayersText 纯函数单测 (SDK 路径已由 llm-summarize.test.ts 契约覆盖,
   这里只锁「模型输出 → 两段分层」的解析容错). R190, damo 1004 飞书拍板. */

describe('parseResultLayersText', () => {
  it('标准标记格式直取', () => {
    const raw = [
      '【概览】',
      '先查了现状, 然后改了弹窗组件, 最后跑了测试全过。',
      '',
      '【核心细节】',
      '• 定位到 ConsoleCanvas.vue 弹窗正文一坨 result',
      '• 新增 LLM 分层总结模块, 输出概览+细节两级',
      '• 单测 8 条全绿',
    ].join('\n');
    const out = parseResultLayersText(raw);
    expect(out?.brief).toContain('改了弹窗组件');
    expect(out?.details).toHaveLength(3);
    expect(out?.details[0]).toBe('定位到 ConsoleCanvas.vue 弹窗正文一坨 result');
  });

  it('容忍 markdown 噪音 (加粗/标题符/引号)', () => {
    const raw = '## 【概览】\n**修好了部署脚本**, 让「重启」不再继承脏 env。\n【核心细节】\n- 用 `maintenance.sh` 清 env 重启\n';
    const out = parseResultLayersText(raw);
    expect(out?.brief).toContain('修好了部署脚本');
    expect(out?.details[0]).toBe('用 maintenance.sh 清 env 重启');
  });

  it('概览多行粘成一段', () => {
    const raw = '【概览】\n第一句话。\n第二句话。\n第三句话。\n【核心细节】\n• 条目\n';
    const out = parseResultLayersText(raw);
    expect(out?.brief).toBe('第一句话。第二句话。第三句话。');
  });

  it('bullet 变体全认 (数字/横线/圆点/中文顿号)', () => {
    const raw = '【概览】\n做了事。\n【核心细节】\n1. 第一条\n- 第二条\n· 第三条\n2、第四条\n';
    const out = parseResultLayersText(raw);
    expect(out?.details).toEqual(['第一条', '第二条', '第三条', '第四条']);
  });

  it('无 bullet 续行粘到上一条', () => {
    const raw = '【概览】\n做了事。\n【核心细节】\n• 主条目\n  补充说明文字\n• 下一条\n';
    const out = parseResultLayersText(raw);
    expect(out?.details[0]).toBe('主条目 补充说明文字');
    expect(out?.details[1]).toBe('下一条');
  });

  it('details 无 bullet 整段也收 (首行当第一条)', () => {
    const raw = '【概览】\n做了事。\n【核心细节】\n改了配置文件让服务识别新字段, 重启后生效。\n';
    const out = parseResultLayersText(raw);
    expect(out?.details[0]).toContain('改了配置文件');
  });

  it('单条超 500 字截断但不加省略号 (damo 1007: 「…」= 总结不到位)', () => {
    const raw = `【概览】\n做了事。\n【核心细节】\n• ${'长'.repeat(300)}\n`;
    const out = parseResultLayersText(raw);
    expect(out?.details[0]?.length).toBe(300); // 300 < 500 cap, 原样保留
    const raw2 = `【概览】\n做了事。\n【核心细节】\n• ${'长'.repeat(600)}\n`;
    const out2 = parseResultLayersText(raw2);
    expect(out2?.details[0]?.length).toBe(500);
    expect(out2?.details[0]?.endsWith('…')).toBe(false);
  });

  it('【下一步】段: 有后续取一行, 「无」归空', () => {
    const raw = '【概览】\n做了事。\n【核心细节】\n• 条目\n【下一步】\n部署到 ao-prod 后观察一天日志。\n';
    const out = parseResultLayersText(raw);
    expect(out?.next).toBe('部署到 ao-prod 后观察一天日志。');
    const out2 = parseResultLayersText('【概览】\n做了事。\n【核心细节】\n• 条目\n【下一步】\n无\n');
    expect(out2?.next).toBe('');
  });

  it('缺【下一步】段 → next 空串, 不影响返回', () => {
    const out = parseResultLayersText('【概览】\n做了事。\n【核心细节】\n• 条目\n');
    expect(out?.next).toBe('');
  });

  it('「(信息不足)」当空; 两段全空 → null', () => {
    expect(parseResultLayersText('【概览】\n(信息不足)\n【核心细节】\n')).toBeNull();
    expect(parseResultLayersText(null)).toBeNull();
    expect(parseResultLayersText('')).toBeNull();
  });

  it('缺【核心细节】段只有概览 → 有值就返回', () => {
    const out = parseResultLayersText('【概览】\n只写了概览。');
    expect(out?.brief).toBe('只写了概览。');
    expect(out?.details).toEqual([]);
  });

  it('标记前寒暄段丢弃, 不混进概览', () => {
    const raw = '好的, 以下是总结:\n【概览】\n正事。\n【核心细节】\n• 条目\n';
    const out = parseResultLayersText(raw);
    expect(out?.brief).toBe('正事。');
  });
});
