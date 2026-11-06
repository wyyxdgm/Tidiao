/* 功能: confirmTextFromLabel 单测 — 回归 R213 (确认按钮文案被 \w 正则吃空).
   关注点: 用例直接锚定「纯中文 label 必须原样保留」这条不变量, 防有人改回 \w. */

import { describe, expect, it } from 'vitest';
import { confirmTextFromLabel } from './confirm-label';

describe('confirmTextFromLabel', () => {
  it('纯中文 label 原样保留 (R213 回归: 删除 / 取消不能被吃空)', () => {
    expect(confirmTextFromLabel('删除')).toBe('删除');
    expect(confirmTextFromLabel('取消')).toBe('取消');
    expect(confirmTextFromLabel('清空重来')).toBe('清空重来');
  });

  it('剥掉前导 emoji / 箭头 / 空白, 保留后面的中文', () => {
    expect(confirmTextFromLabel('▶ 继续干')).toBe('继续干');
    expect(confirmTextFromLabel('🗑 删除')).toBe('删除');
    expect(confirmTextFromLabel('  暂停')).toBe('暂停');
  });

  it('字母 / 数字 label 也不被剥', () => {
    expect(confirmTextFromLabel('OK')).toBe('OK');
    expect(confirmTextFromLabel('  OK  ')).toBe('OK  ');
  });

  it('空串 / 全符号 → 空串 (不抛)', () => {
    expect(confirmTextFromLabel('')).toBe('');
    expect(confirmTextFromLabel('★☆')).toBe('');
  });
});
