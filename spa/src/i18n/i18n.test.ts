// 功能: i18n 不变量测试 — en-US 与 zh-CN 的 key 集合必须一致 (新增文案 zh/en 两份同步,
//   W2+ 派发波次照抄样板时漏写另一半会被这里拦住).
import { describe, it, expect } from 'vitest';
import { locales } from './index';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      keys.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

describe('i18n locales', () => {
  it('存在 zh-CN 与 en-US 两个语言包', () => {
    expect(Object.keys(locales)).toContain('zh-CN');
    expect(Object.keys(locales)).toContain('en-US');
  });

  it('en-US 与 zh-CN 的 key 集合一致 (不缺不漏)', () => {
    const zh = flattenKeys(locales['zh-CN'] as Record<string, unknown>).sort();
    const en = flattenKeys(locales['en-US'] as Record<string, unknown>).sort();
    expect(en).toEqual(zh);
  });
});
