// minimax 全模态平台 mmx-cli API Key 配置 — per-user 加密存储.
//
// 关注点:
//   - mmx-cli **不读** MINIMAX_API_KEY env. 凭据来源只有两条:
//     (1) `mmx auth login --api-key <KEY>` 写进 $MMX_CONFIG_DIR/config.json (明文);
//     (2) 命令行 --api-key flag.
//   - 所以平台做的是: 加密存 + buildEnv() 注入 MMX_CONFIG_DIR (用户隔离目录) +
//     settings 保存时由 API 端 mmx auth login 把明文落到该目录.
//   - 不做 admin 级共享: mmx-cli 是付费 API + per-user 配额, admin 共享会让
//     单用户用量被多人分摊且审计不到. YAGNI. 后续真要加照搬 llm-configs.ts 的
//     owner_type 三态 + isUserGrantedAdminMedia() 双层.
//   - 解密失败: 返 '*** (解密失败, 请重新输入)' 警告态, 同 llm-configs.ts:222.
//
// R120 责任边界 (damo 0829 拍板 = 候选 B 注释半拆):
//   - **mmx CLI 调用本身** = partner 仓 scripts/mmx-call.sh 负责 (token/费用跟踪走
//     minimax-calls.jsonl + minimax-quota-history.jsonl, 见 R119 A 方案).
//   - **结果收口** = 本仓负责: per-user API key 加密存储 + agent-runtime.ts:1078
//     emitAttachment 入口 + /api/tasks/[id]/agent-attachments 注册端点 (R121 P1/P2
//     已在 master 落地 + 三实例部署).
//   - **后续 cost/token 落 attachment metadata**: 见 docs/plans/r121-agent-generated-attachments-design.md
//     §3 "token/费用落 attachment metadata".
//   - **本仓不重复实现 mmx 调用 wrapper**: 任何本仓代码调 mmx 都要先评估"是否应回
//     partner 仓" —— 这是跨仓协调的反向引用。

import { getDb } from "./index";
import { encrypt, decrypt, maskApiKey } from "../crypto";

export interface MediaKey {
  user_id: string;
  api_key_encrypted: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  region: string | null; // 'cn' | 'global' | null (未配 region 时 fallback 'cn')
  created_at: string;
  updated_at: string;
}

/** Safe shape returned to the frontend — never exposes encrypted key. */
export interface MediaKeySafe {
  user_id: string;
  api_key_masked: string | null; // null = 未配; 'sk-...xyz' = 配了并解密成功; '*** (解密失败, 请重新输入)' = 警告态
  has_api_key: boolean;
  region: string | null;
}

/** Input for upsert. `api_key` is plaintext — it will be encrypted before storage. */
export interface UpsertMediaKeyInput {
  api_key?: string; // plaintext, will be encrypted; omit to keep existing
  clear_api_key?: boolean; // true to delete the stored key (encrypted/iv/tag all set NULL)
  region?: string | null; // 'cn' | 'global' | null (clear)
}

const VALID_REGIONS = new Set(["cn", "global"]);

// ---- CRUD ----

export function getMediaKey(userId: string): MediaKey | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM user_media_keys WHERE user_id = ?`)
    .get(userId) as MediaKey | undefined;
  return row ?? null;
}

export function upsertMediaKey(userId: string, data: UpsertMediaKeyInput): MediaKey {
  // Validate region if explicitly provided (null = clear, undefined = keep, string = set)
  if (data.region !== undefined && data.region !== null && !VALID_REGIONS.has(data.region)) {
    throw new Error(`invalid region: ${data.region}; expected cn|global|null`);
  }

  const db = getDb();
  const existing = getMediaKey(userId);

  // Resolve encrypted key fields: three-state (clear / keep / update)
  let apiKeyEncrypted: string | null = existing?.api_key_encrypted ?? null;
  let apiKeyIv: string | null = existing?.api_key_iv ?? null;
  let apiKeyTag: string | null = existing?.api_key_tag ?? null;

  if (data.clear_api_key) {
    apiKeyEncrypted = null;
    apiKeyIv = null;
    apiKeyTag = null;
  } else if (data.api_key !== undefined) {
    const enc = encrypt(data.api_key);
    apiKeyEncrypted = enc.encrypted;
    apiKeyIv = enc.iv;
    apiKeyTag = enc.tag;
  }

  // Region: explicit null = clear; undefined = keep; string = set
  let region: string | null;
  if (data.region === undefined) {
    region = existing?.region ?? null;
  } else {
    region = data.region;
  }

  if (existing) {
    db.prepare(`
      UPDATE user_media_keys
      SET api_key_encrypted = ?, api_key_iv = ?, api_key_tag = ?,
          region = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(apiKeyEncrypted, apiKeyIv, apiKeyTag, region, userId);
  } else {
    db.prepare(`
      INSERT INTO user_media_keys
        (user_id, api_key_encrypted, api_key_iv, api_key_tag, region)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, apiKeyEncrypted, apiKeyIv, apiKeyTag, region);
  }

  return getMediaKey(userId)!;
}

export function deleteMediaKey(userId: string): boolean {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM user_media_keys WHERE user_id = ?`)
    .run(userId);
  return result.changes > 0;
}

// ---- Safe conversion ----

/** Convert a raw row into the safe shape for the frontend.
 *  Never exposes the encrypted key or its components.
 *  If decryption fails (e.g. ENCRYPTION_KEY changed since storage), returns a warning marker. */
export function toSafeMediaKey(row: MediaKey | null): MediaKeySafe | null {
  if (!row) return null;

  let apiKeyMasked: string | null = null;
  let hasApiKey = false;

  if (row.api_key_encrypted && row.api_key_iv && row.api_key_tag) {
    try {
      const plaintext = decrypt(row.api_key_encrypted, row.api_key_iv, row.api_key_tag);
      apiKeyMasked = maskApiKey(plaintext);
      hasApiKey = true;
    } catch {
      // ENCRYPTION_KEY 漂移 / 文件损坏. UI 警告态提示重新输入, 不抛错.
      apiKeyMasked = "*** (解密失败, 请重新输入)";
      hasApiKey = true;
    }
  }

  return {
    user_id: row.user_id,
    api_key_masked: apiKeyMasked,
    has_api_key: hasApiKey,
    region: row.region,
  };
}