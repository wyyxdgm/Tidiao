import { describe, expect, it } from 'vitest';
import { safeRouteParam } from './safe-route-param';

/* R198 回归: /api/tasks/undefined 404 — String(undefined) 被拼进请求路径.
   约束: 任何 falsy param 必须回空串, 绝不产生 "undefined"/"null" 字符串. */
describe('safeRouteParam', () => {
  it('有效 id 原样返回字符串', () => {
    const id = '2fd73bef-28d3-4ff8-ba2d-4e7b84a7b815';
    expect(safeRouteParam(id)).toBe(id);
  });

  it('undefined 回空串 (不产生 "undefined")', () => {
    expect(safeRouteParam(undefined)).toBe('');
  });

  it('null 回空串', () => {
    expect(safeRouteParam(null)).toBe('');
  });

  it('空串回空串', () => {
    expect(safeRouteParam('')).toBe('');
  });

  it('结果永不等于 "undefined" 或 "null" 字符串', () => {
    for (const v of [undefined, null, '', 0, false]) {
      const out = safeRouteParam(v);
      expect(out === 'undefined' || out === 'null').toBe(false);
    }
  });
});
