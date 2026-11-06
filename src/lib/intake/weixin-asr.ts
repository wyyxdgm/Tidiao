// 微信入站语音 → 文字 (ASR 分支, damo 2026-10-15 拍板做语音可用).
//
// 功能: 把 downloadWeixinAudio 解密出的音频字节转成文字. 链路:
//   格式嗅探 → (silk → wav 转码, silk-wasm) → OpenAI whisper 兼容
//   POST /audio/transcriptions multipart → { text }.
//
// ASR 选型 (2026-10-15 实测拍板): 智谱 GLM-ASR (`glm-asr`) —— 平台已有 bigmodel key
//   体系, 国内直连; curl 实测鉴权 + wav 24k mono 转写全通 (真实语音样本转写正确).
//   ⚠️ 实测该 key 的 glm-asr 资源包极小 (几次调用后 1113 余额不足) —— 上线前需给
//   bigmodel 账户充 glm-asr 资源包, 或用 env 指到其他 whisper 兼容服务
//   (阿里 dashscope compatible-mode 同协议可切). 失败一律降级兜底话术.
//
// 关注点:
// - key 解析顺序: env `WEIXIN_ASR_API_KEY` → DB llm_configs 里 bigmodel 配置
//   (decrypt api_key, ao-dev server 进程 env 无 key, DB 是唯一现成来源).
// - endpoint / model / key 全部可 env 覆盖: WEIXIN_ASR_ENDPOINT / WEIXIN_ASR_MODEL /
//   WEIXIN_ASR_API_KEY —— 换供应商零代码改动.
// - 任何一步失败 resolve null, 不抛 —— 调用方 (worker) 降级为兜底话术,
//   不能让语音挂掉整条收消息链 (游标纪律下抛错 = 整批重投).

import { decrypt } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { decode as silkDecode, isSilk } from "silk-wasm";

const ASR_TIMEOUT_MS = 30_000;
// 微信语音 silk 常见采样率 24000 (silk-wasm decode 按 <= 请求值出 pcm, 24k 保清晰度)
const SILK_SAMPLE_RATE = 24_000;

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";
const DEFAULT_MODEL = "glm-asr";

// ---------------------------------------------------------------------------
// 格式嗅探 + 转码
// ---------------------------------------------------------------------------

// 功能: 嗅探音频格式并转成 ASR 可上传的形态. silk (微信语音原生格式) → wav;
//   wav/mp3 直传; amr/未知 → null (无进程内解码器, 走兜底).
// 关注点: silk-wasm decode 要求 \x02#!SILK_V3 微信形态 (实证: 无前缀的裸 silk 解码
//   报 silk decoding failure) —— 裸头先补前缀再解.
export async function toAsrUpload(audio: Buffer): Promise<{ buf: Buffer; mime: string; filename: string } | null> {
  if (audio.byteLength < 16) return null;
  let silkView: Buffer = audio;
  if (audio[0] !== 0x02) {
    silkView = Buffer.concat([Buffer.from([0x02]), audio]);
  }
  try {
    if (isSilk(silkView)) {
      const decoded = await silkDecode(silkView, SILK_SAMPLE_RATE);
      return { buf: wrapWav(Buffer.from(decoded.data), SILK_SAMPLE_RATE), mime: "audio/wav", filename: "voice.wav" };
    }
  } catch {
    return null;
  }
  if (audio.subarray(0, 4).toString("latin1") === "RIFF" && audio.subarray(8, 12).toString("latin1") === "WAVE") {
    return { buf: audio, mime: "audio/wav", filename: "voice.wav" };
  }
  if (audio.subarray(0, 3).toString("latin1") === "ID3" || audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) {
    return { buf: audio, mime: "audio/mpeg", filename: "voice.mp3" };
  }
  // #!AMR 等其他格式: 不支持
  return null;
}

// 功能: PCM s16le 单声道 → WAV 容器 (44 字节头 + data).
function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// key 解析
// ---------------------------------------------------------------------------

let cachedDbKey: { key: string; at: number } | null = null;
const DB_KEY_CACHE_TTL_MS = 10 * 60 * 1000;

// 功能: 解析 ASR key. env 显式配置优先; 否则查 DB llm_configs 里 bigmodel 配置
//   (server 进程 env 无 key, DB 是现成来源), 10 分钟缓存防每条语音打一次 DB.
// 关注点: 解不出返回 null (语音走兜底话术), 不抛.
export function resolveAsrApiKey(): string | null {
  const envKey = (process.env.WEIXIN_ASR_API_KEY ?? "").trim();
  if (envKey) return envKey;
  if (cachedDbKey && Date.now() - cachedDbKey.at < DB_KEY_CACHE_TTL_MS) return cachedDbKey.key;
  try {
    const row = getDb()
      .prepare(
        `SELECT api_key_encrypted, api_key_iv, api_key_tag FROM llm_configs
         WHERE base_url LIKE '%bigmodel.cn%' AND api_key_encrypted IS NOT NULL
         ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
      )
      .get() as { api_key_encrypted: string; api_key_iv: string; api_key_tag: string } | undefined;
    if (!row) return null;
    const key = decrypt(row.api_key_encrypted, row.api_key_iv, row.api_key_tag).trim();
    if (!key) return null;
    cachedDbKey = { key, at: Date.now() };
    return key;
  } catch {
    return null;
  }
}

// 测试辅助: 清 key 缓存
export function _resetAsrKeyCacheForTest(): void {
  cachedDbKey = null;
}

// ---------------------------------------------------------------------------
// 转写
// ---------------------------------------------------------------------------

// 功能: 音频字节 → 文字. 全链路 catch, 失败 resolve null (调用方降级兜底话术).
// 关注点: ASR 30s 超时; 上传走 OpenAI whisper 兼容 multipart (bigmodel/dashscope 同协议).
export async function transcribeAudio(audio: Buffer): Promise<string | null> {
  const key = resolveAsrApiKey();
  if (!key) return null;
  const upload = await toAsrUpload(audio);
  if (!upload) return null;
  const endpoint = (process.env.WEIXIN_ASR_ENDPOINT || DEFAULT_ENDPOINT).trim();
  const model = (process.env.WEIXIN_ASR_MODEL || DEFAULT_MODEL).trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(upload.buf)], { type: upload.mime }), upload.filename);
  form.append("model", model);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as { text?: unknown };
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}
