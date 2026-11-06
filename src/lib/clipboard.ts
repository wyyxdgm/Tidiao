// Clipboard utility with fallback for non-secure contexts (HTTP).
//
// navigator.clipboard.writeText() requires a secure context (HTTPS or
// localhost).  When accessed via plain HTTP (e.g. http://192.168.x.x:13000)
// the Clipboard API is unavailable or rejects.  We fall back to the
// legacy execCommand("copy") approach using a temporary textarea.

export async function copyToClipboard(text: string): Promise<void> {
  // Try the modern API first (works on HTTPS / localhost).
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback: create a temporary <textarea>, select, and execCommand("copy").
  // This works in non-secure contexts as long as the call originates from a
  // user gesture (click handler).
  const ta = document.createElement("textarea");
  ta.value = text;
  // Position off-screen so it doesn't flash.
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand('copy') returned false");
  } finally {
    document.body.removeChild(ta);
  }
}
