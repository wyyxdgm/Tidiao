// Board iframe srcdoc builder (R28).
//
// 功能: 把 AI 写的 body 包成一个 srcdoc, 注入 board-data 监听器 + CSP.
// 关注点:
//  - 必须独立成 .ts 文件, 因为 Vue SFC <script setup> 块不允许嵌入字符串
//    "<script>" 或 "</script>" (编译器会把它们当作新 SFC 块的开始/结束), 即使用
//    Unicode 转义 / 字符串拼接也躲不过 AST-level 的硬性检查.
//  - CSP connect-src 'none' 阻止 iframe 内 fetch 跨域 (数据只能来自 postMessage).
//  - script-src 'unsafe-inline' 是因为 AI 写的 HTML 可能直接含 <script> 标签.
//  - 默认样式 + 数据注入监听器在前, 业务 body 在后 —— 这样业务代码可以监听
//    'message'.
//  - 与 Next board-client.tsx buildSrcDoc 1:1 对等 (含 CSP / ResizeObserver /
//    postMessage 协议).

interface BuildSrcDocOptions {
  /** AI 写的原始 HTML body (frontmatter 之外的部分). */
  body: string;
  /** source 名称列表, 注入到 iframe 内 SOURCES 数组 (与 master frontmatter
     sources[].name 对齐). */
  sourceNames: string[];
}

export function buildBoardSrcDoc({ body, sourceNames }: BuildSrcDocOptions): string {
  const sourcesJson = JSON.stringify(sourceNames);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-src 'none';">
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#1f2937}h1,h2,h3{margin:0.4em 0}table{border-collapse:collapse}td,th{border:1px solid #e5e7eb;padding:4px 8px;font-size:13px}pre{background:#f3f4f6;padding:8px;border-radius:4px;overflow:auto;font-size:12px}.err{color:#dc2626}</style>
</head><body>
<div id="__board_pending__">加载中…</div>
<script>
(function(){
  var SOURCES = ${sourcesJson};
  window.__DATA__ = {};
  window.__ERRORS__ = {};
  window.__META__ = {};
  window.addEventListener('message', function(e){
    if (!e.data || e.data.type !== 'board-data') return;
    window.__DATA__ = e.data.data || {};
    window.__ERRORS__ = e.data.errors || {};
    window.__META__ = e.data.meta || {};
    var pending = document.getElementById('__board_pending__');
    if (pending) pending.remove();
    if (window.__renderBoard) window.__renderBoard();
  });
  function notify(){
    var h = document.documentElement.scrollHeight;
    parent.postMessage({type:'board-resize', height: h}, '*');
  }
  new ResizeObserver(notify).observe(document.documentElement);
  setTimeout(notify, 100);
  setTimeout(notify, 500);
})();
</script>
${body}
</body></html>`;
}