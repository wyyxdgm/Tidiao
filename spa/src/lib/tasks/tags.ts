// 任务标签命名空间约定 (R122 / T1.1):
//   存储位置: tasks.tags JSON 数组列, 已存在 schema (不动).
//   命名空间: dim:* (维度) / mod:* (模块) / req:* (需求).
//   写入约定: 项目 partner / agent 落标签时按本命名空间加前缀, 读取时按前缀归类.
//   本模块只做归类 / 重组 / 增量, 不改 tasks 表 schema, 不走 metadata 通道.

import { parseStrArray } from "../json-array";

// 命名空间常量. 不要把这三个值散落出去当作字符串字面量.
export const TAG_PREFIX = {
  dimension: "dim:",
  module: "mod:",
  requirement: "req:",
} as const;

export type TagKind = keyof typeof TAG_PREFIX;

export const TAG_KINDS: readonly TagKind[] = ["dimension", "module", "requirement"] as const;

// 命名空间 → 简称 (用于 addTag 入参, 紧凑).
export type TagKindShort = "dim" | "mod" | "req";

const SHORT_TO_KIND: Record<TagKindShort, TagKind> = {
  dim: "dimension",
  mod: "module",
  req: "requirement",
};

export interface ParsedTags {
  dimensions: string[];
  modules: string[];
  requirements: string[];
}

// 功能: 把 tasks.tags 的 JSON 字符串拆成三类, 各去前缀 + 去重 + 排序, 保留顺序稳定.
// 关注点: 入参容错 parseStrArray 已做 (脏数据/空/null 都不会抛); 任何不以三类前缀开头的标签
//          归入 dimensions 桶作为"未分类"占位 (上游应自觉加前缀, 不该混进无前缀标签).
export function parseTags(tags: string | null | undefined): ParsedTags {
  const arr = parseStrArray(tags);
  const dimensions: string[] = [];
  const modules: string[] = [];
  const requirements: string[] = [];
  const seen = new Set<string>();

  for (const raw of arr) {
    if (!raw) continue;
    let bucket: string[] | null = null;
    let stripped = raw;
    if (raw.startsWith(TAG_PREFIX.dimension)) {
      bucket = dimensions;
      stripped = raw.slice(TAG_PREFIX.dimension.length);
    } else if (raw.startsWith(TAG_PREFIX.module)) {
      bucket = modules;
      stripped = raw.slice(TAG_PREFIX.module.length);
    } else if (raw.startsWith(TAG_PREFIX.requirement)) {
      bucket = requirements;
      stripped = raw.slice(TAG_PREFIX.requirement.length);
    } else {
      // 未分类: 把整条裸标签塞 dimensions, 让上层看到"还有未分类的".
      bucket = dimensions;
      stripped = raw;
    }
    if (!stripped) continue;
    const key = `${bucket === dimensions ? "dim" : bucket === modules ? "mod" : "req"}:${stripped}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bucket.push(stripped);
  }
  return { dimensions, modules, requirements };
}
