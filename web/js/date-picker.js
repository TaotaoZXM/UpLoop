/* One date model and date control per module. Local calendar dates use noon
   when converting to Date, avoiding UTC/daylight-saving boundary shifts. */
(function () {
  "use strict";
  const B = window.Task = window.Task || {};
  const values = {};
  const listeners = {};
  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  };
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T12:00:00")) && key(new Date(value + "T12:00:00")) === value;
  function key(d) { return [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"), String(d.getDate()).padStart(2,"0")].join("-"); }
  function shift(value, offset) { const d = new Date(value + "T12:00:00"); d.setDate(d.getDate() + offset); return key(d); }
  function week(value) {
    const d = new Date(value + "T12:00:00");
    const monday = shift(value, -((d.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => shift(monday, i));
  }
  function get(module) { return values[module] || today(); }
  function set(module, value) {
    if (!valid(value)) return;
    values[module] = value;
    (listeners[module] || []).slice().forEach(fn => fn(value));
    document.querySelectorAll('[data-date-module="'+module+'"]').forEach(render);
  }
  function subscribe(module, fn) { (listeners[module] = listeners[module] || []).push(fn); }
  function render(host) {
    const module = host.dataset.dateModule;
    const selected = get(module), current = today(), d = new Date(selected + "T12:00:00");
    host.innerHTML = '<div class="task-date-heading"><label class="task-month-entry"><span>' + d.getFullYear() + '年' + (d.getMonth()+1) + '月 <span aria-hidden="true">⌄</span></span>' +
      '<input type="date" aria-label="'+host.dataset.dateLabel+'选择任意日期" value="'+selected+'"></label>' +
      (selected !== current ? '<button type="button" data-date-today>回到今天</button>' : '') + '</div>' +
      '<div class="task-week-nav"><button type="button" data-date-week="-1" aria-label="'+host.dataset.dateLabel+'上一周">‹</button><div class="task-week-days" role="group" aria-label="'+host.dataset.dateLabel+'本周日期">' +
      week(selected).map((value,i) => '<button type="button" data-date-day="'+value+'" aria-label="'+value+'" aria-pressed="'+(value===selected)+'" class="'+(value===selected?'is-selected ':'')+(value===current?'is-today':'')+'"><span>'+['一','二','三','四','五','六','日'][i]+'</span><strong>'+Number(value.slice(-2))+'</strong></button>').join('') +
      '</div><button type="button" data-date-week="1" aria-label="'+host.dataset.dateLabel+'下一周">›</button></div>';
    host.querySelector('input').onchange = event => { if (event.target.value) set(module,event.target.value); };
    host.querySelectorAll('[data-date-day]').forEach(button => button.onclick = () => set(module,button.dataset.dateDay));
    host.querySelectorAll('[data-date-week]').forEach(button => button.onclick = () => set(module,shift(selected,Number(button.dataset.dateWeek)*7)));
    const back = host.querySelector('[data-date-today]'); if (back) back.onclick = () => set(module,today());
    let start, swiped=false;
    const strip = host.querySelector('.task-week-days');
    strip.onpointerdown = event => { if (event.isPrimary !== false) { swiped=false;start = { x:event.clientX,y:event.clientY }; } };
    strip.onpointerup = event => { if (!start) return; const dx=event.clientX-start.x,dy=event.clientY-start.y;start=null;if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)*1.5){swiped=true;set(module,shift(selected,dx<0?7:-7));} };
    strip.addEventListener('click', event => { if(swiped){event.preventDefault();event.stopImmediatePropagation();swiped=false;} },true);
    strip.onpointercancel = () => { start=null; };
  }
  function mount(host,module,label) { host.classList.add('task-date-picker');host.dataset.dateModule=module;host.dataset.dateLabel=label;render(host); }
  B.dates = { get,set,subscribe,mount,today,week,shift,valid };
})();
