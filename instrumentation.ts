// Next.js instrumentation: runs once on server startup

export async function register() {
  // Initialize the AgentRuntime singleton
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntime } = await import("./src/lib/runtime/agent-runtime");
    const { getDb } = await import("./src/lib/db/index");
    const { seedBuiltinRules } = await import("./src/lib/db/rules");
    const { startScheduleRunner } = await import("./src/lib/runtime/schedule-runner");
    const { startWeixinWorker } = await import("./src/lib/intake/weixin-worker");
    getDb(); // Initialize database
    const runtime = getRuntime(); // Initialize runtime
    seedBuiltinRules(); // Idempotent - seeds §8 sample rule on first run
    // v33: 维护模式下不启动定时轮询 —— 否则 60s tick 会在关停期间造出新任务,
    // 正好绕过调度闸门想拦住的东西. 退出维护时 exitMaintenance() 会启动它.
    if (runtime.isMaintenanceActive()) {
      console.log("[Instrumentation] 维护模式生效中 — 跳过 schedule runner 启动");
    } else {
      startScheduleRunner(); // 60s poll for due schedules
    }
    // D3 (channel-qr-bind.md): 微信 iLink 长轮询 worker —— 只消费 enabled weixin
    // 渠道行, 无行时 tick 空转 (2s 一次 listChannelConfigs, 开销可忽略).
    // 与 telegram webhook 形态不同, 微信是唯一走轮询的渠道, 不受维护模式门控
    // (轮询本身不造任务, bind 命令才会, 与 webhook 渠道同口径).
    startWeixinWorker();
    console.log("[Instrumentation] AgentRuntime, database, and schedule runner initialized");
  }
}
