/* 功能: 复制文本到剪贴板, 自动选择 navigator.clipboard (现代/HTTPS) 或
   降级到 textarea + execCommand (非 secure context, 例如 HTTP 内网 IP).

   关注点:
   - navigator.clipboard.writeText 需要 secure context (HTTPS 或 localhost).
     开发环境走 Vite proxy (localhost:13000) 是 secure; 但生产部署若走
     http://内网IP:13000 则会失败. 降级路径用临时 textarea + execCommand,
     在用户点击触发下能成功 (老 API 不受 secure context 限制).
   - 不抛错: 失败时 Promise reject 抛 Error, 由调用方 (toast) 兜底. */

export async function copyToClipboard(text: string): Promise<void> {
  // 1. 现代 API: secure context (HTTPS / localhost) 走 navigator.clipboard.
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // 2. 降级路径: 临时 textarea + execCommand. 必须在用户手势 (click handler)
  // 内调用, 否则浏览器会拒.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error("execCommand('copy') returned false");
  } finally {
    document.body.removeChild(ta);
  }
}