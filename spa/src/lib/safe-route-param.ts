/* 功能: 路由 param → 安全 id 字符串. 缺参 (undefined/空) 回空串.
   关注点: R198 修复 — keep-alive 复用组件时切到无该 param 的路由,
   String(undefined)="undefined" 会被拼进 /api/tasks/${id} 造成高频 404.
   调用方必须以空串为 falsy 信号 guard 掉请求. */
export function safeRouteParam(v: unknown): string {
  return v ? String(v) : '';
}
