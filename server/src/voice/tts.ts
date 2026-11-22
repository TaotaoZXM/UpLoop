import { HttpError } from "../errors.js";

/** Text-to-speech through DashScope's Qwen-TTS HTTP API (same key and host as the ASR adapter). */
export const MAX_SPEECH_CHARS = 80;
const MAX_CLIP_BYTES = 3 * 1024 * 1024;

export type Speech = { audio: Buffer; type: string };

const unavailable = () => new HttpError(502, "tts_provider", "语音合成服务暂时不可用");

/** Encouragement lines are short. Reject anything else so this endpoint cannot be used as a general speech proxy. */
export function speechText(value: unknown) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  const length = Array.from(text).length;
  if (length < 2 || length > MAX_SPEECH_CHARS) throw new HttpError(400, "tts_text", `朗读文字需要 2 到 ${MAX_SPEECH_CHARS} 个字`);
  return text;
}

function clipType(bytes: Buffer) {
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

/** The provider returns a link to the generated clip. Only follow public HTTPS hosts; an http link on aliyuncs.com is upgraded. */
function clipUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw unavailable(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && host.endsWith(".aliyuncs.com")) url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") || host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[")) throw unavailable();
  return url.toString();
}

export async function synthesize(input: {
  text: string; key: string; base: string; model: string; voice: string;
  fetchImpl?: typeof fetch; signal?: AbortSignal;
}): Promise<Speech> {
  const fetchImpl = input.fetchImpl || fetch;
  const signal = input.signal || AbortSignal.timeout(30000);
  const response = await fetchImpl(`${input.base}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, input: { text: input.text, voice: input.voice, language_type: "Chinese" } }),
    signal,
  });
  if (!response.ok) throw unavailable();
  const body = await response.json().catch(() => null) as { output?: { audio?: { url?: string; data?: string } } } | null;
  const audio = body?.output?.audio;
  let bytes: Buffer;
  if (audio?.data) bytes = Buffer.from(audio.data, "base64");
  else if (audio?.url) {
    // The clip link is pre-signed: do not send our API key to that host.
    const file = await fetchImpl(clipUrl(audio.url), { signal });
    if (!file.ok) throw unavailable();
    bytes = Buffer.from(await file.arrayBuffer());
  } else throw unavailable();
  const type = clipType(bytes);
  if (!type || !bytes.length || bytes.length > MAX_CLIP_BYTES) throw unavailable();
  return { audio: bytes, type };
}
