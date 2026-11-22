/* One checklist format for everything: AI task decomposition, manual drafts and daily checklists.
   Draft screen: stages + steps with time, first step lit, "调整 · 再拆细" + "就这样，开始第一步".
   View screen: flat steps, done struck through, current step lit with a 当前 badge. */
(function () {
  'use strict';
  const B=window.Task, esc=value=>B.escape(String(value??'')), clone=value=>JSON.parse(JSON.stringify(value)), uid=()=>crypto.randomUUID();
  const steps=plan=>(plan?.stages||[]).flatMap(stage=>stage.steps||[]);
  const current=plan=>steps(plan).find(step=>!step.done);
  const isComplete=plan=>steps(plan).length>0&&steps(plan).every(step=>step.done);
  const timeText=m=>m>=240?'半天':m>=60?(m%60?Math.floor(m/60)+' 小时 '+m%60+' 分':m/60+' 小时'):m+' 分钟';
  // "25" / "25分钟" / "1.5小时" / "1小时20分" / "1h" / "半天" -> minutes (1–240)
  const parseTime=text=>{
    const v=String(text||'').trim().replace(/\s+/g,'');if(!v)return null;
    if(/^半天$/.test(v))return 240;
    let total=0,matched=false;
    const h=v.match(/(\d+(?:\.\d+)?)(?:个?小时|h|hr|时)/i);if(h){total+=parseFloat(h[1])*60;matched=true;}
    const m=v.match(/(\d+)(?:分钟|分|min|m)(?![a-z])/i);if(m){total+=Number(m[1]);matched=true;}
    if(!matched&&/^\d+(?:\.\d+)?$/.test(v))total=parseFloat(v);
    return total>0?Math.min(240,Math.max(1,Math.round(total))):null;
  };
  const errorFor=step=>{
    const length=Array.from(String(step.title||'').trim()).length;
    if(!length||length>30)return '每步需为1–30字';
    if(!Number.isInteger(step.minutes)||step.minutes<1||step.minutes>240)return '单步需为1–240分钟';
    if(!Number.isInteger(step.waitDays)||step.waitDays<0||step.waitDays>365)return '等待天数需为0–365';
    return '';
  };
  const planError=plan=>!steps(plan).length?'请先添加一步':steps(plan).length>60?'清单最多60步':steps(plan).map(errorFor).find(Boolean)||'';

  // mode: draft (not yet a task/checklist) · task (parent task view) · routine (daily checklist view)
  let draft=null, mode='draft', parentId=null, routine=null, busy=false, adjusting=false, menu=false, status='', failed=false, session=0, lastRequest={mode:'create'}, returnTo='todo', focusAdd=null;
  const panel=document.createElement('section');panel.className='screen work hidden decomposition-screen';panel.id='decompositionScreen';
  let previewRoot=null, previewConfirm=null;
  const surface=()=>previewRoot||panel;
  document.querySelector('.phone').appendChild(panel);screens.decomposition=panel;
  let checklistSwipe=null;
  panel.addEventListener('pointerdown',event=>{
    if(mode==='draft'||panel.classList.contains('hidden')||event.button>0)return;
    if(event.target.closest('.plan-row,button,input,textarea,select,[data-drag],.plan-bottom'))return;
    checklistSwipe={id:event.pointerId,x:event.clientX,y:event.clientY};
  });
  panel.addEventListener('pointerup',event=>{
    if(!checklistSwipe||checklistSwipe.id!==event.pointerId)return;
    const dx=event.clientX-checklistSwipe.x,dy=event.clientY-checklistSwipe.y;checklistSwipe=null;
    if(dx < -72&&Math.abs(dx)>Math.abs(dy)*1.35){event.preventDefault();showScreen('todo');}
  });
  panel.addEventListener('pointercancel',()=>{checklistSwipe=null;});
  const listScreen=document.getElementById('routineScreen');let listSwipe=null;
  listScreen?.addEventListener('pointerdown',event=>{if(event.button>0||event.target.closest('button,input,textarea,select,.checklist-card,.task-row'))return;listSwipe={id:event.pointerId,x:event.clientX,y:event.clientY};});
  listScreen?.addEventListener('pointerup',event=>{if(!listSwipe||listSwipe.id!==event.pointerId)return;const dx=event.clientX-listSwipe.x,dy=event.clientY-listSwipe.y;listSwipe=null;if(dx < -72&&Math.abs(dx)>Math.abs(dy)*1.35){event.preventDefault();showScreen('todo');}});
  listScreen?.addEventListener('pointercancel',()=>{listSwipe=null;});
  const account=()=>currentUser?.id||null;
  let owner=account();
  const activeScreen=()=>Object.keys(screens).find(key=>key!=='decomposition'&&!screens[key].classList.contains('hidden'))||'todo';
  const findParent=id=>[...document.querySelectorAll('#todoGroups .task-row,#doneList .done-row')].find(row=>(row.dataset.taskId||row.querySelector('.todo-check')?.dataset.taskId)===id);
  const taskTitle=row=>row.querySelector('.task-title,.done-copy strong')?.textContent.trim()||'';
  const show=()=>{session++;busy=false;menu=false;status='';failed=false;if(!previewRoot)showScreen('decomposition');render();};

  /* ---------- daily checklist <-> plan ---------- */
  const routineToPlan=(item,doneIds=[])=>{
    const stages=[];
    (item.steps||[]).forEach((raw,index)=>{
      const step=typeof raw==='string'?{title:raw.replace(/^\s*step\s*\d+[\s.:：、-]*/i,''),minutes:10,stage:''}:raw;
      const name=step.stage||'';
      if(!stages.length||stages.at(-1).title!==name)stages.push({id:'rs'+index,title:name,steps:[]});
      stages.at(-1).steps.push({id:'r'+index,title:step.title,minutes:step.minutes||10,waitDays:0,done:Boolean(item.checked)||doneIds.includes('r'+index)||doneIds.includes('legacy-step:'+index)});
    });
    return {stages};
  };
  const planToRoutine=plan=>plan.stages.flatMap(stage=>stage.steps.map(step=>({title:step.title,minutes:step.minutes,stage:stage.title==='开始行动'?'':stage.title})));
  const progressKey=()=>routine.id+'|'+routine.day;

  /* ---------- persistence ---------- */
  const persist=()=>{
    if(!draft||!account())return;
    if(mode==='draft'){
      if(previewRoot||draft.kind==='checklist')return; // checklist drafts live only on screen until confirmed
      const index=planDrafts.findIndex(item=>item.id===draft.id),value=clone(draft);
      if(index<0)planDrafts.unshift(value);else planDrafts[index]=value;persistAppState();return;
    }
    if(mode==='task'){
      if(planError(draft.plan))return;
      const row=findParent(parentId);if(!row){status='父任务已删除，请返回';return;}
      row.taskPlan=clone(draft.plan);
      if(row.dataset.repeatId){const rule=repeatTasks.find(item=>item.id===row.dataset.repeatId);if(rule){rule.occurrencePlans=rule.occurrencePlans||{};rule.occurrencePlans[row.dataset.occurrenceDay]=clone(draft.plan);}}
      persistAppState();decorate();
    }
  };
  const saveRoutine=async()=>{
    if(mode!=='routine'||planError(draft.plan))return;
    try{
      await B.api('/api/routines/'+encodeURIComponent(routine.id),{method:'PUT',body:JSON.stringify({title:draft.title,scenario:routine.scenario,steps:planToRoutine(draft.plan)})});
      const ids=[];steps(draft.plan).forEach((step,index)=>{if(step.done)ids.push('r'+index);});
      draft.plan=routineToPlan({steps:planToRoutine(draft.plan)},ids);
      checklistProgress[progressKey()]=ids;persistAppState();B.records?.renderRoutines();
    }catch(error){status=error.message||'没有保存成功，请重试';render();}
  };
  const changed=()=>{if(mode==='routine')saveRoutine();else persist();};

  const latestStart=()=>{
    if(!draft?.task?.deadline)return '';
    const remaining=steps(draft.plan).filter(step=>!step.done), minutes=remaining.reduce((sum,s)=>sum+s.minutes,0), waiting=remaining.reduce((sum,s)=>sum+s.waitDays,0);
    return shiftDayKey(dateKey(draft.task.deadline),-(Math.max(0,Math.ceil(minutes/240)-1)+waiting));
  };

  /* ---------- open ---------- */
  const open=row=>{
    if(!row?.taskPlan)return;
    returnTo=activeScreen();mode='task';routine=null;adjusting=false;
    parentId=row.dataset.taskId||row.querySelector('.todo-check')?.dataset.taskId;
    draft={id:parentId,title:taskTitle(row),task:{deadline:row.dataset.deadline||''},plan:clone(row.taskPlan)};show();
  };
  const openRoutine=(item,day)=>{
    returnTo=activeScreen();mode='routine';parentId=null;adjusting=false;
    routine={id:item.id,scenario:item.scenario||'life',day,checked:Boolean(item.checked)};
    const ids=Array.isArray(checklistProgress[item.id+'|'+day])?checklistProgress[item.id+'|'+day]:[];
    draft={id:item.id,title:item.title,task:{},plan:routineToPlan(item,ids)};show();
  };
  const resume=item=>{returnTo=activeScreen();mode='draft';parentId=null;routine=null;draft=clone(item);adjusting=!steps(draft.plan).length;show();};
  const startDraft=(value,auto)=>{
    returnTo=activeScreen();mode='draft';parentId=null;routine=null;draft=value;adjusting=!auto;persist();show();
    if(auto)request('create');
  };
  const closePreview=()=>{const submit=document.querySelector('#todoSheet button.sheet-submit:not([type=button])');if(submit)submit.disabled=false;session++;busy=false;previewRoot?.replaceChildren();previewRoot?.classList.add('hidden');previewRoot=null;previewConfirm=null;draft=null;mode='draft';};
  const previewTask=(container,value,onConfirm)=>{
    if(!container||!value)return;
    session++;busy=false;mode='draft';parentId=null;routine=null;returnTo='todo';previewRoot=container;previewConfirm=onConfirm;draft=clone(value);draft.kind='task';draft.plan=draft.plan||{stages:[]};adjusting=false;menu=false;status='';failed=false;container.classList.remove('hidden');const submit=document.querySelector('#todoSheet button.sheet-submit:not([type=button])');if(submit)submit.disabled=true;render();request('create');
  };
  const newChecklist=()=>{
    if(!requireAccount())return;
    startDraft({id:uid(),kind:'checklist',title:'',task:{scenario:'life'},plan:{stages:[]},source:'manual',createdAt:new Date().toISOString()},false);
    surface().querySelector('#planTitle')?.focus();
  };

  /* ---------- AI ---------- */
  const request=async(kind,stepId)=>{
    if(busy||!draft)return;
    if(!draft.title.trim()){status='先写清单名称，再让 AI 拆解';failed=false;render();return;}
    lastRequest={mode:kind,stepId};
    const selected=steps(draft.plan).find(step=>step.id===stepId);
    if(kind==='refine'&&!selected)return;
    busy=true;menu=false;status=kind==='refine'?'正在把这一步拆得更细…':'正在拆解…';failed=false;render();
    const token=session,user=account(),original=clone(draft.plan);
    try{
      const result=await B.api('/api/tasks/decompose',{method:'POST',body:JSON.stringify({title:draft.title,deadline:draft.task?.deadline||'',mode:kind,feedback:'',previous:draft.plan,step:selected||null})});
      if(token!==session||user!==account())return;
      const incoming=result.plan;
      if(kind==='refine'){
        const stage=draft.plan.stages.find(stage=>stage.steps.includes(selected));
        stage.steps.splice(stage.steps.indexOf(selected),1,...steps(incoming));
      }else{
        const done=steps(draft.plan).filter(step=>step.done);
        incoming.stages.forEach(stage=>{stage.steps=stage.steps.filter(step=>!done.some(item=>item.title===step.title));});
        draft.plan={stages:[...(done.length?[{id:uid(),title:'已完成',steps:done}]:[]),...incoming.stages.filter(stage=>stage.steps.length)]};
      }
      if(steps(draft.plan).length>60)throw Error('超过60步，请删掉一些再试');
      draft.source='ai';status='';adjusting=false;changed();
    }catch(error){
      if(token===session&&user===account()){draft.plan=original;failed=true;adjusting=true;status=(error.message||'没有拆解成功')+' · 也可以直接添加步骤';}
    }finally{if(token===session&&user===account()){busy=false;render();}}
  };

  /* ---------- editing ---------- */
  const stepById=id=>steps(draft.plan).find(step=>step.id===id);
  const removeStep=id=>{draft.plan.stages.forEach(stage=>{stage.steps=stage.steps.filter(step=>step.id!==id);});draft.plan.stages=draft.plan.stages.filter(stage=>stage.steps.length);};
  const addStep=(stageId,title)=>{
    title=title.trim();if(!title)return;
    if(steps(draft.plan).length>=60){status='清单最多60步';render();return;}
    let stage=draft.plan.stages.find(item=>item.id===stageId)||draft.plan.stages.at(-1);
    if(!stage){stage={id:uid(),title:'',steps:[]};draft.plan.stages.push(stage);}
    const step={id:uid(),title,minutes:10,waitDays:0,done:false};
    if(errorFor(step)){status=errorFor(step);render();return;}
    if(!steps(draft.plan).length&&!draft.source)draft.source='manual';
    stage.steps.push(step);status='';focusAdd=stage.id;changed();render();
  };
  const editTitle=(id,value)=>{
    const step=stepById(id);if(!step)return;
    if(!value.trim()){if(mode!=='draft'&&steps(draft.plan).filter(item=>!item.done).length<=1){status='最后一步请完成，或删除整个清单';render();return;}removeStep(id);changed();render();return;}
    const proposed={...step,title:value.trim()};
    if(errorFor(proposed)){status=errorFor(proposed);render();return;}
    step.title=proposed.title;status='';changed();
  };
  const editTime=(id,value)=>{const step=stepById(id);if(!step)return;const minutes=parseTime(value);if(!minutes){status='时间可写成 25、1.5 小时、1 小时 20 分或半天';render();return;}step.minutes=minutes;status='';changed();render();};
  const commitInputs=()=>{
    surface().querySelectorAll('[data-title]').forEach(input=>{const step=stepById(input.dataset.title);if(step&&input.value.trim()&&input.value.trim()!==step.title)step.title=input.value.trim();});
    surface().querySelectorAll('[data-add]').forEach(input=>{if(input.value.trim())addStep(input.dataset.add,input.value);});
    const title=surface().querySelector('#planTitle');if(title)draft.title=title.value.trim();
  };

  /* ---------- confirm & complete ---------- */
  const begin=async()=>{
    if(busy)return;commitInputs();
    if(draft.kind==='checklist'&&!draft.title){status='请写清单名称';render();surface().querySelector('#planTitle')?.focus();return;}
    const error=planError(draft.plan);if(error){status=error;adjusting=true;render();return;}
    if(!requireAccount())return;
    if(previewRoot){const callback=previewConfirm,plan=clone(draft.plan),taskDraft=clone(draft);closePreview();callback?.(plan,taskDraft);return;}
    steps(draft.plan).forEach(step=>{step.done=false;});
    if(draft.kind==='checklist'){
      busy=true;render();
      try{
 const result=await B.api('/api/routines',{method:'POST',body:JSON.stringify({title:draft.title,scenario:draft.task.scenario||'life',steps:planToRoutine(draft.plan)})});
        busy=false;const back=returnTo;await B.records?.renderRoutines();openRoutine({...result.item,checked:false},dayKeyToday());returnTo=back;
      }catch(failure){busy=false;status=failure.message||'没有保存成功，内容已保留';render();}
      return;
    }
    const task={...draft.task,id:draft.task.attachId||uid(),title:draft.title,plan:clone(draft.plan),difficulty:'easy',createdAt:new Date().toISOString()};
    task.checklistId=draft.task.checklistId||'checklist:'+task.id;
    if(draft.task.attachId){
      const existing=findParent(draft.task.attachId);if(!existing){status='父任务已删除，请返回';render();return;}
      existing.taskPlan=clone(task.plan);existing.dataset.checklistId=task.checklistId;parentId=draft.task.attachId;
      if(existing.dataset.repeatId){const rule=repeatTasks.find(item=>item.id===existing.dataset.repeatId);if(rule){rule.occurrencePlans=rule.occurrencePlans||{};rule.occurrencePlans[existing.dataset.occurrenceDay]=clone(task.plan);}}
    }else if(task.repeating){
      const rule={...task,startDay:dateKey(new Date()),repeatDays:task.repeatDays,occurrencePlans:{}};delete rule.repeating;repeatTasks.push(rule);renderedRepeatDay='';renderRecurringTasks();
      const row=[...document.querySelectorAll('.repeat-instance')].find(row=>row.dataset.repeatId===rule.id&&row.dataset.occurrenceDay===dateKey(new Date()));
      parentId=row?.querySelector('.todo-check')?.dataset.taskId;
    }else{
      document.querySelector('#todoGroups .group').appendChild(createTodoRow(task));parentId=task.id;
    }
    planDrafts=planDrafts.filter(item=>item.id!==draft.id);updateCounts();
    mode='task';adjusting=false;status='';persist();render();
  };
  const dayKeyToday=()=>dateKey(new Date());
  /* A finished checklist is praised by completeTask (tasks) or here (daily routines); every other tick gets a step line. */
  const praiseStep=(title,plan,routine)=>{
    const all=steps(plan),k=all.filter(s=>s.done).length;
    if(isComplete(plan)){if(routine)B.praise?.notify({type:'done',title,plan:true});return;}
    B.praise?.notify({type:'step',title,k,total:all.length});
  };
  const completeStep=async id=>{
    if(busy)return;
    const step=current(draft.plan);if(!step||step.id!==id)return;
    step.done=true;
    praiseStep(draft.title,draft.plan,mode==='routine');
    if(mode==='routine'){
      const ids=steps(draft.plan).map((item,index)=>item.done?'r'+index:null).filter(Boolean);
      checklistProgress[progressKey()]=ids;persistAppState();render();
      if(isComplete(draft.plan)){
 try{await B.api('/api/routines/'+encodeURIComponent(routine.id)+'/check',{method:'PUT',body:JSON.stringify({day:routine.day,checked:true})});routine.checked=true;delete checklistProgress[progressKey()];persistAppState();}
 catch{status='已勾选，本机已保存；同步失败，请稍后重试';}
      }
      B.records?.renderRoutines();render();return;
    }
    persist();
    if(isComplete(draft.plan)){
      const row=findParent(parentId);if(row?.querySelector('.todo-check'))completeTask(row.querySelector('.todo-check'));
      status='全部完成，已进入 Done，并写进当晚战报';
      renderCal();saveCloudAppState(true).then(()=>B.records?.renderReport()).catch(()=>{status='已完成，本机已保存；云端同步失败，请稍后重试';render();});
    }
    render();
  };

  /* ---------- render ---------- */
  const editControls=step=>`<input class="plan-time-input" data-time="${esc(step.id)}" value="${timeText(step.minutes)}" aria-label="时间，例如 25、1.5 小时、半天"><button type="button" class="plan-icon" data-refine="${esc(step.id)}" ${busy?'disabled':''} title="让 AI 再拆细" aria-label="再拆细${esc(step.title)}">拆</button><button type="button" class="plan-icon" data-del="${esc(step.id)}" aria-label="删除${esc(step.title)}">×</button><button type="button" class="plan-drag" data-drag="${esc(step.id)}" aria-label="拖动调整顺序，也可用上下方向键">⋮⋮</button>`;
  const stageHead=(stage,index)=>stage.title||draft.plan.stages.length>1?`<h2><span class="plan-num">${String(index+1).padStart(2,'0')}</span> · ${esc(stage.title||'步骤')}</h2>`:'';
  const addRow=stageId=>`<label class="plan-row plan-add"><span class="plan-plus" aria-hidden="true">＋</span><input data-add="${esc(stageId)}" maxlength="30" placeholder="添加一步，回车确认" aria-label="添加一步"></label>`;
  function render(){
    if(!draft)return;
    const all=steps(draft.plan),next=current(draft.plan),doneCount=all.filter(step=>step.done).length;
    const viewing=mode!=='draft',row=mode==='task'?findParent(parentId):null;
    const finished=viewing&&(isComplete(draft.plan)||Boolean(row?.classList.contains('done-row')));
    const editing=adjusting&&!finished&&!busy;
    let html='';
    if(viewing){
      html+=`<header class="plan-head is-view"><button type="button" data-back aria-label="返回">‹</button><strong>${esc(draft.title)}</strong><span class="plan-count">${doneCount}/${all.length}</span></header>`;
      html+=`<p class="plan-status" role="status">${esc(status)}</p><div class="plan-list">`+draft.plan.stages.map((stage,index)=>`<section class="plan-stage" data-stage-id="${esc(stage.id)}">${stageHead(stage,index)}`+stage.steps.map(step=>{
        const state=step.done?'is-done':step===next?'is-current':'is-upcoming';
        const canEdit=editing&&!step.done;
 return `<div class="plan-row ${state}" data-step-id="${esc(step.id)}"><button type="button" class="plan-circle" data-complete="${esc(step.id)}" ${step===next&&!finished&&!editing?'':'disabled'} aria-label="完成${esc(step.title)}"></button>${canEdit?`<input class="plan-row-input" data-title="${esc(step.id)}" maxlength="30" value="${esc(step.title)}" aria-label="步骤">${editControls(step)}`:`<span class="plan-copy"><strong>${esc(step.title)}</strong>${step===next&&!finished?`<small>${timeText(step.minutes)} · 今天就能做</small>`:''}</span>${step===next&&!finished?'<b class="plan-badge">当前</b>':''}`}</div>`;
      }).join('')+(editing?addRow(stage.id):'')+'</section>').join('')+'</div>';
    }else{
      const half=all.filter(step=>step.minutes>=240).length, latest=latestStart();
      html+=`<header class="plan-head"><button type="button" data-back aria-label="返回">‹</button><strong>拆解</strong><button type="button" class="plan-pill" data-menu aria-expanded="${menu}">草稿</button></header>`;
      if(menu)html+=`<div class="plan-menu"><button type="button" data-regenerate ${busy?'disabled':''}>整组重拆</button><button type="button" class="is-danger" data-discard>丢弃草稿</button></div>`;
      html+=draft.kind==='checklist'?`<input id="planTitle" class="plan-title-input" maxlength="80" placeholder="清单名称，例如：睡前整理" value="${esc(draft.title)}" aria-label="清单名称">`:`<h1>${esc(draft.title)}</h1>`;
      html+=`<p class="plan-summary">${draft.source==='ai'?'AI 草案':'手动草案'} · ${all.length} 步${half?` · 其中 ${half} 步需要半天`:''}${latest?` · 最晚 ${esc(latest.slice(5).replace('-','.'))} 开始`:''}</p><hr class="plan-rule">`;
      html+=`<p class="plan-status ${failed?'is-error':''}" role="status">${esc(status)}${failed&&!busy?' <button type="button" class="plan-link" data-retry>重试</button>':''}</p>`;
      if(!all.length&&!busy)html+=`<p class="plan-empty">把要做的事一步步写下来${draft.kind==='checklist'?'，或 <button type="button" class="plan-link" data-ai>让 AI 拆解</button>':''}。点「开始」前不会生成任务。</p>`;
      html+='<div class="plan-stages">'+draft.plan.stages.map((stage,index)=>`<section class="plan-stage" data-stage-id="${esc(stage.id)}">${stageHead(stage,index)}${stage.steps.map(step=>`<div class="plan-row ${step===all[0]&&!editing?'is-current':''}" data-step-id="${esc(step.id)}"><span class="plan-circle" aria-hidden="true"></span>${editing?`<input class="plan-row-input" data-title="${esc(step.id)}" maxlength="30" value="${esc(step.title)}" aria-label="步骤">${editControls(step)}`:`<span class="plan-copy"><strong>${esc(step.title)}</strong>${step===all[0]?'<small>今天就能做</small>':''}</span><span class="plan-time">${timeText(step.minutes)}</span>`}</div>`).join('')}${editing?addRow(stage.id):''}</section>`).join('')+(editing&&!draft.plan.stages.length?addRow(''):'')+'</div>';
    }
    const target=surface();target.innerHTML=`<div class="plan-scroll">${html}</div>`;
    if(!viewing)target.insertAdjacentHTML('beforeend',`<footer class="plan-bottom"><button type="button" data-adjust ${busy?'disabled':''}>${adjusting?'完成调整':'调整 · 再拆细'}</button><button type="button" class="plan-begin" data-begin ${!all.length&&!adjusting||busy?'disabled':''}>${previewRoot?'确认并添加任务':'就这样，开始第一步'}</button></footer>`);
    else if(!finished)target.insertAdjacentHTML('beforeend',`<footer class="plan-bottom is-single">${adjusting&&mode==='task'?'<button type="button" data-edit-task>编辑任务信息</button>':''}${adjusting&&mode==='routine'?'<button type="button" class="is-danger" data-delete-routine>删除清单</button>':''}<button type="button" data-adjust ${busy?'disabled':''}>${adjusting?'完成调整':'调整步骤'}</button></footer>`);
    bind();
    if(focusAdd!==null){const input=[...surface().querySelectorAll('[data-add]')].find(item=>item.dataset.add===focusAdd)||surface().querySelector('[data-add]');input?.focus();focusAdd=null;}
  }
  // Rebuild stages from the DOM order after a drag (steps may move across stages).
  const applyOrder=()=>{
    const target=surface(),byId=new Map(steps(draft.plan).map(step=>[step.id,step]));
    draft.plan.stages.forEach(stage=>{
      const section=[...target.querySelectorAll('.plan-stage[data-stage-id]')].find(node=>node.dataset.stageId===stage.id);
      if(section)stage.steps=[...section.querySelectorAll('.plan-row[data-step-id]')].map(node=>byId.get(node.dataset.stepId)).filter(Boolean);
    });
    draft.plan.stages=draft.plan.stages.filter(stage=>stage.steps.length);
    changed();render();
  };
  const moveByKey=(id,up)=>{
    const stages=draft.plan.stages,si=stages.findIndex(stage=>stage.steps.some(step=>step.id===id));if(si<0)return;
    const list=stages[si].steps,i=list.findIndex(step=>step.id===id),step=list[i];
    if(up&&i>0)[list[i-1],list[i]]=[list[i],list[i-1]];
    else if(!up&&i<list.length-1)[list[i+1],list[i]]=[list[i],list[i+1]];
    else if(up&&si>0){list.splice(i,1);stages[si-1].steps.push(step);}
    else if(!up&&si<stages.length-1){list.splice(i,1);stages[si+1].steps.unshift(step);}
    else return;
    draft.plan.stages=stages.filter(stage=>stage.steps.length);changed();render();
    [...surface().querySelectorAll('[data-drag]')].find(node=>node.dataset.drag===id)?.focus();
  };
  function bindDrag(handle){
    handle.addEventListener('keydown',event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();commitInputs();moveByKey(handle.dataset.drag,event.key==='ArrowUp');}});
    handle.addEventListener('pointerdown',event=>{
      if(event.button>0)return;
      event.preventDefault();commitInputs();
      const row=handle.closest('.plan-row'),scroller=surface().querySelector('.plan-scroll');
      row.classList.add('is-dragging');handle.setPointerCapture(event.pointerId);
      let timer=null,lastY=event.clientY;
      const place=y=>{
        const targets=[...surface().querySelectorAll('.plan-stage .plan-row[data-step-id], .plan-stage .plan-add')].filter(node=>node!==row);
        const target=targets.find(node=>{const box=node.getBoundingClientRect();return y<box.top+box.height/2;});
        if(target){if(target.previousElementSibling!==row)target.before(row);}
        else{const last=[...surface().querySelectorAll('.plan-stage')].at(-1);if(last&&last.lastElementChild!==row)last.appendChild(row);}
      };
      const edge=()=>{const box=scroller.getBoundingClientRect();const d=lastY<box.top+48?-10:lastY>box.bottom-48?10:0;if(d){scroller.scrollTop+=d;place(lastY);}};
      const move=e=>{lastY=e.clientY;place(e.clientY);};
      const up=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);clearInterval(timer);row.classList.remove('is-dragging');applyOrder();};
      timer=setInterval(edge,30);
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
    });
  }
  function bind(){
    const target=surface(),on=(selector,handler)=>target.querySelectorAll(selector).forEach(node=>node.addEventListener('click',event=>handler(node,event)));
    on('[data-back]',()=>{commitInputs();if(previewRoot){closePreview();return;}session++;busy=false;showScreen(returnTo);});
    on('[data-menu]',()=>{menu=!menu;render();});
    on('[data-regenerate]',()=>request('regenerate'));
    on('[data-retry]',()=>request(lastRequest.mode,lastRequest.stepId));
    on('[data-ai]',()=>{commitInputs();request('create');});
    on('[data-discard]',()=>{if(previewRoot){closePreview();return;}planDrafts=planDrafts.filter(item=>item.id!==draft.id);session++;draft=null;persistAppState();showScreen(returnTo);decorate();B.records?.renderRoutines();});
    on('[data-adjust]',()=>{commitInputs();adjusting=!adjusting;status='';failed=false;changed();render();});
    on('[data-begin]',begin);
    on('[data-complete]',node=>completeStep(node.dataset.complete));
    target.querySelectorAll('[data-time]').forEach(input=>{input.addEventListener('change',()=>editTime(input.dataset.time,input.value));input.addEventListener('focus',()=>input.select());});
    target.querySelectorAll('[data-drag]').forEach(bindDrag);
    on('[data-refine]',node=>{commitInputs();request('refine',node.dataset.refine);});
    on('[data-del]',node=>{if(mode!=='draft'&&steps(draft.plan).filter(step=>!step.done).length<=1){status='最后一步请完成，或删除整个清单';render();return;}removeStep(node.dataset.del);changed();render();});
    on('[data-edit-task]',()=>{const row=findParent(parentId);if(row){showScreen(returnTo);B.taskCards?.edit(row);}});
    on('[data-delete-routine]',async()=>{try{await B.api('/api/routines/'+encodeURIComponent(routine.id),{method:'DELETE'});delete checklistProgress[progressKey()];persistAppState();draft=null;await B.records?.renderRoutines();showScreen(returnTo);}catch(error){status=error.message||'删除失败';render();}});
    surface().querySelectorAll('[data-title]').forEach(input=>input.addEventListener('change',()=>editTitle(input.dataset.title,input.value)));
    surface().querySelectorAll('[data-add]').forEach(input=>{
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();addStep(input.dataset.add,input.value);}});
      input.addEventListener('blur',()=>{if(input.value.trim()&&input.isConnected)addStep(input.dataset.add,input.value);});
    });
    target.querySelector('#planTitle')?.addEventListener('input',event=>{draft.title=event.target.value;});
  }

  /* ---------- To-do parent card: title · 4/7 · 当前：xx · progress · › ---------- */
  const decorate=()=>{
    document.querySelectorAll('#todoGroups .task-row,#doneList .done-row').forEach(row=>{
      const main=row.querySelector('.task-main')||row.querySelector('.done-copy');if(!main)return;
      if(!row.taskPlan){row.classList.remove('has-task-plan');row.querySelectorAll('.plan-card-summary,.plan-card-progress,.plan-card-open').forEach(node=>node.remove());return;}
      const all=steps(row.taskPlan),next=current(row.taskPlan),done=all.filter(step=>step.done).length;
      const text=done+'/'+all.length+(next?' · 当前：'+next.title:' · 全部完成');
      let summary=row.querySelector('.plan-card-summary');
      if(!summary){summary=document.createElement('span');summary.className='plan-card-summary';main.appendChild(summary);}
      if(summary.textContent!==text)summary.textContent=text;
      let bar=row.querySelector('.plan-card-progress');
      if(!bar){bar=document.createElement('span');bar.className='plan-card-progress';bar.innerHTML='<i></i>';summary.after(bar);}
      const width=(all.length?Math.round(done/all.length*100):0)+'%';if(bar.firstChild.style.width!==width)bar.firstChild.style.width=width;
      bar.setAttribute('aria-label','清单进度 '+done+'/'+all.length);
      let link=row.querySelector('.plan-card-open');
      if(!link){link=document.createElement('button');link.type='button';link.className='plan-card-open';link.textContent='›';link.setAttribute('aria-label','打开清单');(row.querySelector('.swipe-content')||row).appendChild(link);}
      link.onclick=event=>{event.preventDefault();event.stopPropagation();open(row);};
      row.classList.add('has-task-plan');row.classList.toggle('plan-complete',!next);
    });
  };

  document.getElementById('addAndDecompose').onclick=()=>{
    if(!requireAccount())return;
    const title=document.getElementById('newTaskTitle').value.trim();if(!title){document.getElementById('newTaskTitle').focus();return;}
    const repeating=document.getElementById('newTaskRepeatToggle').checked,repeatDays=Number(document.getElementById('newTaskRepeatDays').value);
    if(repeating&&(!Number.isInteger(repeatDays)||repeatDays<1||repeatDays>365)){document.getElementById('newTaskRepeatDays').reportValidity();return;}
    const scenario=document.getElementById('newTaskScenario').value||'life';
    const project=scenario==='work'?(document.querySelector('#todoSheet .project.active')?.textContent.trim()||'未分类'):'未分类';
    const date=taskDeadlineValue,time=document.getElementById('taskDeadlineTime').value,deadline=date?date+'T'+(time||'23:59'):'';
    // Same full-page plan screen as 新建清单: close the sheet, then open the draft there.
    document.getElementById('todoSheet').classList.add('hidden');
    document.getElementById('newTaskTitle').value='';
    startDraft({id:uid(),kind:'task',title,task:{priority:'other',project,scenario,deadline,repeating,repeatDays,reviewRequired:false},plan:{stages:[]},source:'manual',createdAt:new Date().toISOString()},false);
    surface().querySelector('[data-add]')?.focus();
  };
  const decomposeTask=row=>{
    if(row.taskPlan){open(row);return;}
    if(!requireAccount())return;const meta=taskMeta(row.querySelector('.todo-check'));
    startDraft({id:uid(),kind:'task',title:meta.title,task:{attachId:meta.id,checklistId:meta.checklistId,priority:meta.priority,project:meta.project,scenario:meta.scenario,deadline:meta.deadline},plan:{stages:[]},createdAt:new Date().toISOString()},true);
  };
  const completeCurrent=row=>{open(row);const step=current(draft?.plan);if(step)completeStep(step.id);showScreen('todo');};
  const advanceFromChecklist=(row,id)=>{
    if(!row?.taskPlan)return;
    const step=current(row.taskPlan);if(!step||step.id!==id)return;
    step.done=true;persistAppState();updateCounts();decorate();
    praiseStep(row.querySelector('.todo-check')?.dataset.title||'',row.taskPlan,false);
    if(isComplete(row.taskPlan)&&row.querySelector('.todo-check'))completeTask(row.querySelector('.todo-check'));
    B.records?.renderRoutines();
  };
  let queued=false;
  new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;decorate();});}).observe(document.querySelector('.phone'),{childList:true,subtree:true});
  B.event.addEventListener('auth',()=>{if(owner!==account()){owner=account();session++;busy=false;draft=null;parentId=null;routine=null;closePreview();panel.innerHTML='';if(!panel.classList.contains('hidden'))showScreen('overview');}decorate();});
  new MutationObserver(()=>{if(document.getElementById('todoSheet').classList.contains('hidden')&&previewRoot)closePreview();}).observe(document.getElementById('todoSheet'),{attributes:true,attributeFilter:['class']});
  B.decomposition={open,openRoutine,resume,previewTask,newChecklist,decomposeTask,completeCurrent,advanceFromChecklist,isComplete,steps,errorFor,latestStart,routineToPlan,refresh:decorate};
  decorate();
})();
