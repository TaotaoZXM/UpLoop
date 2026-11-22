import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createDecompositionRouter, validatePlan, stepError, DECOMPOSITION_RULES } from '../src/tasks/decompose.js';
import { createFakeDb } from '../src/db/pool.js';
import { env } from '../src/env.js';
import { validateTaskLimits } from '../src/state/routes.js';
import { computeReportStats } from '../src/report/routes.js';
const raw=()=>({stages:[{title:'查清要求',steps:[{title:'查官网材料清单',minutes:10,waitDays:0},{title:'确认递交方式',minutes:5,waitDays:0}]},{title:'备材料',steps:[{title:'拍白底证件照',minutes:30,waitDays:0}]}]});
describe('task decomposition rules and persistence',()=>{
  it('enforces concrete verb-first steps, Unicode length and half-day maximum',()=>{
    assert.equal(stepError('拍白底证件照',30),null);
    assert.equal(stepError('签证材料准备',10),null);assert.equal(stepError('在职证明到手',20),null);
    for(const [title,minutes] of [['准备相关材料',20],['相关事项',10],['查找办理日本签证需要提交的全部材料清单以及各类证明文件的具体要求',10],['拍证件照',241],['查官网',0]] as const)assert.ok(stepError(title,minutes));
    assert.match(DECOMPOSITION_RULES,/15/);assert.match(DECOMPOSITION_RULES,/不重复提问/);
  });
  it('validates phases and persisted step identities',()=>{
    const plan=validatePlan(raw());assert.equal(plan.stages.length,2);assert.equal(plan.stages[0].steps[0].done,false);
    assert.notEqual(plan.stages[0].steps[0].id,plan.stages[0].steps[1].id);
    assert.equal(validateTaskLimits({version:1,todo:[{id:'parent',plan}]}),null);
    const bad=structuredClone(plan);bad.stages[0].steps[0].minutes=500;
    assert.match(validateTaskLimits({version:1,todo:[{id:'parent',plan:bad}]})||'',/拆解/);
    assert.equal(validateTaskLimits({version:1,planDrafts:[{id:'draft',title:'办签证',plan:{stages:[]}}]}),null);
  });
  it('stores standalone checklists and decomposed parents in the shared step format',()=>{
    const plan=validatePlan(raw());
    const checklist={id:'checklist:parent',parentTaskId:'parent',title:'办签证',scenario:'work',plan};
    const state={version:1,todo:[{id:'parent',checklistId:checklist.id,title:'办签证',plan}],checklists:[checklist],checklistProgress:{'checklist:standalone|2026-11-12':[plan.stages[0].steps[0].id]}};
    assert.equal(validateTaskLimits(state),null);
    assert.equal(validateTaskLimits({...state,checklists:[{...checklist,plan:{stages:[{id:'s',title:'阶段',steps:[{id:'a',title:'查官网材料清单',minutes:10,waitDays:0,done:'yes'}]}]}}]}),'任务拆解清单格式不正确');
  });
  it('persists editable manual draft rows without accepting incomplete runnable plans',()=>{
    const draft={id:'draft',title:'整理资料',plan:{stages:[{id:'stage',title:'开始行动',steps:[{id:'step',title:'',minutes:10,waitDays:0,done:false}]}]}};
    assert.equal(validateTaskLimits({version:1,planDrafts:[draft]}),null);
    const runnable={id:'task',title:draft.title,plan:draft.plan};
    assert.match(validateTaskLimits({version:1,todo:[runnable]})||'',/拆解/);
    const invalidDraft=structuredClone(draft);invalidDraft.plan.stages[0].steps[0].title='整'.repeat(31);
    assert.match(validateTaskLimits({version:1,planDrafts:[invalidDraft]})||'',/拆解草稿/);
  });
  it('counts one completed parent in the report, never its checklist steps',async()=>{
    const plan=validatePlan(raw());plan.stages.forEach(stage=>stage.steps.forEach(step=>step.done=true));
    const db=createFakeDb(sql=>({rows:/FROM user_app_state/.test(sql)?[{state:{version:1,done:[{id:'parent',title:'办日本签证',completed:Date.parse('2026-11-11T12:00:00+08:00'),plan}]}}]:[],rowCount:1}));
    const stats=await computeReportStats(db,'owner','2026-11-11');assert.equal(stats.doneCount,1);assert.deepEqual(stats.doneTitles,['办日本签证']);
  });
});
describe('decomposition API',()=>{
  let server:ReturnType<express.Express['listen']>,base:string,consent=true,calls=0,contents:string[]=[],seen:any[]=[];
  const originalFetch=globalThis.fetch, originalKey=env.deepseekKey;
  before(async()=>{
    const db=createFakeDb(sql=>({rows:/FROM user_profile/.test(sql)?[{cloud_consent:consent}]:/FROM usage_calls/.test(sql)?[{li:0,tokens:0,calls:0}]:[],rowCount:1}));
    const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:'owner'};next();});app.use(createDecompositionRouter({db}));
    app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status||500).json({error:err.code,message:err.message}));
    server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    globalThis.fetch=async(input,init)=>{
      if(String(input).startsWith(base))return originalFetch(input,init);
      calls++;seen.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:contents.shift()||JSON.stringify(raw())}}],usage:{prompt_tokens:10,completion_tokens:20}}),{status:200});
    };
  });
  after(()=>{globalThis.fetch=originalFetch;Object.assign(env,{deepseekKey:originalKey});server.close();});
  const post=(body:any)=>fetch(base+'/tasks/decompose',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  it('reports a missing key instead of returning a canned AI plan',async()=>{
    Object.assign(env,{deepseekKey:''});const response=await post({title:'办签证'});assert.equal(response.status,503);assert.equal((await response.json()).error,'ai_unconfigured');
  });
  it('requires cloud consent before sending task data',async()=>{
    Object.assign(env,{deepseekKey:'test-key'});consent=false;const count=calls;
    assert.equal((await post({title:'办签证'})).status,403);assert.equal(calls,count);consent=true;
  });
  it('repairs invalid steps and retains original context and feedback',async()=>{
    Object.assign(env,{deepseekKey:'test-key'});contents=[JSON.stringify({stages:[{title:'准备',steps:[{title:'准备相关材料',minutes:300}]}]}),JSON.stringify(raw())];
    const response=await post({title:'办签证',deadline:'2026-12-01',mode:'regenerate',feedback:'我时间很紧',previous:raw()});
    assert.equal(response.status,200);assert.equal((await response.json()).plan.stages.length,2);
    const context=JSON.parse(seen.at(-1).messages[1].content);assert.equal(context.title,'办签证');assert.equal(context.feedback,'我时间很紧');assert.ok(context.previous);
    assert.equal(seen.at(-1).max_tokens,5000);assert.match(seen.at(-1).messages[0].content,/不超过15/);
  });
  it('rejects an invalid repaired response',async()=>{
    contents=['{}','{}'];const response=await post({title:'办签证',mode:'refine',step:{title:'拍证件照',minutes:30},previous:raw()});assert.equal(response.status,502);
  });
});
