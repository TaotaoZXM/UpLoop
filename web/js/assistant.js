/* AI page: a welcome screen first, then a guided conversation with an avatar. The AI asks, the user taps.
   One flow creates a To-do task or a Done event; Manage's "+" buttons open it too. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {}), G = B.guide;
  if (!G) return;
  const { read, dateOptions, timeOptions, whenText, latestStart, totalText, minutesText, stepsOf, SCENES, ymd } = G;
  const esc = v => B.escape(String(v ?? ""));
  const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = ms => new Promise(r => setTimeout(r, reduce() ? 0 : ms));
  const account = () => (typeof currentUser !== "undefined" ? currentUser?.id || null : null);
  const userName = () => (typeof currentUser !== "undefined" ? currentUser?.username || "" : "");
  const needAccount = () => typeof requireAccount === "function" && !requireAccount();
  const canSpeak = () => Boolean(B.voice && window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const now = () => new Date();
  const hm = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const SAMPLES = { task: ["下周五前办完日本签证", "明天下午三点准备客户会议材料", "月底前整理好报销发票"], done: ["昨天整理完了房间", "今天上午写完了周报", "晚上跑了五公里"] };
  const FEEDBACK = [["步骤更少，更简单", "步骤更少"], ["拆得更细，每步更小", "拆得更细"], ["时间很紧，只保留最关键的步骤", "时间更紧"], ["", "随便换一种"]];
  const ICON = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6M11 6.5L5.5 12l5.5 5.5"/></svg>',
    task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h3.5"/></svg>',
    done: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8 12l2.7 2.7 5.3-5.6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/></svg>',
    tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };
  let F, root, thread, input, slipBox, noteBox, micButton;
  // step: say (waiting for the sentence) · date · time · scene · split · plan · done
  // Keep in sync with extractHttpUrls() in server/src/tasks/extract-link.ts
  const firstHttpUrl = text => {
    const m = String(text || "").match(/https?:\/\/[^\s<>"'）】)\]}>，。；、]+/i);
    return m ? m[0].replace(/[.,;:!?，。；：！？)、】》]+$/g, "") : "";
  };
  const fresh = (mode, from) => ({ mode, from: from || "", step: "say", title: "", date: null, time: "", scene: "", split: undefined, plan: null, busy: false,
    timeAsked: false, deadlineAsked: false, editing: false, widget: null, lastMode: "create", lastFeedback: "", ticket: (F?.ticket || 0) + 1,
    project: "", projectAsked: false, repeat: undefined, repeatDays: 0,
    linkQueue: [], linkSteps: [], linkConfidence: "" });
  const faceInner = () => String(B.aiFace || "").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/taskDock(Hair|Shirt)/g, "as$1");
  const face = cls => '<svg class="' + cls + '" viewBox="0 0 72 72" aria-hidden="true"><use href="#asFace"/></svg>';
  const hasPlan = () => Boolean(F.plan && stepsOf(F.plan).length);
  const activeScreen = () => (typeof screens !== "undefined" ? Object.keys(screens).find(k => !screens[k].classList.contains("hidden")) : "") || "";
  const el = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  /* ---------- views ---------- */
  const greeting = () => { const h = now().getHours(); return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好"; };
  const avatarSprite = () => '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
    '<symbol id="asFace" viewBox="0 0 72 72">' + faceInner().replace(/<defs>.*?<\/defs>/, "") + '</symbol></defs></svg>';

  function welcomeHtml() {
    const name = userName(), speak = canSpeak();
    const modes = [["task", "新建任务", "说一句，AI 带你理清", ICON.task], ["done", "记录完成", "做完的事，补一笔", ICON.done]];
    return '<div class="as-welcome">' +
      '<div class="as-hero"><span class="as-avatar-xl">' + face("as-face") + '<i class="as-pulse" aria-hidden="true"></i></span>' +
      '<h2 class="as-hello" tabindex="-1">' + esc(greeting()) + (name ? "，" + esc(name) : "") + '，<br>今天想做成什么事？</h2></div>' +
      '<form class="as-bar" data-form="start"><input name="say" type="text" maxlength="200" autocomplete="off" placeholder="说一句想做的事，或直接打字" aria-label="想做的事" id="taskAssistInput">' +
      '<button type="button" class="as-mic" data-mic aria-label="按住说话，松开发送"' + (speak ? "" : ' aria-disabled="true"') + '>' + ICON.mic + '</button>' +
      '<button type="submit" class="as-go" aria-label="开始">' + ICON.up + '</button></form>' +
      '<p class="as-note" data-note role="status" aria-live="polite">' + esc(speak ? "按住麦克风说话，普通话、English、粤语都行" : "当前浏览器不能录音，直接打字也一样") + '</p>' +
      '<div class="as-modes" role="group" aria-label="想做什么">' + modes.map(([key, label, sub, icon]) => '<button type="button" class="as-mode' + (key === "task" ? " is-primary" : "") + '" data-act="mode" data-mode="' + key + '">' + icon + '<b>' + label + '</b><small>' + sub + '</small></button>').join("") + '</div>' +
      '<div class="as-try"><span>试试这样说</span><div class="as-chips" role="group" aria-label="示例">' + SAMPLES.task.map((t, i) => '<button type="button" data-act="sample" data-i="' + i + '">' + esc(t) + '</button>').join("") + '</div></div></div>';
  }

  /** The note pinned above the thread: what the AI has understood so far. */
  function slipHtml() {
    const done = F.mode === "done", cell = (label, value, key) => '<button type="button" class="as-cell' + (value ? " is-filled" : "") + '" data-act="field" data-field="' + key + '" aria-label="修改' + label + '"><span>' + label + '</span><strong>' + esc(value || "待定") + '</strong></button>';
    const splitText = hasPlan() ? stepsOf(F.plan).length + " 步" : F.split === false ? "不拆" : "";
    const repeatText = F.repeat ? ((F.repeatDays || 7) + " 天") : F.repeat === false ? "不循环" : "";
    const projectCell = F.scene === "work" ? cell("项目", F.projectAsked ? (F.project || "未分类") : "", "project") : "";
    const extra = done ? "" : '<div class="as-slip-grid as-slip-more">' + projectCell + cell("循环", repeatText, "repeat") + '</div>';
    return '<div class="as-slip"><div class="as-slip-title">' + (F.editing
      ? '<form data-form="title"><input name="t" value="' + esc(F.title) + '" maxlength="80" autocomplete="off" aria-label="任务名称"><button type="submit" class="as-ok" aria-label="确定">' + ICON.tick + '</button></form>'
      : '<button type="button" class="as-title" data-act="edit-title" aria-label="修改名称：' + esc(F.title) + '">' + esc(F.title) + '</button>') + '</div>' +
      '<div class="as-slip-grid' + (done ? " is-done" : "") + '">' + cell(done ? "完成于" : "截止", whenText(F.date, F.time, now()), "date") + cell("场景", SCENES[F.scene] || "", "scene") + (done ? "" : cell("步骤", splitText, "split")) + '</div>' + extra + '</div>';
  }

  function chatHtml() {
    return '<div class="as-chat"><header class="as-top"><button type="button" class="as-back" data-act="exit" aria-label="返回">' + ICON.back + '</button>' +
      '<span class="as-avatar-sm">' + face("as-face") + '</span><div class="as-who"><b>UpLoop AI</b><small data-state>' + (F.mode === "done" ? "记录完成事件" : "新建任务") + '</small></div></header>' +
      '<div class="as-slip-wrap" data-slip-wrap hidden><button type="button" class="as-slip-toggle" data-act="toggle-slip" aria-expanded="false"><span data-slip-title></span><span aria-hidden="true">⌄</span></button><div class="as-slip-detail" data-slip></div></div><div class="as-thread" data-thread role="log" aria-live="polite"></div>' +
      '<form class="as-bar as-bar-chat" data-form="reply"><input name="say" type="text" maxlength="200" autocomplete="off" placeholder="也可以直接打字回答" aria-label="回复" id="taskAssistInput">' +
      '<button type="button" class="as-mic" data-mic aria-label="按住说话，松开发送"' + (canSpeak() ? "" : ' aria-disabled="true"') + '>' + ICON.mic + '</button>' +
      '<button type="submit" class="as-go" aria-label="发送">' + ICON.up + '</button></form></div>';
  }
  /* ---------- thread: AI bubbles, user bubbles, answer cards ---------- */
  const scroll = () => { if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: reduce() ? "auto" : "smooth" }); };
  const refreshSlip = () => {
    if (!slipBox) return;
    const wrap = root.querySelector("[data-slip-wrap]");
    wrap.hidden = !F.title;
    const title = root.querySelector("[data-slip-title]");
    if (title) title.textContent = F.title || "";
    slipBox.innerHTML = F.title ? slipHtml() : "";
    if (F.editing) { const i = slipBox.querySelector("input"); i?.focus(); i?.select(); }
  };
  const mount = (node, enter) => { thread.appendChild(node); if (enter) node.classList.add("as-in"); scroll(); return node; };
  function aiRow(inner, extra) { return el('<div class="as-row as-ai ' + (extra || "") + '"><span class="as-avatar-xs">' + face("as-face") + '</span><div class="as-stack">' + inner + '</div></div>'); }
  async function say(text, extra) {
    const typing = mount(aiRow('<div class="as-bubble as-typing" aria-label="AI 正在输入"><i></i><i></i><i></i></div>'), true), mine = F.ticket;
    await wait(Math.min(620, 220 + text.length * 14));
    if (mine !== F.ticket || !typing.isConnected) { typing.remove(); return null; }
    typing.querySelector(".as-stack").innerHTML = '<div class="as-bubble">' + esc(text) + '</div>';
    if (extra) typing.querySelector(".as-stack").insertAdjacentHTML("beforeend", extra);
    scroll(); return typing;
  }
  const userSays = text => { mount(el('<div class="as-row as-me"><div class="as-bubble">' + esc(text) + '</div></div>'), true); };
  /** Replaces the live option card with the answer the user gave, like a chat reply. */
  function settle(text) { thread.querySelectorAll(".as-live").forEach(n => n.closest(".as-row").remove()); userSays(text); }

  const opt = (act, value, label, sub, tag) => '<button type="button" class="as-opt" data-act="' + act + '" data-value="' + esc(value) + '"><span><b>' + esc(label) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : "") + '</span>' + (tag ? '<em>' + esc(tag) + '</em>' : "") + '</button>';
  const card = (inner, cls) => '<div class="as-card as-live ' + (cls || "") + '">' + inner + '</div>';

  function dateCard() {
    if (F.mode === "task") return card('<div class="as-deadline-controls"><label>日期<input type="date" required data-deadline-date value="' + esc(F.date || '') + '"></label><label>时间<input type="time" data-deadline-time value="' + esc(F.time || '') + '"></label></div>' + opt("confirm-deadline", "", "确定", "") + opt("skip-deadline", "", "暂不设置", "之后可补充日期"), "as-opts");
    return card(dateOptions(now(), "past").map(o => opt("pick-date", o.key, o.label, o.sub)).join("") + opt("pick-calendar", "", "选个日期", "打开日历") + '<input type="date" class="as-date" data-date-input max="' + ymd(now()) + '" tabindex="-1" aria-hidden="true">', "as-opts");
  }
  function timeCard() {
    return card(timeOptions(F.date, now(), "past").map(o => opt("pick-time", o.key, o.label, o.sub)).join("") + opt("pick-clock", "", "自己定", "几点几分") + '<input type="time" class="as-date" data-time-input tabindex="-1" aria-hidden="true">', "as-opts as-times");
  }
  const sceneCard = () => card(Object.entries(SCENES).map(([k, name]) => opt("pick-scene", k, name, k === "work" ? "项目、会议、客户" : "家务、出行、办事")).join(""), "as-opts");
  const knownProjects = () => {
    const names = (typeof projectNames !== "undefined" && Array.isArray(projectNames)) ? projectNames : [];
    const out = [];
    names.forEach(name => {
      const clean = String(name || "").trim();
      if (!clean || clean === "未分类" || out.includes(clean)) return;
      if (typeof isLegacyPlaceholderProject === "function" && isLegacyPlaceholderProject(clean)) return;
      out.push(clean);
    });
    return out;
  };
  const projectCard = () => card(opt("pick-project", "", "未分类", "不归到项目") + knownProjects().map(name => opt("pick-project", name, name, "")).join("") + opt("pick-project", "new", "新增项目", "输入名称"), "as-opts");
  const repeatCard = () => card(opt("pick-repeat", "no", "不用循环", "只这一次") + opt("pick-repeat", "7", "循环 7 天", "含今天，表单默认") + opt("pick-repeat", "custom", "自己定天数", "1 到 365 天"), "as-opts");
  const repeatDaysCard = () => card(["3", "7", "14", "30"].map(n => opt("pick-repeat-days", n, n + " 天", n === "7" ? "默认" : "")).join(""), "as-opts");
  const splitCard = () => {
    const link = F.linkSteps && F.linkSteps.length;
    return card((link ? opt("pick-split", "link", "用整理出的步骤", "来自这篇网页") : "") + opt("pick-split", "yes", link ? "重新拆" : "拆成步骤", link ? "不用网页里的步骤" : "第一步小到今天就能动手", link ? "" : "推荐") + opt("pick-split", "no", "不用，直接加入", "只保存这一条任务"), "as-opts");
  };
  const planFromLinkSteps = steps => {
    const list = (Array.isArray(steps) ? steps : []).map((title, i) => ({ id: "linkstep_" + i, title: Array.from(String(title || "")).slice(0, 30).join(""), minutes: 15, waitDays: 0, done: false })).filter(step => step.title);
    return list.length ? { stages: [{ id: "linkstage", title: "活动安排", steps: list }] } : null;
  };

  function planCard() {
    const list = stepsOf(F.plan), total = list.reduce((s, x) => s + x.minutes, 0), first = list.find(x => !x.done);
    const start = F.date ? latestStart(F.plan, F.date) : "", late = start && start < ymd(now());
    let n = 0;
    const stages = F.plan.stages.map(st => '<section class="as-stage"><h4>' + esc(st.title) + '</h4><ul>' + st.steps.map(step => { n += 1;
      return '<li class="as-step' + (step === first ? " is-first" : "") + '"><span class="as-n">' + n + '</span><span class="as-step-t">' + esc(step.title) + (step === first ? '<em>今天就能做</em>' : "") + '</span><span class="as-step-m">' + esc(minutesText(step.minutes) + (step.waitDays ? " · 等 " + step.waitDays + " 天" : "")) + '</span></li>'; }).join("") + '</ul></section>').join("");
    const regen = '<div class="as-chips as-regen" data-regen hidden>' + FEEDBACK.map(([, label], i) => '<button type="button" data-act="regen" data-i="' + i + '">' + label + '</button>').join("") + '</div>';
    return card('<div class="as-plan-head"><b>共 ' + list.length + ' 步，约' + totalText(total) + '</b>' + (start ? '<small class="' + (late ? "is-late" : "") + '">' + (late ? "时间偏紧，今天就要开始" : "最晚 " + G.dayLong(start) + " 开始") + '</small>' : "") + '</div>' + stages +
      '<div class="as-plan-actions"><button type="button" class="as-primary" data-act="create">加入 To-do</button><div class="as-links"><button type="button" data-act="toggle-regen">换一种拆法</button><button type="button" data-act="create-plain">不拆了，只加任务</button></div>' + regen + '</div>', "as-plan");
  }
  const skeleton = () => card('<div class="as-skel" aria-hidden="true"><i></i><i></i><i></i><i></i></div><button type="button" class="as-link" data-act="cancel-plan">取消</button>', "as-wait");
  const retryCard = msg => card('<p class="as-err" role="alert">' + esc(msg) + '</p><div class="as-opts-inline">' + opt("retry", "", "再试一次") + opt("create-plain", "", "只加任务，不拆") + '</div>', "as-opts");
  /* ---------- flow ---------- */
  const missing = () => F.mode === "task"
    ? (!F.scene ? "scene" : F.repeat === undefined ? "repeat" : F.repeat && !F.repeatDays ? "repeatDays" : !F.deadlineAsked ? "date" : F.scene === "work" && !F.projectAsked ? "project" : F.split === undefined ? "split" : "")
    : (F.date === null ? "date" : F.date && !F.time && !F.timeAsked ? "time" : !F.scene ? "scene" : "");
  const QUESTION = {
    date: () => (F.mode === "done" ? "是哪一天完成的？" : "什么时候要完成？"),
    time: () => (F.mode === "done" ? "大概几点？" : "几点前要完成？"),
    scene: () => "这件事属于哪一类？",
    project: () => "要放到哪个项目？没有就选未分类。",
    projectNew: () => "新项目叫什么？",
    repeat: () => "要设成循环任务吗？循环按天重复，截止日期不会单独保存。",
    repeatDays: () => "连续循环多少天（含今天）？直接输入 1 到 365 的数字也可以。",
    split: () => "要我拆成一步步的清单吗？拆完你只需要确认。"
  };
  const CARD = { date: dateCard, time: timeCard, scene: sceneCard, project: projectCard, projectNew: () => "", repeat: repeatCard, repeatDays: repeatDaysCard, split: splitCard };

  /** What the AI says after reading the sentence, so the user sees what was understood before the next question. */
  const heard = () => {
    const bits = [F.date ? whenText(F.date, F.time, now()) : "", SCENES[F.scene] || ""].filter(Boolean);
    return bits.length ? "好，「" + F.title + "」。我先记下：" + bits.join("，") + "。" : "好，「" + F.title + "」。";
  };

  async function ask(first) {
    const mine = F.ticket, key = missing();
    F.step = key || "ready";
    refreshSlip();
    if (!key) { if (F.mode === "done") return finishDone(); return finishTask(); }
    await say((first ? heard() + " " : "") + QUESTION[key](), "");
    if (mine !== F.ticket) return;
    mount(aiRow(CARD[key]()), true);
    refreshSlip();
  }

  function applyLinkDraft(draft) {
    const d = draft || {};
    F.title = Array.from(String(d.title || "").trim()).slice(0, 80).join("") || F.title;
    F.date = d.date || null;
    F.time = d.time || "";
    F.timeAsked = false; F.deadlineAsked = Boolean(d.date);
    F.scene = d.scene === "work" || d.scene === "life" ? d.scene : "";
    if (d.project) { F.project = d.project; F.projectAsked = true; } else { F.project = ""; F.projectAsked = false; }
    if (d.repeat === true && Number(d.repeatDays) >= 1) { F.repeat = true; F.repeatDays = Number(d.repeatDays); }
    else if (d.repeat === false) { F.repeat = false; F.repeatDays = 0; }
    else { F.repeat = undefined; F.repeatDays = 0; }
    F.linkSteps = Array.isArray(d.steps) ? d.steps.slice(0, 12) : [];
    F.linkConfidence = d.confidence === "low" ? "low" : d.confidence === "high" ? "high" : "";
  }
  function linkConfirmText(draft, leftover) {
    const when = draft.date ? whenText(draft.date, draft.time || "", now()) : "";
    const scene = draft.scene === "work" ? "工作" : draft.scene === "life" ? "生活" : "";
    const bits = [when, scene, draft.summary || ""].filter(Boolean);
    const uncertain = draft.confidence === "low" ? "有些信息不太确定，请先看一眼上面的摘要，不对就点上去改。" : "先按这个来，不对可以点上面改。";
    const more = leftover ? "同一页里还排着 " + leftover + " 个活动，这件保存后可点「再来一个」继续。" : "";
    return "我从链接里整理出「" + (draft.title || "一项活动") + "」。" + (bits.length ? "记下：" + bits.join("，") + "。" : "") + uncertain + (more ? " " + more : "");
  }
  async function startExtracted(draft, queue, keepThread) {
    if (needAccount()) return;
    F = fresh("task", "link");
    F.linkQueue = Array.isArray(queue) ? queue : [];
    if (keepThread && root.dataset.view === "chat" && thread) refreshSlip();
    else enterChat();
    applyLinkDraft(draft);
    refreshSlip();
    const mine = F.ticket;
    await say(linkConfirmText(draft, F.linkQueue.length), "");
    if (mine !== F.ticket) return;
    await ask(false);
  }
  async function beginFromLink(text, url, source) {
    const keepThread = root?.dataset.view === "chat" && thread;
    if (keepThread) settle(text);
    F = fresh("task", source || "link");
    if (!keepThread) { enterChat(); userSays(text); }
    const mine = F.ticket;
    await say("正在读取这个链接里的活动信息…", "");
    try {
      const result = await B.api("/api/tasks/extract-link", { method: "POST", body: JSON.stringify({ url, note: text }) });
      if (mine !== F.ticket) return;
      const events = Array.isArray(result.events) ? result.events : [];
      if (!events.length) {
        await say("没能从这篇网页里辨认出活动信息。你可以把内容贴过来，或用一句话告诉我要做什么。", "");
        F.step = "say";
        return;
      }
      applyLinkDraft(events[0]);
      F.linkQueue = events.slice(1);
      refreshSlip();
      await say(linkConfirmText(events[0], F.linkQueue.length), "");
      if (mine !== F.ticket) return;
      await ask(false);
    } catch (error) {
      if (mine !== F.ticket) return;
      if (error && error.code === "cloud_consent") B.emit?.("onboarding-required");
      await say((error && error.message) || "打不开这个链接。你可以把活动文字贴过来，或用一句话告诉我要做什么。", "");
      F.step = "say";
    }
  }
  async function begin(text, source) {
    if (needAccount()) return;
    const url = firstHttpUrl(text);
    if (url) return beginFromLink(text, url, source);
    const parsed = read(text, now());
    if (!parsed.title) return;
    const mode = F.mode;
    const keepThread = root?.dataset.view === "chat" && thread;
    if (keepThread) settle(text);
    F = fresh(mode, source);
    if (!keepThread) enterChat();
    Object.assign(F, { title: parsed.title, date: parsed.date || null, time: parsed.time });
    F.scene = parsed.scenario || ""; F.deadlineAsked = Boolean(parsed.date);
    if (F.mode === "done" && !F.date) F.date = null;
    if (!keepThread) userSays(text);
    refreshSlip();
    await ask(true);
  }

  async function answer(label, patch, thenAsk) {
    settle(label);
    Object.assign(F, patch);
    refreshSlip();
    if (thenAsk !== false) await ask(false);
  }

  const act = {
    mode(b) { startMode(b.dataset.mode); },
    sample(b) { begin(SAMPLES[F?.mode === "done" ? "done" : "task"][Number(b.dataset.i)] || "", "sample"); },
    exit() { exitChat(); },
    "edit-title"() { F.editing = true; refreshSlip(); },
    "toggle-slip"(b) { const wrap = b.closest(".as-slip-wrap"); const expanded = wrap.classList.toggle("is-expanded"); b.setAttribute("aria-expanded", String(expanded)); },
    field(b) { reopen(b.dataset.field); },
    "confirm-deadline"() {
      const date = thread.querySelector('[data-deadline-date]'), time = thread.querySelector('[data-deadline-time]');
      if (!date.value) { date.reportValidity(); date.focus(); return; }
      answer(whenText(date.value, time.value, now()), {date:date.value,time:time.value,timeAsked:true,deadlineAsked:true});
    },
    "skip-deadline"() { answer("暂不设置", {date:"",time:"",timeAsked:true,deadlineAsked:true}); },
    "pick-date"(b) { const v = b.dataset.value, o = dateOptions(now(), F.mode === "done" ? "past" : "future").find(x => x.key === v);
      answer(v ? (o ? o.label : whenText(v, "", now())) : "暂不设置", { date: v, time: v ? F.time : "", timeAsked: !v }); },
    "pick-calendar"(b) { const i = thread.querySelector("[data-date-input]"); try { i.showPicker(); } catch { i.focus(); i.click(); } },
    "pick-time"(b) { const v = b.dataset.value; answer(v === "-" ? "不限时间" : v, { time: v === "-" ? "" : v, timeAsked: true }); },
    "pick-clock"() { const i = thread.querySelector("[data-time-input]"); try { i.showPicker(); } catch { i.focus(); i.click(); } },
    "pick-scene"(b) {
      const scene = b.dataset.value;
      if (scene === "life") Object.assign(F, { scene, project: "", projectAsked: true });
      else Object.assign(F, { scene, project: "", projectAsked: false });
      settle(SCENES[scene]); refreshSlip(); ask(false);
    },
    "pick-project"(b) { const v = b.dataset.value; if (v === "new") { settle("新增项目"); F.step = "projectNew"; say(QUESTION.projectNew(), ""); return; } acceptProject(v, v ? v : "未分类"); },
    "pick-repeat"(b) { const v = b.dataset.value; if (v === "custom") { answer("自己定天数", { repeat: true, repeatDays: 0 }, true); return; } if (v === "no") { answer("不用循环", { repeat: false, repeatDays: 0 }); return; } answer("循环 " + v + " 天", { repeat: true, repeatDays: Number(v) }); },
    "pick-repeat-days"(b) { acceptRepeatDays(Number(b.dataset.value), b.dataset.value + " 天"); },
    "pick-split"(b) {
      if (b.dataset.value === "link") {
        const plan = planFromLinkSteps(F.linkSteps);
        settle("用整理出的步骤"); F.split = true; F.plan = plan; refreshSlip();
        if (plan) mount(aiRow(planCard()), true); else finishTask();
        return;
      }
      if (b.dataset.value === "yes") { settle("拆成步骤"); F.split = true; makePlan("create"); } else { answer("不用，直接加入", { split: false }, false).then(finishTask); }
    },
    retry() { settle("再试一次"); makePlan(F.lastMode === "regenerate" && hasPlan() ? "regenerate" : "create", F.lastFeedback); },
    "cancel-plan"() { F.ticket++; thread.querySelectorAll(".as-wait").forEach(n => n.closest(".as-row").remove()); F.busy = false; F.split = undefined; settle("先不拆了"); ask(false); },
    "toggle-regen"(b) { const r = thread.querySelector("[data-regen]"); if (r) { r.hidden = !r.hidden; scroll(); } },
    regen(b) { const [fb, label] = FEEDBACK[Number(b.dataset.i)] || ["", ""]; settle(label); makePlan("regenerate", fb); },
    create() { settle("加入 To-do"); addTask(true); },
    "create-plain"() { settle("只加任务，不拆"); addTask(false); },
    open() { openCreated(); },
    again() { restart(); }
  };

  /** Re-ask one answered field without replaying the whole conversation. */
  async function reopen(key) {
    if (F.busy || F.step === "done") return;
    const mine = ++F.ticket;
    thread.querySelectorAll(".as-live").forEach(n => n.closest(".as-row").remove());
    F.plan = null; F.busy = false;
    if (key === "date") Object.assign(F, { date: null, time: "", timeAsked: false, deadlineAsked:false });
    else if (key === "scene") F.scene = "";
    else if (key === "project") Object.assign(F, { project: "", projectAsked: false });
    else if (key === "repeat") Object.assign(F, { repeat: undefined, repeatDays: 0 });
    else if (key === "split") F.split = undefined;
    F.step = key; refreshSlip();
    await say(QUESTION[key](), "");
    if (mine !== F.ticket) return;
    const card = CARD[key];
    if (typeof card === "function" && card()) mount(aiRow(card()), true);
  }

  function acceptProject(name, label) {
    const project = String(name || "").trim();
    const used = project || "未分类";
    if (used !== "未分类" && typeof addProjectToPickers === "function") addProjectToPickers(used);
    answer(label || used, { project: used === "未分类" ? "" : used, projectAsked: true });
  }
  function acceptRepeatDays(value, label) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 365) { say("请输入 1 到 365 之间的整数天数。", ""); return false; }
    answer(label || (days + " 天"), { repeat: true, repeatDays: days });
    return true;
  }
  /* ---------- decompose + create ---------- */
  const deadlineValue = () => (F.date ? F.date + "T" + (F.time || "23:59") : "");

  async function makePlan(mode, feedback) {
    if (F.busy) return;
    const mine = ++F.ticket, user = account(), keep = F.plan;
    Object.assign(F, { busy: true, lastMode: mode, lastFeedback: feedback || "" });
    await say(mode === "regenerate" ? "好，换个思路重新排。" : "好，我来拆。先找出今天就能动手的第一步。", "");
    if (mine !== F.ticket) return;
    const wait = mount(aiRow(skeleton().replace('class="as-card as-live as-wait"', 'class="as-card as-live as-wait"')), true);
    try {
      const result = await B.api("/api/tasks/decompose", { method: "POST", body: JSON.stringify({ title: F.title, deadline: deadlineValue(), mode, feedback: feedback || "", previous: mode === "regenerate" ? keep : null, step: null }) });
      if (mine !== F.ticket || user !== account()) return;
      if (!stepsOf(result.plan).length) throw new Error("没有拆出步骤");
      F.plan = result.plan; F.busy = false; wait.remove();
      await say("拆好了，从第一步开始。", "");
      if (mine !== F.ticket) return;
      mount(aiRow(planCard()), true); refreshSlip();
    } catch (error) {
      if (mine !== F.ticket || user !== account()) return;
      F.busy = false; F.plan = mode === "regenerate" ? keep : null; wait.remove();
      if (error.code === "cloud_consent") B.emit?.("onboarding-required");
      await say("这次没拆成功：" + (error.message || "请稍后再试"), "");
      if (mine !== F.ticket) return;
      if (F.plan) mount(aiRow(planCard()), true); else mount(aiRow(retryCard("可以再试一次，或者只加任务。")), true);
      refreshSlip();
    }
  }

  function taskAttrs() {
    return { project: F.scene === "work" && F.projectAsked && F.project ? F.project : "未分类", priority: "other", reviewRequired: false, scenario: F.scene || "life" };
  }
  function addTask(withPlan) {
    if (needAccount()) return;
    const attrs = taskAttrs(), plan = withPlan && hasPlan() ? JSON.parse(JSON.stringify(F.plan)) : null;
    if (plan) stepsOf(plan).forEach(s => { s.done = false; });
    if (F.repeat) {
      if (!Array.isArray(typeof repeatTasks !== "undefined" ? repeatTasks : null) || typeof renderRecurringTasks !== "function") { say("To-do 还没加载好，请稍后再试。"); return; }
      const repeatDays = Number(F.repeatDays) || 7;
      if (!Number.isInteger(repeatDays) || repeatDays < 1 || repeatDays > 365) { say("循环天数需要是 1 到 365 之间的整数。", ""); return; }
      const id = "task_" + crypto.randomUUID();
      const startDay = typeof dateKey === "function" ? dateKey(new Date()) : ymd(now());
      const rule = { id, title: F.title, project: attrs.project, priority: attrs.priority, scenario: attrs.scenario, reviewRequired: attrs.reviewRequired, startDay, repeatDays };
      if (plan) rule.plan = plan;
      repeatTasks.push(rule);
      if (typeof renderedRepeatDay !== "undefined") renderedRepeatDay = "";
      renderRecurringTasks();
      if (typeof persistAppState === "function") persistAppState();
      F.created = { id, plan, kind: "task", repeat: true }; F.step = "done"; F.busy = false; F.ticket++;
      celebrate("已加入 To-do", "会按 " + repeatDays + " 天循环出现。");
      return;
    }
    const group = document.querySelector("#todoGroups .group");
    if (!group || typeof createTodoRow !== "function") { say("To-do 还没加载好，请稍后再试。"); return; }
    const id = "task_" + crypto.randomUUID();
    group.appendChild(createTodoRow({ id, title: F.title, project: attrs.project, difficulty: "easy", priority: attrs.priority, scenario: attrs.scenario,
      deadline: deadlineValue(), display: "", reviewRequired: attrs.reviewRequired, createdAt: new Date().toISOString(), plan, checklistId: plan ? "checklist:" + id : "" }));
    ["updateCounts", "applyTodoFilters", "persistAppState", "fillCurrentPushSlots"].forEach(n => { if (typeof window[n] === "function") window[n](); });
    F.created = { id, plan, kind: "task" }; F.step = "done"; F.busy = false; F.ticket++;
    celebrate(plan ? "已加入 To-do" : "已加入 To-do", plan ? "第一步：" + (stepsOf(plan).find(s => !s.done)?.title || "") : "它在 To-do 列表里了");
  }

  function addDone() {
    if (needAccount()) return;
    const list = document.getElementById("doneList");
    if (!list || typeof createDoneRow !== "function") { say("Done 还没加载好，请稍后再试。"); return; }
    const at = F.date ? new Date(F.date + "T" + (F.time || hm(now())) + ":00").getTime() : Date.now();
    const when = Number.isNaN(at) ? Date.now() : Math.min(at, Date.now());
    const id = "done_" + crypto.randomUUID();
    list.prepend(createDoneRow({ id, title: F.title, project: "未分类", difficulty: "easy", deadline: "", completed: when, reviewRequired: false, scenario: F.scene || "life", priority: "other",
      display: new Date(when).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }));
    ["updateCounts", "applyDoneFilters", "renderReviewList", "renderCal", "persistAppState"].forEach(n => { if (typeof window[n] === "function") window[n](); });
    F.created = { id, kind: "done" }; F.step = "done"; F.ticket++;
    celebrate("已记录到 Done", whenText(ymd(new Date(when)), hm(new Date(when)), now()));
  }

  const finishTask = () => { F.step = "ready"; addTask(false); };
  const finishDone = () => addDone();

  async function celebrate(title, sub) {
    refreshSlip();
    const rowAfter = await say(title + (sub ? "。" + sub : "。"), "");
    if (!rowAfter) return;
    const links = F.created?.kind === "task" && F.created.plan ? opt("open", "", "查看清单") : opt("open", "", F.created?.kind === "done" ? "去 Done" : "去 To-do");
    rowAfter.querySelector(".as-stack").insertAdjacentHTML("beforeend", '<div class="as-done-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21"/><path d="M15 25l6.5 6.5L33 18"/></svg></div>');
    if (F.created?.kind === "done") { const p = B.praise?.forChat({ type: "done", title: F.title }); if (p) { await say(p.text, p.extra); p.speak(); } }
    mount(aiRow(card(links + opt("again", "", "再来一个", F.linkQueue && F.linkQueue.length ? "下一件活动" : F.mode === "done" ? "继续记录" : "继续新建"), "as-opts")), true);
  }

  function openCreated() {
    const c = F.created; exitChat();
    if (!c) return;
    if (c.kind === "done") { window.showScreen?.("done"); return; }
    const row = [...document.querySelectorAll("#todoGroups .task-row")].find(r => {
      const id = r.querySelector(".todo-check")?.dataset.taskId || "";
      return id === c.id || (c.repeat && (id === "repeat:" + c.id || String(id).startsWith("repeat:" + c.id + ":")));
    });
    if (row?.taskPlan && B.decomposition?.open) B.decomposition.open(row); else window.showScreen?.("todo");
  }
  /* ---------- enter / leave the conversation ---------- */
  function showWelcome() {
    root.dataset.view = "welcome";
    root.innerHTML = avatarSprite() + welcomeHtml();
    thread = slipBox = null;
    input = root.querySelector("input[name=say]");
  }
  function enterChat() {
    root.dataset.view = "chat";
    root.innerHTML = avatarSprite() + chatHtml();
    thread = root.querySelector("[data-thread]"); slipBox = root.querySelector("[data-slip]");
    input = root.querySelector("input[name=say]");
    root.classList.add("is-enter"); setTimeout(() => root.classList.remove("is-enter"), 400);
  }
  function startMode(mode, keepThread) {
    if (needAccount()) return;
    F = fresh(mode, keepThread ? "again" : "mode");
    if (keepThread && root.dataset.view === "chat" && thread) refreshSlip();
    else enterChat();
    const done = mode === "done";
    (async () => {
      const mine = F.ticket;
      await say(done ? "好，补记一件已经做完的事。告诉我做了什么？" : "好，我们新建一个任务。用一句话告诉我要做什么？", "");
      if (mine !== F.ticket) return;
      const samples = SAMPLES[done ? "done" : "task"];
      mount(aiRow('<div class="as-chips as-live" role="group" aria-label="示例">' + samples.map((t, i) => '<button type="button" data-act="sample" data-i="' + i + '">' + esc(t) + '</button>').join("") + '</div>'), true);
      input?.focus({ preventScroll: true });
    })();
  }
  function restart() {
    if (needAccount()) return;
    const mode = F.mode;
    const queue = Array.isArray(F.linkQueue) ? F.linkQueue.slice() : [];
    F.ticket++;
    settle("再来一个");
    if (queue.length) { startExtracted(queue.shift(), queue, true); return; }
    startMode(mode, true);
  }
  function exitChat() {
    if (F) F.ticket++;
    if (typeof B.voice?.cancel === "function") B.voice.cancel();
    F = fresh("task");
    showWelcome();
  }

  /** Public: Manage's "+" and the dock's long-press come in here. */
  function open(options) {
    const o = options || {};
    if (needAccount()) return;
    B.taskHub?.leave?.();
    window.showScreen?.("start");
    startMode(o.mode === "done" ? "done" : "task");
    if (o.text) begin(o.text, "manage");
  }
  async function sayFromVoice(text) {
    if (needAccount()) return;
    if (root.dataset.view === "chat" && F.step === "say") { begin(text, "voice"); return; }
    if (root.dataset.view === "chat" && F.step !== "done") { input.value = text; input.form.requestSubmit(); return; }
    F = fresh("task", "voice"); begin(text, "voice");
  }

  /* ---------- events ---------- */
  function onClick(event) {
    const b = event.target.closest("[data-act]");
    if (b && root.contains(b) && act[b.dataset.act]) { event.preventDefault(); act[b.dataset.act](b); }
  }
  function onSubmit(event) {
    const form = event.target.closest("[data-form]"); if (!form) return;
    event.preventDefault();
    const kind = form.dataset.form;
    if (kind === "title") { const v = form.elements.t.value.trim(); F.title = v ? Array.from(v).slice(0, 80).join("") : F.title; F.editing = false; refreshSlip(); return; }
    const text = form.elements.say.value.trim(); if (!text) return;
    form.elements.say.value = "";
    if (kind === "start") { F = fresh("task"); begin(text, "web"); return; }
    if (F.step === "say") { begin(text, "web"); return; }
    typedAnswer(text);
  }
  /** Typing during a question is read as the answer to it (a date, a clock time or a scene). */
  function typedAnswer(text) {
    if (F.step === "date") { const r = read(text, now()); if (r.date) { settle(text); Object.assign(F, { date: r.date, time: r.time || F.time, deadlineAsked:true, timeAsked:F.mode === "task" }); refreshSlip(); ask(false); return; } }
    if (F.step === "time") { const r = read("今天" + text, now()); if (r.time) { settle(text); Object.assign(F, { time: r.time, timeAsked: true }); refreshSlip(); ask(false); return; } }
    if (F.step === "scene") { const s = G.readScene(text) || (/工作/.test(text) ? "work" : /生活/.test(text) ? "life" : ""); if (s) { settle(text); Object.assign(F, {scene: s, project: "", projectAsked: s === "life"}); refreshSlip(); ask(false); return; } }
    if (F.step === "project" || F.step === "projectNew") {
      const name = Array.from(text.trim()).slice(0, 40).join("");
      if (name) { acceptProject(name, text); return; }
    }
    if (F.step === "repeat") {
      if (/不(用)?循环|不必|不用/.test(text) && !/需要|要循环/.test(text)) { settle(text); Object.assign(F, { repeat: false, repeatDays: 0 }); refreshSlip(); ask(false); return; }
      const n = Number((text.match(/(\d{1,3})/) || [])[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 365) { settle(text); Object.assign(F, { repeat: true, repeatDays: n }); refreshSlip(); ask(false); return; }
    }
    if (F.step === "repeatDays") { if (acceptRepeatDays(Number((text.match(/\d{1,3}/) || [])[0]), text)) return; return; }
    userSays(text);
    say("这一步点上面的选项就行，也可以按住麦克风说。", "");
  }
  function onChange(event) {
    const t = event.target;
    if (t.matches("[data-date-input]") && t.value) { const key = t.value; answer(whenText(key, "", now()), { date: key, timeAsked: false }); }
    else if (t.matches("[data-time-input]") && t.value) answer(t.value, { time: t.value, timeAsked: true });
  }

  /* ---------- microphone ---------- */
  function paintMic(next, message) {
    const mics = root.querySelectorAll("[data-mic]"), failed = next === "error" || next === "unavailable";
    mics.forEach(b => { b.dataset.state = next; b.setAttribute("aria-pressed", String(next === "recording")); });
    const note = root.querySelector("[data-note]") || root.querySelector("[data-state]");
    if (note && root.dataset.view === "welcome") {
      note.textContent = failed ? message : next === "recording" ? "在听，说完松开" : next === "recognizing" ? "正在听写…" : next === "loading" ? "正在准备麦克风…" : (canSpeak() ? "按住麦克风说话，普通话、English、粤语都行" : "当前浏览器不能录音，直接打字也一样");
      note.classList.toggle("is-error", failed);
    } else if (note) note.textContent = failed ? message : next === "recording" ? "正在听…" : next === "recognizing" ? "正在听写…" : next === "loading" ? "准备麦克风…" : (F.mode === "done" ? "记录完成事件" : "新建任务");
    root.classList.toggle("is-listening", next === "recording");
  }
  function wireMic() {
    let origin = null, since = 0;
    const btn = event => event.target.closest("[data-mic]");
    const begin = () => B.voice.beginHold({ onText: text => { paintMic("idle", ""); return sayFromVoice(text); }, onState: paintMic });
    const finish = cancelled => {
      if (!origin) return;
      const quick = Date.now() - since < 350; origin = null;
      root.querySelectorAll("[data-mic]").forEach(b => b.classList.remove("is-held"));
      if (cancelled) B.voice.cancel(); else B.voice.endHold();
      if (!cancelled && quick) paintMic("error", "按住不放，说完再松开");
    };
    root.addEventListener("pointerdown", event => {
      const b = btn(event); if (!b || event.button !== 0 || origin) return;
      if (!canSpeak()) { paintMic("unavailable", "当前浏览器不能录音，直接打字也一样"); return; }
      origin = { id: event.pointerId, x: event.clientX, y: event.clientY }; since = Date.now();
      b.setPointerCapture?.(event.pointerId); b.classList.add("is-held"); begin();
    });
    root.addEventListener("pointermove", event => { if (origin?.id === event.pointerId && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 96) finish(true); });
    root.addEventListener("pointerup", event => { if (origin?.id === event.pointerId) finish(false); });
    root.addEventListener("pointercancel", () => finish(true));
    root.addEventListener("lostpointercapture", () => finish(true));
    root.addEventListener("contextmenu", event => { if (btn(event)) event.preventDefault(); });
    root.addEventListener("keydown", event => {
      if (event.code !== "Space" || event.repeat || origin || !btn(event) || !canSpeak()) return;
      event.preventDefault(); origin = { id: "key", x: 0, y: 0 }; since = Date.now(); begin();
    });
    root.addEventListener("keyup", event => { if (event.code === "Space" && origin?.id === "key") { event.preventDefault(); finish(false); } });
    window.addEventListener("blur", () => finish(true));
  }

  /* ---------- mount ---------- */
  function init() {
    const screen = document.getElementById("startScreen");
    if (!screen) return;
    root = document.createElement("section"); root.id = "taskAssistant"; root.className = "assistant"; root.setAttribute("aria-label", "AI 助手");
    screen.classList.add("has-assistant");
    screen.prepend(root);
    F = fresh("task");
    showWelcome();
    root.addEventListener("click", onClick); root.addEventListener("submit", onSubmit); root.addEventListener("change", onChange);
    // Match the visible viewport when the iOS keyboard opens, without changing scale.
    const viewport = window.visualViewport;
    const fitKeyboard = () => {
      const phone = screen.closest(".phone"), focused = root.contains(document.activeElement) && document.activeElement.matches("input,textarea");
      const keyboard = Boolean(viewport && focused && innerHeight - viewport.height > 120 && matchMedia("(max-width:700px)").matches);
      phone?.classList.toggle("as-keyboard", keyboard);
      if (keyboard) phone?.style.setProperty("--as-visible-height", viewport.height + "px");
      else phone?.style.removeProperty("--as-visible-height");
    };
    viewport?.addEventListener("resize", fitKeyboard);
    root.addEventListener("focusin", fitKeyboard); root.addEventListener("focusout", () => setTimeout(fitKeyboard, 0));
    wireMic();
    B.event?.addEventListener("auth", () => { F.ticket++; F = fresh("task"); showWelcome(); });
    document.addEventListener("task-navigation", () => { if (root.dataset.view === "chat" && F.step === "done" && activeScreen() !== "start") showWelcome(); });
  }
  B.assistant = { open, say: sayFromVoice, exit: exitChat };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
