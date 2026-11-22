/* Home: a board that sums up the day. It does not list every task (My Tasks does). It shows the cards pulled on
   Task Pull, today's three nearest tasks, what is already done, and the Task Pull entry. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const hm = m => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const gap = m => { const h = Math.floor(m / 60), r = m % 60; return h === 0 ? r + " 分钟" : r === 0 ? h + " 小时" : h + " 小时 " + r + " 分"; };
  const steps = plan => (plan?.stages || []).flatMap(stage => stage.steps || []);
  function progress(plan) {
    const all = steps(plan), next = all.find(step => !step.done);
    return all.length ? { total: all.length, done: all.filter(step => step.done).length, next: next?.title || "" } : null;
  }
  /** Due day (yyyy-mm-dd) and clock minute of a task. 23:59 is the "any time that day" default, so it has no minute. */
  function dueDay(node) {
    if (node.repeating) return node.repeatDay || "";
    const when = node.deadline ? new Date(node.deadline) : null;
    return when && !Number.isNaN(when.getTime()) ? ymd(when) : "";
  }
  function dueMinute(node) {
    if (node.repeating || !node.deadline) return null;
    const when = new Date(node.deadline);
    if (Number.isNaN(when.getTime())) return null;
    const minute = when.getHours() * 60 + when.getMinutes();
    return minute === 1439 ? null : minute;
  }
  const nextDay = now => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const minuteOf = d => d.getHours() * 60 + d.getMinutes();
  const isLate = (node, now) => { const day = dueDay(node), minute = dueMinute(node); return Boolean(day) && (day < ymd(now) || (day === ymd(now) && minute != null && minute < minuteOf(now))); };
  const shortDate = day => Number(day.slice(5, 7)) + "/" + Number(day.slice(8));
  function dueText(node, now) {
    const day = dueDay(node), today = ymd(now), minute = dueMinute(node), at = minuteOf(now);
    if (!day) return "";
    if (day < today) return "已逾期 " + Math.round((new Date(today) - new Date(day)) / 864e5) + " 天";
    if (day === today) return minute == null ? "今天内完成" : minute > at ? hm(minute) + " 截止，还有 " + gap(minute - at) : hm(minute) + " 已过，逾期 " + gap(at - minute);
    return (day === nextDay(now) ? "明天" : Number(day.slice(5, 7)) + "月" + Number(day.slice(8)) + "日") + (minute == null ? "" : " " + hm(minute)) + " 截止";
  }
  const sortKey = n => (dueDay(n) || "9999-12-31") + String(dueMinute(n) ?? 1439).padStart(4, "0");
  /** Everything the board shows, computed from workspace nodes. Overdue tasks count as today. */
  function summarize(nodes, now) {
    const today = ymd(now), tomorrow = nextDay(now);
    const tasks = nodes.filter(n => n.kind === "task");
    const open = tasks.filter(n => !n.completed).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    const done = tasks.filter(n => n.completed && Number(n.doneAt) > 1e11 && ymd(new Date(Number(n.doneAt))) === today);
    const buckets = { today: [], tomorrow: [], later: [], none: [] };
    open.forEach(n => { const d = dueDay(n); buckets[!d ? "none" : d <= today ? "today" : d === tomorrow ? "tomorrow" : "later"].push(n); });
    const rows = [...buckets.today.filter(n => dueDay(n) === today), ...done.filter(n => dueDay(n) === today)]
      .filter(n => dueMinute(n) != null).map(n => ({ node: n, minute: dueMinute(n), done: Boolean(n.completed) })).sort((a, b) => a.minute - b.minute);
    return { today, open, done, buckets, rows, late: buckets.today.filter(n => isLate(n, now)).length, total: done.length + buckets.today.length };
  }
  /** The cards chosen on Task Pull, read from its rendered slots (that page keeps them private). Done or deleted tasks drop out. */
  function pulled(open) {
    const used = new Set(), out = [];
    document.querySelectorAll("#taskDraw .dr-slot").forEach(slot => {
      const title = (slot.querySelector(".dr-chosen")?.getAttribute("aria-label") || "").replace(/^已选任务：/, "");
      const node = title && open.find(n => n.title === title && !used.has(n.id));
      if (node) { used.add(node.id); out.push({ node, slot: Number(slot.dataset.slot) }); }
    });
    return out;
  }
  const account = () => typeof currentUser !== "undefined" ? currentUser?.id || null : null;
  let root, body, scheduled = false;
    const head = now => '<header class="hm-head"><h1>周' + WEEK[now.getDay()] + " " + (now.getMonth() + 1) + " 月 " + now.getDate() + " 日</h1></header>";
  const tile = (cls, label, body, right) => '<section class="hm-tile ' + cls + '" aria-label="' + label + '"><div class="hm-th"><b>' + label + "</b>" + (right ? "<span>" + right + "</span>" : "") + "</div>" + body + "</section>";
  function pullHtml(picked) {
    const n = picked.length;
    return '<button type="button" class="hm-tile hm-pull hm-wide" data-hm="pull" aria-label="进入抽牌"><div class="hm-fan" aria-hidden="true">' + [0, 1, 2].map(i => '<div class="hm-mc' + (i < n ? " on" : "") + '"></div>').join("") +
      "</div><div><strong>抽三件事<span>›</span></strong><small" + (n && n < 3 ? ' class="pend"' : "") + ">" + (n === 0 ? "今天还没抽，点开开始" : n < 3 ? "已抽 " + n + " 件，还能再抽 " + (3 - n) + " 件" : "已抽满，做完一件再抽") + "</small></div></button>";
  }
  function todoHtml(s, now) {
    const rows = s.buckets.today.slice(0, 3).map(n => {
      const minute = dueMinute(n), late = isLate(n, now);
      return '<button type="button" class="hm-row' + (late ? " late" : "") + '" data-hm-go="today" aria-label="' + esc(n.title) + (late ? "，已逾期" : minute != null ? "，" + hm(minute) : "") + '，打开任务页"><i aria-hidden="true"></i><span class="mt">' + esc(n.title) + '</span><span class="md">' + (late ? "逾期" : minute != null ? hm(minute) : "") + "</span></button>";
    }).join("");
    return tile("hm-wide", "待办", rows ? '<div class="hm-todo">' + rows + "</div>" : '<p class="hm-why">今天没有待办。</p>', "今天共 " + s.buckets.today.length + " 件");
  }
  function doneHtml(s) {
    return tile("hm-wide", "今天完成", s.done.length ? '<div class="hm-chips">' + s.done.map(n => '<span class="hm-chip"><i aria-hidden="true">✓</i>' + esc(n.title) + "</span>").join("") + "</div>" : '<p class="hm-why">完成的任务会出现在这里。</p>', s.done.length + " 件");
  }
  function render() {
    if (!body) return;
    const now = new Date(), user = account();
    if (!user) { body.innerHTML = head(now) + '<div class="hm-grid">' + tile("hm-wide", "今天", '<p class="hm-why">登录后，这里会汇总你今天的任务。</p><div class="hm-acts"><button type="button" class="hm-btn pri" data-hm="signin">登录</button></div>') + "</div>"; return; }
    const s = summarize(B.workspace?.nodes?.() || [], now), picked = pulled(s.open);
    body.innerHTML = head(now) + '<div class="hm-grid">' + todoHtml(s, now) + doneHtml(s) + pullHtml(picked) + "</div>";
  }
  function go(key) {
    window.showScreen?.("todo");
    const name = { today: ["今天"], tomorrow: ["明天"], later: ["更晚"], none: ["未设日期"] }[key];
    requestAnimationFrame(() => [...document.querySelectorAll("#todoGroups .group-title, #todoGroups .manage-date-title")].find(h => name.some(t => h.textContent.trim().startsWith(t)))?.scrollIntoView({ block: "start" }));
  }
  function wire() {
    root.addEventListener("click", event => {
      const el = event.target.closest("button"); if (!el) return;
      if (el.dataset.hmGo) return go(el.dataset.hmGo);
      const act = el.dataset.hm;
      if (act === "pull") window.showScreen?.("overview");
      else if (act === "add") { if (B.assistant?.open) B.assistant.open({ mode: "task" }); else window.showScreen?.("todo"); }
      else if (act === "signin" && typeof openAuthDialog === "function") openAuthDialog();
    });
  }
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; if (root && !root.classList.contains("hidden")) render(); }); }
  function init() {
    const phone = document.querySelector(".phone");
    if (!phone || !B.workspace || !window.showScreen) { requestAnimationFrame(init); return; }
    root = document.createElement("section"); root.id = "homeScreen"; root.className = "screen work hidden"; root.setAttribute("aria-label", "首页");
    phone.appendChild(root); screens.home = root;
    body = document.createElement("div"); body.className = "hm-body"; root.appendChild(body); wire();
    document.addEventListener("task-navigation", schedule);
    B.event?.addEventListener("auth", schedule); B.event?.addEventListener("task-record", schedule);
    const watch = new MutationObserver(schedule);
    ["todoTasksView", "doneList"].forEach(id => { const el = document.getElementById(id); if (el) watch.observe(el, { childList: true, subtree: true }); });
    const draw = document.getElementById("taskDraw"); if (draw) watch.observe(draw, { childList: true, subtree: true });
    setInterval(() => { if (!root.classList.contains("hidden")) render(); }, 60000);
    window.showScreen("start");
  }
  B.home = { summarize, pulled, render, dueDay, dueMinute, dueText, isLate };
  if (typeof document !== "undefined") { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init(); }
})();
