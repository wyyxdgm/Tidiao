// 安全解析 JSON 编码的字符串数组列（tasks/schedules 的 tags、allowed_tools）。
// 这些列设计上存 JSON 数组字符串（'["a","b"]'），但历史上有通过裸 API 传入
// 逗号分隔字符串（"a,b"）再被 JSON.stringify 成 '"a,b"' 的脏数据，导致下游
// .map() 崩溃。本模块在读取处兜底：非数组值按逗号分隔愈合为 string[]。

// 功能: 把任意 JS 值规整成 string[]。数组保留(元素转字符串)；非空字符串按逗号分隔；其余返回 []。
export function coerceStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// 功能: 解析 DB 列的 JSON 字符串为 string[]，容忍非数组脏数据，永不抛异常。
export function parseStrArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return coerceStrArray(JSON.parse(raw));
  } catch {
    // 不是合法 JSON —— 当作裸逗号分隔字符串处理。
    return coerceStrArray(raw);
  }
}

// 功能: 把任意 JS 值规整成可入库的 JSON 数组字符串，空数组返回 null。
export function stringifyStrArray(v: unknown): string | null {
  const arr = coerceStrArray(v);
  return arr.length ? JSON.stringify(arr) : null;
}
