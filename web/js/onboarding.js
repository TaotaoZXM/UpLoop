/* WP2.2 / F-S2: mandatory full-screen onboarding. Gender -> water -> birth YYYY-MM
   -> explicit cloud consent. NO goals, NO medical history, NO age band. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});

  B.api = B.api || async function taskApi(path, options) {
    const opts = options || {};
    const response = await fetch(btUrl(path), Object.assign({}, opts, {
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {})
    }));
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      const error = new Error(data.message || data.error || "请求失败");
      error.status = response.status;
      error.code = data.error;
      throw error;
    }
    return data;
  };

  B.event = B.event || new EventTarget();
  B.escape = B.escape || function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  };
  B.dayKey = B.dayKey || function (date) {
    const d = date || new Date();
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  };
  B.emit = B.emit || function (name, detail) {
    B.event.dispatchEvent(new CustomEvent(name, { detail: detail }));
  };

  const draft = { gender: null, waterGoalMl: null, birthYm: "", cloudConsent: null };
  let step = 0;
  let overlay = null;

  function defaultsFor(gender) {
    return gender === "female" ? 1500 : gender === "male" ? 1700 : 1500;
  }

  function choices(items, key, onPick) {
    return '<div class="task-onboarding-choices">' + items.map(function (item) {
      const active = draft[key] === item.value ? " active" : "";
      return '<button type="button" data-pick="' + B.escape(key) + '" data-value="' + B.escape(item.value) + '" class="' + active.trim() + '">' + B.escape(item.label) + "</button>";
    }).join("") + "</div>";
  }

  function render() {
    if (!overlay) return;
    if (!B.features?.wellness) {
      overlay.innerHTML = '<div class="task-onboarding-card"><div class="eyebrow">开始之前</div><h2>云端处理</h2>' +
        '<p>使用 AI 对话和语音识别时，输入内容需要发送到云端处理。请明确选择。</p>' +
        choices([{ value: "yes", label: "同意" }, { value: "no", label: "不同意" }], "cloudConsent") +
        '<p class="task-muted">不同意也可以手动管理任务、灵感和日常清单。</p>' +
        '<div class="task-onboarding-error" id="taskOnboardError"></div><button class="task-onboarding-next" id="taskOnboardNext" type="button">完成，开始使用</button></div>';
      overlay.querySelectorAll("[data-pick]").forEach(function (button) {
        button.addEventListener("click", function () { draft.cloudConsent = button.getAttribute("data-value"); render(); });
      });
      document.getElementById("taskOnboardNext").addEventListener("click", advance);
      return;
    }
    const steps = ["性别", "喝水目标", "出生年月", "云端同意"];
    let body = "";
    if (step === 0) {
      body = "<p>先认识一下。这里不会问目标，也不问病史。</p>" +
        choices([{ value: "female", label: "女" }, { value: "male", label: "男" }, { value: "custom", label: "自选" }], "gender");
    } else if (step === 1) {
      body = '<p>每天想喝多少水？之后随时可以改。</p><label>基础目标（毫升）<input id="taskOnboardWater" type="number" min="500" max="6000" step="50" value="' + B.escape(draft.waterGoalMl || defaultsFor(draft.gender)) + '"></label><p class="task-muted">女 1500 / 男 1700，可填 500–6000。</p>';
    } else if (step === 2) {
      body = '<p>出生年月只用于记录，不会展示给其他人。</p><label>出生年月<input id="taskOnboardBirth" type="month" value="' + B.escape(draft.birthYm) + '"></label>';
    } else {
      body = "<p>对话记录需要云端处理才能使用。请明确选择，之后可以在「我的」里改。</p>" +
        choices([{ value: "yes", label: "同意" }, { value: "no", label: "不同意" }], "cloudConsent") +
        '<p class="task-muted">不同意仍可手动记录喝水、运动和睡眠，但不能使用对话。</p>';
    }
    overlay.innerHTML = '<div class="task-onboarding-card"><div class="eyebrow">开始之前 · ' + (step + 1) + "/4</div>" +
      "<h2>" + B.escape(steps[step]) + "</h2>" + body +
      '<div class="task-onboarding-error" id="taskOnboardError"></div>' +
      '<button class="task-onboarding-next" id="taskOnboardNext" type="button">' + (step === 3 ? "完成，开始使用" : "下一步") + "</button></div>";

    overlay.querySelectorAll("[data-pick]").forEach(function (button) {
      button.addEventListener("click", function () {
        const key = button.getAttribute("data-pick");
        draft[key] = button.getAttribute("data-value");
        if (key === "gender") draft.waterGoalMl = defaultsFor(draft.gender);
        render();
      });
    });
    const next = document.getElementById("taskOnboardNext");
    if (next) next.addEventListener("click", advance);
  }

  function fail(message) {
    const box = document.getElementById("taskOnboardError");
    if (box) box.textContent = message;
  }

  async function advance() {
    if (!B.features?.wellness) {
      if (!draft.cloudConsent) return fail("请明确选择是否同意");
      const button = document.getElementById("taskOnboardNext");
      button.disabled = true;
      try {
        await B.api("/api/onboarding", { method: "POST", body: JSON.stringify({ cloud_consent: draft.cloudConsent === "yes" }) });
        hide();
        B.emit("onboarded");
      } catch (error) { fail(error.message || "保存失败，请再试一次"); }
      finally { button.disabled = false; }
      return;
    }
    if (step === 0 && !draft.gender) return fail("请选择一项");
    if (step === 1) {
      const input = document.getElementById("taskOnboardWater");
      const ml = Number(input && input.value);
      if (!Number.isFinite(ml) || ml < 500 || ml > 6000) return fail("请填 500 到 6000 毫升");
      draft.waterGoalMl = Math.round(ml);
    }
    if (step === 2) {
      const input = document.getElementById("taskOnboardBirth");
      const ym = input && input.value;
      if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return fail("请填写出生年月");
      draft.birthYm = ym;
    }
    if (step === 3) {
      if (!draft.cloudConsent) return fail("请明确选择是否同意");
      try {
        await B.api("/api/onboarding", {
          method: "POST",
          body: JSON.stringify({
            gender: draft.gender,
            water_goal_ml: draft.waterGoalMl,
            birth_ym: draft.birthYm,
            cloud_consent: draft.cloudConsent === "yes"
          })
        });
      } catch (error) {
        return fail(error.message || "保存失败，请再试一次");
      }
      hide();
      B.emit("onboarded");
      return;
    }
    step += 1;
    render();
  }

  function show() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "task-onboarding";
    overlay.id = "taskOnboarding";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    document.body.appendChild(overlay);
    // No close button, no backdrop dismiss: PRD B1 says it cannot be skipped.
    render();
  }

  function hide() {
    if (overlay) overlay.remove();
    overlay = null;
  }

  async function check() {
    try {
      await B.api("/api/auth/me");
    } catch (error) {
      if (error.status === 401) { hide(); return; }
      return;
    }
    try {
      const profile = await B.api("/api/profile");
      if (profile.onboardingRequired) show();
      else hide();
    } catch (error) {
      if (error.status === 401) hide();
    }
  }

  B.onboarding = { check: check, show: show, hide: hide, draft: draft };
  B.event.addEventListener("auth", check);
  B.event.addEventListener("onboarding-required", show);

  // Existing qingzhou auth flow calls showAccountState / signOut; wrap them so
  // a freshly logged-in (legacy) account is forced into onboarding (WP2.2).
  const originalState = window.showAccountState;
  if (typeof originalState === "function") {
    window.showAccountState = function (user) {
      originalState(user);
      B.emit("auth", user);
    };
  }
  const originalSignOut = window.signOut;
  if (typeof originalSignOut === "function") {
    window.signOut = function () {
      const result = originalSignOut();
      hide();
      return result;
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
  else check();
})();
