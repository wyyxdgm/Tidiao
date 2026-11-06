import { describe, expect, it } from 'vitest';
import { pickDefaultVersionId } from './version-default';

/** 回归背景 (damo 2026-10-27 反馈): 全局看板「+创建任务」弹窗第一次打开选中的
    是第一个版本而非默认版本. 根因 = 旧代码用 versions[].is_current 判默认版本,
    但 versions 表没这列 (R56-B22 同款坑) → 永远 fallback 到 versions[0].
    权威源 = projects.current_version_id. */

const versions = [
  { id: 'v-aaa' }, // name 排序第一 (后端 ORDER BY name ASC)
  { id: 'v-bbb' },
  { id: 'v-ccc' }, // 项目 current 版本
];

describe('pickDefaultVersionId', () => {
  it('外部预选在列表中 → 选预选 (项目看板/版本详情场景)', () => {
    expect(
      pickDefaultVersionId(versions, { preferVersionId: 'v-aaa', currentVersionId: 'v-ccc' }),
    ).toBe('v-aaa');
  });

  it('无预选 → 选项目 current_version_id (回归: is_current 列不存在时的正确判定)', () => {
    expect(pickDefaultVersionId(versions, { currentVersionId: 'v-ccc' })).toBe('v-ccc');
  });

  it('旧数据形态回归: versions 条目无 is_current 字段也不影响 current 判定', () => {
    // 真实 API 返回的 versions 没有 is_current; 旧代码 find(v => v.is_current === 1)
    // 永远 undefined → 选了 v-aaa. 新逻辑直接吃 currentVersionId 参数, 与条目字段无关.
    expect(pickDefaultVersionId(versions, { currentVersionId: 'v-ccc' })).not.toBe('v-aaa');
  });

  it('current 不在列表中 (已删/已切) → fallback 第一个', () => {
    expect(pickDefaultVersionId(versions, { currentVersionId: 'v-gone' })).toBe('v-aaa');
  });

  it('预选与 current 都缺 → 第一个', () => {
    expect(pickDefaultVersionId(versions)).toBe('v-aaa');
  });

  it('列表空 → 不挂版本哨兵 ""', () => {
    expect(pickDefaultVersionId([], { currentVersionId: 'v-ccc' })).toBe('');
  });

  it('null/undefined 预选与 current 等价于缺省', () => {
    expect(
      pickDefaultVersionId(versions, { preferVersionId: null, currentVersionId: null }),
    ).toBe('v-aaa');
  });
});
