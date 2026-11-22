/* Task hub: a four-card grid (To-do / Done / 任务复盘 / 正反馈) that stays mounted
   at the top of whichever sub-page is open, mirroring the reference layout of
   "grid card + content below". The requested default when tapping Task in the
   dock is the FIRST sub-page (To-do); the old standalone hub screen and the
   "今天" summary card are gone. No existing DOM node is moved: each cell routes
   to the screen/tab that already owns that feature. Deferred script, no build
   step (D1.6). */
(function () {
  "use strict";
  var B = (window.Task = window.Task || {});

  var SUBS = [
    { key: "todo", label: "To-do", tone: "green", screen: "todoScreen" },
    { key: "done", label: "Done", tone: "blue", screen: "doneScreen" },
    { key: "reviews", label: "任务复盘", screen: "doneScreen" },
    { key: "feedback", label: "正反馈", tone: "violet", screen: "startScreen" }
  ];

  var COUNT_SELECTORS = {
    todo: "#todoTasksView .task-row",
    done: "#doneList .done-row",
    reviews: "#pendingReviews [data-review-id]",
    feedback: "#feedbackList .feedback-row"
  };

  var current = null;
  var feedbackWasHidden = true;
  var grid = null;

  function go(name) {
    if (typeof window.showScreen === "function") window.showScreen(name);
  }

  function count(selector) {
    return document.querySelectorAll(selector).length;
  }

  /** The To-do screen header is shared by two sub-pages; relabel it for 灵感. */
  function setTodoHead(ideas) {
    if (!setTodoHead.cache) {
      var h1 = document.querySelector("#todoScreen .work-head h1");
      if (!h1) return;
      var eyebrow = document.querySelector("#todoScreen .work-head .eyebrow");
      setTodoHead.cache = { h1: h1, eyebrow: eyebrow, title: h1.textContent, eyebrowText: eyebrow ? eyebrow.textContent : "" };
    }
    var c = setTodoHead.cache;
    c.h1.textContent = ideas ? "灵感" : c.title;
    if (c.eyebrow) c.eyebrow.textContent = ideas ? "IDEAS" : c.eyebrowText;
  }

  function refreshCounts() {
    var totals = {};
    SUBS.forEach(function (sub) { totals[sub.key] = count(COUNT_SELECTORS[sub.key]); });
    // Keep the legacy tab counters in step with the grid, so both surfaces
    // report the same numbers.
    [
      ["#todoTabCount", totals.todo],
      ["#todoIdeasTab span", count("#ideaList .idea-row")],
      ["#completedTabCount", totals.done]
    ].forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (el) el.textContent = String(pair[1]);
    });
    if (!grid) return;
    SUBS.forEach(function (sub) {
      var badge = grid.querySelector('[data-hub="' + sub.key + '"] .task-task-value');
      if (badge) {
        badge.textContent = String(totals[sub.key]);
      }
    });
  }

  /** Mount the grid as the FIRST element of the sub-page screen: nothing of
   *  the sub-page (title, intro, tabs, list) may render above it. */
  function mountGrid(screenId) {
    var screen = document.getElementById(screenId);
    if (!screen) return;
    if (grid.parentElement !== screen) screen.insertBefore(grid, screen.firstChild);
    grid.style.display = "";
  }

  /** Clear all sub-page decoration. Safe to call repeatedly. */
  function leave() {
    current = null;
    setTodoHead(false);
    var start = document.getElementById("startScreen");
    if (start) start.classList.remove("task-subpage-feedback");
    var feedback = document.getElementById("feedbackBlock");
    if (feedback && feedbackWasHidden) feedback.classList.add("hidden");
    // The grid belongs to the Task sub-pages only — hide it on leave, or it
    // would leak into whichever screen it was last mounted on (e.g. the chat
    // home, which the 正反馈 sub-page reuses).
    if (grid) grid.style.display = "none";
    document.dispatchEvent(new Event("task-task-view"));
    if (grid) {
      grid.querySelectorAll(".task-task-cell").forEach(function (cell) { cell.classList.remove("active"); cell.setAttribute("aria-selected", "false"); });
    }
  }

  function enter(key) {
    if ((key === "reviews" || key === "feedback") && !B.features?.taskReflection) return;
    var sub = SUBS.filter(function (s) { return s.key === key; })[0];
    if (!sub) return;
    leave();
    current = key;
    var feedback = document.getElementById("feedbackBlock");
    feedbackWasHidden = feedback ? feedback.classList.contains("hidden") : true;

    if (key === "todo" || key === "ideas") {
      go("todo");
      setTodoHead(key === "ideas");
      if (typeof window.showTodoTab === "function") window.showTodoTab(key === "ideas" ? "ideas" : "tasks");
    } else if (key === "done" || key === "reviews") {
      go("done");
      document.getElementById(key === "reviews" ? "reviewsTab" : "completedTab").click();
      document.querySelector("#doneScreen .work-head h1").textContent = key === "reviews" ? "任务复盘" : "Done";
      document.getElementById("newEvent").hidden = key === "reviews";
    } else {
      go("start");
      var start = document.getElementById("startScreen");
      if (start) start.classList.add("task-subpage-feedback");
      if (feedback) feedback.classList.remove("hidden");
      if (start) start.scrollTop = start.scrollHeight;
    }

    // To-do and Done now have independent dock entries; optional reflection restores the old hub.
    if (B.features?.taskReflection) mountGrid(sub.screen);
    document.dispatchEvent(new Event("task-task-view"));
    var cell = grid.querySelector('[data-hub="' + key + '"]');
    if (cell) { cell.classList.add("active"); cell.setAttribute("aria-selected", "true"); }
    refreshCounts();
  }

  function init() {
    var phone = document.querySelector(".phone");
    if (!phone || document.getElementById("taskTaskGrid")) return;

    grid = document.createElement("div");
    grid.id = "taskTaskGrid";
    grid.className = "task-task-grid og-cards";
    grid.setAttribute("role", "tablist");
    grid.setAttribute("aria-label", "任务子页面");
    grid.innerHTML = SUBS.map(function (sub) {
      return '<button class="task-task-cell og-card" type="button" role="tab" aria-selected="false" data-hub="' + sub.key + '" aria-label="' + sub.label + '">' +
        '<span class="og-card-label">' + sub.label + '</span>' +
        '<span class="og-value"><span class="task-task-value">0</span><small>' + (sub.key === "feedback" ? '条' : '项') + '</small></span>' +
        '<span class="og-sub">' + ({todo:'待安排与进行中',done:'已完成的任务',reviews:'待完成的复盘',feedback:'值得记住的小进步'})[sub.key] + '</span>' +
      '</button>';
    }).join("");
    grid.style.display = "none";
    phone.appendChild(grid);

    grid.querySelectorAll(".task-task-cell").forEach(function (cell) {
      cell.addEventListener("click", function () { enter(cell.dataset.hub); });
    });

    // Keep in-page entry points consistent with the new hierarchy. The
    // feedback tile no longer exists (removed from the chat home), so this
    // binding is simply skipped.
    var bind = function (id, key) {
      var el = document.getElementById(id);
      if (el) el.onclick = function () { enter(key); };
    };
    bind("openDoneFromTodo", "done");
    bind("todoTasksTab", "todo");
    var ideasLink = document.getElementById("todoIdeasTab");
    if (ideasLink) ideasLink.onclick = function () { go("idea"); };
    bind("feedbackTile", "feedback");

    // Counts come from the real DOM, so imported/local state stays in sync.
    var observer = new MutationObserver(refreshCounts);
    ["#todoTasksView", "#doneList", "#ideaList", "#feedbackList", "#pendingReviews", "#reviewedList"].forEach(function (selector) {
      var node = document.querySelector(selector);
      if (node) observer.observe(node, { childList: true, subtree: true });
    });

    refreshCounts();
    B.taskHub = {
      open: function () { enter(SUBS[0].key); },
      enter: enter,
      leave: leave,
      refresh: refreshCounts,
      current: function () { return current; }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
