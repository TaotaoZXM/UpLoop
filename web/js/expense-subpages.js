/* Expense sub-pages: 收支记录 (the single merged ledger) / 收支分类.
   The ledger flow itself (#taskLedger, rendered by records.js) records BOTH
   income and expense via the expenses.kind column; there is deliberately no
   separate income panel and no localStorage fallback any more — user request
   2026-11-05. This module only owns the sub-tab switching and the category
   summary panel. */
(function () {
  "use strict";
  var B = (window.Task = window.Task || {});
  var SUBS = [
    { key: "ledger", label: "收支记录" },
    { key: "categories", label: "收支分类" }
  ];
  var active = "ledger";
  var tabs = null;
  var panels = {};
  var lead = null;
  var ledger = null;
  var categoryRequest = 0;

  function escape(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function dayKey() {
    var d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  }

  function api(path) {
    return fetch(btUrl(path), { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("request failed");
      return r.json();
    });
  }

  function yuan(n) {
    return (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
  }

  function categoryBars(map, total, tone, emptyText) {
    var keys = Object.keys(map);
    if (!keys.length) return '<div class="task-cat-empty">' + emptyText + "</div>";
    return keys.sort(function (a, b) { return map[b] - map[a]; }).map(function (key) {
      var value = map[key];
      var pct = total > 0 ? Math.round((value / total) * 100) : 0;
      return '<div class="task-cat-row"><div class="task-cat-head"><b>' + escape(key) +
        "</b><span>" + escape(yuan(value)) + " 元 · " + pct + "%</span></div>" +
        '<div class="task-cat-bar' + (tone === "income" ? " income" : "") + '"><i style="width:' + pct + '%"></i></div></div>';
    }).join("");
  }

  function renderCategories() {
    var request = ++categoryRequest;
    var today = B.records ? B.records.expenseDay() : dayKey();
    panels.categories.innerHTML =
      '<div id="taskCategoryDate"></div><h3>收支分类</h3>' +
      '<p class="task-subnote">按所选日期 ' + escape(today) + ' 的流水汇总，收入与支出都来自云端记录。</p>' +
      '<div class="task-subtotal">统计中…</div>' +
      '<div id="taskCategoryBody"><div class="task-cat-empty">正在读取当天流水…</div></div>';

    if (B.dates) B.dates.mount(document.getElementById("taskCategoryDate"), "expense", "收支");
    api("/api/expenses?day=" + encodeURIComponent(today)).then(function (data) {
      if (request !== categoryRequest) return;
      var maps = { expense: {}, income: {} };
      var totals = { expense: 0, income: 0 };
      (data.items || []).forEach(function (item) {
        var kind = item.kind === "income" ? "income" : "expense";
        var key = item.category || (kind === "income" ? "未分类" : "未分类");
        maps[kind][key] = (maps[kind][key] || 0) + (Number(item.amount) || 0);
        totals[kind] += Number(item.amount) || 0;
      });
      var totalEl = panels.categories.querySelector(".task-subtotal");
      if (totalEl) {
        totalEl.innerHTML = "当日结余 " + escape(yuan(totals.income - totals.expense)) +
          " 元<small>收入 " + escape(yuan(totals.income)) + " · 支出 " + escape(yuan(totals.expense)) + "</small>";
      }
      var body = document.getElementById("taskCategoryBody");
      if (!body) return;
      body.innerHTML =
        '<div class="og-section-label" style="margin:10px 2px 6px;color:var(--muted);font-size:11px;letter-spacing:.1em">支出分类</div>' +
        categoryBars(maps.expense, totals.expense, "expense", "这一天还没有支出。") +
        '<div class="og-section-label" style="margin:16px 2px 6px;color:var(--muted);font-size:11px;letter-spacing:.1em">收入分类</div>' +
        categoryBars(maps.income, totals.income, "income", "这一天还没有收入。");
    }).catch(function () {
      if (request !== categoryRequest) return;
      var body = document.getElementById("taskCategoryBody");
      if (body) body.innerHTML = '<div class="task-cat-empty">流水暂时读不出来，稍后再试。</div>';
    });
  }

  function activate(key) {
    active = key;
    if (tabs) {
      tabs.querySelectorAll("button").forEach(function (button) {
        var on = button.dataset.sub === key;
        button.classList.toggle("active", on);
        button.setAttribute("aria-selected", String(on));
      });
    }
    if (ledger) ledger.style.display = key === "ledger" ? "" : "none";
    panels.categories.style.display = key === "categories" ? "" : "none";
    if (lead) {
      lead.textContent = key === "categories"
        ? "看看钱花在哪里，也看看收入来源。"
        : "收入与支出，一起记清楚。";
    }
    if (key === "categories") renderCategories();
  }

  function init() {
    var screen = document.getElementById("ledgerScreen");
    if (!screen || document.getElementById("taskExpenseSubs")) return;
    ledger = document.getElementById("taskLedger");
    if (!ledger) return;
    lead = screen.querySelector(".module-lead");

    tabs = document.createElement("div");
    tabs.id = "taskExpenseSubs";
    tabs.className = "task-subtabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "记账子页面");
    tabs.innerHTML = SUBS.map(function (sub) {
      return '<button type="button" role="tab" data-sub="' + sub.key + '">' + sub.label + "</button>";
    }).join("");
    screen.insertBefore(tabs, ledger);

    var categoryBox = document.createElement("div");
    categoryBox.className = "task-panel task-subpanel";
    categoryBox.id = "taskCategories";
    categoryBox.style.display = "none";
    screen.appendChild(categoryBox);
    panels.categories = categoryBox;

    // The ledger flow now holds both income and expense rows.
    var ledgerTitle = ledger.querySelector("h3");
    if (ledgerTitle) ledgerTitle.textContent = "收支 · 按日流水";

    tabs.querySelectorAll("button").forEach(function (button) {
      button.addEventListener("click", function () { activate(button.dataset.sub); });
    });
    activate("ledger");

    B.expenseSubs = { activate: activate, current: function () { return active; } };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
