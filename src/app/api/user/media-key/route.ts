// GET/PUT/DELETE /api/user/media-key
// Per-user minimax mmx-cli API key + region. 加密存储, 返回脱敏.
// PUT "保存即生效": 存 DB 后 spawn `mmx auth login` 写到 per-user MMX_CONFIG_DIR,
// 这样 buildEnv() 注入 MMX_CONFIG_DIR 后 agent 子进程立刻能用.

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getMediaKey, upsertMediaKey, deleteMediaKey, toSafeMediaKey } from "@/lib/db/media-keys";
import { decrypt } from "@/lib/crypto";
import { ORCHESTRATOR_HOME } from "@/lib/constants";

const MMX_TIMEOUT_MS = 8000;

/** Per-user config dir = $ORCHESTRATOR_HOME/users/<userId>/.mmx.
 *  关注点: buildEnv() 把这个路径作为 MMX_CONFIG_DIR 注入 agent 子进程, 多用户
 *  同机不共享 ~/.mmx (避免串号). */
function userMmxConfigDir(userId: string): string {
  return path.join(ORCHESTRATOR_HOME, "users", userId, ".mmx");
}

/** Spawn `mmx auth login --api-key <key> --region <region>` in a specific MMX_CONFIG_DIR.
 *  关注点: mmx-cli 不读 MINIMAX_API_KEY env, 必须 --api-key flag; spawn 用独立 env
 *  MMX_CONFIG_DIR 隔离当前调用. 不抛错 — 失败返 reason 让 route 区分 mmx 不可用 vs 网络挂. */
function runMmxAuthLogin(
  apiKey: string,
  region: string,
  configDir: string,
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      "mmx",
      ["auth", "login", "--api-key", apiKey, "--region", region],
      { env: { ...process.env, MMX_CONFIG_DIR: configDir } },
    );
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stdout += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, reason: `mmx auth login 超时 (${MMX_TIMEOUT_MS / 1000}s)` });
    }, MMX_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: `mmx 退出 ${code}: ${stdout.slice(-200)}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `mmx 未安装或无法启动: ${err.message}` });
    });
  });
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const row = getMediaKey(userId);
  const safe = toSafeMediaKey(row);
  // 总是返 shape (即使未配) — 前端无需 null 分支
  return NextResponse.json(
    safe || {
      user_id: userId,
      api_key_masked: null,
      has_api_key: false,
      region: null,
    },
  );
}

export async function PUT(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const upsertData: Record<string, unknown> = {};
  if (body.api_key !== undefined) upsertData.api_key = body.api_key;
  if (body.clear_api_key === true) upsertData.clear_api_key = true;
  if (body.region !== undefined) upsertData.region = body.region || null;

  let row;
  try {
    row = upsertMediaKey(userId, upsertData);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // upsertMediaKey 在 region 不合法时 throw → 400 而非 500
    if (msg.startsWith("invalid region")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    throw err;
  }

  // 「保存即生效」分支: 用户提交了明文 key (非 clear) → 解密 + mmx auth login 写 config.json.
  // clear_api_key 走单独分支清掉 config.json 目录. region-only 修改不触发 mmx 写入.
  let mmxWarning: string | null = null;

  if (body.clear_api_key === true) {
    try {
      fs.rmSync(userMmxConfigDir(userId), { recursive: true, force: true });
    } catch {
      // 不存在/权限问题忽略
    }
  } else if (body.api_key !== undefined && row.api_key_encrypted && row.api_key_iv && row.api_key_tag) {
    let plaintext: string;
    try {
      plaintext = decrypt(row.api_key_encrypted, row.api_key_iv, row.api_key_tag);
    } catch {
      return NextResponse.json({
        ...toSafeMediaKey(row),
        mmx_warning: "解密失败, 无法写入 mmx 配置; 请重新输入 key",
      });
    }
    const configDir = userMmxConfigDir(userId);
    try {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(configDir, 0o700);
    } catch {
      // mkdir 失败不算 fatal — mmx auth login 自己也会 mkdir
    }
    const mmxStatus = await runMmxAuthLogin(
      plaintext,
      row.region || "cn",
      configDir,
    );
    if (!mmxStatus.ok) {
      mmxWarning = mmxStatus.reason ?? "mmx 写入失败";
    }
  }

  const safe = toSafeMediaKey(row);
  return NextResponse.json(mmxWarning ? { ...safe, mmx_warning: mmxWarning } : safe);
}

export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  deleteMediaKey(userId);
  // 顺手清掉 per-user config.json 目录
  try {
    fs.rmSync(userMmxConfigDir(userId), { recursive: true, force: true });
  } catch {
    // 不存在忽略
  }
  return NextResponse.json({ ok: true });
}