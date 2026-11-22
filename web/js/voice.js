/* Shared voice capture: MediaRecorder -> decoded 16 kHz mono WAV -> Fun-ASR.
   Dock flow (no options): a dialog shows progress and the transcript is sent through the shared AI chat.
   Inline flow (beginHold({ onText, onState })): no dialog, no chat; the transcript goes to onText, e.g. the Overview guide. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});
  let dialog, status, cancelButton;
  let holding = false;
  let recorder, stream, timer, jobId, generation = 0;
  let mode = "idle";
  let pendingBlob = null;
  let config;
  let sink = null;
  const busy = () => ["loading", "recording", "recognizing"].includes(mode);
  const retry = () => sink ? "可以再按住试一次，或直接打字" : "请关闭后重新长按 AI 或直接打字";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const id = () => crypto.randomUUID();
  const api = async (path, options) => {
    const response = await fetch(btUrl(path), Object.assign({ credentials: "same-origin", signal: AbortSignal.timeout(180000) }, options));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.message || "语音服务暂不可用"); error.code = data.error; throw error; }
    return data;
  };
  function state(next, message) {
    mode = next; status.textContent = message || "";
    cancelButton.disabled = next === "sending";
    if (sink?.onState) sink.onState(next, message || "");
  }
  function release() {
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  function cancel() {
    if (mode === "sending") return;
    holding = false;
    generation++;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release(); pendingBlob = null;
    if (jobId) api("/api/voice/transcriptions/" + jobId, { method: "DELETE" }).catch(() => {});
    jobId = null; mode = "idle";
    const target = sink; sink = null;
    if (target?.onState) target.onState("idle", "");
    dialog.close();
  }
  function encodeWav(samples) {
    const max = 16000 * 60;
    const length = Math.min(samples.length, max);
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const string = (at, value) => { for (let n = 0; n < value.length; n++) view.setUint8(at + n, value.charCodeAt(n)); };
    string(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); string(8, "WAVE");
    string(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    string(36, "data"); view.setUint32(40, length * 2, true);
    for (let n = 0; n < length; n++) {
      const value = Math.max(-1, Math.min(1, samples[n]));
      view.setInt16(44 + n * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }
  async function wav(blob) {
    const Context = window.AudioContext || window.webkitAudioContext;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const context = new Context();
    try {
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const offline = new Offline(1, Math.min(60 * 16000, Math.ceil(audio.duration * 16000)), 16000);
      const source = offline.createBufferSource(); source.buffer = audio; source.connect(offline.destination); source.start();
      return encodeWav((await offline.startRendering()).getChannelData(0));
    } finally { await context.close(); }
  }
  async function upload(token) {
    state("recognizing", "正在识别普通话 / English / 粤语…");
    try {
      await api("/api/voice/transcriptions/" + jobId, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: pendingBlob });
      for (let n = 0; n < 110 && token === generation; n++) {
        await sleep(1500);
        if (token !== generation) return;
        const result = await api("/api/voice/transcriptions/" + jobId);
        if (token !== generation) return;
        if (result.state === "error") throw new Error(result.message);
        if (result.state === "done") {
          pendingBlob = null;
          const text = result.text;
          if (sink && !String(text || "").trim()) { state("error", "没听清，再按住说一次"); return; }
          // The transcript is the user message, just like typed text.
          if (jobId) api("/api/voice/transcriptions/" + jobId, { method: "DELETE" }).catch(() => {});
          jobId = null; mode = "idle";
          const target = sink; sink = null;
          if (target) { if (target.onState) target.onState("idle", ""); await target.onText(text); return; }
          dialog.close();
          if (B.taskHub?.leave) B.taskHub.leave();
          if (typeof window.showScreen === "function") window.showScreen("start");
          if (B.assistant?.say) { await B.assistant.say(text, "voice"); return; }
          await B.chat.sendText(text, "voice");
          return;
        }
      }
      if (token === generation) throw new Error("识别等待超时，请取消后重新录音");
    } catch (error) {
      if (token === generation) state("error", error.message + "。" + retry() + "。");
    }
  }
  async function record() {
    const token = ++generation;
    state("loading", "正在请求麦克风权限…");
    try {
      const capturedStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      if (token !== generation) { capturedStream.getTracks().forEach(track => track.stop()); return; }
      stream = capturedStream;
      const chunks = [];
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { if (token !== generation) return; release(); state("error", "录音失败，" + retry()); };
      recorder.onstop = async () => {
        if (token !== generation) return;
        release();
        state("recognizing", "正在整理录音…");
        try {
          pendingBlob = await wav(new Blob(chunks, { type: recorder.mimeType }));
          if (token !== generation) return;
          jobId = id();
          await upload(token);
        } catch (error) { if (token === generation) state("error", "无法读取录音，" + retry()); }
      };
      recorder.start();
      state("recording", sink ? "正在听，说完松开即可。支持普通话、English、粤语，最长60秒。" : "正在听，松开 AI 即可发送。支持普通话、English、粤语，最长60秒。");
      timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60000);
    } catch (error) {
      if (token !== generation) return;
      release();
      state("error", error.name === "NotAllowedError" ? "未获得麦克风权限，请在浏览器设置中允许，或改用文字" : "麦克风不可用，请检查设备或输入文字");
    }
  }
  async function beginHold(options) {
    const inline = options && typeof options.onText === "function" ? options : null;
    holding = true;
    if (typeof window.requireAccount === "function" && !window.requireAccount()) { holding = false; return; }
    if (dialog.open || (inline && busy())) return;
    sink = inline;
    if (!sink) dialog.show();
    jobId = null; pendingBlob = null;
    state("loading", "正在检查语音服务…");
    const token = ++generation;
    try {
      config = await api("/api/voice/config");
      if (token !== generation) return;
      if (!config.enabled) { state("unavailable", "语音服务尚未配置完成，请联系管理员。仍可使用原有文字记录。"); return; }
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !(window.AudioContext || window.webkitAudioContext) || !(window.OfflineAudioContext || window.webkitOfflineAudioContext)) {
        state("unavailable", "当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari，并通过 HTTPS 访问。"); return;
      }
      if (holding) await record();
    } catch (error) { if (token === generation) state("unavailable", error.message); }
  }
  function endHold() {
    holding = false;
    if (mode === "recording" && recorder?.state === "recording") recorder.stop();
    else if (mode === "loading") { cancel(); return; }
    // Capture has finished, so the processing/error panel may now trap focus.
    if (!sink && dialog.open) { dialog.close(); dialog.showModal(); }
  }

  function bindTrigger(trigger, actions) {
    const controls = actions || { begin: beginHold, end: endHold, cancel };
    let pressTimer, origin = null, longPress = false, suppressClick = false;
    const clear = () => { clearTimeout(pressTimer); pressTimer = null; };
    const start = () => {
      clear();
      longPress = true; suppressClick = true;
      trigger.classList.add("voice-holding");
      controls.begin();
    };
    const finish = cancelled => {
      clear();
      if (longPress) { if (cancelled) controls.cancel(); else controls.end(); }
      trigger.classList.remove("voice-holding");
      origin = null; longPress = false;
    };
    trigger.setAttribute("title", "轻点进入对话，长按说话，松开发送");
    trigger.setAttribute("aria-description", "轻点进入对话；长按或按住空格键说话，松开发送");
    trigger.addEventListener("pointerdown", event => {
      if (event.button !== 0 || origin) return;
      suppressClick = false;
      origin = { id: event.pointerId, x: event.clientX, y: event.clientY };
      trigger.setPointerCapture?.(event.pointerId);
      pressTimer = setTimeout(start, 450);
    });
    trigger.addEventListener("pointermove", event => {
      if (!origin || origin.id !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
      if (distance > (longPress ? 72 : 14)) finish(true);
    });
    trigger.addEventListener("pointerup", event => {
      if (origin?.id === event.pointerId) finish(false);
    });
    trigger.addEventListener("pointercancel", () => finish(true));
    trigger.addEventListener("lostpointercapture", () => { if (origin) finish(true); });
    trigger.addEventListener("contextmenu", event => event.preventDefault());
    trigger.addEventListener("click", event => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, true);
    trigger.addEventListener("keydown", event => {
      if (event.code === "Space" && !event.repeat && !origin) {
        event.preventDefault(); suppressClick = false; origin = { id: "keyboard", x: 0, y: 0 };
        pressTimer = setTimeout(start, 450);
      }
      if (event.key === "Escape" && origin) finish(true);
    });
    window.addEventListener("keyup", event => {
      if (event.code === "Space" && origin?.id === "keyboard") {
        event.preventDefault(); const wasLong = longPress; finish(false);
        if (!wasLong) trigger.click();
      }
    });
    window.addEventListener("blur", () => { if (origin) finish(true); });
  }

  function init() {
    dialog = document.createElement("dialog"); dialog.className = "task-voice";
    dialog.setAttribute("aria-labelledby", "taskVoiceTitle");
    dialog.innerHTML = '<h2 id="taskVoiceTitle">按住说话</h2><p>语音将交由阿里云识别，并以文字记录在对话中。</p>' +
      '<div class="task-voice-status" role="status" aria-live="polite"></div>' +
      '<div class="task-voice-actions"><button type="button" data-voice="cancel">关闭 / 取消</button></div>';
    document.body.appendChild(dialog);
    status = dialog.querySelector('[role="status"]');
    cancelButton = dialog.querySelector('[data-voice="cancel"]');
    cancelButton.onclick = cancel;

    dialog.addEventListener("cancel", event => { event.preventDefault(); cancel(); });
    window.addEventListener("pagehide", () => { generation++; release(); });
    const trigger = document.getElementById("taskDockAi");
    if (trigger) bindTrigger(trigger);
  }
  B.voice = { beginHold, endHold, cancel, bindTrigger, encodeWav };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
