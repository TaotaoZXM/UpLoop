/* Overview: a fan of task cards. Swipe to browse, tap / swipe up / press 抽取 to draw one, then start it.
   The front of every card already shows the task, so drawing is about committing to one. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});
  const SCENES = { work: "工作", life: "生活" };
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const steps = plan => (plan?.stages || []).flatMap(stage => stage.steps || []);

  /** Due text for a deadline like 2026-11-27T23:59. 23:59 is the "any time that day" default and is not shown as a clock time. */
  function dueInfo(deadline, now) {
    if (!deadline) return null;
    const when = new Date(deadline);
    if (Number.isNaN(when.getTime())) return null;
    const today = startOf(now || new Date()), days = Math.round((startOf(when) - today) / 864e5);
    const clock = pad(when.getHours()) + ":" + pad(when.getMinutes());
    const rel = days < 0 ? "已逾期 " + -days + " 天" : days === 0 ? "今天截止" : days === 1 ? "明天截止" : "还有 " + days + " 天";
    return { days, rel, tone: days < 0 ? "late" : days <= 1 ? "soon" : "calm",
      date: (when.getMonth() + 1) + "月" + when.getDate() + "日 周" + WEEK[when.getDay()] + (clock === "23:59" ? "" : " " + clock) };
  }
  /** Where the task stands: how many steps are done and which one is next. */
  function progress(plan) {
    const all = steps(plan), done = all.filter(step => step.done).length, next = all.find(step => !step.done);
    return all.length ? { total: all.length, done, next: next?.title || "", ratio: done / all.length } : null;
  }
  /** Sooner deadlines first (overdue on top), tasks without one after them in their original order. */
  function order(list) {
    return list.map((item, index) => ({ item, index })).sort((a, b) => {
      const x = a.item.deadline || "", y = b.item.deadline || "";
      if (!x !== !y) return x ? -1 : 1;
      return (x < y ? -1 : x > y ? 1 : 0) || a.index - b.index;
    }).map(entry => entry.item);
  }
  function collect() {
    const nodes = B.workspace?.nodes?.() || [];
    return order(nodes.filter(node => node.kind === "task" && !node.completed).map(node => ({
      id: node.id, sourceId: node.sourceId, title: node.title, scene: node.scenario === "work" ? "work" : "life",
      project: node.scenario === "work" ? node.project || "" : "", important: Boolean(node.important), deadline: node.deadline || "", plan: node.plan || null, repeating: Boolean(node.repeating)
    })));
  }
  const esc = value => B.escape(String(value ?? ""));
  const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const account = () => typeof currentUser !== "undefined" ? currentUser?.id || null : null;
  const available = (list, ids) => list.filter(card => !ids.includes(card.id));
  const reconcile = (list, ids) => [...new Set(ids)].filter(id => list.some(card => card.id === id)).slice(0, 3);
  let root, cards = [], selected = [], index = 0, busy = false, finished = false, drag = null, owner = null, scheduled = false, suppressClick = false;
  const limit = () => Math.min(3, cards.length);
  const remaining = () => available(cards, selected);
  function metadata(card) {
    const due = dueInfo(card.deadline), prog = progress(card.plan);
    return (card.scene ? '<span>' + SCENES[card.scene] + '</span>' : '') +
      (card.project && card.project !== '未分类' ? '<span>' + esc(card.project) + '</span>' : '') +
      (due ? '<span>' + esc(due.date) + '</span>' : '') +
      (card.repeating ? '<span>循环</span>' : '') +
      (prog ? '<span>' + prog.done + ' / ' + prog.total + ' 步</span>' : '');
  }
  function face(card) {
    return '<span class="dr-face"><span class="dr-scene">' + (SCENES[card.scene] || '') + '</span><strong class="dr-title">' + esc(card.title) + '</strong><span class="dr-meta">' + metadata(card) + '</span></span>';
  }
  const importanceHtml=card=>'<button type="button" class="dr-important" data-important="'+esc(card.id)+'" aria-pressed="'+card.important+'" aria-label="'+(card.important?'取消重要标记：':'标记为重要：')+esc(card.title)+'">'+(card.important?'★':'☆')+'</button>';
  function ringHtml(list) {
    return list.map((card, i) => '<div role="button" tabindex="0" class="dr-card" data-ring="' + i + '" aria-label="抽取：' + esc(card.title) + '">' + face(card) + importanceHtml(card) + '</div>').join('');
  }
  function slotsHtml() {
    return Array.from({length:3}, (_, i) => {
      const card = cards.find(c => c.id === selected[i]);
      return '<div class="dr-slot' + (card ? ' is-filled' : '') + '" data-slot="' + i + '">' + (card ?
        '<article class="dr-chosen" aria-label="已选任务：' + esc(card.title) + '">' + face(card) + importanceHtml(card) + '<button type="button" class="dr-remove" data-remove="' + i + '" title="放回牌阵" aria-label="放回牌阵：' + esc(card.title) + '">×</button></article>' :
        '<span class="dr-slot-no">0' + (i + 1) + '</span><span>' + (i < limit() ? '等待抽取' : '选中位置') + '</span>') + '</div>';
    }).join('');
  }
  function place() {
    if (!root) return;
    const list = remaining(); index = Math.max(0, Math.min(index, list.length - 1));
    root.querySelectorAll('[data-ring]').forEach((node,i) => {
      let d = i - index;
      if (list.length > 6) { if(d > list.length/2)d -= list.length; if(d < -list.length/2)d += list.length; }
      node.style.setProperty('--angle', d * 22 + 'deg');
      node.style.zIndex = String(20 - Math.abs(d));
      node.classList.toggle('is-front',d===0); node.classList.toggle('is-hidden',Math.abs(d)>3);
      node.setAttribute('aria-disabled',String(busy || selected.length >= limit())); node.tabIndex = Math.abs(d)>3 ? -1 : 0;
      node.setAttribute('aria-hidden',String(Math.abs(d)>3));
    });
    const count = root.querySelector('.dr-count'); if(count)count.textContent = list.length ? (index+1) + ' / ' + list.length : '';
  }
  function render() {
    if (!root) return;
    const nextOwner = account(), changedOwner = owner !== nextOwner;
    if(owner !== nextOwner) { owner = nextOwner; selected = []; finished = false; }
    cards = owner ? collect() : []; if(changedOwner)index=Math.floor(available(cards,selected).length/2); selected = reconcile(cards,selected);
    root.dataset.view = !owner || !cards.length ? 'empty' : finished ? 'finished' : selected.length>=limit() ? 'full' : 'deck';
    const header = '<header class="dr-head"><h1>Task Pull</h1><button type="button" class="dr-add" data-act="add" aria-label="新建任务">＋</button></header>';
    if(!owner || !cards.length) {
      root.innerHTML=header+'<div class="dr-empty"><div class="dr-empty-square" aria-hidden="true"></div><h2>' + (owner?'把想做的事放进牌组':'登录后，开始抽取') + '</h2><button type="button" class="dr-primary" data-act="'+(owner?'add':'signin')+'">'+(owner?'新建任务':'登录')+'</button></div>';return;
    }
    const full=selected.length>=limit();
    root.innerHTML=header + '<div class="dr-intro"><p class="dr-eyebrow">YOUR NEXT THREE</p><h2 class="dr-lead">' + (finished?'这几件，慢慢做。':full?'选好了，就从这里开始。':'抽出你想做的三件事') + '</h2><p class="dr-status" role="status">已选 ' + selected.length + ' / ' + limit() + (cards.length<3?' · 共 '+cards.length+' 项待办':'') + '</p></div>' +
      '<div class="dr-selected" aria-label="选中的任务">'+slotsHtml()+'</div>' +
      '<div class="dr-stage" aria-label="任务卡圆弧轮盘"><div class="dr-orbit" aria-hidden="true"></div><div class="dr-deck">'+ringHtml(remaining())+'</div></div>' +
      '<div class="dr-controls"><div class="dr-browse"'+(full?' hidden':'')+'><button type="button" class="dr-arrow" data-act="prev" aria-label="上一张任务">←</button><span class="dr-count"></span><button type="button" class="dr-arrow" data-act="next" aria-label="下一张任务">→</button></div><p class="dr-hint">'+(full?'点击已选卡片上的 ×，随时放回牌阵':'左右滑动牌组，点击卡牌抽取')+'</p><div class="dr-actions">'+(full?'<button type="button" class="dr-primary" data-act="confirm">'+(finished?'查看 My Tasks':'确认这 '+limit()+' 项任务')+'</button>':'<button type="button" class="dr-ghost-btn" data-act="shuffle">随机抽取</button><button type="button" class="dr-primary" data-act="draw">抽取这张</button>')+'</div></div>';
    place();
  }
  function go(step) { if(busy || !remaining().length || selected.length>=limit())return; const n=remaining().length;index=(index+step+n)%n;place(); }
  async function draw(pick) {
    if(busy || selected.length>=limit())return;
    const user=account(), list=remaining(), at=pick??index, card=list[at];if(!card)return;
    index=at; place();busy=true;place();
    const source=root.querySelector('[data-ring="'+at+'"]'), target=root.querySelector('[data-slot="'+selected.length+'"]');
    let flying;
    try {
      if(!reduce() && source && target) {
        const a=source.getBoundingClientRect(), b=target.getBoundingClientRect();
        flying=document.createElement('div');flying.className='dr-flying';flying.innerHTML=face(card);flying.setAttribute('aria-hidden','true');
        Object.assign(flying.style,{left:a.left+'px',top:a.top+'px',width:a.width+'px',height:a.height+'px'});document.body.appendChild(flying);source.style.visibility='hidden';
        await flying.animate([{transform:'translate(0,0) rotate(0deg)',opacity:1},{transform:'translate('+(b.left-a.left)+'px,'+(b.top-a.top)+'px) scale('+b.width/a.width+') rotate(0deg)',opacity:1}],{duration:640,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'}).finished;
      }
      if(account() !== user)return;selected.push(card.id);index=Math.min(index,remaining().length-1);
    } finally { flying?.remove();busy=false;render();root.querySelector('[data-remove="'+(selected.length-1)+'"]')?.focus({preventScroll:true}); }
  }
  function remove(at) { if(busy)return;const [id]=selected.splice(at,1);finished=false;index=remaining().findIndex(card=>card.id===id);render();root.querySelector('.dr-card.is-front')?.focus({preventScroll:true}); }
  async function shuffle() {
    if(busy || !remaining().length || selected.length>=limit())return;
    const n=remaining().length,pick=Math.floor(Math.random()*n);index=pick;place();
    if(!reduce()) { busy=true;place();await new Promise(r=>setTimeout(r,400));busy=false; }
    await draw(pick);
  }
  function wire() {
    root.addEventListener('click',event=>{
      const button=event.target.closest('button,[data-ring]');if(!button || busy)return;
      if(button.hasAttribute('data-important')){const card=cards.find(c=>c.id===button.dataset.important);if(card){const row=[...document.querySelectorAll('#todoGroups .task-row')].find(r=>r.querySelector('.todo-check')?.dataset.taskId===card.sourceId||('task:repeat:'+r.dataset.repeatId)===card.id);row?.querySelector('.task-important-toggle')?.click();render();}return;}
      if(button.hasAttribute('data-remove'))return remove(Number(button.dataset.remove));
      if(button.hasAttribute('data-ring')){if(suppressClick){suppressClick=false;return;}return draw(Number(button.dataset.ring));}
      const action=button.dataset.act;
      if(action==='prev')go(-1);else if(action==='next')go(1);else if(action==='draw')draw();else if(action==='shuffle')shuffle();
      else if(action==='confirm'){ if(finished)window.showScreen?.('todo');else{finished=true;render();} }
      else if(action==='add'){ if(B.assistant?.open)B.assistant.open({mode:'task'});else window.showScreen?.('todo'); }
      else if(action==='signin' && typeof openAuthDialog==='function')openAuthDialog();
    });
    root.addEventListener('keydown',event=>{if(!event.target.closest('.dr-stage'))return;if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-ring]')){event.preventDefault();draw(Number(event.target.dataset.ring));}else if(event.key==='ArrowLeft'){event.preventDefault();go(-1);}else if(event.key==='ArrowRight'){event.preventDefault();go(1);}});
    root.addEventListener('pointerdown',event=>{if(!event.target.closest('.dr-stage') || busy)return;drag={x:event.clientX,y:event.clientY};});
    root.addEventListener('pointerup',event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag=null;if(Math.abs(dx)>35 && Math.abs(dx)>Math.abs(dy)){suppressClick=true;go(dx>0?-1:1);event.preventDefault();setTimeout(()=>{suppressClick=false;},300);}else if(dy < -55)draw();});
    root.addEventListener('pointercancel',()=>{drag=null;});
  }
  function schedule(){if(scheduled || busy)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;if(root && !root.closest('.screen').classList.contains('hidden'))render();});}
  function init(){
    const screen=document.getElementById('overviewScreen');if(!screen || !B.workspace){requestAnimationFrame(init);return;}
    screen.querySelectorAll(':scope > .ws-bar').forEach(n=>n.remove());root=document.createElement('section');root.id='taskDraw';root.className='draw';root.setAttribute('aria-label','抽取三项任务');screen.appendChild(root);wire();render();
    document.addEventListener('task-navigation',schedule);
    const todos=document.getElementById('todoGroups');if(todos)new MutationObserver(schedule).observe(todos,{childList:true,subtree:true});
    B.event?.addEventListener('auth',schedule);B.event?.addEventListener('task-record',schedule);
  }
  B.draw={dueInfo,progress,order,collect,available,reconcile};
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();}
})();
