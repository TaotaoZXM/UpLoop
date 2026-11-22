/* Card taps edit, the edit sheet can open decomposition, and horizontal swipes delete. */
(function(){
  const B=window.Task,sheet=document.getElementById('todoSheet'),form=sheet.querySelector('form');
  let editId=null;
  const find=id=>[...document.querySelectorAll('#todoGroups .task-row')].find(row=>row.querySelector('.todo-check')?.dataset.taskId===id);
  const edit=row=>{
    const meta=row.querySelector('.todo-check')?taskMeta(row.querySelector('.todo-check')):{id:row.dataset.taskId,title:taskTitle(row),project:row.dataset.project||'未分类',priority:row.dataset.priority||'other',scenario:row.dataset.scenario||'life',deadline:row.dataset.deadline||'',createdAt:row.dataset.createdAt||'',difficulty:row.dataset.difficulty||'easy'};
    openTaskForm(meta.title);editId=meta.id;
    sheet.querySelector('h2').textContent='编辑任务';sheet.querySelector('.sheet-submit').textContent='保存修改';
    document.getElementById('addAndDecompose').hidden=true;
    document.getElementById('editTaskDecompose').classList.remove('hidden');
    setScenarioChoice('newTaskScenario',meta.scenario);
    setProjectActive(sheet.querySelector('.project-list'),meta.project);
    showTaskDeadline(meta.deadline?.slice(0,10)||'',meta.deadline?.slice(11,16)||'');
    const rule=repeatTasks.find(rule=>rule.id===meta.repeatId),toggle=document.getElementById('newTaskRepeatToggle');
    window.setTaskRepeatChoice?.('newTaskRepeatToggle',Boolean(rule));document.getElementById('newTaskRepeatDays').value=rule?.repeatDays||7;
    document.getElementById('newTaskTitle').focus();
  };
  const saveEdit=async(decomposeAfter=false)=>{
    if(!editId)return null;
    const row=find(editId);if(!row)return;
    const meta=taskMeta(row.querySelector('.todo-check')),title=document.getElementById('newTaskTitle').value.trim();
    if(!title){document.getElementById('newTaskTitle').focus();return null;}
    const repeating=document.getElementById('newTaskRepeatToggle').checked,days=Number(document.getElementById('newTaskRepeatDays').value);
    if(repeating&&(!Number.isInteger(days)||days<1||days>365)){document.getElementById('newTaskRepeatDays').reportValidity();return null;}
    const date=taskDeadlineValue,time=document.getElementById('taskDeadlineTime').value;
    const scenario=document.getElementById('newTaskScenario').value||'life';
    const item={id:meta.id,title,scenario,priority:meta.priority||'other',project:scenario==='work'?(sheet.querySelector('.project.active')?.textContent.trim()||'未分类'):'未分类',important:row.dataset.important==='true',reviewRequired:row.dataset.reviewRequired==='true',deadline:date?date+'T'+(time||'23:59'):'',plan:row.taskPlan||null,createdAt:meta.createdAt,difficulty:meta.difficulty};
    const rule=repeatTasks.find(rule=>rule.id===meta.repeatId);
    if(rule&&repeating){Object.assign(rule,{title:item.title,scenario:item.scenario,priority:item.priority,project:item.project,repeatDays:days});}
    else if(repeating){repeatTasks.push({...item,id:meta.id,startDay:dateKey(new Date()),repeatDays:days});row.remove();}
    else{
      if(rule){repeatTasks=repeatTasks.filter(value=>value.id!==rule.id);item.id='task_'+crypto.randomUUID();}
      row.replaceWith(createTodoRow(item));
    }
    renderedRepeatDay='';renderRecurringTasks();updateCounts();persistAppState();B.decomposition?.refresh();sheet.classList.add('hidden');
    const updated=rule&&repeating?[...document.querySelectorAll('#todoGroups .repeat-instance')].find(item=>item.dataset.repeatId===rule.id&&item.dataset.occurrenceDay===row.dataset.occurrenceDay)||row:row;
    if(decomposeAfter){await saveCloudAppState(true).catch(()=>{});B.decomposition.decomposeTask(updated);}
    return updated;
  };
  form.addEventListener('submit',event=>{if(!editId)return;event.preventDefault();event.stopImmediatePropagation();saveEdit(false);},true);
  document.getElementById('editTaskDecompose').onclick=()=>saveEdit(true);
  new MutationObserver(()=>{if(!sheet.classList.contains('hidden'))return;editId=null;sheet.querySelector('h2').textContent='添加任务';sheet.querySelector('.sheet-submit').textContent='添加';document.getElementById('addAndDecompose').hidden=false;document.getElementById('editTaskDecompose').classList.add('hidden');}).observe(sheet,{attributes:true,attributeFilter:['class']});
  const target=event=>event.target.closest('#todoGroups .task-row');
  document.addEventListener('click',event=>{
    const row=target(event);if(!row)return;
    if(event.target.closest('.todo-check,.swipe-delete,.plan-card-open,.task-important-toggle'))return;
    if(row.classList.contains('swiped'))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(row.taskPlan){B.decomposition.open(row);return;}
    edit(row);
  },true);
  B.taskCards={edit};
})();
