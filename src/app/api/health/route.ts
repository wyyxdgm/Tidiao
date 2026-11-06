// GET /api/health - 极轻存活探针, 供 SPA 呼吸点 (BackendBreathDot) 轮询.
// 返回 200 { ok: true } = Next 进程活着且能响应请求.
// 关注点: 故意不碰 DB / runtime —— 判据是「服务后台可用」(进程 + HTTP 栈),
// 依赖越少误报越少; DB 故障会从业务 API 层暴露, 不混进这个信号.
// 关注点 2: 不用 Response.json() —— 静态方法需 TS 5.1+, 本仓 5.0.2 编译直接挂
// (2026-10-04 部署实测), 用 new Response(JSON.stringify(...)) 同语义.
export async function GET() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
