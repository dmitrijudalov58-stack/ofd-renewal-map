(function(root){
  'use strict';
  const P=root.Planning2;
  const S=root.SalesPlanning;
  const online=event=>event.partner==='АО "Калуга Астрал" (ЛК ОФД)';
  const own=event=>S.family(P.classify(event.partner,event.center))==='own';

  function rateForUnits(ledger,from,to,cut,predicate){
    if(!ledger||Math.floor(to)+31>cut)return null;
    let base=0,renewed=0;
    for(const client of ledger.clients.values())for(const list of client.units.values()){
      const periods=new Set();
      for(const event of list){
        if(event.start>=cut||event.end<from||event.end>=Math.floor(to)+1||!predicate(event))continue;
        const key=[Math.floor(event.start),Math.floor(event.end)].join("|");
        if(periods.has(key))continue;
        periods.add(key);
        const result=P.outcome(list,event,cut);
        base++;
        if(result.renewed)renewed++;
      }
    }
    return base?renewed/base:null;
  }

  function group(row){
    if(row.channel==='Корп')return 'Атол';
    if(row.channel===P.UNKNOWN&&row.channels?.includes('Корп'))return 'Не определён';
    if(row.family==='own')return 'Собственный';
    if(row.family==='partner')return 'Партнёры';
    return 'Не определён';
  }

  function allRetro(sales){
    const counts=new Map();
    function get(label){
      if(!counts.has(label))counts.set(label,{label,plan:0,base:0,renewed:0,pending:0});
      return counts.get(label);
    }
    for(const row of sales.rows)get(row.cohortLabel).plan++;
    for(const row of sales.retro.rows){
      const item=get(row.cohortLabel);
      item.base++;
      if(!row.complete)item.pending++;
      else if(row.renewed)item.renewed++;
    }
    const total={label:'Вся база ОФД',plan:sales.rows.length,base:0,renewed:0,pending:0};
    const ordered=[...new Set(S.COHORTS.map(c=>c.label)),'Требует проверки'];
    const rows=ordered.filter(label=>counts.has(label)).map(label=>counts.get(label));
    for(const row of rows)for(const key of ['base','renewed','pending'])total[key]+=row[key];
    return [total,...rows].map(row=>({...row,rate:sales.retro.periodComplete&&row.base&&!row.pending?row.renewed/row.base:null}));
  }

  function detailRows(rows,ledger,excluded,knownInactive,product,activityKnown){
    const details=[];
    for(const row of rows){
      const history=ledger.clients.get(row.inn);
      const clientConnected=history.records.find(event=>event.start<row.snapshot)?.start;
      const current=[...history.units].filter(([,events])=>events.some(event=>event.start<row.snapshot&&event.end>=row.snapshot));
      const units=[...history.units].filter(([,events])=>events[0].start<row.snapshot).map(([unit])=>unit);
      const partial=units.some(unit=>knownInactive.has(row.inn+'|'+unit)) &&
        units.some(unit=>!knownInactive.has(row.inn+'|'+unit));
      for(const event of row.endings){
        if(product==='ofd'&&(!own(event)||excluded.has(row.inn+'|'+event.unit)))continue;
        // Promo codes have no verified cash-register identifier.
        if(product==='onec'&&event.source==='promo')continue;
        const first=history.units.get(event.unit)?.[0];
        details.push({
          inn:row.inn,org:row.org,unit:event.unit,month:P.iso(event.end).slice(0,7),
          connected:first?.start??event.start,clientConnected,currentCount:current.length,
          inactiveCount:units.filter(unit=>knownInactive.has(row.inn+'|'+unit)).length,
          partner:product==='ofd'?event.partner:row.partner,
          channel:product==='ofd'?P.classify(event.partner,event.center):row.channel,
          start:event.start,end:event.end,tariff:event.months,
          cohort:row.cohort,prob:row.prob,online:product==='ofd'&&online(event),
          activity:activityKnown?'Вне списка неактивных':'Нет списка',partial
        });
      }
    }
    return details.sort((a,b)=>a.end-b.end||a.inn.localeCompare(b.inn));
  }

  function build(ofd,onec,promos,inactive,params){
    const from=P.date(params.retroFrom),to=P.date(params.retroTo),cut=P.date(params.asOf);
    if(!Number.isInteger(params.year)||params.year<2000||params.year>2100||from==null||to==null||cut==null||from>to)
      throw new Error('Проверьте год, период ретро и дату среза.');
    const sales=ofd?S.build(ofd,params):null;
    const rows=sales?.rows||[];
    const match=ofd&&inactive?P.matchExclusions(ofd,inactive,params.year,cut):null;
    const excluded=match?.excluded||new Set();
    const knownInactive=new Set(excluded);
    for(const record of match?.report||[])if(record.identityFound)knownInactive.add(record.inn+'|'+record.unit);
    const oneLedger=promos?P.mergePromos(onec,promos).ledger:onec;
    const oneRows=oneLedger?P.candidates(oneLedger,ofd||P.ledger([]),'onec',params.year,cut):[];
    const oneRate=oneLedger?P.retro(oneLedger,'onec',from,to,cut).stats.get('Все клиенты').rate:null;
    const ofdDetails=ofd?detailRows(rows,ofd,excluded,knownInactive,'ofd',!!match):[];
    const oneDetails=oneLedger?detailRows(oneRows,oneLedger,new Set(),new Set(),'onec',false):[];
    const otherMonths=Array.from({length:12},()=>({partner:0,atol:0,unknown:0}));
    for(const row of rows)for(const event of row.endings){
      if(own(event))continue;
      const channel=P.classify(event.partner,event.center);
      const kind=channel==='Корп'?'atol':S.family(channel)==='partner'?'partner':'unknown';
      otherMonths[Number(P.iso(event.end).slice(5,7))-1][kind]++;
    }
    return {
      ofdRetro:sales?allRetro(sales):[],otherMonths,sales,rows,oneRows,oneRate,match,ofdDetails,oneDetails,oneLoaded:!!oneLedger,
      oneMissing:oneRows.reduce((sum,row)=>sum+row.endings.length,0)-oneDetails.length,
      ofdUnitRate:rateForUnits(ofd,from,to,cut,own),
      oneUnitRate:rateForUnits(onec,from,to,cut,()=>true)
    };
  }

  function summarize(plan,assumptions){
    return ['Собственный','Партнёры','Атол','Не определён'].map(name=>{
      const rows=plan.rows.filter(row=>group(row)===name);
      let expected=0,money=0,missingRate=0,missingMoney=0;
      for(const row of rows){
        const rate=name==='Партнёры'?.6:name==='Атол'?assumptions.atolRate: name==='Собственный'?row.prob:null;
        const check=name==='Атол'?assumptions.atolCheck:assumptions.checks[row.channel];
        if(rate==null)missingRate++;else expected+=rate;
        if(rate==null||check==null)missingMoney++;else money+=rate*check;
      }
      return {name,base:rows.length,expected:missingRate?null:expected,missingRate,
        money:name==='Собственный'||name==='Не определён'||missingMoney?null:money};
    });
  }
  root.Planning3={build,summarize,group};
})(typeof window!=='undefined'?window:globalThis);
