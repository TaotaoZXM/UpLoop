import { HttpError } from "../errors.js";

export const MAX_AUDIO_SECONDS = 60;
export const MAX_AUDIO_BYTES = 44 + 16000 * 2 * MAX_AUDIO_SECONDS;

/** The browser/firmware uploads a canonical 16 kHz mono PCM WAV. Inspect the
 * actual header and payload, never trust a client-supplied duration or MIME. */
export function wavDuration(audio: Buffer) {
  if (audio.length < 46 || audio.length > MAX_AUDIO_BYTES ||
      audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE" ||
      audio.toString("ascii", 12, 16) !== "fmt " || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 ||
      audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000 ||
      audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 ||
      audio.toString("ascii", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44 ||
      audio.readUInt32LE(4) !== audio.length - 8 || (audio.length - 44) % 2) {
    throw new HttpError(400, "invalid_audio", "请上传 60 秒以内的 16kHz 单声道 PCM WAV 录音");
  }
  const seconds = (audio.length - 44) / 32000;
  if (seconds < 0.3) throw new HttpError(400, "short_audio", "录音太短，请再说一次");
  return seconds;
}

type ProviderOutput = {
  output?: { task_id?: string; task_status?: string; results?: Array<{ subtask_status?: string; transcription_url?: string }> };
  usage?: { duration?: number };
};

export async function transcribe(input: {
  audioUrl: string; key: string; base: string; model: string;
  fetchImpl?: typeof fetch; pause?: () => Promise<void>; signal?: AbortSignal;
  onSubmitted?: () => void;
}) {
  const fetchImpl = input.fetchImpl || fetch;
  const signal = input.signal || AbortSignal.timeout(150000);
  const headers = { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" };
  const request = async (url: string, init?: RequestInit, authenticated = true) => {
    const response = await fetchImpl(url, { ...init, headers: authenticated ? { ...headers, ...init?.headers } : undefined, signal });
    if (!response.ok) throw new HttpError(502, "asr_provider", "语音识别服务暂时不可用，请稍后再试");
    return response.json();
  };
  const submitted = await request(`${input.base}/services/audio/asr/transcription`, {
    method: "POST", headers: { "X-DashScope-Async": "enable" },
    body: JSON.stringify({ model: input.model, input: { file_urls: [input.audioUrl] }, parameters: { channel_id: [0] } }),
  }) as ProviderOutput;
  const task = submitted.output?.task_id;
  if (!task) throw new HttpError(502, "asr_provider", "语音识别任务未创建，请重试");
  input.onSubmitted?.();
  let result: ProviderOutput = submitted;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (input.pause) await input.pause();
    else await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const stop = () => { clearTimeout(timer); reject(new Error("aborted")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 1500);
      signal.addEventListener("abort", stop, { once: true });
    });
    result = await request(`${input.base}/tasks/${encodeURIComponent(task)}`) as ProviderOutput;
    const status = result.output?.task_status;
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "CANCELED") throw new HttpError(502, "asr_failed", "录音未能识别，请检查声音或稍后重试");
  }
  const item = result.output?.results?.[0];
  if (result.output?.task_status !== "SUCCEEDED" || item?.subtask_status !== "SUCCEEDED" || !item.transcription_url) {
    throw new HttpError(504, "asr_timeout", "识别超时或失败，请稍后重新录音");
  }
  // Only follow the provider's HTTPS result URL; never forward API credentials.
  const url = new URL(item.transcription_url);
  if (url.protocol !== "https:") throw new HttpError(502, "asr_result", "识别结果地址无效");
  const document = await request(url.href, undefined, false) as { transcripts?: Array<{ text?: string }> };
  const text = (document.transcripts || []).map(part => part.text || "").join(" ").trim();
  if (!text) throw new HttpError(422, "empty_transcript", "没有识别到说话内容，请靠近麦克风再试一次");
  if (text.length > 2000) throw new HttpError(422, "long_transcript", "识别内容过长，请分段录入");
  return { text, billedSeconds: result.usage?.duration };
}
