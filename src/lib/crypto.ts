// AES-256-GCM encryption for sensitive values (API keys).
// Key source: ENCRYPTION_KEY env var (32-byte hex), or derived from JWT_SECRET via scrypt.

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const SALT = "agent-orchestrator-llm-config";

function getKey(): Buffer {
  if (process.env.ENCRYPTION_KEY) {
    return Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  }
  // Derive from JWT_SECRET (always available in production).
  // If JWT_SECRET changes, previously encrypted values become undecryptable.
  const secret = process.env.JWT_SECRET || "insecure-dev-secret-change-me";
  return scryptSync(secret, SALT, 32);
}

export interface EncryptedValue {
  encrypted: string; // hex-encoded ciphertext
  iv: string;        // hex-encoded initialization vector
  tag: string;       // hex-encoded GCM auth tag
}

export function encrypt(plaintext: string): EncryptedValue {
  const key = getKey();
  const iv = randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

export function decrypt(encrypted: string, iv: string, tag: string): string {
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Mask an API key for display: first 4 + "..." + last 3 chars.
 *  Short keys (< 8 chars) get "***...***". */
export function maskApiKey(key: string): string {
  if (key.length < 8) return "***...***";
  return key.slice(0, 4) + "..." + key.slice(-3);
}
