/* WP2.11 / WP2.7 / WP2.8: expense day review + category filter, per-day Routine
   completion, daily report + diary, and export / delete-account entries.
   The legacy inline expense/routine widgets are hidden (not renamed or moved),
   which keeps the five html.indexOf() slice tests valid. */
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
  const dayKey = B.dayKey || function () { return new Date().toISOString().slice(0, 10); };

  let expenseDay = dayKey();
  let expenseCategory = "";
  let expenseKind = "expense";
  let expenseRequest = 0;
  let routineDay = dayKey(), migrating = false;
  let routineRequest = 0;
  let diaryDraft;
  let diaryDay;
  const diaryDrafts = new Map();
  let reportRequest = 0;

  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }

  function panel(screenId, id, title) {
    const screen = document.getElementById(screenId);
    if (!screen || document.getElementById(id)) return null;
    const box = document.createElement("div");
    box.className = "task-panel";
    box.id = id;
    box.innerHTML = "<h3>" + escape(title) + "</h3><div class=\"task-panel-body\"></div>";
    screen.appendChild(box);
    return box.querySelector(".task-panel-body");
  }

  function shift(ymd, offset) {
    const p = ymd.split("-").map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  /* ---------------- Expenses (M04-F2) ---------------- */
  async function renderExpenses() {
    const body = document.getElementById("taskLedgerBody");
    if (!body) return;
    const request = ++expenseRequest;
    let data;
    try {
      const query = "?day=" + encodeURIComponent(expenseDay) + (expenseCategory ? "&category=" + encodeURIComponent(expenseCategory) : "");
      data = await api("/api/expenses" + query);
    } catch (error) {
      if (error.status === 401) return;
      if (error.code === "onboarding_required" && B.emit) B.emit("onboarding-required");
      body.innerHTML = '<div class="task-muted">流水暂时读不出来。</div>';
      return;
    }
    if (request !== expenseRequest) return;
    body.innerHTML =
      '<div id="taskExpenseDate"></div><div class="task-expense-filter"><select id="taskExpenseCategory" aria-label="筛选收支分类"><option value="">全部分类</option>' +
      (data.categories || []).map(function (c) { return '<option value="' + escape(c) + '"' + (c === expenseCategory ? ' selected' : '') + '>' + escape(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="task-ledger-totals" aria-label="所选日期收支合计">' +
        '<div><span>支出</span><strong>' + escape(data.totalYuan || "0.00") + '<small>元</small></strong></div>' +
        '<div><span>收入</span><strong>' + escape(data.incomeYuan || "0.00") + '<small>元</small></strong></div></div>' +
      '<div class="task-compose"><div class="task-section-heading"><h3>记一笔</h3><span>也可以在 AI 对话中说一句</span></div>' +
      '<div class="task-row task-ledger-form-row"><span class="task-kind-toggle" id="taskExpenseKind">' +
      '<button type="button" data-kind="expense"' + (expenseKind === "expense" ? ' class="active"' : "") + ">支出</button>" +
      '<button type="button" data-kind="income"' + (expenseKind === "income" ? ' class="active"' : "") + ">收入</button></span>" +
      '<input id="taskExpenseAmount" aria-label="收支金额" inputmode="decimal" placeholder="金额" style="width:80px">' +
      '<select id="taskExpenseNewCategory" aria-label="新记录分类"><option value="">分类可选</option>' +
      ((expenseKind === "income" ? data.incomeCategories : data.expenseCategories) || []).map(function (c) { return '<option value="' + escape(c) + '">' + escape(c) + "</option>"; }).join("") +
      "</select></div>" +
      '<div class="task-row task-ledger-form-row"><input id="taskExpenseNote" aria-label="收支明细" maxlength="80" placeholder="明细" style="flex:1;min-width:0">' +
      '<button class="task-primary" type="button" id="taskExpenseAdd">记下</button></div>' +
      '<div id="taskExpenseStatus" class="task-inline-status" role="status"></div></div>' +
      '<div class="task-section-heading task-history-heading"><h3>当日流水</h3><span>' + escape((data.items || []).length) + ' 笔</span></div>' +
      (data.items || []).map(function (item) {
        const income = item.kind === "income";
        return '<div class="task-row task-ledger-entry' + (income ? " task-income-line" : "") + '">' +
          '<div class="task-entry-copy"><strong>' + escape(item.note || item.category || (income ? "收入" : "支出")) + '</strong>' +
          '<small>' + escape(item.category || "未分类") + ' · ' + escape(item.day) + '</small></div>' +
          '<strong class="task-entry-amount">' + (income ? "+" : "−") + escape(item.amount) + '</strong>' +
          '<button type="button" data-exp-delete="' + escape(item.id) + '" aria-label="删除' + escape(item.note || item.category || "这笔记录") + '">删除</button></div>';
      }).join("") +
      (data.items && data.items.length ? "" : '<div class="task-empty-state"><strong>这一天还没有收支</strong><p>在上面记一笔，或去 AI 对话里说一句。</p></div>');

    if (B.dates) B.dates.mount(document.getElementById("taskExpenseDate"), "expense", "收支");
    body.querySelectorAll("[data-exp-shift]").forEach(function (button) {
      button.addEventListener("click", function () { expenseDay = shift(expenseDay, Number(button.getAttribute("data-exp-shift"))); renderExpenses(); });
    });
    const dateInput = document.getElementById("taskExpenseDay");
    if (dateInput) dateInput.addEventListener("change", function () { if (dateInput.value) { expenseDay = dateInput.value; renderExpenses(); } });
    const cat = document.getElementById("taskExpenseCategory");
    if (cat) cat.addEventListener("change", function () { expenseCategory = cat.value; renderExpenses(); });
    body.querySelectorAll("#taskExpenseKind [data-kind]").forEach(function (button) {
      button.addEventListener("click", function () {
        expenseKind = button.getAttribute("data-kind") === "income" ? "income" : "expense";
        body.querySelectorAll("#taskExpenseKind [data-kind]").forEach(function (item) {
          const active = item.getAttribute("data-kind") === expenseKind;
          item.classList.toggle("active", active);
          item.setAttribute("aria-pressed", String(active));
        });
        const category = document.getElementById("taskExpenseNewCategory");
        category.innerHTML = '<option value="">分类可选</option>' +
          ((expenseKind === "income" ? data.incomeCategories : data.expenseCategories) || []).map(function (value) {
            return '<option value="' + escape(value) + '">' + escape(value) + '</option>';
          }).join("");
      });
    });
    const add = document.getElementById("taskExpenseAdd");
    if (add) add.addEventListener("click", async function () {
      const amount = document.getElementById("taskExpenseAmount").value;
      const note = document.getElementById("taskExpenseNote").value;
      const category = document.getElementById("taskExpenseNewCategory").value;
      const status = document.getElementById("taskExpenseStatus");
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { status.textContent = "请填写大于 0 的金额"; return; }
      add.disabled = true;
      status.textContent = "正在保存…";
      try {
        await api("/api/expenses", { method: "POST", body: JSON.stringify({ amount: amount, note: note, category: category || null, kind: expenseKind, day: expenseDay }) });
        renderExpenses();
      } catch (error) { status.textContent = error.message || "没有保存成功，内容已保留，请重试"; }
      finally { add.disabled = false; }
    });
    body.querySelectorAll("[data-exp-delete]").forEach(function (button) {
      button.addEventListener("click", function () {
        api("/api/expenses/" + encodeURIComponent(button.getAttribute("data-exp-delete")), { method: "DELETE" }).then(renderExpenses).catch(function () {
          document.getElementById("taskExpenseStatus").textContent = "删除失败，请稍后重试";
        });
      });
    });
  }

  /* ---------------- Routines (M05-F2) ---------------- */
  let historyObserver, historyScreenObserver;
  function mountRoutineHistory(body, anchor, request) {
    historyObserver?.disconnect();historyScreenObserver?.disconnect();
    let cursor = shift(anchor, -1), busy = false;
    const button = body.querySelector('#routineHistoryMore');
    const holder = body.querySelector('#routineHistory');
    const load = async () => {
      if (busy || request !== routineRequest || !button.isConnected) return;
      busy = true;button.disabled = true;button.textContent = '正在读取…';
      const to = cursor, from = shift(to, -29);
      try {
        const result = await api('/api/routines/timeline?from=' + from + '&to=' + to);
        if (request !== routineRequest || !button.isConnected) return;
        const groups = new Map();
        (result.events || []).sort((a,b) => b.day.localeCompare(a.day)).forEach(item => {
          if (!groups.has(item.day)) groups.set(item.day, []);
          groups.get(item.day).push(item);
        });
        groups.forEach((items, day) => {
          const section = document.createElement('section');section.className = 'manage-date-group';
          section.innerHTML = '<div class="manage-date-title">' + escape(day.replaceAll('-', '.')) + '<small>' + items.length + '</small></div>' + items.map(item => '<div class="manage-history-entry"><strong>' + escape(item.title) + '</strong><small>已完成 · ' + escape(({life:'生活',work:'工作'})[item.scenario] || '生活') + '</small></div>').join('');
          holder.appendChild(section);
        });
        cursor = result.previousDay || '';
        button.textContent = cursor ? '查看更早记录' : '已显示全部完成记录';
        if (!cursor) { button.hidden = true;historyObserver?.disconnect(); }
        else if (!groups.size) { queueMicrotask(load); }
      } catch { button.textContent = '读取失败，点击重试';historyObserver?.disconnect(); }
      finally { busy = false;button.disabled = false; }
    };
    button.onclick = load;
    historyObserver = new IntersectionObserver(entries => { if(entries.some(entry=>entry.isIntersecting))load(); }, {rootMargin:'100px'});
    if (document.getElementById('routineScreen').classList.contains('hidden')) {
      historyScreenObserver = new MutationObserver(() => { if(!document.getElementById('routineScreen').classList.contains('hidden')){historyScreenObserver.disconnect();load();} });
      historyScreenObserver.observe(document.getElementById('routineScreen'),{attributes:true,attributeFilter:['class']});
    } else load();
    historyObserver.observe(button);
  }

  async function renderRoutines(options) {
    const body = document.getElementById("taskRoutineBody");
    if (!body) return;
    const request = ++routineRequest;
    let data;
    try {
      data = await api("/api/routines?day=" + encodeURIComponent(routineDay));
    } catch (error) {
      if (error.status === 401) return;
      body.innerHTML = '<div class="task-muted">清单暂时读不出来，请稍后再试。</div>';
      return;
    }
    if (request !== routineRequest) return;
    if (B.emit) B.emit("routines-updated", { day: routineDay, items: data.items || [] });
    const items = data.items || [];
    const state = typeof readAppState === "function" ? readAppState() : {};
    // One-time move of client-only checklists into daily checklists, so every checklist has one home.
    const strays = (Array.isArray(state.checklists) ? state.checklists : []).filter(item => !item.parentTaskId && item.plan);
    if (strays.length && !migrating) {
      migrating = true;
      try {
        for (const item of strays) {
   await api("/api/routines", { method: "POST", body: JSON.stringify({ title: item.title, scenario: item.scenario || "life", steps: item.plan.stages.flatMap(stage => stage.steps.map(step => ({ title: step.title, minutes: step.minutes || 10, stage: stage.title === "开始行动" ? "" : stage.title }))) }) });
          checklists = checklists.filter(entry => entry.id !== item.id);
 }
        persistAppState();
      } catch { /* keep them for the next attempt */ }
      migrating = false;
      if (request === routineRequest) return renderRoutines(options);
    }
    if (request !== routineRequest) return;
    const progress = state.checklistProgress || {};
    const D = B.decomposition;
    const daily = items.map(item => ({ kind: "routine", id: item.id, title: item.title, scenario: item.scenario, plan: D.routineToPlan(item, progress[item.id + "|" + routineDay] || []), source: item }));
    const tasks = [...(state.todo || []), ...(state.done || [])].filter(item => item?.plan).map(item => ({ kind: "task", id: item.id, title: item.title, scenario: item.scenario, plan: item.plan }));
    const drafts = (state.planDrafts || []).map(item => ({ kind: "draft", id: item.id, title: item.title, scenario: item.task?.scenario, plan: item.plan }));
    const all = [...daily, ...tasks, ...drafts];
    const finished = all.filter(item => D.isComplete(item.plan)).length;
    const card = item => {
      const steps = D.steps(item.plan), done = steps.filter(step => step.done).length, next = steps.find(step => !step.done);
      const line = item.kind === "draft" ? "草稿 · " + steps.length + " 步 · 待开始" : steps.length ? done + "/" + steps.length + (next ? " · 当前：" + next.title : " · 全部完成") : "还没有步骤";
      const tag = item.kind === "routine" ? "每日" : item.kind === "task" ? "任务" : "草稿";
      return '<button type="button" class="checklist-card' + (steps.length && !next ? " is-complete" : "") + (item.kind === "draft" ? " is-draft" : "") + '" data-checklist-open="' + item.kind + ":" + escape(item.id) + '">' +
 '<span class="checklist-card-copy"><strong>' + escape(item.title) + '</strong><small>' + escape(tag + ' · ' + line) + '</small>' +
        (item.kind === "draft" ? "" : '<span class="plan-card-progress"><i style="width:' + (steps.length ? Math.round(done / steps.length * 100) : 0) + '%"></i></span>') +
        '</span>' + B.kindIcon(item.kind === "task" ? "task" : "routine") + '<span class="checklist-card-open" aria-hidden="true">›</span></button>';
    };
    body.innerHTML =
      '<div class="manage-date-title">' + escape(routineDay === dayKey() ? '今天 · ' + routineDay.replaceAll('-', '.') : routineDay.replaceAll('-', '.')) + '</div>' +
      '<div class="task-routine-progress"><div><strong>已完成 ' + finished + ' / ' + all.length + '</strong><span>每日清单明天自动重新开始</span></div>' +
      '<span class="plan-card-progress"><i style="width:' + (all.length ? Math.round(finished / all.length * 100) : 0) + '%"></i></span></div>' +
      '<div id="taskRoutineList" class="checklist-list">' + all.map(card).join("") +
      (all.length ? "" : '<div class="task-empty-state"><strong>还没有清单</strong><p>新建一份，或在 To-do 里「添加并拆解任务」。</p></div>') + '</div>' +
      '<button type="button" class="checklist-new" id="checklistNew">＋ 新建清单</button>' +
      '<div id="taskRoutineStatus" class="task-inline-status" role="status"></div><div id="routineHistory"></div><button type="button" id="routineHistoryMore" class="manage-history-more">查看更早记录</button>';
    mountRoutineHistory(body, routineDay, request);
    document.getElementById("checklistNew").onclick = function () { D.newChecklist(); };
    body.querySelectorAll("[data-checklist-open]").forEach(function (button) {
      button.onclick = function () {
 const [kind, ...rest] = button.dataset.checklistOpen.split(":"), id = rest.join(":");
        const entry = all.find(item => item.kind === kind && String(item.id) === id);
        if (!entry) return;
        if (kind === "routine") D.openRoutine(entry.source, routineDay);
        else if (kind === "draft") { const draft = (readAppState().planDrafts || []).find(item => item.id === id); if (draft) D.resume(draft); }
        else { const row = [...document.querySelectorAll('#todoGroups .task-row,#doneList .done-row')].find(item => (item.dataset.taskId || item.querySelector('.todo-check')?.dataset.taskId) === id); if (row) D.open(row); }
      };
    });
  }

  function statusText(value) { const node = document.getElementById("taskRoutineStatus"); if (node) node.textContent = value; }

  /* ---------------- Daily report + diary (M01-F5) ---------------- */
  /* recap-lines:start */
  /** Turns any recap text (template, model, or an old single paragraph) into: a short headline, a few short lines, one cheer line. */
  function recapLines(narrative, stats, day, today) {
    const st = stats || {};
    const when = day && today && day !== today ? "这一天" : "今天";
    const text = String(narrative || "").trim() || when + "的记录会在这里汇成一份回顾。";
    let lines = text.split(/\n+/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (lines.length === 1) lines = (text.match(/[^。！？!?]+[。！？!?]?/g) || [text]).map(function (t) { return t.trim(); }).filter(Boolean);
    // headline: the card already shows the date, so drop a leading date; split "标题：内容"
    lines[0] = lines[0].replace(/^(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日\s*(?:[（(]?周[一二三四五六日天][）)]?)?\s*[，,、：:]?\s*/, "").trim();
    if (!lines[0]) lines.shift();
    if (!lines.length) lines = [when + "的记录会在这里汇成一份回顾。"];
    const colon = lines[0].search(/[：:]/);
    if (colon > 0 && colon <= 22) { const tail = lines[0].slice(colon + 1).trim(); lines[0] = lines[0].slice(0, colon); if (tail) lines.splice(1, 0, tail); }
    if (lines[0].length > 18) { const c = lines[0].search(/[，,]/); if (c >= 6 && c < lines[0].length - 4) { lines.splice(1, 0, lines[0].slice(c + 1).trim()); lines[0] = lines[0].slice(0, c); } }
    // task names: always shown as 「名称」
    const names = Array.from(new Set([].concat(st.doneTitles || [], st.routineTitles || []).map(String).filter(function (t) { return t.length >= 2 && t.length <= 24; })));
    names.sort(function (a, b) { return b.length - a.length; });
    if (names.length) {
      const re = new RegExp("「[^」]*」|(" + names.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "g");
      lines = lines.map(function (t) { return t.replace(re, function (m, g) { return g ? "「" + g + "」" : m; }); });
    }
    // long body lines break once at a comma so every line stays short
    const out = [lines[0]];
    lines.slice(1).forEach(function (t) {
      let cut = -1;
      if (t.length > 30) {
        const re = /[，,、]/g; let m;
        while ((m = re.exec(t))) {
          const head = t.slice(0, m.index);
          if (m.index >= 7 && t.length - m.index - 1 >= 6 && (head.match(/「/g) || []).length === (head.match(/」/g) || []).length) { cut = m.index; break; }
        }
      }
      if (cut > 0) { out.push(t.slice(0, cut)); out.push(t.slice(cut + 1).trim()); } else out.push(t);
    });
    // only a real cheer line is bold; add one when the day has records but the text has none
    let cheer = out.length > 1 && /掌声|加油|明天|值得|了不起|真棒|很棒|不错|骄傲|期待|辛苦/.test(out[out.length - 1]) ? out.pop() : "";
    if (!cheer && ((st.doneCount || 0) + (st.routineDoneCount || 0) + (st.ideaCount || 0) + (st.focusMinutes || 0)) > 0) cheer = "给自己一点掌声。";
    return { lead: out[0], rest: out.slice(1, 5), cheer: cheer };
  }
  /* recap-lines:end */

  async function renderReport() {
    const body = document.getElementById("taskReportBody");
    if (!body) return;
    const request = ++reportRequest;
    const reportDay = B.dates ? B.dates.get("today") : dayKey();
    let data;
    try {
      data = await api("/api/report?day=" + encodeURIComponent(reportDay));
    } catch (error) {
      if (error.status === 401) return;
      body.innerHTML = '<div class="task-muted">战报暂时读不出来。</div>';
      return;
    }
    if (request !== reportRequest) return;
    if (B.emit) B.emit("daily-summary", { day: reportDay, stats: data.stats || {} });
    if (diaryDay !== reportDay) { diaryDay = reportDay; diaryDraft = diaryDrafts.get(reportDay); }
    if (diaryDraft === undefined) diaryDraft = data.diary || "";
    const stats = data.stats || {};
    B.completedChecklistTitles = B.completedChecklistTitles || {};
    B.completedChecklistTitles[reportDay] = stats.routineTitles || [];
    renderCal();
    // AI recap, then a note to yourself.
    const recapDate = function (key) {
      const d = new Date(key + "T12:00:00");
      return (key === dayKey() ? "今天 · " : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + "日一二三四五六"[d.getDay()];
    };
    const recap = recapLines(data.narrative, stats, reportDay, dayKey());
    const lead = recap.lead, rest = recap.rest, cheer = recap.cheer;
    const mark = function (t) { return escape(t).replace(/「([^」]{1,24})」/g, "<mark>「$1」</mark>"); };
    body.innerHTML = '<section class="task-report-narrative" aria-label="AI 回顾"><i class="rn-loop" aria-hidden="true"></i><div class="task-report-head"><div class="rn-tag"><span>AI 回顾</span><time datetime="' + reportDay + '">' + escape(recapDate(reportDay)) + '</time></div><button type="button" class="task-report-refresh" id="taskReportRefresh" aria-label="重新生成回顾" title="重新生成"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/></svg></button></div><h2 class="rn-lead">' + mark(lead) + "</h2>" + (rest.length || cheer ? '<div class="rn-rest">' + rest.map(function (t) { return "<p>" + mark(t) + "</p>"; }).join("") + (cheer ? '<p class="rn-cheer">' + mark(cheer) + "</p>" : "") + "</div>" : "") + "</section>" +
      '<div class="task-section-heading task-diary-heading"><h3>写给自己</h3></div>' +
      '<textarea id="taskDiary" maxlength="500" rows="3" placeholder="写给今天的自己：收获，或者想改进的地方（500 字以内）">' + escape(diaryDraft) + "</textarea>" +
      '<div class="task-editor-actions"><button class="task-primary" type="button" id="taskDiarySave">保存</button></div>';
    const diary = document.getElementById("taskDiary");
    const save = document.getElementById("taskDiarySave");
    const status = document.createElement("div");
    status.className = "task-muted";
    status.setAttribute("role", "status");
    body.appendChild(status);
    diary.addEventListener("input", function () {
      diaryDraft = diary.value;
      diaryDrafts.set(reportDay, diaryDraft);
      status.textContent = "尚未保存";
    });
    save.addEventListener("click", async function () {
      const value = diary.value;
      diaryDraft = value;
      save.disabled = true;
      status.textContent = "保存中…";
      try {
        await api("/api/report/diary", { method: "PATCH", body: JSON.stringify({ day: reportDay, diary: value }) });
        status.textContent = diary.value === value ? "已保存" : "已有新修改，记得再次保存";
      } catch (error) {
        status.textContent = "保存失败，内容已保留，请重试";
      } finally {
        save.disabled = false;
      }
    });
    document.getElementById("taskReportRefresh").addEventListener("click", function () {
      api("/api/report", { method: "POST", body: JSON.stringify({ day: reportDay }) }).then(renderReport).catch(function () {});
    });
  }

  /* ---------------- Export / delete (F-S6) ---------------- */
  function renderAccount() {
    const body = document.getElementById("taskAccountBody");
    if (!body) return;
    body.innerHTML = '<section class="task-account-section"><h3>带走你的记录</h3><p class="task-muted">下载全部记录与保留的历史数据。</p>' +
      '<button class="task-primary" type="button" id="taskExport">导出全部数据</button></section>' +
      '<details class="task-account-delete"><summary>删除账号与全部数据</summary><p class="task-muted">删除后无法恢复。请输入“删除”确认。</p>' +
      '<div class="task-editor-actions"><input id="taskDeleteConfirm" maxlength="10" aria-label="输入删除确认" placeholder="输入「删除」"><button class="task-primary" type="button" id="taskDelete">永久删除账号</button></div></details>' +
      '<div class="task-inline-status" id="taskAccountStatus" role="status"></div>';
    document.getElementById("taskExport").addEventListener("click", async function () {
      try {
        const data = await api("/api/export");
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "task-export-" + dayKey() + ".json";
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        document.getElementById("taskAccountStatus").textContent = error.message || "导出失败";
      }
    });
    document.getElementById("taskDelete").addEventListener("click", async function () {
      const value = document.getElementById("taskDeleteConfirm").value.trim();
      if (value !== "删除") {
        document.getElementById("taskAccountStatus").textContent = "请输入「删除」两个字确认";
        return;
      }
      try {
        await api("/api/account", { method: "DELETE", body: JSON.stringify({ confirm: "删除" }) });
        if (typeof window.signOut === "function") window.signOut();
        location.reload();
      } catch (error) {
        document.getElementById("taskAccountStatus").textContent = error.message || "删除失败";
      }
    });
  }

  function init() {
    if (B.dates) {
      B.dates.subscribe("routine", function (value) { routineDay=value;renderRoutines(); });
      B.dates.subscribe("today", renderReport);
    }
    hide("expenseForm"); hide("expenseList"); hide("expenseEmpty");
    hide("routineForm"); hide("routineList"); hide("routineEmpty");
    const routine = panel("routineScreen", "taskRoutine", "Checklist");
    if (routine) routine.id = "taskRoutineBody";
    const report = panel("todayScreen", "taskReport", "今日回顾");
    if (report) report.id = "taskReportBody";
    const account = panel("meScreen", "taskAccount", "数据与账号");
    if (account) account.id = "taskAccountBody";
    renderRoutines();
    renderReport();
    renderAccount();
    if (B.event) {
      B.event.addEventListener("task-record", function () { renderRoutines(); });
      B.event.addEventListener("auth", function () { diaryDraft = undefined; diaryDrafts.clear(); B.completedChecklistTitles = {}; renderRoutines(); renderReport(); });
      B.event.addEventListener("onboarded", function () { renderRoutines(); renderReport(); });
    }
  }

  B.records = { expenseDay: function () { return expenseDay; }, init: init, renderExpenses: renderExpenses, renderRoutines: renderRoutines, renderReport: renderReport, shift: shift };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
