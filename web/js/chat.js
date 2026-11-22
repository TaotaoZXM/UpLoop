/* Message stream under the chat heading. Voice capture is voice.js.
   No usage / quota / RMB text anywhere in this file. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});
  const api = B.api || async function (path, options) {
    const opts = options || {};
    const response = await fetch(btUrl(path), Object.assign({}, opts, { credentials: "same-origin", headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {}) }));
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) { const e = new Error(data.message || data.error || "请求失败"); e.status = response.status; e.code = data.error; throw e; }
    return data;
  };
  const escape = B.escape || function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  const emit = B.emit || function () {};

  let list = null;
  let input = null;
  let pendingCount = 0;
  let historyRequest = 0;
  let sendQueue = Promise.resolve();

  function cardText(card) {
    const type = card && card.type;
    if (type === "food") return "饮食 · 约 " + escape(card.kcal) + " kcal" + (card.estimated ? " · 估算" : "");
    if (type === "water") return "喝水 · " + escape(card.water_ml) + " ml";
    if (type === "sleep") return "睡眠 · " + escape(card.minutes == null ? "已记录" : card.minutes + " 分钟");
    if (type === "exercise") return "运动 · " + escape(card.text || "") + " · " + escape(card.kcal) + " kcal" + (card.estimated ? " · 估算" : "");
    if (type === "expense") return "收支 · " + escape(card.text || "");
    if (type === "tasks") return escape(card.text || "");
    if (type === "focus") return "专注 · " + escape(card.text || "");
    if (type === "routine") return "Checklist · " + escape(card.text || "");
    if (type === "report") return "今日战报 · " + escape(card.text || "");
    if (type === "task") return "任务 · " + escape(card.text || "");
    return escape(card && card.text ? card.text : "");
  }

  function appendMessage(role, text, cards, hint) {
    if (!list) return;
    const row = document.createElement("div");
    row.className = "task-msg " + (role === "user" ? "user" : "assistant");
    row.textContent = text;
    (cards || []).forEach(function (card) {
      const box = document.createElement("div");
      box.className = "task-card";
      box.textContent = cardText(card);
      row.appendChild(box);
    });
    if (hint) {
      const small = document.createElement("small");
      small.textContent = hint;
      row.appendChild(small);
    }
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    return row;
  }

  async function loadHistory() {
    const request = ++historyRequest;
    try {
      const data = await api("/api/messages");
      if (request !== historyRequest || pendingCount || !list) return;
      list.replaceChildren();
      (data.messages || []).forEach(function (message) {
        const cards = message.meta && message.meta.cards ? message.meta.cards : [];
        appendMessage(message.role, message.content, cards, message.role === "user" && message.meta?.source === "voice" ? "语音转写" : undefined);
      });
    } catch (error) {
      if (error.status === 401) return;
    }
  }

  async function maybeRemind() {
    const key = "task-review-reminder-" + (B.dayKey ? B.dayKey() : new Date().toISOString().slice(0, 10));
    if (localStorage.getItem(key)) return;
    try {
      const data = await api("/api/report/reminder");
      if (data.shouldRemind) {
        appendMessage("assistant", "今天还没写战报。想回看一下的话，可以说「战报」，或者打开记录页看看。", [], "应用内提醒");
        localStorage.setItem(key, "1");
      }
    } catch (error) { /* reminder is optional */ }
  }

  function sendText(value, source) {
    const text = String(value || "").trim();
    if (!text) return Promise.resolve(false);
    if (typeof window.requireAccount === "function" && !window.requireAccount()) return Promise.resolve(false);
    const payload = { text, source: source === "voice" ? "voice" : "web", requestId: crypto.randomUUID() };
    historyRequest++;
    const row = appendMessage("user", text, []);
    const status = document.createElement("small"); status.textContent = (payload.source === "voice" ? "语音转写 · " : "") + "等待发送…"; row?.appendChild(status);
    const deliver = async () => {
      status.textContent = "正在记录…";
      try {
        const result = await api("/api/chat", { method: "POST", body: JSON.stringify(payload) });
        status.textContent = payload.source === "voice" ? "语音转写" : "";
        appendMessage("assistant", result.reply || "记下了。", result.cards || []);
        emit("task-record", result);
        if (typeof window.loadCloudAppState === "function") await window.loadCloudAppState().catch(() => {});
        return true;
      } catch (error) {
        if (error.code === "onboarding_required" || error.code === "cloud_consent_required") emit("onboarding-required");
        status.textContent = error.message || "这句话没记上，请重试。";
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试发送";
        retry.onclick = () => { retry.remove(); enqueue(); };
        row?.appendChild(retry);
        return false;
      }
    };
    const enqueue = () => {
      pendingCount++;
      const result = sendQueue.then(deliver, deliver).finally(() => { pendingCount--; });
      sendQueue = result.catch(() => {});
      return result;
    };
    return enqueue();
  }

  async function send() {
    if (!input || !input.value.trim()) return;
    if (typeof window.requireAccount === "function" && !window.requireAccount()) return;
    const text = input.value; input.value = "";
    await sendText(text, "web");
    input.focus();
  }

  function init() {
    const start = document.getElementById("startScreen");
    if (!start) return;
    const wrap = document.createElement("div");
    wrap.className = "task-chat";
    wrap.id = "taskChat";
    wrap.innerHTML = '<div class="section-label">和 Task 说一句</div><div class="task-chat-list" id="taskChatList"></div>' +
      '<form class="task-chat-form" id="taskChatForm"><input id="taskChatInput" maxlength="2000" autocomplete="off" placeholder="记下一件，或完成日常清单"><button type="submit">发送</button></form>';
    start.appendChild(wrap);
    list = document.getElementById("taskChatList");
    input = document.getElementById("taskChatInput");
    const form = document.getElementById("taskChatForm");
    form.addEventListener("submit", function (event) { event.preventDefault(); send(); });
    // Typing/focus alone must not reopen a dismissed login dialog.
    // Authentication is requested only on an explicit send or protected action.
    loadHistory().then(maybeRemind);
    if (B.event) {
      B.event.addEventListener("onboarded", loadHistory);
      B.event.addEventListener("task-record", function () { if (B.wellness && B.wellness.refresh) B.wellness.refresh(); });
      B.event.addEventListener("auth", loadHistory);
    }
  }

  B.chat = { init: init, send: send, sendText: sendText, loadHistory: loadHistory, appendMessage: appendMessage, cardText: cardText };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
