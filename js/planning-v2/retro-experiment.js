/* Diagnostic only: reselect historical INNs by current activity lists. */
(function(root){
 'use strict';
 const P=root.Planning2||(typeof require==='function'?require('./core.js'):null),cache=new WeakMap();
 const GROUPS={zero:'Не отправляют',partial:'Частично отправляют',other:'Остальные'};
 const NOTE='Условный пересчёт прошлого по сегодняшним спискам активности. Он показывает эффект отбора клиентов и не доказывает будущую вероятность продления. Ручные вероятности основного плана здесь не применяются.';
 function summary(rows,periodComplete){
  const s={base:rows.length,renewed:0,notRenewed:0,pending:0,rate:null};
  for(const r of rows)if(!r.complete)s.pending++;else if(r.renewed)s.renewed++;else s.notRenewed++;
  if(periodComplete&&s.base&&!s.pending)s.rate=s.renewed/s.base;
  return s;
 }
 function build(ofd,params,zero,partial){
  if(!ofd)return {status:'unavailable'};if(!zero||!partial)return {status:'pending'};
  if(['retroFrom','retroTo','asOf'].some(k=>P.date(params[k])==null))throw new Error('Заполните период ретро и дату среза.');
  const p=P.normalizeParams(params),from=P.date(p.retroFrom),to=P.date(p.retroTo),cut=P.date(p.asOf),key=[from,to,cut].join('|');
  if(from>to)throw new Error('Начало ретро должно быть не позже окончания.');
  let old=cache.get(ofd);if(!old||old.key!==key){old={key,retro:P.retro(ofd,'ofd',from,to,cut)};cache.set(ofd,old);}
  const rt=old.retro,rows=rt.rows.map(r=>{const group=partial.clients.has(r.inn)?'partial':zero.clients.has(r.inn)?'zero':'other';return {...r,group,excluded:group==='zero'};}),removed=rows.filter(r=>r.excluded),kept=rows.filter(r=>!r.excluded),before=summary(rows,rt.periodComplete),after=summary(kept,rt.periodComplete),clean=!zero.issues.length&&!partial.issues.length;
  const cohorts=[...rt.stats.keys()].map(cohort=>{const all=rows.filter(r=>r.cohort===cohort),left=all.filter(r=>!r.excluded),a=summary(all,rt.periodComplete),b=summary(left,rt.periodComplete);return {cohort,before:a,after:b,removed:all.length-left.length,delta:clean&&a.rate!=null&&b.rate!=null?b.rate-a.rate:null};});
  const groups=Object.entries(GROUPS).map(([key,label])=>({key,label,...summary(rows.filter(r=>r.group===key),rt.periodComplete)})),ids=new Set(rows.map(r=>r.inn)),outside=[];
  for(const [group,data]of [['zero',zero],['partial',partial]])for(const r of data.clients.values())if(!ids.has(r.inn))outside.push({...r,group});
  const m={status:!rows.length?'empty':clean&&before.rate!=null&&after.rate!=null?'ready':'partial',params:p,periodComplete:rt.periodComplete,rows,removed,kept,before,after,cohorts,groups,outside,delta:clean&&before.rate!=null&&after.rate!=null?after.rate-before.rate:null,files:{zero:zero.files,partial:partial.files},fileIssues:[...zero.issues.map(r=>({...r,group:'zero'})),...partial.issues.map(r=>({...r,group:'partial'}))]};
  m.audit=reconcile(m);if(!m.audit.ok)m.status='error';return m;
 }
 function reconcile(m){
  const errors=[],a=summary(m.rows,m.periodComplete),b=summary(m.kept,m.periodComplete);
  if(new Set(m.rows.map(r=>r.inn)).size!==m.rows.length)errors.push('Повторяющиеся ИНН');
  if(m.removed.length+m.kept.length!==m.rows.length||m.removed.some(r=>!r.excluded||r.group!=='zero')||m.kept.some(r=>r.excluded||r.group==='zero'))errors.push('Не сошлось исключение ИНН');
  for(const key of ['base','renewed','notRenewed','pending','rate'])if(a[key]!==m.before[key]||b[key]!==m.after[key])errors.push('Не сошёлся итог '+key);
  for(const side of ['before','after'])for(const key of ['base','renewed','notRenewed','pending'])if(m.cohorts.reduce((n,r)=>n+r[side][key],0)!==m[side][key])errors.push('Не сошлись когорты '+key);
  return {ok:!errors.length,errors};
 }
 function workbook(m){
  const rate=v=>({v,s:5}),row=(name,a,b,removed,delta)=>[name,a.base,a.renewed,a.notRenewed,a.pending,rate(a.rate),removed,b.base,b.renewed,b.notRenewed,b.pending,rate(b.rate),delta==null?null:delta*100];
  return {sheets:[
   {sheetName:'Описание',headers:['Параметр','Значение'],rows:[['Эксперимент №2',NOTE],['Период ретро',m.params.retroFrom+' — '+m.params.retroTo],['Срез на начало дня',m.params.asOf],['Исключение','ИНН только из списка «Не отправляют» удаляются из базы и продлившихся. ИНН из обоих файлов остаются с фактической историей.'],['Файл не отправляют',m.files.zero.join('; ')],['Файл частично',m.files.partial.join('; ')],['Незавершённые','Вероятность не рассчитывается до завершения периода ретро и всех 30-дневных окон.'],['Другие борды','Основной план, эксперимент №1 и Обмен с 1С не изменяются.']],colWidths:[30,115]},
   {sheetName:'Когорты',forceFormulaBook:true,headers:['Когорта','База до','Продлились до','Не продлились до','Не завершены до','Доля до','Исключено ИНН','База после','Продлились после','Не продлились после','Не завершены после','Доля после','Разница, п.п.'],rows:[row('Вся база',m.before,m.after,m.removed.length,m.delta),...m.cohorts.map(r=>row(r.cohort,r.before,r.after,r.removed,r.delta))],colWidths:[35,18,20,22,22,18,22,18,22,24,22,18,22]},
   {sheetName:'Группы активности',forceFormulaBook:true,headers:['Группа сейчас','ИНН в ретро','Продлились','Не продлились','Не завершены','Факт ретро, доля','Действие'],rows:m.groups.map(g=>[g.label,g.base,g.renewed,g.notRenewed,g.pending,rate(g.rate),g.key==='zero'?'Исключены из эксперимента':'Оставлены с фактической историей']),colWidths:[32,22,20,22,22,25,48]},
   {sheetName:'Клиенты',headers:['ИНН','Клиент','Когорта','Первое окончание в ретро','Группа сейчас','Действие','Фактический исход'],rows:m.rows.map(r=>[r.inn,r.org,r.cohort,P.displayDate(r.anchor),GROUPS[r.group],r.excluded?'Исключён':'Оставлен',!r.complete?'Не завершён':r.renewed?'Продлился':'Не продлился']),textCols:[0],colWidths:[18,42,35,30,32,22,25]},
   {sheetName:'Вне ретро',headers:['ИНН','Клиент','Список'],rows:m.outside.map(r=>[r.inn,r.org,GROUPS[r.group]]),textCols:[0],colWidths:[18,42,32]},
   {sheetName:'Ошибки файлов',headers:['ИНН','Клиент','Список','Файл','Лист','Строка','Причина'],rows:m.fileIssues.map(r=>[r.inn,r.org,GROUPS[r.group],r.file,r.sheet,r.row,r.reason]),textCols:[0],colWidths:[18,42,30,42,24,14,70]}
  ]};
 }
 const api={GROUPS,NOTE,summary,build,reconcile,workbook};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Planning2RetroExperiment=api;
})(typeof window!=='undefined'?window:globalThis);
