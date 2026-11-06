// POST /api/user/media-key/test
// 解密用户 key + 用临时目录跑 `mmx auth login + mmx quota` 健康检查.
// 关注点:
//   - 临时目录 (mkdtempSync) 跑 mmx, 不污染用户 per-user MMX_CONFIG_DIR.
//   - 5s timeout, mmx 未安装 ENOENT 兜底返清晰错误.
//   - 鉴权走 x-user-id, 不接受 body 里的 key (防中继, 同 /api/user/notify-feishu/test).

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMediaKey } from "@/lib/db/media-keys";
import { decrypt } from "@/lib/crypto";

const MMX_TIMEOUT_MS = 8000;

/** Run `mmx <args>` in a temp MMX_CONFIG_DIR, capture stdout/stderr, 8s timeout. */
function runMmx(
  args: string[],
  configDir: string,
): Promise<{ ok: boolean; reason?: string; stdout?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("mmx", args, {
      env: { ...process.env, MMX_CONFIG_DIR: configDir },
    });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stdout += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, reason: `mmx ${args[0]} 超时 (${MMX_TIMEOUT_MS / 1000}s)` });
    }, MMX_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, reason: `mmx ${args[0]} 退出 ${code}: ${stdout.slice(-200)}` });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `mmx 未安装或无法启动: ${err.message}` });
    });
  });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = getMediaKey(userId);
  if (!row?.api_key_encrypted || !row.api_key_iv || !row.api_key_tag) {
    return NextResponse.json({ ok: false, reason: "未配置 API Key" });
  }

  let plaintext: string;
  try {
    plaintext = decrypt(row.api_key_encrypted, row.api_key_iv, row.api_key_tag);
  } catch {
    return NextResponse.json({ ok: false, reason: "解密失败 (ENCRYPTION_KEY 漂移?)" });
  }

  // 临时隔离目录, 跑 mmx auth login + mmx quota. 失败不影响用户目录.
  const tmpDir = mkdtempSync(join(tmpdir(), "mmx-test-"));
  try {
    const authResult = await runMmx(
      ["auth", "login", "--api-key", plaintext, "--region", row.region || "cn"],
      tmpDir,
    );
    if (!authResult.ok) {
      return NextResponse.json({ ok: false, reason: authResult.reason });
    }
    const quotaResult = await runMmx(["quota"], tmpDir);
    if (!quotaResult.ok) {
      return NextResponse.json({ ok: false, reason: quotaResult.reason });
    }
    return NextResponse.json({ ok: true, quota_stdout: quotaResult.stdout?.slice(0, 500) });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}