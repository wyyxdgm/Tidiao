// wiki mermaid 渲染支持 —— 检测 react-markdown 给 pre/code 元素的 props,
// 决定是不是 mermaid 代码块, 并提取源码.
//
// 风险点 (改前必读):
//   1. react-markdown v10 的 code 元素 className 形如 "language-mermaid" 或
//      ["language-mermaid"] (markdown-it 产物); remark-gfm 可能包额外类. 检测必须
//      兼容字符串 / 字符串数组 / 字符串数组里含 'language-mermaid' 三种形态.
//   2. mermaid 失败 / 空块 / null children 不能崩, 也不能返回误导性内容.
//   3. 本模块**不**调 mermaid 库本体, 只做 props → {isMermaid, code} 的解构. 实际
//      渲染由 wiki-client.tsx 的 MermaidBlock 在客户端 useEffect 里做 (避免 SSR 炸).

import type { ReactNode } from "react";

export interface CodeChildProps {
  className?: string | string[] | null | undefined;
  children?: ReactNode;
}

export interface MermaidDetection {
  // 是否为 mermaid 代码块.
  isMermaid: boolean;
  // 提取出的源码 (best-effort); 非 mermaid 块返回空串, 不要读.
  code: string;
}

// 功能: 把 react-markdown 的 code 元素 props 解出 className 数组.
// 关注点: 输入可能是 string / string[] / undefined / null; remark-gfm 给的通常是
//        字符串数组. 字符串时按空白拆, 与 markdown-it 数组形式保持等价.
export function classNameToArray(
  className: CodeChildProps["className"]
): string[] {
  if (Array.isArray(className)) return className.filter((c) => typeof c === "string");
  if (typeof className === "string") return className.split(/\s+/).filter(Boolean);
  return [];
}

// 功能: 检测 react-markdown 的 pre/code children 是否为 mermaid 块, 并提取源码.
// 关注点:
//  - child 是 undefined / null → 不是 mermaid, code 返回空串.
//  - children 不是字符串 (嵌套元素等) → 用 String() 强转, 但仅在判定为 mermaid 后
//    才读 code 字段, 避免普通代码块被误读.
//  - 这层**不**做兜底默认值, 调用方拿到 !isMermaid 时按原 children 渲染 (保留默认
//    react-markdown code/pre 样式).
export function detectMermaid(child: unknown): MermaidDetection {
  if (!child || typeof child !== "object") {
    return { isMermaid: false, code: "" };
  }
  const props = (child as { props?: CodeChildProps }).props;
  if (!props) return { isMermaid: false, code: "" };
  const classes = classNameToArray(props.className);
  if (!classes.includes("language-mermaid")) {
    return { isMermaid: false, code: "" };
  }
  const raw = props.children;
  const code = typeof raw === "string" ? raw : String(raw ?? "");
  return { isMermaid: true, code };
}