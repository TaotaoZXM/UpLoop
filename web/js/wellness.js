/* WP2.10 / M02-F10,F11: health four-cards on the records screen, openGym scope,
   day switching, editable history, water reminder (this screen only), and the
   "建议，可改" post-exercise hydration suggestion that requires a tap. */
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

  let host = null;
  let day = B.dayKey ? B.dayKey() : new Date().toISOString().slice(0, 10);
  let current = null;

  /* Sub-page order requested for the Wellness module. The four cards double as
     the sub-page switcher; the old grouped heading line is intentionally gone. */
  const SUBS = [
    { key: "exercise", label: "运动" },
    { key: "food", label: "饮食" },
    { key: "sleep", label: "睡眠" },
    { key: "water", label: "喝水" }
  ];
  let activeKind = "exercise";
  const subLabel = function (key) {
    const found = SUBS.filter(function (s) { return s.key === key; })[0];
    return found ? found.label : "";
  };

  function shiftDay(ymd, offset) {
    const parts = ymd.split("-").map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  function minutesLabel(min) {
    if (!min) return "0";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h ? h + "h" + (m ? m + "m" : "") : m + "m";
  }

  function cardsHtml(s) {
    const kcal = s.summary || {};
    const defs = {
      exercise: { value: escape(kcal.exercise_min || 0) + '<small>分钟</small>', sub: "约 " + escape(kcal.exercise_kcal || 0) + " kcal" },
      food: { value: escape(kcal.kcal || 0) + '<small>kcal · 估算</small>', sub: "区间 " + escape(kcal.kcal_low || 0) + "–" + escape(kcal.kcal_high || 0) },
      sleep: { value: escape(minutesLabel(kcal.sleep_min)), sub: escape(kcal.sleep_bedtime || "—") + " → " + escape(kcal.sleep_wake || "—") },
      water: { value: escape(kcal.water_ml || 0) + '<small>ml / ' + escape(kcal.water_goal_ml || 0) + "</small>", sub: escape(kcal.water_ratio || 0) + "% 目标" }
    };
    return '<div class="og-cards" role="tablist" aria-label="健康子页面">' +
      SUBS.map(function (sub) {
        const active = sub.key === activeKind;
        return '<button type="button" role="tab" aria-selected="' + active + '" class="og-card' + (active ? " active" : "") + '" data-kind="' + sub.key + '">' +
          '<span class="og-card-label">' + sub.label + '</span>' +
          '<span class="og-value">' + defs[sub.key].value + "</span>" +
          '<div class="og-sub">' + defs[sub.key].sub + "</div></button>";
      }).join("") + "</div>";
  }

  function entriesHtml(entries, kind) {
    const filtered = (entries || []).filter(function (entry) { return entry.kind === kind; });
    if (!filtered.length) {
      return '<div class="og-empty">这一天还没有' + subLabel(kind) + "记录。" +
        (kind === "food" ? "在对话里说一句就能记，比如「午饭吃了米饭和鸡胸」。" : "想起来就记一笔，不必凑满目标。") + "</div>";
    }
    return filtered.map(function (entry) {
      const detail = entry.detail || {};
      let label = entry.kind;
      if (entry.kind === "food") label = "饮食 · " + (detail.items || []).map(function (i) { return i.name; }).join("、") + " · 约 " + entry.kcal + " kcal";
      if (entry.kind === "water") label = "喝水 · " + entry.water_ml + " ml";
      if (entry.kind === "sleep") label = "睡眠 · " + entry.sleep_min + " 分钟";
      if (entry.kind === "exercise") label = "运动 · " + (detail.activity || "") + " · " + entry.exercise_min + " 分钟 · 约 " + entry.kcal + " kcal";
      const gramsInput = entry.kind === "food" && detail.items && detail.items.length
        ? '<input type="number" min="1" max="5000" value="' + escape(detail.items[0].grams) + '" data-grams="' + escape(entry.id) + '" aria-label="克重">'
        : "";
      return '<div class="og-entry"><span>' + escape(label) + "</span>" + gramsInput +
        '<button type="button" data-delete="' + escape(entry.id) + '">删除</button></div>';
    }).join("");
  }

  function recordForm(kind) {
    if (kind === "food") return '<div class="task-food-entry"><p>吃了什么，说一句就能记。</p>' +
      '<small>例如：午饭吃了一碗米饭、150 克鸡胸肉</small><button type="button" class="og-action" data-open-chat>去 AI 记录饮食</button></div>';
    const water = kind === "water";
    const sleep = kind === "sleep";
    const amountLabel = water ? "水量（毫升）" : sleep ? "睡眠时长（分钟）" : "运动时长（分钟）";
    return '<div class="og-form"><input id="taskEntryKind" type="hidden" value="' + kind + '">' +
      '<label>' + amountLabel + '<input id="taskEntryAmount" type="number" inputmode="numeric" min="1"' +
      (sleep ? ' max="1200"' : '') + ' placeholder="' + (water ? '例如 250' : sleep ? '例如 480' : '例如 30') + '"></label>' +
      (sleep ? '<input id="taskEntryNote" type="hidden" value=""><p class="task-muted">也可以在 AI 对话里说“昨晚 11 点睡，早上 7 点醒”。</p>'
        : '<label>' + (water ? '饮品' : '运动类型') + '<input id="taskEntryNote" maxlength="40" placeholder="' + (water ? '白水、茶或咖啡' : '散步、跑步或攀岩') + '"></label>') +
      '<button type="button" class="og-action og-primary" id="taskEntryAdd">保存' + subLabel(kind) + '</button></div>';
  }

  function render(data) {
    if (!host) return;
    current = data;
    day = data.day || day;
    const summary = data.summary || {};
    const week = data.week || [];
    host.innerHTML = cardsHtml(data) +
      '<div id="taskHealthDate"></div>' +
      (activeKind === "water"
        ? '<div class="task-water-progress"><div><strong>已喝 ' + escape(summary.water_ml || 0) + ' ml</strong><span>目标 ' + escape(summary.water_goal_ml || 1500) + ' ml</span></div>' +
          '<progress value="' + Math.max(0, Number(summary.water_ml || 0)) + '" max="' + Math.max(1, Number(summary.water_goal_ml || 1500)) + '" aria-label="喝水进度"></progress></div>'
        : '') +
      (activeKind === "water" && data.suggestion ? '<div class="og-suggestion">运动后可增加 ' + escape(data.suggestion.add_ml) + ' ml 水量目标。<button type="button" class="og-action" id="taskApplySuggestion">调整目标</button></div>' : "") +
      '<div class="task-section-heading"><h3>记一笔' + subLabel(activeKind) + '</h3></div>' + recordForm(activeKind) +
      '<div id="taskHealthStatus" class="task-inline-status" role="status"></div>' +
      '<div class="task-section-heading task-history-heading"><h3>当日' + subLabel(activeKind) + '记录</h3><span>' +
        escape((data.entries || []).filter(function (entry) { return entry.kind === activeKind; }).length) + ' 条</span></div>' +
      '<div class="og-entries">' + entriesHtml(data.entries || [], activeKind) + "</div>";

    if (B.dates) B.dates.mount(document.getElementById("taskHealthDate"), "wellness", "健康");

    host.querySelectorAll("[data-kind]").forEach(function (card) {
      card.addEventListener("click", function () {
        activeKind = card.getAttribute("data-kind");
        if (current) render(current);
      });
    });
    host.querySelectorAll("[data-day]").forEach(function (button) {
      button.addEventListener("click", function () { day = button.getAttribute("data-day"); refresh(); });
    });
    host.querySelectorAll("[data-shift]").forEach(function (button) {
      button.addEventListener("click", function () { day = shiftDay(day, Number(button.getAttribute("data-shift"))); refresh(); });
    });
    const dateInput = document.getElementById("taskHealthDay");
    if (dateInput) dateInput.addEventListener("change", function () { if (dateInput.value) { day = dateInput.value; refresh(); } });
    const apply = document.getElementById("taskApplySuggestion");
    if (apply) apply.addEventListener("click", function () {
      api("/api/wellness/days/" + encodeURIComponent(day) + "/water-goal", { method: "POST", body: JSON.stringify({ apply_suggestion: true }) })
        .then(refresh).catch(function () {});
    });
    host.querySelectorAll("[data-open-chat]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (B.taskHub && B.taskHub.leave) B.taskHub.leave();
        if (typeof window.showScreen === "function") window.showScreen("start");
        const input = document.getElementById("taskChatInput");
        if (input) input.focus();
      });
    });
    const add = document.getElementById("taskEntryAdd");
    if (add) add.addEventListener("click", addManual);
    host.querySelectorAll("[data-delete]").forEach(function (button) {
      button.addEventListener("click", function () {
        api("/api/entries/" + encodeURIComponent(button.getAttribute("data-delete")), { method: "DELETE" }).then(refresh).catch(function () {});
      });
    });
    host.querySelectorAll("[data-grams]").forEach(function (input) {
      input.addEventListener("change", function () {
        const grams = Number(input.value);
        if (!grams || grams <= 0) return;
        api("/api/entries/" + encodeURIComponent(input.getAttribute("data-grams")) + "/grams", {
          method: "POST", body: JSON.stringify({ index: 0, grams: grams })
        }).then(refresh).catch(function () {});
      });
    });
  }

  async function addManual() {
    if (!host) return;
    const kind = document.getElementById("taskEntryKind").value;
    const amount = Number(document.getElementById("taskEntryAmount").value);
    const note = document.getElementById("taskEntryNote").value.trim();
    const status = document.getElementById("taskHealthStatus");
    const add = document.getElementById("taskEntryAdd");
    if (!Number.isFinite(amount) || amount <= 0) { status.textContent = "请填写大于 0 的数量"; return; }
    if (kind === "sleep" && amount > 1200) { status.textContent = "睡眠时长请填写 1200 分钟以内"; return; }
    add.disabled = true;
    status.textContent = "正在保存…";
    const body = kind === "water"
      ? { kind: "water", day: day, ml: amount, beverage: note || "白水" }
      : kind === "sleep"
        ? { kind: "sleep", day: day, minutes: amount }
        : { kind: "exercise", day: day, activity: note || "运动", minutes: amount, skip_weight: true };
    try {
      await api("/api/entries", { method: "POST", body: JSON.stringify(body) });
      await refresh();
    } catch (error) {
      if (error.code === "onboarding_required" && B.emit) B.emit("onboarding-required");
      status.textContent = error.message || "没有保存成功，内容已保留，请重试";
    } finally { add.disabled = false; }
  }

  async function refresh() {
    if (!host) return;
    try {
      render(await api("/api/wellness/day?day=" + encodeURIComponent(day)));
    } catch (error) {
      if (error.status === 401) return;
      if (error.code === "onboarding_required") { if (B.emit) B.emit("onboarding-required"); return; }
      host.innerHTML = '<div class="og-empty">记录暂时读不出来，稍后再试。</div>';
    }
  }

  function init() {
    if (!B.features?.wellness) return;
    if (B.dates) B.dates.subscribe("wellness", function (value) { day = value; refresh(); });
    const cal = document.getElementById("calScreen");
    if (!cal) return;
    cal.classList.add("og-enabled");
    host = document.createElement("div");
    host.id = "taskHealth";
    cal.insertBefore(host, cal.firstChild);
    refresh();
    if (B.event) {
      B.event.addEventListener("task-record", refresh);
      B.event.addEventListener("auth", refresh);
      B.event.addEventListener("onboarded", refresh);
    }
  }

  function enter() {
    if (!B.features?.wellness) return;
    activeKind = "exercise";
    // Render cached data immediately, then refresh from the server.
    if (current) render(current);
    refresh();
  }

  B.wellness = { recordForm: recordForm, enter: enter, init: init, refresh: refresh, shiftDay: shiftDay, render: render };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
