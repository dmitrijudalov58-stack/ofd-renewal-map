const assert=require('node:assert/strict'),P=require('../js/planning-v2/core.js'),R=require('../js/planning-v2/retro-experiment.js'),X=require('../js/vendor/xlsx.full.min.js'),E=require('../js/export.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const id=n=>'770'+String(n).padStart(7,'0'),records=[],params={...P.defaults(),asOf:'2026-11-02'};
for(let n=1;n<=100;n++){
 const common={inn:id(n),unit:String(n).padStart(16,'0'),months:15,org:'Client '+n,partner:'Partner',partnerInn:'7700000000',center:''};
 records.push({...common,pin:'old'+n,start:P.day(2019),end:P.day(2025,2,1)});
 if(n<=40)records.push({...common,pin:'new'+n,start:P.day(2025,2,2),end:P.day(2027,4,1)});
}
const ofd=P.ledger(records),snapshot=JSON.stringify(ofd.records),sourceParams=JSON.stringify(params);
function file(ids,issues=[]){return {files:['activity.xlsx'],clients:new Map(ids.map(inn=>[inn,{inn,org:'Client'}])),issues};}
// Agreed example:100 clients/40 renewals, exclude20 including5 renewals =>35/80.
const zero=file([...Array.from({length:5},(_,i)=>id(i+1)),...Array.from({length:15},(_,i)=>id(i+41)),id(56)]),partial=file([id(56),id(57)]);
assert.equal(R.build(null,params,zero,partial).status,'unavailable');assert.equal(R.build(ofd,params,zero,null).status,'pending');
const m=R.build(ofd,params,zero,partial);assert.equal(m.status,'ready');assert.equal(m.before.base,100);assert.equal(m.before.renewed,40);assert.equal(m.before.rate,.4);assert.equal(m.removed.length,20);assert.equal(m.after.base,80);assert.equal(m.after.renewed,35);assert.equal(m.after.rate,.4375);assert.equal(m.delta,.03749999999999998);assert.equal(m.before.pending,0);assert.equal(m.audit.ok,true);
assert.equal(m.rows.find(r=>r.inn===id(56)).excluded,false,'Overlap retains actual history');assert.equal(m.groups.find(g=>g.key==='partial').rate,0,'Partial group uses observed0%, never forced50%');assert.equal(m.cohorts.reduce((s,r)=>s+r.removed,0),20);assert.equal(m.outside.length,0);assert.equal(JSON.stringify(ofd.records),snapshot);assert.equal(JSON.stringify(params),sourceParams);
assert.equal(m.forecast.originalBase,40);assert.equal(m.forecast.removed.length,5);assert.equal(m.forecast.base,35);assert.equal(m.forecast.before.base,m.forecast.after.base);assert.ok(Math.abs(m.forecast.before.expected-14)<1e-10);assert.equal(m.forecast.after.expected,15.3125);assert.equal(m.forecast.after.rate,.4375);
//500 remaining clients in cohortA and300 inB: use their own rates, not a mean of cohort rates.
const planned=Array.from({length:1000},(_,i)=>({inn:id(i+1),cohort:i<700?'A':'B'})),rates=[{cohort:'A',before:{rate:.4},after:{rate:.5}},{cohort:'B',before:{rate:.8},after:{rate:.75}}],planZero=file(Array.from({length:201},(_,i)=>id(i+1))),planPartial=file([id(201)]),q=R.project(planned,rates,planZero,planPartial);
assert.equal(q.originalBase,1000);assert.equal(q.removed.length,200);assert.equal(q.base,800);near(q.before.expected,440);assert.equal(q.after.expected,475);near(q.before.rate,.55);assert.equal(q.after.rate,.59375);near(q.delta,35);assert.ok(Math.abs(q.rateDelta-.04375)<1e-10);assert.equal(q.kept.find(r=>r.inn===id(201)).group,'partial');assert.equal(q.kept.filter(r=>r.inn===id(201)).length,1);
const missing=R.project(planned,[rates[0],{...rates[1],after:{rate:null}}],planZero,planPartial);near(missing.before.expected,440);assert.equal(missing.after.missing,300);assert.equal(missing.after.expectedKnown,250);assert.equal(missing.after.expected,null);assert.equal(missing.after.rate,null);assert.equal(missing.delta,null);
const free=R.project(planned,rates.map(r=>({...r,after:{rate:0}})),planZero,planPartial);assert.equal(free.after.expected,0);assert.equal(free.after.rate,0);assert.equal(free.after.missing,0);
const noPlan=R.build(ofd,{...params,year:2030},zero,partial);assert.equal(noPlan.forecast.base,0);assert.equal(noPlan.forecast.after.expected,0);assert.equal(noPlan.forecast.after.rate,null);assert.equal(R.project(planned,rates,planZero,planPartial,false).after.expected,null);
const overridden=R.build(ofd,{...params,manual:{ofd:Object.fromEntries(P.COHORTS.map(k=>[k,{value:.99,reason:'Main plan'}]))}},zero,partial);assert.equal(overridden.after.rate,m.after.rate,'Manual forecast overrides never replace observed retro');
const negative=R.build(ofd,params,file(Array.from({length:20},(_,i)=>id(i+1))),file([]));assert.equal(negative.after.rate,.25);assert.ok(negative.delta<0,'Exclusion can reduce conversion too');
const empty=R.build(ofd,params,file(Array.from({length:100},(_,i)=>id(i+1))),file([]));assert.equal(empty.after.base,0);assert.equal(empty.after.rate,null);assert.equal(empty.delta,null);
const pending=R.build(ofd,{...params,asOf:'2025-02-10'},zero,partial);assert.equal(pending.periodComplete,false);assert.ok(pending.after.pending>0);assert.equal(pending.before.rate,null);assert.equal(pending.after.rate,null);assert.equal(pending.delta,null);
const absent=R.build(ofd,{...params,retroFrom:'2024-01-01',retroTo:'2024-12-31'},zero,partial);assert.equal(absent.status,'empty');assert.equal(absent.before.rate,null);assert.equal(absent.outside.length,23);
const bad=R.build(ofd,params,file([], [{inn:'',reason:'Invalid'}]),partial);assert.equal(bad.status,'partial');assert.equal(bad.delta,null);assert.equal(bad.fileIssues.length,1);
assert.throws(()=>R.build(ofd,{...params,asOf:''},zero,partial),/Заполните/);assert.throws(()=>R.build(ofd,{...params,retroFrom:'2026-01-01'},zero,partial),/Начало ретро/);
assert.equal(R.reconcile({...m,after:{...m.after,renewed:36}}).ok,false);
assert.equal(R.reconcile({...m,forecast:{...m.forecast,before:{...m.forecast.before,expected:99}}}).ok,false);assert.throws(()=>R.build(ofd,{...params,year:0},zero,partial),/Год плана/);
const wb=X.read(E.buildXlsx(R.workbook(m)),{type:'array'});assert.equal(wb.Sheets['Когорты'].B2.v,100);assert.equal(wb.Sheets['Когорты'].H2.v,80);assert.equal(wb.Sheets['Когорты'].I2.v,35);assert.equal(wb.Sheets['Когорты'].L2.v,.4375);assert.ok(Math.abs(wb.Sheets['Когорты'].M2.v-3.75)<1e-9);assert.equal(wb.Sheets['Клиенты'].A2.t,'s');assert.equal(wb.Sheets['Клиенты'].F2.v,'Исключён');assert.ok(wb.Sheets['Описание'].B2.v.includes('не доказывает'));
assert.equal(wb.Sheets['Общие итоги'].B7.v,35);assert.ok(Math.abs(wb.Sheets['Общие итоги'].B8.v-14)<1e-10);assert.equal(wb.Sheets['Общие итоги'].C8.v,15.3125);assert.equal(wb.Sheets['Прогноз по ИНН'].A2.t,'s');assert.equal(wb.Sheets['Прогноз по ИНН'].F2.v,'Исключён из обоих прогнозов');assert.equal(wb.Sheets['Прогноз по ИНН'].I2,undefined);
console.log('PASS retro experiment: historical35/80, same clean future base, weighted440→475 forecast, overlap, zero/missing/empty/pending, isolation, audit and Excel');
