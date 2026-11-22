/* AI encouragement. When a task is finished or a checklist step is ticked, pick a random line from the corpus
   (praise-corpus.js), show it as a small toast with the AI avatar (or as a chat bubble on the AI page) and,
   if the user chose voice, read it aloud with the browser's speech synthesis. Setting: 关闭 / 文字 / 文字 + 语音. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});
  const KEY = "task.praise.mode", MODES = ["off", "text", "voice"], KEEP = 10;
  const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a8 8 0 010 11"/></svg>';
  const recent = [];
  let toast = null, timer = 0;

  /* ---------- setting ---------- */
  function mode() {
    let m = null;
    try { m = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    return MODES.includes(m) ? m : "text";
  }
  function setMode(m) {
    if (!MODES.includes(m)) return;
    try { localStorage.setItem(KEY, m); } catch (e) { /* storage blocked */ }
    paint();
  }

  /* ---------- choosing a line ---------- */
  const NEED = /\{(\w+)\}/g;
  const shortTitle = s => { const a = Array.from(String(s || "").trim()); return a.length > 14 ? a.slice(0, 14).join("") + "…" : a.join(""); };
  const shortName = s => Array.from(String(s || "").trim()).slice(0, 8).join("");
  function fill(line, vars) {
    let ok = true;
    const out = line.replace(NEED, (_, k) => { if (vars[k] == null || vars[k] === "") { ok = false; return ""; } return String(vars[k]); });
    return ok ? out : null;
  }
  /** Which corpus pools apply to this event, with weights. The general pool is always there, so the specific ones come up often but not every time. */
  function pools(ev, hour) {
    const C = B.praiseCorpus || {}, out = [], add = (name, w) => { if (C[name] && C[name].length) out.push([C[name], w]); };
    if (ev.type === "step") {
      add("step", 3);
      if (ev.k === 1) add("stepFirst", 2);
      if (ev.total - ev.k === 1) add("stepLast", 2);
    } else {
      add("done", 3);
      if (ev.plan) add("planDone", 3);
      if (ev.hard) add("hard", 3);
      if (ev.n === 1) add("first", 2); else if (ev.n >= 5) add("many", 2); else if (ev.n >= 3) add("three", 2);
    }
    if (ev.name) add(ev.type === "step" ? "stepNamed" : "doneNamed", 1);
    if (ev.scene === "work" || ev.scene === "life") add(ev.scene, 1);
    if (hour >= 5 && hour < 10) add("morning", 1); else if (hour >= 22 || hour < 4) add("night", 1);
    return out;
  }
  /** One line for an event {type:"step"|"done", title, k, total, n, hard, plan, hour}. Skips lines used recently and lines whose placeholders are unknown. */
  function compose(ev, rnd, hist) {
    rnd = rnd || Math.random; hist = hist || recent; ev = ev || {};
    const vars = { name: shortName(ev.name), title: shortTitle(ev.title), n: ev.n, k: ev.k, total: ev.total, left: ev.total && ev.k ? ev.total - ev.k : null };
    const hour = ev.hour != null ? ev.hour : new Date().getHours();
    const lines = (pool, skipUsed) => pool.map(l => fill(l, vars)).filter(t => t && !(skipUsed && hist.includes(t)));
    for (const skipUsed of [true, false]) {
      const left = pools(ev, hour);
      while (left.length) {
        let r = rnd() * left.reduce((s, p) => s + p[1], 0), i = 0;
        while (i < left.length - 1 && (r -= left[i][1]) >= 0) i++;
        const usable = lines(left[i][0], skipUsed);
        if (usable.length) {
          const text = usable[Math.floor(rnd() * usable.length) % usable.length];
          hist.push(text); if (hist.length > KEEP) hist.shift();
          return text;
        }
        left.splice(i, 1);
      }
    }
    return "";
  }
  function doneToday() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    try { return [...document.querySelectorAll("#doneList .done-row")].filter(r => Number(r.dataset.completed) >= start.getTime()).length; } catch (e) { return 0; }
  }
  const userName = () => { try { return typeof currentUser !== "undefined" && currentUser && currentUser.username ? currentUser.username : ""; } catch (e) { return ""; } };
  const line = ev => {
    ev = Object.assign({}, ev || {});
    if (ev.name == null) ev.name = userName();
    if (ev.type === "done" && ev.n == null) ev.n = doneToday();
    return compose(ev);
  };

  /* ---------- voice ---------- */
  const synth = () => (typeof window !== "undefined" && window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null);
  /** Ranks installed voices: Mandarin first, and neural / "natural" / premium builds ahead of the plain ones. */
  function rank(v) {
    const lang = String(v.lang || "").replace("_", "-"), name = String(v.name || "");
    if (!/^zh/i.test(lang)) return -1;
    let s = /^zh-CN$/i.test(lang) ? 10 : /^zh-(TW|HK)$/i.test(lang) ? 4 : 6;
    if (/natural|neural|premium|enhanced|xiaoxiao|xiaoyi|yunxi|tingting|meijia|ya-?ling|ting-ting/i.test(name)) s += 6;
    if (v.localService === false && /google|microsoft/i.test(name)) s += 2;
    if (/compact|novelty|bad|bubbles|bells|cellos|whisper|zarvox/i.test(name)) s -= 8;
    return s;
  }
  function bestVoice(list) {
    let best = null, top = 0;
    (list || []).forEach(v => { const s = rank(v); if (s > top) { top = s; best = v; } });
    return best;
  }
  let primed = false;
  /** Browsers load the voice list late, and iOS Safari only lets speech start after a tap; both are handled by touching the engine once. */
  function prime() {
    const s = synth();
    if (!s || primed) return;
    primed = true;
    try {
      if (s.getVoices) s.getVoices();
      if (s.addEventListener) s.addEventListener("voiceschanged", () => { s.getVoices(); });
      const u = new SpeechSynthesisUtterance(" "); u.volume = 0; s.speak(u);
    } catch (e) { /* speech unavailable */ }
  }
  /* Cloud voice first (the server turns the line into speech with a large model), the browser voice if that fails.
     Cloud clips are kept in memory by text, so replaying a line costs nothing. */
  const clips = new Map();
  let playing = null, token = 0, cloudOff = false;
  const stopAll = () => {
    token++;
    if (playing) { try { playing.pause(); } catch (e) { /* already stopped */ } playing = null; }
    const s = synth(); if (s) { try { s.cancel(); } catch (e) { /* ignore */ } }
  };
  function browserSpeak(text) {
    const s = synth();
    if (!s || !text) return false;
    try {
      s.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/[「」]/g, ""));
      u.lang = "zh-CN"; u.rate = 1; u.pitch = 1.05;
      const v = bestVoice(s.getVoices ? s.getVoices() : []);
      if (v) { u.voice = v; u.lang = v.lang; }
      s.speak(u);
      return true;
    } catch (e) { return false; }
  }
  async function cloudClip(text) {
    if (clips.has(text)) return clips.get(text);
    if (typeof fetch !== "function" || typeof Audio === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) throw new Error("no audio");
    const url = typeof window.btUrl === "function" ? window.btUrl("api/voice/speech") : "/api/voice/speech";
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000) });
    if (res.status === 503 || res.status === 403) cloudOff = true;   // not configured, quota used up or no consent: stop asking this session
    if (!res.ok) throw new Error("tts " + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error("empty");
    const src = URL.createObjectURL(blob);
    clips.set(text, src);
    if (clips.size > 30) { const old = clips.keys().next().value; URL.revokeObjectURL(clips.get(old)); clips.delete(old); }
    return src;
  }
  /** Speaks a line. Resolves to "cloud", "browser" or "none" depending on what actually played. */
  async function speak(text) {
    text = String(text || "").trim();
    if (!text) return "none";
    stopAll();
    const mine = token;
    if (!cloudOff) {
      try {
        const src = await cloudClip(text.replace(/[「」]/g, ""));
        if (mine !== token) return "none";
        const audio = new Audio(src);
        playing = audio;
        await audio.play();
        return "cloud";
      } catch (e) { if (mine !== token) return "none"; /* fall through to the browser voice */ }
    }
    return browserSpeak(text) ? "browser" : "none";
  }

  /* ---------- toast ---------- */
  const face = () => String(B.aiFace || "").replace('class="task-dock-ai-face"', 'class="pr-face"').replace(/taskDock(Hair|Shirt)/g, "pr$1");
  const esc = v => (B.escape ? B.escape(String(v)) : String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  function hide(now) {
    clearTimeout(timer);
    const el = toast; toast = null;
    if (!el) return;
    if (now) { el.remove(); return; }
    el.classList.remove("is-in"); setTimeout(() => el.remove(), 260);
  }
  function show(text) {
    hide(true);
    const el = document.createElement("div");
    el.className = "pr-toast"; el.setAttribute("role", "status");
    el.innerHTML = '<span class="pr-av">' + face() + '</span><p class="pr-text"></p>' + sayButton(text);
    el.querySelector(".pr-text").textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-in"));
    timer = setTimeout(() => hide(), 5200);
    toast = el;
  }
  const sayButton = (text, inline) => '<button type="button" class="pr-say' + (inline ? " pr-say-inline" : "") + '" data-pr-say data-text="' + esc(text) + '" aria-label="朗读这句鼓励">' + SPEAKER + '</button>';

  /** Called by the app when a step is ticked or a task is finished. Never throws: encouragement must not break the task flow. */
  function notify(ev) {
    try {
      const m = mode();
      if (m === "off") return "";
      const text = line(ev);
      if (!text) return "";
      show(text);
      if (m === "voice") speak(text);
      return text;
    } catch (e) { return ""; }
  }
  /** For the AI page: the line plus its speaker button, so the caller can render it as a chat bubble. Null when the user turned it off. */
  function forChat(ev) {
    try {
      const m = mode();
      if (m === "off") return null;
      const text = line(ev);
      return text ? { text, extra: sayButton(text, true), speak: () => { if (m === "voice") speak(text); } } : null;
    } catch (e) { return null; }
  }

  /* ---------- events ---------- */
  function paint() {
    if (!document.querySelectorAll) return;
    const m = mode();
    document.querySelectorAll("[data-pr]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.pr === m)));
  }
  function onClick(event) {
    const t = event.target;
    if (!t || !t.closest) return;
    const say = t.closest("[data-pr-say]");
    if (say) { speak(say.dataset.text); return; }
    const pick = t.closest("[data-pr]");
    if (pick) { setMode(pick.dataset.pr); if (pick.dataset.pr !== "off") notify({ type: "done", n: 2 }); return; }
    if (t.closest(".pr-toast")) hide();
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", onClick);
    document.addEventListener("pointerdown", prime, { once: true, capture: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paint); else paint();
  }

  B.praise = { compose, line, notify, forChat, speak, mode, setMode, sayButton, bestVoice, stopAll };
})();
