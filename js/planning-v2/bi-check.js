/* Compare actual B1 per-gap churn with annual INN renewal outcomes. */
(function(root){
 'use strict';
 const P=root.Planning2||(typeof require==='function'?require('./core.js'):null),cache=new WeakMap();
 function dateLabel(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 function index(M,model,year,asOfText){
  if(!M||!model)return null;
  let stored=cache.get(model);if(!stored){stored=new Map();cache.set(model,stored);}const key=year+'|'+asOfText;if(stored.has(key))return stored.get(key);
  const asOf=new Date(asOfText+'T23:59:59'),calendarCut=new Date(asOf.getFullYear(),asOf.getMonth(),asOf.getDate()+1),from=new Date(year,0,1),to=new Date(year,11,31,23,59,59),clients=new Map();let events=0;
  model.clients.forEach(c=>{
   if(c.phys)return;
   const id=P.inn(c.key),coverage=M.clientCoverage(c),gaps=M.coverageGaps(coverage,asOf),hits=gaps.filter(g=>g.status==='churned'&&g.E.getFullYear()===year);
   let entry=clients.get(id);if(!entry){entry={inn:id,org:c.org||'',sources:[],events:[],gaps:[],calendarEvents:[]};clients.set(id,entry);}entry.sources.push(c);
   for(const g of gaps){if(g.E.getFullYear()!==year)continue;const deadline=new Date(g.E.getFullYear(),g.E.getMonth(),g.E.getDate()+31),status=g.S&&g.S<deadline?'safe':calendarCut>=deadline?'churned':'pending',item={end:dateLabel(g.E),returned:g.S?dateLabel(g.S):'',endTime:localTime(g.E),returnTime:g.S?localTime(g.S):'',status,originalStatus:g.status};entry.gaps.push(item);if(status==='churned')entry.calendarEvents.push(item);}
   entry.events.push(...hits.map(g=>({end:dateLabel(g.E),returned:g.S?dateLabel(g.S):''})));events+=hits.length;
  });
  const flow=M.computeGapFlow(model,from,to,asOf,false),b1Total=flow.churnByMonth.reduce((s,n)=>s+n,0),unique=[...clients.values()].filter(c=>c.events.length);
  const result={clients,events,b1Total,unique:unique.length,repeated:events-unique.length,asOf,sourceMatches:events===b1Total};
  if(stored.size>=3)stored.delete(stored.keys().next().value);stored.set(key,result);return result;
 }
 function localTime(d){return dateLabel(d)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');}
 function compareRetention(M,model,allRows,rows,year,asOfText){
  const source=index(M,model,year,asOfText);if(!source)return {state:'unavailable',rows:[],differences:[],adjustments:[],outside:[]};
  const allIds=new Set(allRows.map(r=>r.inn)),outside=[...source.clients.values()].filter(c=>c.events.length&&!allIds.has(c.inn)),detail=[];
  let common=0,retained=0,churn=0,biChurn=0,calendarChurn=0,missing=0,unfinished=0,selectedEvents=0,selectedUnique=0;
  for(const r of rows){const c=source.clients.get(r.inn),found=!!c&&c.sources.length===1&&r.retentionKnown,raw=c?c.events.length:0,normalized=c?c.calendarEvents.length:0,boundary=c?c.gaps.filter(g=>(g.originalStatus==='churned')!==(g.status==='churned')):[];selectedEvents+=raw;if(raw)selectedUnique++;let category='Совпало',reason='',difference=false,adjustment=false;
   if(!found){missing++;category='Не сопоставлен';reason=c?'Неоднозначная или неполная клиентская модель.':'ИНН отсутствует в модели B1.';difference=true;}
   else if(!r.complete){unfinished++;category='Окно не завершено';reason='Годовой случай исключён из процентов до завершения всех окон наблюдения.';}
   else{common++;if(r.retained)retained++;else churn++;if(raw)biChurn++;if(normalized)calendarChurn++;difference=r.retained===(normalized>0);adjustment=!difference&&(raw>0)!==(normalized>0);
    if(difference){category='Не совпал исход после выравнивания';reason='Сравните состав касс, ИНН и интервалы обслуживания в двух источниках.';}
    else if(adjustment){category='Граница 30-го дня';reason=boundary.some(g=>g.originalStatus==='churned'&&g.status==='safe')?'B1 округлил разрыв до 31 дня; обслуживание возобновилось в течение 30-го календарного дня.':boundary.some(g=>g.originalStatus==='safe'&&g.status==='churned')?'B1 округлил разрыв до 30 дней; обслуживание возобновилось после 30-го календарного дня.':boundary.some(g=>g.originalStatus==='pending'&&g.status==='churned')?'К концу даты среза календарное окно завершилось; исходный B1 ещё считает его незавершённым.':'Разница исходного и календарного оттока требует проверки дат.';}
   }
   detail.push({inn:r.inn,org:r.org||c?.org||'',anchor:P.iso(r.anchor),complete:r.complete,inCommon:found&&r.complete,retained:r.retained,renewed:r.renewed,biEvents:raw,calendarEvents:normalized,biDates:c?c.events.map(e=>e.end).join('; '):'',calendarDates:c?c.calendarEvents.map(e=>e.end).join('; '):'',boundaryDates:boundary.map(e=>e.endTime+' → '+e.returnTime).join('; '),category,reason,difference,adjustment});
  }
  const differences=detail.filter(r=>r.difference),adjustments=detail.filter(r=>r.adjustment),duplicateRows=rows.length-new Set(rows.map(r=>r.inn)).size,invalidRows=rows.filter(r=>typeof r.retained!=='boolean'||!Array.isArray(r.retentionEvents)||r.retained!==(r.retentionKnown&&r.retentionEvents.length===0)).length;
  const state=(!source.sourceMatches||duplicateRows||invalidRows)?'error':!rows.length?'empty':missing?'incomplete':!common?'pending':differences.length?'different':'matched';
  return {state,source,rows:detail,differences,adjustments,outside,duplicateRows,invalidRows,common,retained,churn,biChurn,calendarChurn,missing,unfinished,selectedEvents,selectedUnique,repeated:selectedEvents-selectedUnique,rate:common?retained/common:null,churnRate:common?calendarChurn/common:null,rawChurnRate:common?biChurn/common:null,sum:common?(retained+calendarChurn)/common:null,rawSum:common?(retained+biChurn)/common:null,delta:common?calendarChurn-churn:null};
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
 const api={index,compare,compareRetention};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Planning2BICheck=api;
})(typeof window!=='undefined'?window:globalThis);
