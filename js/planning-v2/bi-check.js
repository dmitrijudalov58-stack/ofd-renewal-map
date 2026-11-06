/* Compare actual B1 per-gap churn with annual INN renewal outcomes. */
(function(root){
 'use strict';
 const P=root.Planning2||(typeof require==='function'?require('./core.js'):null),cache=new WeakMap();
 function dateLabel(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 function index(M,model,year,asOfText){
  if(!M||!model)return null;
  let stored=cache.get(model);if(!stored){stored=new Map();cache.set(model,stored);}const key=year+'|'+asOfText;if(stored.has(key))return stored.get(key);
  const asOf=new Date(asOfText+'T23:59:59'),from=new Date(year,0,1),to=new Date(year,11,31,23,59,59),clients=new Map();let events=0;
  model.clients.forEach(c=>{
   if(c.phys)return;
   const id=P.inn(c.key),coverage=M.clientCoverage(c),gaps=M.coverageGaps(coverage,asOf),hits=gaps.filter(g=>g.status==='churned'&&g.E.getFullYear()===year);
   let entry=clients.get(id);if(!entry){entry={inn:id,org:c.org||'',sources:[],events:[]};clients.set(id,entry);}entry.sources.push(c);
   entry.events.push(...hits.map(g=>({end:dateLabel(g.E),returned:g.S?dateLabel(g.S):''})));events+=hits.length;
  });
  const flow=M.computeGapFlow(model,from,to,asOf,false),b1Total=flow.churnByMonth.reduce((s,n)=>s+n,0),unique=[...clients.values()].filter(c=>c.events.length);
  const result={clients,events,b1Total,unique:unique.length,repeated:events-unique.length,asOf,sourceMatches:events===b1Total};
  if(stored.size>=3)stored.delete(stored.keys().next().value);stored.set(key,result);return result;
 }
 function compare(M,model,allRows,rows,year,asOfText){
  const source=index(M,model,year,asOfText);if(!source)return {state:'unavailable',rows:[],differences:[],outside:[]};
  const allIds=new Set(allRows.map(r=>r.inn)),outside=[...source.clients.values()].filter(c=>c.events.length&&!allIds.has(c.inn));
  let common=0,renewed=0,lost=0,biChurn=0,selectedEvents=0,selectedUnique=0,missing=0,unfinished=0;const detail=[];
  for(const r of rows){
   const c=source.clients.get(r.inn),found=!!c&&c.sources.length===1,count=c?c.events.length:0;
   selectedEvents+=count;if(count)selectedUnique++;
   let reason='',category='Совпало',difference=false;
   if(!found){missing++;category='Не сопоставлен';difference=true;reason=c?'Несколько клиентов BI соответствуют одному ИНН.':'ИНН отсутствует в клиентской модели B1.';}
   else if(!r.complete){unfinished++;category='Окно не завершено';reason='Исключён из сравнения процентов: не все окна продления года завершены.';}
   else{
    common++;if(r.renewed)renewed++;else lost++;if(count)biChurn++;
    difference=r.renewed===(count>0);
    if(difference){
     category=r.renewed?'Продлился и попал в отток B1':'Не продлился, но оттока B1 нет';
     if(r.renewed)reason='Ретро нашло продление хотя бы одной кассы; B1 зафиксировал полный разрыв покрытия в этом году.';
     else{
      const deadline=new Date(P.iso(Math.floor(r.anchor)+31)+'T00:00:00'),coverage=M.clientCoverage(c.sources[0]);
      reason=coverage.some(iv=>iv.start<=source.asOf&&iv.start<=deadline&&iv.end>=deadline)?'По BI покрытие клиента сохраняется после окна ретро: B1 учитывает все его кассы вместе.':'B1 не нашёл полный разрыв в выбранном году. Проверьте даты и состав покрытия в двух моделях.';
     }
    }
   }
   detail.push({inn:r.inn,org:r.org||c?.org||'',anchor:P.iso(r.anchor),complete:r.complete,inCommon:found&&r.complete,renewed:r.renewed,biEvents:count,biDates:c?c.events.map(e=>e.end).join('; '):'',category,reason,difference});
  }
  const differences=detail.filter(r=>r.difference),rate=common?renewed/common:null,churnRate=common?biChurn/common:null,sum=common?(renewed+biChurn)/common:null;
  const duplicateRows=rows.length-new Set(rows.map(r=>r.inn)).size;
  const state=(!source.sourceMatches||duplicateRows)?'error':!rows.length?'empty':missing?'incomplete':!common?'pending':differences.length?'different':'matched';
  return {state,source,duplicateRows,common,renewed,lost,biChurn,rate,churnRate,sum,delta:common?biChurn-lost:null,deltaPP:common?(biChurn-lost)/common:null,selectedEvents,selectedUnique,repeated:selectedEvents-selectedUnique,missing,unfinished,rows:detail,differences,outside};
 }
 const api={index,compare};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Planning2BICheck=api;
})(typeof window!=='undefined'?window:globalThis);
