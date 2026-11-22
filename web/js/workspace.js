/* Three destinations, one account-owned dataset. Grouping is visual; only
   explicitly saved links are drawn as relationships. */
(function () {
  "use strict";
  const B = window.Task = window.Task || {};
  const escape = value => B.escape(String(value ?? ""));
  const groups = { task: "Tasks", idea: "Ideas", routine: "Checklist" };
  const relationNames = { related: "相关", inspires: "启发", supports: "支持", precedes: "前置" };
  let routines = [], loading = false, loadError = "", request = 0;
  let timelineMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1), timelineRoutines = [], timelineRange = "", timelineRequest = 0;
  let mode = "timeline", kind = "all", view = "todo", query = "", includeDone = false, selected = null;
  const MANAGE_PAGES = ["home", "todo", "done", "routine", "idea", "all"];
  let manage = "home", userKey = null;
  let root, board, content, detail, tabs;
  let refreshScheduled = false;

  function owner() { return typeof currentUser !== "undefined" ? currentUser?.id || null : null; }
  function nodes() {
    if (!owner()) return [];
    const state = readAppState();
    const tasks = [...state.todo.map(item => ({ ...item, completed: false })),
      ...state.done.map(item => ({ ...item, doneAt: item.completed, completed: true }))];
    return [
      ...tasks.map(item => ({ id: "task:" + item.id, sourceId: item.id, kind: "task", title: item.title,
 meta: item.completed ? "已完成" : item.project || "未分类", completed: item.completed, important: Boolean(item.important), project: item.project || "未分类",
        scenario: item.scenario || "life", deadline: item.deadline || "", doneAt: item.doneAt || null, plan: item.plan || null })),
      ...(state.repeatTasks || []).flatMap(rule => {
        const today = B.dayKey();
        let day = rule.startDay > today ? rule.startDay : today;
        const end = shiftDay(rule.startDay, Number(rule.repeatDays));
        while (day < end && state.done.some(item => item.repeatId === rule.id && item.occurrenceDay === day)) day = shiftDay(day, 1);
        return day < end ? [{ id: "task:repeat:" + rule.id, sourceId: rule.id, kind: "task", title: rule.title,
          meta: "循环 · " + (rule.project || "未分类"), project: rule.project || "", plan: rule.occurrencePlans?.[day] || rule.plan || null, completed: false, scenario: rule.scenario || "life", repeating: true, repeatDay: day }] : [];
      }),
      ...state.ideas.map(item => ({ id: "idea:" + item.id, sourceId: item.id, kind: "idea", title: item.text, meta: "灵感", completed: false, createdAt: item.createdAt || "" })),
      ...routines.map(item => ({ id: "routine:" + item.id, sourceId: item.id, kind: "routine", title: item.title,
        meta: item.checked ? "今天已完成" : "今天未完成", completed: item.checked, scenario: item.scenario || "life", steps: Array.isArray(item.steps) ? item.steps.length : 0 })),
    ];
  }
  function filtered() {
    return nodes().filter(item => (kind === "all" || item.kind === kind) &&
      (includeDone || item.kind !== "task" || !item.completed) &&
      (!query || (item.title + " " + item.meta).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  }
  function monthRange() {
    const from = `${timelineMonth.getFullYear()}-${String(timelineMonth.getMonth()+1).padStart(2,"0")}-01`;
    const to = `${timelineMonth.getFullYear()}-${String(timelineMonth.getMonth()+1).padStart(2,"0")}-${String(new Date(timelineMonth.getFullYear(),timelineMonth.getMonth()+1,0).getDate()).padStart(2,"0")}`;
    return { from, to, key: from.slice(0,7) };
  }
  function dayOf(value) {
    if (!value) return "";
    const date = new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T12:00:00" : value);
    return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  }
  // 23:59 is the "no clock time" deadline default, so it stays hidden unless the time is a real record (exact).
  function timeOf(value, exact) {
    if (!value || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const text = `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
    return text === "23:59" && !exact ? "" : text;
  }
  function gapText(minutes) {
    const m = Math.round(minutes);
    if (m < 1) return "";
    return "间隔 " + (m < 60 ? m + " 分钟" : Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : ""));
  }
  const KIND_ICON = { task: "□", idea: "◇", routine: "↻" };
  function timelineItems() {
    const { from, to } = monthRange(), state = readAppState(), events = [];
    const inRange = day => day && day >= from && day <= to;
    const dims = item => typeof taskDimsText === "function" ? taskDimsText(item, false) : "";
    const add = (day, kind, title, label, id, completed, at, info = "", scenario = "life", exact = false) => {
      if (inRange(day) &&
        (!query || (title + " " + label + " " + info).toLocaleLowerCase().includes(query.toLocaleLowerCase()))) {
        const time = timeOf(at, exact);
        events.push({ day, kind, title, label, id, completed: Boolean(completed), time, ms: time ? new Date(at).getTime() : NaN, info });
      }
    };
    const completedByOccurrence = new Set(state.done.filter(item => item.repeatId).map(item => `${item.repeatId}|${item.occurrenceDay}`));
    state.done.forEach(item => add(dayOf(item.completed), "task", item.title, "", item.id, true, item.completed, dims(item), item.scenario, true));
    state.todo.forEach(item => { const day = dayOf(item.deadline || item.createdAt); if(day) add(day, "task", item.title, item.deadline ? "截止" : "", item.id, false, item.deadline || item.createdAt || null, dims(item), item.scenario, !item.deadline); });
    state.ideas.forEach(item => add(dayOf(item.createdAt), "idea", item.text, "", item.id, false, item.createdAt, "", "life", true));
    timelineRoutines.forEach(item => add(item.day, "routine", item.title, "", item.id, true, null, dims({ scenario: item.scenario }), item.scenario));
    (state.repeatTasks || []).forEach(rule => {
      let day = rule.startDay;
      for (let index = 0; index < Number(rule.repeatDays) && day <= to; index++, day = shiftDay(day, 1)) {
        if (day < from || completedByOccurrence.has(`${rule.id}|${day}`)) continue;
        add(day, "task", rule.title, "", rule.id, false, null, dims({ ...rule, repeatId: rule.id }), rule.scenario);
      }
    });
    return events.sort((a,b) => b.day.localeCompare(a.day) || (a.time || '99').localeCompare(b.time || '99'));
  }
  function shiftDay(day, offset) {
    const [year,month,date] = day.split("-").map(Number);
    return new Date(Date.UTC(year,month-1,date+offset)).toISOString().slice(0,10);
  }
  async function loadTimelineRoutines() {
    const range = monthRange();
    if (timelineRange === range.key || !owner()) { schedule(); return; }
    const seq = ++timelineRequest, activeOwner = owner();
    timelineRange = range.key;
    timelineRoutines = [];
    try {
      const result = await B.api(`/api/routines/timeline?from=${range.from}&to=${range.to}`);
      if (seq !== timelineRequest || owner() !== activeOwner) return;
      timelineRoutines = result.events || [];
    } catch { if (seq === timelineRequest) timelineRoutines = []; }
    schedule();
  }
  function schedule() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => { refreshScheduled = false; render(); });
  }
  function choose(id) {
    selected = id;
    renderDetail();
    content.querySelectorAll("[data-node]").forEach(button => button.classList.toggle("is-selected", button.dataset.node === id));
    detail.querySelector("[data-close-detail]")?.focus({ preventScroll: true });
    detail.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
  function openNode(node) {
    if (!node) return;
    if (node.kind === "task" && node.repeating) { openTimelineItem("task", node.repeatDay, node.sourceId); return; }
    if (node.kind === "routine") B.dates?.set("routine", B.dayKey());
    navigate("manage", node.kind === "task" ? node.completed ? "done" : "todo" : node.kind, true);
    const row = node.kind === "task"
      ? [...document.querySelectorAll(node.completed ? "#doneList .done-row" : "#todoTasksView .task-row")].find(el => (el.dataset.taskId || el.querySelector(".todo-check")?.dataset.taskId) === node.sourceId || (node.repeating && el.dataset.repeatId === node.sourceId))
      : node.kind === "idea" ? [...document.querySelectorAll("#ideaList .idea-row")].find(el => el.dataset.ideaId === node.sourceId)
      : [...document.querySelectorAll("[data-rt-check]")].find(el => el.dataset.rtCheck === node.sourceId)?.closest(".task-routine-item");
    if (node.kind === "idea") B.dates?.set("idea", dateKey(new Date(row?.dataset.createdAt || Date.now())));
    if (node.kind === "task") {
      const raw = readAppState()[node.completed ? "done" : "todo"].find(item => item.id === node.sourceId);
      const key = node.completed ? completedDateKey(row) : dateKey(raw?.deadline || new Date());
      if (key) B.dates?.set(node.completed ? "done" : "todo", key);
      document.querySelectorAll(node.completed ? "#doneProjectFilter,#doneDifficultyFilter" : "#todoProjectFilter,#todoDifficultyFilter").forEach(el => { el.dataset.value = ""; });
      if (node.completed) applyDoneFilters(); else applyTodoFilters();
    }
    row?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    if (row) { row.classList.add("ws-highlight"); setTimeout(() => row.classList.remove("ws-highlight"), 1800); }
  }
  function renderDetail() {
    const all = nodes(), node = all.find(item => item.id === selected);
    if (!node) { selected = null; detail.hidden = true; return; }
    detail.hidden = false;
    const linked = overviewLinks.filter(link => (link.from === node.id || link.to === node.id) && all.some(item => item.id === (link.from === node.id ? link.to : link.from)));
    detail.innerHTML = '<div class="ws-detail-head"><span>' + groups[node.kind] + '</span><button type="button" data-close-detail aria-label="关闭详情">×</button></div>' +
      '<h2>' + escape(node.title) + '</h2><p>' + escape(node.meta) + '</p><button type="button" class="ws-light-button" data-open-node>在 My Tasks 中打开 ↗</button>' +
      (node.kind === "task" && !node.completed ? '<button type="button" class="ws-light-button" data-complete-node>标记完成</button>' : '') +
      '<h3>关联</h3><div class="ws-links">' + (linked.map(link => {
        const other = all.find(item => item.id === (link.from === node.id ? link.to : link.from));
        return '<div><span>' + (link.from === node.id ? '→ ' : '← ') + escape(relationNames[link.kind] || "相关") + ' · ' + escape(other.title) + '</span><button type="button" data-remove-link="' + escape(link.id) + '" aria-label="移除此关联">×</button></div>';
      }).join('') || '<p class="ws-muted">尚未添加关联。</p>') + '</div>' +
      '<form id="wsLinkForm"><label>连接到<select id="wsLinkTarget" required><option value="">选择内容</option>' + all.filter(item => item.id !== node.id).map(item => '<option value="' + escape(item.id) + '">' + groups[item.kind] + ' · ' + escape(item.title) + '</option>').join('') + '</select></label>' +
      '<label>关系<select id="wsLinkKind">' + Object.entries(relationNames).map(([value, label]) => '<option value="' + value + '">' + label + '</option>').join('') + '</select></label><button type="submit" class="ws-light-button">添加关联</button><p id="wsLinkStatus" role="status"></p></form>';
    detail.querySelector("[data-close-detail]").onclick = () => { selected = null; detail.hidden = true; };
    detail.querySelector("[data-open-node]").onclick = () => openNode(node);
    const complete = detail.querySelector("[data-complete-node]");
    if (complete) complete.onclick = () => {
      if (node.repeating) B.dates?.set("todo", node.repeatDay);
      const row = [...document.querySelectorAll("#todoTasksView .task-row")].find(el => el.querySelector(".todo-check")?.dataset.taskId === node.sourceId || (node.repeating && el.dataset.repeatId === node.sourceId));
      row?.querySelector(".todo-check")?.click();
      schedule();
    };
    detail.querySelectorAll("[data-remove-link]").forEach(button => button.onclick = () => {
      overviewLinks = overviewLinks.filter(link => link.id !== button.dataset.removeLink);
      persistAppState(); render();
    });
    detail.querySelector("#wsLinkForm").onsubmit = event => {
      event.preventDefault();
      const to = detail.querySelector("#wsLinkTarget").value, linkKind = detail.querySelector("#wsLinkKind").value;
      if (!to || !requireAccount()) return;
      if (overviewLinks.some(link => link.from === node.id && link.to === to && link.kind === linkKind)) {
        detail.querySelector("#wsLinkStatus").textContent = "这条关联已存在。"; return;
      }
      overviewLinks.push({ id: crypto.randomUUID(), from: node.id, to, kind: linkKind });
      persistAppState(); render();
    };
  }
  function render() {
    if (!content) return;
    const all = filtered();
    board.querySelector("#wsMonth").textContent = `${timelineMonth.getFullYear()}.${String(timelineMonth.getMonth()+1).padStart(2,"0")}`;
    board.querySelector("#wsRoutineStatus").innerHTML = loadError ? '日常清单加载失败 <button type="button" id="wsRetry">重试</button>' : '';
    board.querySelector("#wsRetry")?.addEventListener("click", loadRoutines);
    if (!owner()) {
      board.querySelector("#wsChips").innerHTML = "";
      content.innerHTML = '<div class="ws-empty"><h2>给想法和行动一个位置。</h2><p>登录后，在这里按时间看见任务、灵感和日常。</p><button type="button" class="ws-light-button" id="wsSignIn">登录或注册</button></div>';
      content.querySelector("#wsSignIn").onclick = () => openAuthDialog();
      detail.hidden = true; return;
    }
    const everything = timelineItems(), today = B.dayKey();
    const counts = { all: everything.length, task: 0, idea: 0, routine: 0 };
    everything.forEach(item => { counts[item.kind] += 1; });
    board.querySelector("#wsChips").innerHTML = [["all","全部"],["task","任务"],["idea","灵感"],["routine","清单"]].map(([key, label]) =>
      '<button type="button" data-kind="' + key + '" aria-pressed="' + (kind === key) + '">' + label + '<b>' + counts[key] + '</b></button>').join('');
    const inView = item => view === "routine" ? item.kind === "routine" : item.kind === "task" && (view === "done" ? item.completed : !item.completed);
    const events = everything.filter(inView), grouped = new Map();
    events.forEach(item => { if (!grouped.has(item.day)) grouped.set(item.day, []); grouped.get(item.day).push(item); });
    const week = ['日','一','二','三','四','五','六'];
    content.innerHTML = grouped.size ? '<ol class="ws-tl">' + [...grouped.entries()].map(([day, items]) => {
      const when = day === today ? "is-today" : day > today ? "is-future" : "is-past";
      return '<li class="ws-tl-day ' + when + '"><div class="ws-tl-date"><strong>' + Number(day.slice(-2)) + '</strong><span>' + (day === today ? '今天' : '周' + week[new Date(day + 'T12:00:00').getDay()]) + '</span></div><div class="ws-tl-events">' +
        items.map((item, index) => {
          const check = item.kind === "task" ? (item.completed ? '<span class="tcheck is-done" aria-label="已完成"></span>' : '<button type="button" class="tcheck" data-tl-done="' + escape(item.id) + '" data-tl-day="' + item.day + '" aria-label="完成 ' + escape(item.title) + '"></button>') : item.kind === "routine" ? '<span class="tcheck is-done" aria-label="已完成"></span>' : '<span class="tcheck is-none" aria-hidden="true"></span>';
          const small = [item.label === '截止' ? '<span class="ws-tl-due">截止</span>' : '', escape(item.info)].filter(Boolean).join(' · ');
          const previous = items[index - 1], gap = previous && Number.isFinite(previous.ms) && Number.isFinite(item.ms) ? gapText((item.ms - previous.ms) / 60000) : "";
          return (gap ? '<div class="ws-tl-gap" aria-label="' + gap + '"><i aria-hidden="true"></i><span>' + gap + '</span></div>' : '') +
            '<div class="ws-tl-event is-' + item.kind + (item.completed ? ' is-complete' : '') + (item.label === '截止' ? ' is-deadline' : '') + '"><time class="ws-tl-time">' + (item.time || '') + '</time>' + check +
            '<button type="button" class="ws-tl-open" data-timeline-kind="' + item.kind + '" data-timeline-day="' + item.day + '" data-timeline-id="' + escape(item.id) + '"><strong>' + escape(item.title) + '</strong>' + (small ? '<small>' + small + '</small>' : '') + '</button>' + B.kindIcon(item.kind) + '</div>';
        }).join('') +
        '</div></li>';
    }).join('') + '</ol>' : '<div class="ws-timeline-empty"><strong>' + (query ? '没有匹配的记录' : '这个月还没有记录') + '</strong><span>完成任务、写下灵感或勾完清单后，会按天出现在这里。</span></div>';
    content.querySelectorAll('[data-timeline-kind]').forEach(button => button.onclick = () => openTimelineItem(button.dataset.timelineKind, button.dataset.timelineDay, button.dataset.timelineId));
    content.querySelectorAll('[data-tl-done]').forEach(button => button.onclick = () => {
      const id = button.dataset.tlDone, day = button.dataset.tlDay;
      const row = [...document.querySelectorAll('#todoGroups .task-row')].find(el => (el.querySelector('.todo-check')?.dataset.taskId === id) || (el.dataset.repeatId === id && el.dataset.occurrenceDay === day));
      if (!row) { openTimelineItem('task', day, id); return; }
      if (row.taskPlan) { B.decomposition?.open(row); return; }
      button.classList.add('is-done'); completeTask(row.querySelector('.todo-check')); schedule();
    });
    content.querySelectorAll("[data-node]").forEach(button => { button.onclick = () => choose(button.dataset.node); button.classList.toggle("is-selected", button.dataset.node === selected); });
    renderDetail();
  }
  function openTimelineItem(kind, day, id) {
    if (kind === "task") {
      const done = readAppState().done.some(item => String(item.id) === id);
      B.dates?.set(done ? "done" : "todo", day); navigate("manage", done ? "done" : "todo", true);
      const row = [...document.querySelectorAll(done ? "#doneList .done-row" : "#todoTasksView .task-row")].find(item => (item.dataset.taskId || item.querySelector(".todo-check")?.dataset.taskId) === id || item.dataset.repeatId === id);
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (kind === "idea") {
      B.dates?.set("idea", day); navigate("manage", "idea", true);
    } else {
      B.dates?.set("routine", day); navigate("manage", "routine", true);
    }
  }
  async function loadRoutines() {
    const activeOwner = owner(), seq = ++request;
    if (!activeOwner) { routines = []; loadError = ""; schedule(); return; }
    loading = true; loadError = ""; schedule();
    try {
      const result = await B.api("/api/routines?day=" + B.dayKey());
      if (seq !== request || owner() !== activeOwner) return;
      routines = result.items || [];
    } catch (error) {
      if (seq !== request || owner() !== activeOwner) return;
      routines = []; loadError = error.status === 401 ? "" : "error";
    } finally { if (seq === request) { loading = false; schedule(); } }
  }
  function mountManage(name) {
    if (!MANAGE_PAGES.includes(name)) { tabs.hidden = true; return; }
    manage = name;
    const cur = name === "all" ? view : name;
    try { sessionStorage.setItem("task-manage-section", name === "all" ? view : name); } catch {}
    const screen = document.getElementById(name + "Screen");
    screen.prepend(tabs); tabs.hidden = false;
    tabs.innerHTML = '<header class="ws-bar"><h1>My Tasks</h1><button type="button" class="ws-add" id="wsManageAdd" aria-label="新增">＋</button></header><nav class="ws-manage-tabs ws-chips" aria-label="管理内容">' + [["home","今天"],["todo","To-do"],["done","Done"],["routine","Checklist"]].map(([key,label]) => '<button type="button" data-manage="' + key + '" aria-current="' + (key === cur ? 'page' : 'false') + '" aria-pressed="' + (key === cur) + '">' + label + '</button>').join('') + '</nav>';
    tabs.querySelectorAll("[data-manage]").forEach(button => button.onclick = () => navigate("manage", button.dataset.manage));
    // One add button per section, in the compact bar; the screens' own headers are hidden by CSS.
    tabs.querySelector("#wsManageAdd").onclick = () => {
      if (cur === "todo" || cur === "home") openTaskForm("");
      else if (cur === "done") document.getElementById("newEvent")?.click();
      else if (cur === "routine") document.getElementById("checklistNew")?.click();
      else { const input = document.getElementById("ideaInput"); input?.scrollIntoView({ block: "center" }); input?.focus(); }
    };
  }
  function navigate(destination, section, drill) {
    if (destination === "manage") {
      if (!drill && ["todo", "done", "routine"].includes(section)) { view = section; section = "all"; }
      window.showScreen(section || manage);
    }
    else window.showScreen(destination);
  }
  function init() {
    try { const saved = sessionStorage.getItem("task-manage-section"); if (saved === "home") manage = "home"; else if (["todo", "done", "routine"].includes(saved)) { view = saved; manage = "all"; } } catch {}
    root = document.createElement("section"); root.id = "overviewScreen"; root.className = "screen work hidden ws-overview";
    root.innerHTML = '<header class="ws-bar"><h1>Task Pull</h1></header>';
    document.querySelector(".phone").appendChild(root); screens.overview = root;
    board = document.createElement("section"); board.id = "allScreen"; board.className = "screen work hidden ws-all";
    board.innerHTML = '<div class="ws-tools"><div class="ws-tools-row"><input type="search" id="wsSearch" placeholder="搜索" aria-label="搜索"><div class="ws-month"><button type="button" data-month-shift="-1" aria-label="上个月">‹</button><span id="wsMonth"></span><button type="button" data-month-shift="1" aria-label="下个月">›</button></div></div><div id="wsChips" class="ws-chips" role="group" aria-label="类型筛选"></div></div><div id="wsRoutineStatus" role="status"></div><div id="wsContent" class="ws-timeline"></div><aside id="wsDetail" class="ws-detail" aria-label="内容详情" hidden></aside>';
    document.querySelector(".phone").appendChild(board); screens.all = board;
    content = board.querySelector("#wsContent"); detail = board.querySelector("#wsDetail");
    tabs = document.createElement("div"); tabs.id = "wsManage";
    B.dates.subscribe("routine", () => { if (mode === "timeline") { timelineRange = ""; loadTimelineRoutines(); } });
    board.addEventListener("click", event => {
      const chip = event.target.closest("[data-kind]");
      if (chip) { kind = chip.dataset.kind; render(); return; }
      const shift = event.target.closest("[data-month-shift]");
      if (shift) { timelineMonth = new Date(timelineMonth.getFullYear(), timelineMonth.getMonth() + Number(shift.dataset.monthShift), 1); timelineRange = ""; render(); loadTimelineRoutines(); }
    });
    board.querySelector("#wsSearch").oninput = event => { query = event.target.value; schedule(); };
    const original = window.showScreen;
    window.showScreen = function (name) {
      if (name === "manage") name = manage;
      original(name);
      const active = Object.entries(screens).find(([, screen]) => !screen.classList.contains("hidden"))?.[0];
      mountManage(active);
      if (active === "all") { render(); loadTimelineRoutines(); }
      document.dispatchEvent(new Event("task-navigation"));
    };
    const observer = new MutationObserver(schedule);
    ["todoTasksView","doneList","ideaList"].forEach(id => observer.observe(document.getElementById(id), { childList: true, subtree: true, characterData: true }));
    B.event.addEventListener("auth", () => { if (owner() !== userKey) { userKey = owner(); selected = null; routines = []; timelineRoutines = []; timelineRange = ""; detail.hidden = true; } loadRoutines(); if (mode === "timeline") loadTimelineRoutines(); });
    B.event.addEventListener("onboarded", loadRoutines);
    B.event.addEventListener("task-record", loadRoutines);
    B.event.addEventListener("routines-updated", event => { timelineRange = ""; if (mode === "timeline") loadTimelineRoutines(); if (owner() && event.detail.day === B.dayKey()) { routines = event.detail.items; schedule(); } });
    B.workspace = { navigate, refresh: loadRoutines, nodes };
    window.showScreen("overview");
    loadRoutines();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
