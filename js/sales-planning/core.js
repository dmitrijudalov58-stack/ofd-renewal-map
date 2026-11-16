/* Sales planning: isolated INN model, lifetime x tariff, actual retro. */
(function(root){
 'use strict';
 const P=root.Planning2||(typeof require==='function'?require('../planning-v2/core.js'):null),M=root.OFDMetrics||(typeof require==='function'?require('../metrics.js'):null),cache=new WeakMap();
 const FAMILIES=[{key:'own',label:'Собственные продажи'},{key:'partner',label:'Партнёрские продажи'}],AGES=['До 1 года','1–3 года','3–5 лет','5+ лет'],BANDS=[{key:'short',label:'Тариф до 12 мес. включительно'},{key:'long',label:'Тариф более 12 мес.'}];
 const COHORTS=FAMILIES.flatMap(f=>AGES.flatMap((age,i)=>BANDS.map(b=>({key:f.key+'|'+i+'|'+b.key,family:f.key,familyLabel:f.label,age:i,band:b.key,label:age+' · '+b.label}))));
 const familyLabel=k=>FAMILIES.find(f=>f.key===k)?.label||'Канал не определён';
 function normalize(raw){
  const r=raw||{},d=P.defaults(),nested=r.checks?.ofd||r.checks||{};
  return {year:r.year==null?d.year:+r.year,retroFrom:r.retroFrom??d.retroFrom,retroTo:r.retroTo??d.retroTo,asOf:r.asOf??'',vat:r.vat??'',upsell:r.upsell===undefined?d.upsell:P.num(r.upsell),checks:{...nested},manual:{...(r.manual||{})},clients:{...(r.clients||{})}};
 }
 function family(channel){const side=M.CHANNEL_SIDE[channel];return side==='Собственный'?'own':side==='Партнёрский'?'partner':null;}
 function classify(client,events,anchor,cut){
  const feat=P.features(client,anchor,cut),age=P.AGES.indexOf(feat.age),first=events.filter(e=>Math.floor(e.end)===Math.floor(anchor)),channels=[...new Set(first.map(e=>P.classify(e.partner,e.center)))],families=[...new Set(channels.map(family))],bands=[...new Set(first.map(e=>e.months>0?(e.months<=12?'short':'long'):null))],reasons=[];
  const side=families.length===1?families[0]:null,band=bands.length===1?bands[0]:null;
  if(age<0)reasons.push('Нет наблюдаемой даты первого подключения');
  if(!side)reasons.push('Не определён единый собственный/партнёрский канал первого окончания');
  if(!band)reasons.push(bands.includes(null)?'Неизвестен срок тарифа первого окончания':'В первую дату заканчиваются и короткий, и длинный тарифы');
  const key=age>=0&&side&&band?side+'|'+age+'|'+band:null;
  return {...feat,ageIndex:age,family:side,familyLabel:familyLabel(side),band,key,cohortLabel:key?COHORTS.find(c=>c.key===key).label:'Требует проверки',channel:channels.length===1?channels[0]:P.UNKNOWN,channels,partner:[...new Set(first.map(e=>e.partner).filter(Boolean))].join(' / '),firstTariffs:[...new Set(first.map(e=>e.months))],allTariffs:[...new Set(events.map(e=>e.months))],review:reasons.join('; ')};
 }
 function history(ofd,from,to,cut){
  const rows=[],periodComplete=Math.floor(to)+31<=cut;
  for(const c of ofd.clients.values()){
   const events=[];let upsell=false;const upsellUnits=new Set();
   for(const list of c.units.values())for(const r of list){
    if(r.start>=cut||r.end<from||r.end>=Math.floor(to)+1)continue;
    const o=P.outcome(list,r,cut);events.push({...r,...o});
    if(o.renewed&&r.months>0){const next=list.filter(n=>n.start===o.next&&n.end>r.end&&n.start>r.start);if(next.length&&next.every(n=>n.months>r.months)){upsell=true;upsellUnits.add(r.unit);}}
   }
   if(!events.length)continue;
   const anchor=Math.min(...events.map(e=>e.end)),info=classify(c,events,anchor,cut);
   rows.push({inn:c.inn,org:events[0].org,anchor,...info,renewed:events.some(e=>e.renewed),complete:events.every(e=>e.mature),upsell,upsellUnits:upsellUnits.size,dueUnits:new Set(events.map(e=>e.unit)).size});
  }
  const stats=COHORTS.map(c=>{const r=rows.filter(r=>r.key===c.key),pending=r.filter(r=>!r.complete).length,renewed=r.filter(r=>r.complete&&r.renewed).length,upsell=r.filter(r=>r.complete&&r.renewed&&r.upsell).length;return {...c,base:r.length,renewed,pending,notRenewed:r.length-renewed-pending,rate:periodComplete&&r.length&&!pending?renewed/r.length:null,upsellClients:upsell,upsellRate:periodComplete&&renewed&&!pending?upsell/renewed:null};});
  return {rows,stats,periodComplete};
 }
 function summarize(rows){
  const s={base:rows.length,dueUnits:0,expectedKnown:0,missingProb:0,baseMoneyKnown:0,renewalKnown:0,upsellKnown:0,totalKnown:0,missingBase:0,missingMoney:0};
  for(const r of rows){s.dueUnits+=r.dueUnits;if(r.prob==null)s.missingProb++;else s.expectedKnown+=r.prob;if(r.base==null)s.missingBase++;else s.baseMoneyKnown+=r.base;if(r.renewal!=null)s.renewalKnown+=r.renewal;if(r.uplift!=null)s.upsellKnown+=r.uplift;if(r.total==null)s.missingMoney++;else s.totalKnown+=r.total;}
  s.expected=s.missingProb?null:s.expectedKnown;s.rate=s.base&&s.expected!=null?s.expected/s.base:null;s.baseMoney=s.missingBase?null:s.baseMoneyKnown;s.renewal=s.missingMoney?null:s.renewalKnown;s.upsell=s.missingMoney?null:s.upsellKnown;s.money=s.missingMoney?null:s.totalKnown;return s;
 }
 function build(ofd,raw,finance){
  if(!ofd)return null;const p=normalize(raw),from=P.date(p.retroFrom),to=P.date(p.retroTo),cut=P.date(p.asOf);
  if(!Number.isInteger(p.year)||p.year<2000||p.year>2100)throw new Error('Год плана: от 2000 до 2100.');
  if(from==null||to==null||cut==null||from>to)throw new Error('Заполните корректные даты ретро и среза.');
  if(p.upsell!=null&&(p.upsell<0||p.upsell>1))throw new Error('Денежная надбавка: от 0 до 100%.');
  const historyKey=[from,to,cut].join('|');let old=cache.get(ofd);if(!old||old.key!==historyKey){old={key:historyKey,retro:history(ofd,from,to,cut)};cache.set(ofd,old);}
  if(old.year!==p.year){old.year=p.year;old.candidates=P.candidates(ofd,ofd,'ofd',p.year,cut);}
  const retro=old.retro,stats=new Map(retro.stats.map(s=>[s.key,s])),rows=old.candidates.map(c=>{
   const info=classify(ofd.clients.get(c.inn),c.endings,c.anchor,c.snapshot),stat=stats.get(info.key),manual=info.key?p.manual[info.key]:null,validManual=manual&&P.num(manual.value)!=null&&manual.value>=0&&manual.value<=1&&String(manual.reason||'').trim(),prob=validManual?+manual.value:stat?.rate??null,edit=p.clients[p.year+'|'+c.inn]||{},check=P.num(p.checks[info.channel]),manualBase=P.num(edit.base),hasBase=edit.base!==undefined&&edit.base!==null&&String(edit.base).trim()!=='',base=hasBase?(manualBase!=null&&manualBase>=0?manualBase:null):(check!=null&&check>=0?check:null),share=c.unknownTariffUnits?null:c.eligibleUpsellUnits/c.dueUnits,renewal=base==null||prob==null?null:base*prob,uplift=renewal==null||p.upsell==null?null:p.upsell===0?0:share==null?null:renewal*p.upsell*share,monthOverride=P.num(edit.month),month=monthOverride!=null&&Number.isInteger(monthOverride)&&monthOverride>=1&&monthOverride<=12?monthOverride:+P.iso(c.anchor).slice(5,7);
   const reason=info.review||('Первое окончание '+P.displayDate(c.anchor)+'; '+info.cohortLabel+'; '+(validManual?'ручная вероятность: '+manual.reason:stat?.rate!=null?'ретро '+p.retroFrom+' — '+p.retroTo+': '+stat.renewed+' / '+stat.base+' ИНН':'нет завершённого ретро для этой когорты'));
   return {...c,...info,cohort:info.cohortLabel,prob,probSource:validManual?'Ручная: '+manual.reason:'Фактическое ретро',base,baseSource:hasBase?'Ручная сумма клиента':'Средний чек канала — оценка',manualBase:hasBase?manualBase:null,monthOverride:monthOverride||null,note:String(edit.note||''),type:c.inn.length===12?'ИП (по длине ИНН)':c.inn.length===10?'Юрлицо (по длине ИНН)':'Не определён',share,renewal,uplift,total:renewal==null||uplift==null?null:renewal+uplift,month,reason,paid:finance?.byInn?.get(c.inn)||null};
  });
  const model={params:p,rows,retro,stats:retro.stats,finance:finance||null,total:summarize(rows),review:rows.filter(r=>!r.key),cohorts:COHORTS.map(c=>({...c,retro:stats.get(c.key),...summarize(rows.filter(r=>r.key===c.key))}))};model.audit=reconcile(model);return model;
 }
 function select(model,familyKey,cohortKey){return model.rows.filter(r=>(!familyKey||r.family===familyKey)&&(!cohortKey||r.key===cohortKey));}
 function reconcile(m){const errors=[],ids=new Set(m.rows.map(r=>r.inn));if(ids.size!==m.rows.length)errors.push('Повтор ИНН в годовом плане');if(m.cohorts.reduce((s,c)=>s+c.base,0)+m.review.length!==m.rows.length)errors.push('Не сошлась разбивка когорт');for(const r of m.rows)if(r.prob!=null&&(r.prob<0||r.prob>1))errors.push('Вероятность вне 0–100%');const s=summarize(m.rows);for(const k of ['base','dueUnits','expectedKnown','missingProb','missingBase','totalKnown'])if(Math.abs(s[k]-m.total[k])>1e-7)errors.push('Не сошёлся итог '+k);return {ok:!errors.length,errors};}
 const api={FAMILIES,AGES,BANDS,COHORTS,family,familyLabel,normalize,classify,history,summarize,build,select,reconcile};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SalesPlanning=api;
})(typeof window!=='undefined'?window:globalThis);
