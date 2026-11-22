/* Manage reads as a chronological feed; Today keeps its independent date picker. */
(function () {
  const B = window.Task;
  if (!B?.dates) return;
  const D = B.dates;
  const signatures = new WeakMap(), identities = new WeakMap();
  let nextIdentity = 0;
  const day = value => value ? dateKey(value) : '';
  const label = value => value ? (value === dateKey(new Date()) ? '今天 · ' : '') + value.replaceAll('-', '.') : '更早';
  function groupRows(holder, selector, getDay, todo) {
    if (!holder) return;
    const rows = [...holder.querySelectorAll(selector)];
    rows.forEach(row => { if(!identities.has(row))identities.set(row,++nextIdentity); });
    const key = JSON.stringify(rows.map(row => [identities.get(row),row.dataset.taskId || row.querySelector('.todo-check')?.dataset.taskId || row.dataset.ideaId, getDay(row), row.classList.contains('hidden')]).sort());
    if (signatures.get(holder) === key) return;
    signatures.set(holder, key);
    const buckets = new Map();
    rows.forEach(row => {
      if(row.classList.contains('task-date-hidden'))row.classList.remove('task-date-hidden');
      const value = getDay(row) || '';
      if (!buckets.has(value)) buckets.set(value, []);
      buckets.get(value).push(row);
    });
    // Keep the same row elements and listeners, including swipe and completion.
    const fragment = document.createDocumentFragment();
    const keys = [...buckets.keys()].sort((a,b) => !a ? -1 : !b ? 1 : b.localeCompare(a));
    if (todo && !keys.length) keys.push('');
    keys.forEach(value => {
      const section = document.createElement('section');
      section.className = todo ? 'group manage-date-group' : 'manage-date-group';
      const heading = document.createElement('div');
      heading.className = todo ? 'group-title manage-date-title' : 'manage-date-title';
      heading.textContent = label(value);
      const count = document.createElement('small');
      count.textContent = (buckets.get(value) || []).filter(row => !row.classList.contains('hidden')).length;
      heading.appendChild(count);
      section.appendChild(heading);
      (buckets.get(value) || []).forEach(row => section.appendChild(row));
      fragment.appendChild(section);
    });
    holder.replaceChildren(fragment);
  }
  let queued = false;
  function refresh() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      window.renderRecurringTasks?.();
      groupRows(document.getElementById('todoGroups'), '.task-row', row => row.dataset.occurrenceDay || day(row.dataset.createdAt), true);
      groupRows(document.getElementById('doneList'), '.done-row', row => completedDateKey(row), false);
      groupRows(document.getElementById('ideaList'), '.idea-row', row => day(row.dataset.createdAt), false);
    });
  }
  function init() {
    document.getElementById('taskIdeaDate')?.remove();
    const screen = document.getElementById('todayScreen');
    if (screen) {
      const picker = document.createElement('div');picker.id = 'taskTodayDate';
      const old = screen.querySelector('.cal-month');screen.insertBefore(picker,old);
      if (old) old.hidden = true;
      D.mount(picker,'today','回顾');
      D.subscribe('today',value => {calSelectedDate=new Date(value+'T12:00:00');calViewDate=new Date(value+'T12:00:00');renderCal();});
    }
    const observer = new MutationObserver(refresh);
    ['todoGroups','doneList','ideaList'].forEach(id => {
      const element = document.getElementById(id);
      if (element) observer.observe(element,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    });
    D.subscribe('todo', refresh);D.subscribe('done',refresh);D.subscribe('idea',refresh);
    document.addEventListener('task-navigation', refresh);
    refresh();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
