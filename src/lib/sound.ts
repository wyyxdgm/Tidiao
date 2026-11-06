// 功能: 用 Web Audio API 合成短促提示音, 用于任务待审核/工具审批提醒. 无需音频文件.
// 关注点: 浏览器 autoplay policy - AudioContext 首次可能 suspended, 需 resume();
//   SSR 安全 (无 window 时 no-op); 单例复用避免每次创建开销.

let audioCtx: AudioContext | null = null;

export function playNotifySound() {
  if (typeof window === "undefined") return;
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    // resume() is a no-op if already running; required after first user gesture.
    if (audioCtx.state === "suspended") audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    // 短促 beep, 带淡入淡出避免爆音
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    // 静默失败: 音频不可用不应影响功能
  }
}
