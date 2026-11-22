/* F-S4 floating dock: one AI orb on the left, four active slots and optional Wellness in a glass
   capsule on the right. Loaded as a deferred script (no build step, D1.6).
   The legacy four-tab bar stays in the DOM but is hidden by CSS, so the inline
   navs object, showScreen() and the archived slice tests keep working. */
(function () {
  "use strict";
  var B = (window.Task = window.Task || {});

  var AI_FACE = [
    '<svg class="task-dock-ai-face" viewBox="0 0 72 72" aria-hidden="true">',
    '<circle cx="36" cy="36" r="36" fill="#cbf53a"/>',
    '<ellipse cx="25" cy="17" rx="13" ry="6" fill="#fff" opacity=".45" transform="rotate(-28 25 17)"/>',
    '<ellipse cx="28.5" cy="33" rx="3.2" ry="5.2" fill="#1e2a12"/>',
    '<ellipse cx="43.5" cy="33" rx="3.2" ry="5.2" fill="#1e2a12"/>',
    '<circle cx="29.7" cy="31" r="1.1" fill="#fff"/>',
    '<circle cx="44.7" cy="31" r="1.1" fill="#fff"/>',
    '<ellipse cx="21.5" cy="43" rx="3.6" ry="2.3" fill="#fff" opacity=".4"/>',
    '<ellipse cx="50.5" cy="43" rx="3.6" ry="2.3" fill="#fff" opacity=".4"/>',
    '<path d="M29 44.5c2 3.6 5 5.4 7 5.4s5-1.8 7-5.4" fill="none" stroke="#1e2a12" stroke-width="3.4" stroke-linecap="round"/>',
    '</svg>'
  ].join("");
  B.aiFace = AI_FACE;

  var ICONS = {
    task: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h3.5"/><path d="M16 16.4l1.3 1.3 2.4-2.5"/>',
    wellness: '<path d="M12 3.2c3.4 4.1 5.4 6.7 5.4 9.3a5.4 5.4 0 0 1-10.8 0c0-2.6 2-5.2 5.4-9.3z"/><path d="M9.4 13.4h1.4l1-1.9 1.3 2.9 1-1.7h1.5"/>',
    idea: '<path d="M9 17h6M9.8 20h4.4"/><path d="M12 3.2a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.7v.2h5.4v-.2c0-.7.3-1.3.8-1.7A6 6 0 0 0 12 3.2z"/>',
    routine: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8 3.5v4M16 3.5v4"/><path d="M8.6 15l2 2 4-4"/>',
    today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>'
  };

  var SLOTS = [
    { key: "home", label: "Home", screen: "start" },
    { key: "manage", label: "My Tasks", screen: "manage" },
    { key: "today", label: "Daily Recap", screen: "today" }
  ];

  var SCREEN_TO_SLOT = {
    start: "home", todo: "manage", taskHub: "manage", home: "manage", overview: "manage", cal: "manage",
    idea: "manage", routine: "manage", today: "today",
    // Task hub's Done sub-page still lives on doneScreen -> highlight Task.
    done: "manage",
    all: "manage"
  };

  function init() {
    ICONS.home = '<rect x="4" y="4" width="7" height="9" rx="2"/><rect x="13" y="4" width="7" height="5" rx="2"/><rect x="13" y="11" width="7" height="9" rx="2"/><rect x="4" y="15" width="7" height="5" rx="2"/>';
    ICONS.overview = '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7 3 3m4 0 3-3M10 14l-3 3m7-3 3 3"/>';
    ICONS.manage = ICONS.task;
    ICONS.todo = ICONS.task;
    ICONS.done = '<circle cx="12" cy="12" r="8.5"/><path d="M8 12l2.7 2.7 5.3-5.6"/>';
    var phone = document.querySelector(".phone");
    var legacyNav = document.querySelector(".bottom-nav");
    if (!phone || !legacyNav || document.getElementById("taskDock")) return;

    phone.classList.add("task-dock-on");

    var dock = document.createElement("div");
    dock.id = "taskDock";
    dock.className = "task-dock";
    dock.innerHTML =
      '<nav class="task-dock-pill" style="grid-template-columns:repeat(' + SLOTS.length + ',minmax(0,1fr))" aria-label="主导航">' +
        SLOTS.map(function (slot) {
          return '<button class="task-dock-item" type="button" data-dock="' + slot.key + '" aria-label="' + slot.label + '">' +
            '<span class="task-dock-ico"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[slot.key] + '</svg></span>' +
            '<span>' + slot.label + '</span>' +
            '<span class="task-dock-badge" hidden></span>' +
          '</button>';
        }).join("") +
      '</nav>';
    phone.appendChild(dock);

    var items = Array.prototype.slice.call(dock.querySelectorAll(".task-dock-item"));

    function go(name) {
      // Leaving any dock destination closes the Task sub-page breadcrumb and
      // the focused feedback view.
      if (B.taskHub && typeof B.taskHub.leave === "function") B.taskHub.leave();
      var start = document.getElementById("startScreen");
      if (start) start.classList.remove("task-subpage-feedback");
      if (B.workspace && name === "manage") B.workspace.navigate("manage");
      else if (typeof window.showScreen === "function") window.showScreen(name);
    }

    items.forEach(function (item) {
      item.addEventListener("click", function () {
        var slot = SLOTS.filter(function (s) { return s.key === item.dataset.dock; })[0];
        if (!slot) return;
        // Each dock entry resets its module to the PRD default sub-page.
        if (slot.key === "wellness" && B.wellness) B.wellness.enter();
        if (slot.key === "today") {
          // Calendar dates are owned by the existing inline application.
          calViewDate = new Date();
          calSelectedDate = new Date();
        }
        go(slot.screen);
        if (slot.key === "task" && typeof window.showTodoTab === "function") window.showTodoTab("tasks");
      });
    });

    function syncActive() {
      var screens = Array.prototype.slice.call(document.querySelectorAll(".screen"));
      var visible = screens.filter(function (s) { return !s.classList.contains("hidden"); })[0];
      var key = visible ? SCREEN_TO_SLOT[visible.id.replace(/Screen$/, "")] : null;
      // While inside a Task sub-page, keep the Task slot highlighted so the
      // breadcrumb hierarchy wins over the screen-to-slot mapping (the
      // 正反馈 sub-page reuses startScreen, which otherwise maps to AI).
      // The screen-set guard keeps direct showScreen() calls to other
      // screens (e.g. Wellness) correct even if a sub-page was left
      // programmatically without the dock's leave() cleanup.
      var stripped = visible ? visible.id.replace(/Screen$/, "") : null;
      var HUB_SCREEN_KEYS = { todo: 1, done: 1, start: 1 };
      if (B.taskHub && typeof B.taskHub.current === "function" && B.taskHub.current() && stripped && HUB_SCREEN_KEYS[stripped]) key = "manage";
      items.forEach(function (item) {
        var active = item.dataset.dock === key;
        item.classList.toggle("active", active);
        item.setAttribute("aria-current", active ? "page" : "false");
      });
    }

    function setBadge(slotKey, text, dot) {
      var item = items.filter(function (i) { return i.dataset.dock === slotKey; })[0];
      var el = item && item.querySelector(".task-dock-badge");
      if (!el) return;
      if (text === null || text === undefined) { el.hidden = true; return; }
      el.hidden = false;
      el.textContent = dot ? "" : String(text);
      el.classList.toggle("dot", Boolean(dot));
    }

    function refreshBadges() {
      var todoCount = document.querySelectorAll("#todoTasksView .task-row").length;
      var doneCount = document.querySelectorAll("#doneList .done-row").length;
      setBadge("manage", todoCount ? String(Math.min(todoCount, 99)) : null, false);
      setBadge("today", doneCount ? "" : null, true);
    }

    // Keep the highlight in step with showScreen() without wrapping it.
    var screenObserver = new MutationObserver(syncActive);
    Array.prototype.slice.call(document.querySelectorAll(".screen")).forEach(function (s) {
      screenObserver.observe(s, { attributes: true, attributeFilter: ["class"] });
    });

    var badgeObserver = new MutationObserver(refreshBadges);
    ["#todoTasksView", "#doneList"].forEach(function (selector) {
      var node = document.querySelector(selector);
      if (node) badgeObserver.observe(node, { childList: true, subtree: true });
    });

    syncActive();
    document.addEventListener("task-navigation", syncActive);
    refreshBadges();

    // These sub-pages used to return to the "模块" hub. That hub is no longer a
    // dock destination (all five destinations are direct now), so return to the
    // conversation instead. The hub screen itself stays in the DOM (Q10).
    ["wellnessBack", "ledgerBack", "routineBack"].forEach(function (id) {
      var back = document.getElementById(id);
      if (!back) return;
      back.textContent = "返回对话";
      back.onclick = null;
      back.addEventListener("click", function () { go("start"); });
    });

    // The account page (export / delete) is no longer one of the five slots,
    // so keep it reachable from the existing appbar account menu.
    var menu = document.getElementById("accountMenu");
    if (menu && !document.getElementById("taskDockMe")) {
      var me = document.createElement("button");
      me.id = "taskDockMe";
      me.type = "button";
      me.textContent = "我的";
      me.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (typeof window.closeAccountMenu === "function") window.closeAccountMenu();
        go("me");
      });
      menu.appendChild(me);
    }

    B.dock = { setBadge: setBadge, refresh: refreshBadges, sync: syncActive };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
