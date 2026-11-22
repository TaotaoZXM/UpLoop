/* Compact task properties reuse the existing form controls and saved values. */
(function () {
  const icons = {
    scenario: '<path d="M3 10 12 3l9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    project: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 10h18M8 5V3"/>'
  };
  const icon = kind => '<svg viewBox="0 0 24 24" aria-hidden="true">' + icons[kind] + '</svg>';
  function mount(sheet) {
    const form = sheet.querySelector('form');
    const toolbar = document.createElement('div');toolbar.className = 'task-property-toolbar';
    form.querySelector('label').after(toolbar);
    [
      ...(sheet.id==='eventSheet'?[{ kind:'scenario', label:'场景', field:form.querySelector('.scenario-choice')?.parentElement }]:[]),
      { kind:'project', label:'项目', field:form.querySelector('.project-picker') }
    ].forEach(({kind,label,field}) => {
      if(!field)return;
      const button=document.createElement('button');button.type='button';button.className='task-property-trigger';
      const value=document.createElement('span');button.innerHTML=icon(kind);button.appendChild(value);
      field.id = sheet.id + '-' + kind + '-popover';
      field.setAttribute('popover','auto');field.classList.add('task-property-popover');
      field.setAttribute('role','dialog');field.setAttribute('aria-label','选择'+label);
      button.setAttribute('aria-controls',field.id);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
      toolbar.appendChild(button);
      const sync=()=>{
        if(kind==='project'){
          const isWork=form.querySelector('.scenario-choice .active')?.dataset.scenario==='work';
          button.hidden=!isWork;
          if(field.classList.contains('hidden')===isWork)field.classList.toggle('hidden',!isWork);
          if(!isWork&&field.matches(':popover-open'))field.hidePopover();
        }
        const active=field.querySelector(kind==='project'?'.project.active':'.choice.active');
        value.textContent=active?.textContent.trim() || label;
        button.setAttribute('aria-label',label+'：'+(active?.textContent.trim()||'未选择'));
        field.querySelectorAll('.choice,.project:not(.new-project)').forEach(option=>option.setAttribute('aria-pressed',String(option.classList.contains('active'))));
      };
      const position=()=>{
        const anchor=button.getBoundingClientRect();
        const width=Math.min(292,innerWidth-32);
        field.style.width=width+'px';
        field.style.left=Math.max(16,Math.min(anchor.left,innerWidth-width-16))+'px';
        const height=field.getBoundingClientRect().height;
        const above=anchor.top-height-10;
        field.style.top=(above>=16?above:Math.max(16,Math.min(anchor.bottom+10,innerHeight-height-16)))+'px';
      };
      button.onclick=()=>{
        if(field.matches(':popover-open')){field.hidePopover();return;}
        sync();field.showPopover();position();
        (field.querySelector('.choice.active,.project.active')||field.querySelector('button,input'))?.focus({preventScroll:true});
      };
      field.addEventListener('toggle',()=>{button.setAttribute('aria-expanded',String(field.matches(':popover-open')));});
      field.addEventListener('click',event=>{
        const option=event.target.closest('.choice,.project:not(.new-project)');
        if(!option)return;
        sync();field.hidePopover();button.focus({preventScroll:true});
      });
      field.addEventListener('keydown',event=>{
        if(event.key==='Escape'){field.hidePopover();button.focus({preventScroll:true});}
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.target.matches('input'))return;
        const options=[...field.querySelectorAll('.choice,.project:not(.hidden)')].filter(option=>!option.disabled);
        if(!options.length)return;
        event.preventDefault();const index=options.indexOf(document.activeElement);
        options[event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();
      });
      let scheduled=false;
      new MutationObserver(()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;sync();if(field.matches(':popover-open'))position();});}).observe(field,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
      sheet.querySelectorAll('[data-close],.sheet-submit').forEach(close=>close.addEventListener('click',()=>{if(field.matches(':popover-open'))field.hidePopover();}));
      addEventListener('resize',()=>{if(field.matches(':popover-open'))position();});
      form.addEventListener('scroll',()=>{if(field.matches(':popover-open'))position();});
      sync();
      form.addEventListener('task-scenario-change',sync);
    });
    form.addEventListener('submit',()=>form.querySelectorAll(':popover-open').forEach(field=>field.hidePopover()));
  }
  ['todoSheet','eventSheet'].forEach(id=>{const sheet=document.getElementById(id);if(sheet)mount(sheet);});
})();
