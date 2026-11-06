// weixin-asr 单测: 格式嗅探 + silk→wav 转码 + key 解析 + 转写降级.
// fetch 全 mock (不真连 ASR); silk 转码用 silk-wasm 真实 roundtrip (encode→decode).

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encode as silkEncode, isSilk } from "silk-wasm";
import { resolveAsrApiKey, toAsrUpload, transcribeAudio, _resetAsrKeyCacheForTest } from "./weixin-asr";
import { closeDb, getDb } from "../db/index";
import { encrypt } from "../crypto";
import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// toAsrUpload 格式嗅探
// ---------------------------------------------------------------------------

describe("toAsrUpload", () => {
  it("silk 字节 → wav (真实 silk-wasm roundtrip)", async () => {
    // 造 1s 440Hz 正弦 pcm s16le 24k → silk → 走嗅探转码
    const pcm = Buffer.alloc(24_000 * 2);
    for (let i = 0; i < 24_000; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 3000), i * 2);
    }
    const enc = await silkEncode(pcm, 24_000);
    expect(isSilk(enc.data)).toBe(true);
    const out = await toAsrUpload(Buffer.from(enc.data));
    expect(out?.mime).toBe("audio/wav");
    expect(out?.filename).toBe("voice.wav");
    // wav 头校验
    expect(out!.buf.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(out!.buf.subarray(8, 12).toString("latin1")).toBe("WAVE");
    // 44 头 + pcm
    expect(out!.buf.byteLength).toBe(44 + Number(out!.buf.readUInt32LE(40)));
  });

  it("微信形态 \\x02 前缀 silk (encode 原生产物) 正常识别", async () => {
    const pcm = Buffer.alloc(24_000 * 2);
    const enc = await silkEncode(pcm, 24_000);
    // silkEncode 输出自带 \x02#!SILK_V3 微信形态头, 直接过嗅探
    expect(Buffer.from(enc.data)[0]).toBe(0x02);
    const out = await toAsrUpload(Buffer.from(enc.data));
    expect(out?.mime).toBe("audio/wav");
  });

  it("无 \\x02 前缀的裸 silk → 自动补前缀解码 (silk-wasm 要求微信形态)", async () => {
    const pcm = Buffer.alloc(24_000 * 2);
    const enc = await silkEncode(pcm, 24_000);
    const bare = Buffer.from(enc.data).subarray(1); // 剥掉 0x02 → 裸 #!SILK_V3
    expect(bare[0]).toBe(0x23);
    const out = await toAsrUpload(bare);
    expect(out?.mime).toBe("audio/wav");
  });

  it("wav 直传不改写", async () => {
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    const out = await toAsrUpload(wav);
    expect(out?.buf).toBe(wav);
    expect(out?.mime).toBe("audio/wav");
  });

  it("mp3 (ID3 头) 直传", async () => {
    const mp3 = Buffer.alloc(64);
    mp3.write("ID3", 0);
    const out = await toAsrUpload(mp3);
    expect(out?.mime).toBe("audio/mpeg");
  });

  it("amr / 未知格式 → null (走兜底话术)", async () => {
    const amr = Buffer.alloc(64);
    amr.write("#!AMR\n", 0);
    expect(await toAsrUpload(amr)).toBeNull();
    expect(await toAsrUpload(Buffer.alloc(8, 0xaa))).toBeNull();
    expect(await toAsrUpload(Buffer.alloc(4))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAsrApiKey
// ---------------------------------------------------------------------------

describe("resolveAsrApiKey", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-weixin-asr-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();
    _resetAsrKeyCacheForTest();
  });

  afterEach(() => {
    closeDb();
    delete process.env.ORCHESTRATOR_DB_PATH;
    delete process.env.WEIXIN_ASR_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertLlmConfig(name: string, baseUrl: string, apiKey: string | null): void {
    getDb()
      .prepare(
        `INSERT INTO llm_configs (id, owner_type, owner_id, name, type, api_key_encrypted, api_key_iv, api_key_tag, base_url, model, is_default, created_at, updated_at)
         VALUES (?, 'user', 'u1', ?, 'anthropic', ?, ?, ?, ?, 'm', 0, datetime('now'), datetime('now'))`,
      )
      .run(
        `lc-${name}`,
        name,
        ...(apiKey
          ? (() => {
              const e = encrypt(apiKey);
              return [e.encrypted, e.iv, e.tag];
            })()
          : [null, null, null]),
        baseUrl,
      );
  }

  it("env WEIXIN_ASR_API_KEY 优先", () => {
    process.env.WEIXIN_ASR_API_KEY = "env-key";
    insertLlmConfig("bigmodel", "https://open.bigmodel.cn/api/anthropic", "db-key");
    expect(resolveAsrApiKey()).toBe("env-key");
  });

  it("无 env → DB bigmodel 配置解密兜底", () => {
    insertLlmConfig("bigmodel", "https://open.bigmodel.cn/api/anthropic", "db-key-1");
    expect(resolveAsrApiKey()).toBe("db-key-1");
  });

  it("DB 无 bigmodel 配置 → null (语音走兜底)", () => {
    insertLlmConfig("deepseek", "https://api.deepseek.com/anthropic", "other-key");
    expect(resolveAsrApiKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// transcribeAudio (mock fetch)
// ---------------------------------------------------------------------------

describe("transcribeAudio", () => {
  // 钉死 endpoint/model: 部署给服务配的 WEIXIN_ASR_* env (如 ao-prod MiniMax 覆盖)
  // 会泄漏进 vitest 进程, 不钉则默认端点断言随部署环境漂移 (2026-10-25 实证).
  const savedEndpoint = process.env.WEIXIN_ASR_ENDPOINT;
  const savedModel = process.env.WEIXIN_ASR_MODEL;

  beforeEach(() => {
    _resetAsrKeyCacheForTest();
    process.env.WEIXIN_ASR_API_KEY = "test-key";
    delete process.env.WEIXIN_ASR_ENDPOINT;
    delete process.env.WEIXIN_ASR_MODEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.WEIXIN_ASR_API_KEY;
    if (savedEndpoint !== undefined) process.env.WEIXIN_ASR_ENDPOINT = savedEndpoint;
    if (savedModel !== undefined) process.env.WEIXIN_ASR_MODEL = savedModel;
  });

  it("转写成功: whisper 兼容 multipart → text", async () => {
    let captured: { url: string; auth: string; model: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const form = init!.body as FormData;
        captured = { url: String(url), auth: (init!.headers as any).Authorization, model: String(form.get("model")) };
        return jsonResponse({ text: " 明天三点开会 " });
      }),
    );
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    expect(await transcribeAudio(wav)).toBe("明天三点开会");
    expect(captured!.url).toContain("/audio/transcriptions");
    expect(captured!.auth).toBe("Bearer test-key");
    expect(captured!.model).toBe("glm-asr");
  });

  it("env 覆盖 endpoint/model (MiniMax 形态, 生产当前配置)", async () => {
    process.env.WEIXIN_ASR_ENDPOINT = "https://api.minimaxi.com/v1/speech_to_text";
    process.env.WEIXIN_ASR_MODEL = "asr-1.0";
    let captured: { url: string; model: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        captured = { url: String(url), model: String((init!.body as FormData).get("model")) };
        return jsonResponse({ text: " 好的 " });
      }),
    );
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    expect(await transcribeAudio(wav)).toBe("好的");
    expect(captured!.url).toBe("https://api.minimaxi.com/v1/speech_to_text");
    expect(captured!.model).toBe("asr-1.0");
  });

  it("ASR 失败 (HTTP 500 / 余额不足) → null 不抛", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    expect(await transcribeAudio(wav)).toBeNull();
  });

  it("无 key / 不支持的格式 → null (不发请求)", async () => {
    delete process.env.WEIXIN_ASR_API_KEY;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const amr = Buffer.alloc(64);
    amr.write("#!AMR\n", 0);
    expect(await transcribeAudio(amr)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("转写空文本 → null (视同失败)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ text: "  " })));
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    expect(await transcribeAudio(wav)).toBeNull();
  });
});
