import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

function model() {
  const context = vm.createContext({ Date, Number, String, Array, Object, document: { querySelectorAll: () => [] } });
  vm.runInContext('window=globalThis', context);
  vm.runInContext(readFileSync(new URL('../../web/js/date-picker.js',import.meta.url),'utf8'),context);
  return (context.Task as {dates: {week:(d:string)=>string[];shift:(d:string,n:number)=>string;valid:(d:string)=>boolean;get:(m:string)=>string;set:(m:string,d:string)=>void;subscribe:(m:string,fn:(d:string)=>void)=>void}}).dates;
}
it('shared date picker handles Monday/Sunday, month and year boundaries',()=>{
  const d=model();
  assert.deepEqual(Array.from(d.week('2026-11-08')),['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08']);
  assert.equal(d.week('2027-01-01')[0],'2026-12-28');
  assert.equal(d.shift('2026-12-31',1),'2027-01-01');
  assert.equal(d.shift('2024-02-28',1),'2024-02-29');
  assert.equal(d.valid('2026-02-30'),false);
});
it('all five modules own independent dates and notify only their subscribers',()=>{
  const d=model(),events:string[]=[];
  for(const m of ['task','wellness','idea','routine','today'])d.set(m,'2026-11-06');
  d.subscribe('idea',value=>events.push(value));
  d.set('idea','2026-10-12');
  for(const m of ['task','wellness','routine','today'])assert.equal(d.get(m),'2026-11-06');
  assert.equal(d.get('idea'),'2026-10-12');assert.deepEqual(events,['2026-10-12']);
  d.set('idea','2026-02-30');assert.equal(d.get('idea'),'2026-10-12');
});
