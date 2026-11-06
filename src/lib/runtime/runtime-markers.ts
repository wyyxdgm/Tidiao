// 运行时 marker 清洗 — agent 汇报文本里穿插的内部标记 (`<checkpoint step=N summary="..."/>` /
// `<awaiting .../>` / `<git commit-id="..."/>`) 是给 runtime 解析用的管线符号, 不该出现在
// 面向用户的任何表面: tasks.result 落库 / 摘要类 LLM 输入 (result-layers / card-summary /
// 标题自动命名) / 前端原文兜底展示 (存量任务 DB 里已带标签, 落库清洗管不到).
//
// 只剥标签本身, 不动其余文本; checkpoint/awaiting 的解析都在 active-session 的活文本
// 路径上 (parseCheckpointsInBlock / parseAwaitingMarkersInBlock), 与本清洗互不影响.

const RUNTIME_TAG_RES = [
  /<checkpoint\b[^>]*\/?>/g, // <checkpoint step=N summary="..." by="..." status="..."/>
  /<awaiting\b[^>]*\/?>/g, // <awaiting type="..." .../> / <awaiting clear/>
  /<git\b[^>]*\/?>/g, // <git commit-id="..."/>
];

// 功能: 剥掉文本里的运行时 marker 标签, 压掉剥完后产生的连续空行, 返回清洗后文本.
// 关注点: 只处理字符串入参 (null/undefined/非字符串原样返回空 — 调用点在 reviewing
//   关键路径上, 宁可返回空也不抛); 只剥已知三类标签, 不做通用 XML 清洗 (避免误伤
//   正文里的泛指文本); 连续 3+ 空行压成 1 个空行.
export function stripRuntimeMarkers(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  let out = text;
  for (const re of RUNTIME_TAG_RES) out = out.replace(re, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
