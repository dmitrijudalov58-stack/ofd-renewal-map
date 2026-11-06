/* Annual retrospective: unique INNs, first-event attribution, no current exclusions. */
(function(root){
 'use strict';
 const P=root.Planning2||(typeof require==='function'?require('./core.js'):null);
 const union=xs=>[...new Set(xs)];
 // Search names across Cyrillic/Latin spellings without changing partner identity.
 function searchText(value){
  const letters={'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'i','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'};
  return String(value||'').toLowerCase().replace(/[а-яё]/g,c=>letters[c]).replace(/([a-z])\1+/g,'$1').replace(/[^a-z0-9]+/g,' ').trim();
 }
 function findPartners(partners,query){
  const terms=searchText(query).split(/\s+/).filter(Boolean);
  return partners.filter(p=>{const hay=searchText(p.label).replace(/\s/g,'');return terms.every(t=>hay.includes(t));})
   .sort((a,b)=>a.label.localeCompare(b.label,'ru'));
 }
 function attribution(records){
  return {channels:union(records.map(r=>P.classify(r.partner,r.center))),partners:union(records.map(r=>r.partnerInn?'inn:'+r.partnerInn:r.partner?'name:'+r.partner:'unknown'))};
 }
 function sourcePartners(ofd,inn,year,cut){
  const c=ofd&&ofd.clients.get(inn);if(!c)return [];
  const known=c.records.filter(r=>r.start<cut),due=known.filter(r=>r.end>=P.day(year)&&r.end<P.day(year+1));
  if(due.length){const anchor=Math.min(...due.map(r=>r.end));return due.filter(r=>r.end===anchor);}
  if(!known.length)return [];
  const last=Math.max(...known.map(r=>r.start));return known.filter(r=>r.start===last);
 }
 function build(ofd,base,promos,product,year,cut){
  const led=product==='ofd'?ofd:promos?P.mergePromos(base,promos).ledger:base;
  if(!led)return null;
  const from=P.day(year),to=P.day(year+1),rows=[],newRows=[],partners=new Map();
  function addPartner(r){
   const key=r.partnerInn?'inn:'+r.partnerInn:r.partner?'name:'+r.partner:'unknown';
   if(!partners.has(key))partners.set(key,{key,inn:r.partnerInn||'',names:[]});
   const p=partners.get(key);if(r.partner&&!p.names.includes(r.partner))p.names.push(r.partner);
  }
  // The search directory is not restricted to clients with events in the selected year.
  if(ofd)for(const r of ofd.records)if(r.start<cut)addPartner(r);
  function attrs(c,records){
   const rr=product==='ofd'?records:sourcePartners(ofd,c.inn,year,cut),a=attribution(rr);
   if(!a.channels.length)a.channels=[P.UNKNOWN];if(!a.partners.length)a.partners=['unknown'];
   rr.forEach(addPartner);
   return a;
  }
  const retro=P.retro(led,product,from,to-1,cut);
  for(const row of retro.rows){
   const c=led.clients.get(row.inn),events=c.records.filter(r=>r.start<cut&&r.end>=from&&r.end<to),first=events.filter(r=>r.end===row.anchor),a=attrs(c,first),transitions=[],seenTransitions=new Set(),renewedUnits=new Set();let unknownTariffs=0;
   if(product==='ofd')for(const old of events){
    const list=c.units.get(old.unit),state=P.outcome(list,old,cut);if(!state.renewed)continue;
    renewedUnits.add(old.unit);
    const nexts=list.filter(n=>n.start===state.next&&n.end>old.end&&n.start<cut),tariffs=union(nexts.map(n=>n.months));
    if(old.months==null||tariffs.length!==1||tariffs[0]==null){unknownTariffs++;continue;}
    if(tariffs[0]>old.months){const n=nexts[0],key=[old.unit,old.start,old.end,n.start,n.end,old.months,n.months].join('|');if(seenTransitions.has(key))continue;seenTransitions.add(key);transitions.push({inn:c.inn,org:row.org,unit:old.unit,from:old.months,to:n.months,end:old.end,start:n.start,partner:old.partner,partnerInn:old.partnerInn,channel:P.classify(old.partner,old.center)});}
   }
   rows.push({...row,...a,transitions,renewedUnits:[...renewedUnits],unknownTariffs});
  }
  for(const c of led.clients.values()){
   const known=c.records.filter(r=>r.start<cut);if(!known.length)continue;
   const first=known[0].start;if(first<from||first>=to)continue;
   newRows.push({inn:c.inn,org:known[0].org,start:first,...attrs(c,known.filter(r=>r.start===first))});
  }
  const channels=union([...P.CHANNELS,P.UNKNOWN,...rows.flatMap(r=>r.channels),...newRows.flatMap(r=>r.channels)]);
  return {product,year,cut,rows,newRows,channels,partners:[...partners.values()].filter(p=>p.key!=='unknown').map(p=>({...p,label:p.names.join(' / ')+(p.inn?' · '+p.inn:'')})).concat([{key:'unknown',label:'Партнёр не определён',inn:'',names:[]}])};
 }
 function select(rows,filter){return rows.filter(r=>filter.mode==='partner'?r.partners.includes(filter.partner):filter.channels==null||r.channels.some(c=>filter.channels.includes(c)));}
 function summarize(rows){
  const actual=rows.filter(r=>r.renewed).length,closed=rows.filter(r=>r.complete),closedRenewed=closed.filter(r=>r.renewed).length,lost=closed.length-closedRenewed,transitions=rows.flatMap(r=>r.transitions||[]);
  return {due:rows.length,actual,lost,pending:rows.length-actual-lost,closed:closed.length,closedRenewed,early:actual-closedRenewed,rate:closed.length?closedRenewed/closed.length:null,
   upsellClients:rows.filter(r=>r.transitions&&r.transitions.length).length,upsellRate:actual?rows.filter(r=>r.transitions&&r.transitions.length).length/actual:null,
   renewedRegisters:new Set(rows.flatMap(r=>(r.renewedUnits||[]).map(u=>r.inn+'|'+u))).size,upsellRegisters:new Set(transitions.map(r=>r.inn+'|'+r.unit)).size,transitions,unknownTariffs:rows.reduce((s,r)=>s+(r.unknownTariffs||0),0)};
 }
 const api={build,select,summarize,attribution,searchText,findPartners};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Planning2Retro=api;
})(typeof window!=='undefined'?window:globalThis);
