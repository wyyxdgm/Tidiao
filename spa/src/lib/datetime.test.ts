/* 功能: datetime 纯函数单测 — SQLite UTC 串解析口径 + 卡片短格式.
   关注点: 期望值用 Z 形态 ISO 独立推导 (非循环引用被测函数), 任意时区跑都成立. */

import { describe, expect, it } from 'vitest';
import { formatShortDateTime, parseDbTime } from './datetime';

describe('parseDbTime', () => {
  it('SQLite "YYYY-MM-DD HH:MM:SS" 当 UTC 解析 (补 Z), 与 Z 形态同一时刻', () => {
    expect(parseDbTime('2026-10-05 06:30:00')?.getTime()).toBe(
      Date.parse('2026-10-05T06:30:00Z'),
    );
  });

  it('已带 Z / 含 T 的 ISO 直接解析; 非法 / 缺省 → null', () => {
    expect(parseDbTime('2026-10-05T06:30:00Z')?.getTime()).toBe(
      Date.parse('2026-10-05T06:30:00Z'),
    );
    expect(parseDbTime(null)).toBeNull();
    expect(parseDbTime('')).toBeNull();
    expect(parseDbTime('not-a-date')).toBeNull();
  });
});

describe('formatShortDateTime', () => {
  it('输出本地时区 "MM-DD HH:mm" (与 Z 形态经本地访问器推导一致)', () => {
    const d = new Date('2026-10-05T06:30:00Z');
    const pad = (n: number): string => String(n).padStart(2, '0');
    const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatShortDateTime('2026-10-05 06:30:00')).toBe(expected);
    expect(formatShortDateTime('2026-10-05T06:30:00Z')).toBe(expected);
  });

  it('非法 / 缺省 → 空串 (调用方 v-if 隐藏, 不渲染占位)', () => {
    expect(formatShortDateTime(null)).toBe('');
    expect(formatShortDateTime(undefined)).toBe('');
    expect(formatShortDateTime('not-a-date')).toBe('');
  });
});
