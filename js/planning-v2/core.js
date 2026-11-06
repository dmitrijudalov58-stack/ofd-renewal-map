/* Планирование 2.0. Независимая модель: ИНН → когорта → канал → годовой чек клиента. */
(function (root) {
  'use strict';
  const DAY=86400000, EPOCH=Date.UTC(1899,11,30), UNKNOWN='Не определён';
  const CHANNELS=['Корп','Ольга Зибер','Пенигина — прямые','Пенигина — ОП','Партнёры'];
  const AGES=['<1 года','1–<3 лет','3–<5 лет','5+ лет'];
  const COHORTS=AGES.flatMap(a=>[a+' / 1 касса',a+' / 2+ кассы']);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
  function num(v){if(v==null||String(v).trim()==='')return null;const n=Number(String(v).replace(',','.').replace(/\s/g,''));return Number.isFinite(n)?n:null;}
  function day(y,m=1,d=1){return (Date.UTC(y,m-1,d)-EPOCH)/DAY;}
  function iso(v){return v==null?'':new Date(EPOCH+Math.floor(v)*DAY).toISOString().slice(0,10);}
  function displayDate(v){return iso(v).split('-').reverse().join('.');}
  function date(v,date1904=false){
    if(v==null||v==='')return null;
    if(typeof v==='number')return Number.isFinite(v)?v+(date1904?1462:0):null;
    if(Object.prototype.toString.call(v)==='[object Date]')return Number.isNaN(+v)?null:(Date.UTC(v.getUTCFullYear(),v.getUTCMonth(),v.getUTCDate(),v.getUTCHours(),v.getUTCMinutes(),v.getUTCSeconds(),v.getUTCMilliseconds())-EPOCH)/DAY;
    let s=String(v).trim(),m=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(s);
    if(!m){const r=/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);if(!r)return null;m=[r[0],r[3],r[2],r[1],r[4],r[5],r[6]];}
    const y=+m[1],mo=+m[2],d=+m[3],h=+(m[4]||0),mi=+(m[5]||0),sec=+(m[6]||0);
    const dt=new Date(Date.UTC(y,mo-1,d,h,mi,sec));
    return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d&&h<24&&mi<60&&sec<60?(+dt-EPOCH)/DAY:null;
  }
  function clean(v){return v==null?'':String(v).trim();}
  function inn(v){let s=clean(v);if(/^\d+$/.test(s)&&[9,11].includes(s.length))s='0'+s;return s;}
  function month(v){return iso(v).slice(0,7);}
  function addMonths(start,months){const dt=new Date(EPOCH+start*DAY),last=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+months+1,0)).getUTCDate();return day(dt.getUTCFullYear(),dt.getUTCMonth()+months+1,Math.min(dt.getUTCDate(),last))+(start-Math.floor(start));}
  const PROMO_HEADERS=['Дата генерации','Наименование организации','ИНН','КПП','Тариф','Промокод','Статус промокода','Дата активации','Признак партнера'];
  function parsePromos(X,wb,file){
    const records=[],report=[],issues=[],seen=new Map(),conflicts=new Set();let sourceRows=0,inactive=0,duplicates=0;
    for(const sheet of wb.SheetNames){const ws=wb.Sheets[sheet];if(!ws||!ws['!ref'])continue;const range=X.utils.decode_range(ws['!ref']);if(range.e.r<1)continue;
      if(!PROMO_HEADERS.every((h,c)=>clean(readCell(X,ws,0,c))===h))throw new Error('Не совпали столбцы промокодов на листе '+sheet+'.');
      for(let row=1;row<=range.e.r;row++){const get=c=>readCell(X,ws,row,c);if(PROMO_HEADERS.every((_,c)=>get(c)==null||get(c)===''))continue;sourceRows++;
        const id=inn(get(2)),pin=clean(get(5)),start=date(get(7),!!(wb.Workbook&&wb.Workbook.WBProps&&wb.Workbook.WBProps.date1904)),m=/\d+/.exec(clean(get(4))),months=m?+m[0]:null;
        const r={inn:id,unit:'promo-client:'+id,pin,start,end:start==null||!months?null:addMonths(start,months),months,source:'promo',overall:null,partner:'',partnerInn:'',center:'',org:clean(get(1)),file,sheet,row:row+1};
        if(clean(get(6)).toLowerCase()!=='активирован'){inactive++;report.push({...r,status:'Не активирован — не учитывается'});continue;}
        if(!id||!pin||start==null||!months){const item={...r,status:'Некорректные данные активации'};issues.push(item);report.push(item);continue;}
        if(seen.has(pin)){duplicates++;const prior=seen.get(pin);if(prior.inn!==id||prior.start!==start||prior.end!==r.end)conflicts.add(pin);report.push({...r,status:'Повтор промокода'});continue;}
        seen.set(pin,r);records.push(r);report.push({...r,status:'Активирован'});
      }
    }
    if(!sourceRows)throw new Error('Файл промокодов пуст.');
    for(const item of report)if(conflicts.has(item.pin))item.status='Конфликт одного промокода — не учитывается';
    return {records:records.filter(r=>!conflicts.has(r.pin)),report,issues,sourceRows,inactive,duplicates,files:[file]};
  }
  const mergedPromoCache=new WeakMap();
  function mergePromos(base,data){
    const old=mergedPromoCache.get(data);if(old&&old.base===base)return old.result;
    const key=r=>[r.inn,Math.floor(r.start),Math.floor(r.end),r.months].join('|'),existing=new Set((base?base.records:[]).map(key)),seen=new Set(existing),extra=[];let overlap=0,repeatedCoverage=0;
    for(const r of data.records){const k=key(r);if(existing.has(k)){overlap++;continue;}if(seen.has(k)){repeatedCoverage++;continue;}seen.add(k);extra.push(r);}
    const merged=ledger([...(base?base.records:[]),...extra]);
    const result={ledger:merged,addedCoverage:extra.length,overlap,repeatedCoverage};mergedPromoCache.set(data,{base,result});return result;
  }
  function age(first,at){if(first==null)return 'Нет даты';const a=new Date(EPOCH+first*DAY),b=new Date(EPOCH+at*DAY);let years=b.getUTCFullYear()-a.getUTCFullYear();if(b.getUTCMonth()<a.getUTCMonth()||(b.getUTCMonth()===a.getUTCMonth()&&b.getUTCDate()<a.getUTCDate()))years--;return years<1?AGES[0]:years<3?AGES[1]:years<5?AGES[2]:AGES[3];}
  function classify(partner,center){const m=root.OFDMetrics||(typeof require==='function'?require('../metrics.js'):null);return partner||center?m.classifyChannel(partner,center):UNKNOWN;}
  function readCell(X,ws,r,c){if(Array.isArray(ws))return ws[r]&&ws[r][c]?ws[r][c].v:null;const cell=ws[X.utils.encode_cell({r,c})];return cell?cell.v:null;}
  function parseWorkbook(X,wb,product,file){
    const records=[],issues=[],badHeaders=[],date1904=!!(wb.Workbook&&wb.Workbook.WBProps&&wb.Workbook.WBProps.date1904);
    let sourceRows=0,maxStart=null;
    const expected=product==='ofd'?(root.OFDParser||(typeof require==='function'?require('../parser.js'):null)).EXPECTED_HEADERS:['Ключ доступа','ИНН покупателя','Заводской номер ККТ','Начало действия тарифа','Окончание действия тарифа','Количество месяцев','Итоговая сумма','Сумма роялти'];
    for(const name of wb.SheetNames){
      const ws=wb.Sheets[name];if(!ws||!ws['!ref'])continue;
      const range=X.utils.decode_range(ws['!ref']);
      if(range.e.r<1)continue;
      if(!expected.every((h,c)=>clean(readCell(X,ws,0,c))===h)){badHeaders.push(name);continue;}
      for(let r=1;r<=range.e.r;r++){
        const get=c=>readCell(X,ws,r,c);
        if(expected.every((_,c)=>get(c)==null||get(c)===''))continue;
        sourceRows++;
        if(product==='ofd'&&clean(get(4))!=='Зарегистрировано')continue;
        const start=date(get(product==='ofd'?9:3),date1904),end=date(get(product==='ofd'?10:4),date1904);
        const id=inn(get(product==='ofd'?14:1))||(product==='ofd'?inn(get(6)):'');
        const unit=clean(get(product==='ofd'?12:2));
        const reason=!id?'Нет ИНН':!unit?'Нет номера кассы':start==null?'Нет даты начала':end==null?'Нет даты окончания':start>end?'Начало позже окончания':'';
        if(reason){issues.push({product,inn:id,unit,reason,file,sheet:name,row:r+1});continue;}
        const tariff=clean(get(product==='ofd'?5:5));const n=/\d+/.exec(tariff);
        records.push({inn:id,unit,pin:clean(get(product==='ofd'?2:0)),start,end,
          overall:product==='ofd'?date(get(11),date1904):null,months:n?+n[0]:null,
          partner:product==='ofd'?clean(get(19)):'',partnerInn:product==='ofd'?inn(get(20)):'',
          center:product==='ofd'?clean(get(22)):'',org:product==='ofd'?clean(get(13)):'',
          file,sheet:name,row:r+1});
        if(maxStart==null||start>maxStart)maxStart=start;
      }
    }
    if(badHeaders.length)throw new Error('Не совпали столбцы файла '+file+' на листах: '+badHeaders.join(', ')+'. Выберите исходную выгрузку '+(product==='ofd'?'ОФД':'Обмена с 1С')+'.');
    return {records,issues,sourceRows,maxStart};
  }
  function ledger(input){
    const seen=new Set(),records=[],clients=new Map();let duplicates=0,maxStart=null;
    for(const r of input){
      const key=JSON.stringify([r.inn,r.unit,r.pin,r.start,r.end,r.overall,r.months,r.partner,r.partnerInn,r.org,r.center]);
      if(seen.has(key)){duplicates++;continue;}seen.add(key);records.push(r);
      let c=clients.get(r.inn);if(!c){c={inn:r.inn,units:new Map(),records:[]};clients.set(r.inn,c);}
      c.records.push(r);if(r.source==='promo'){if(!c.promoRecords)c.promoRecords=[];c.promoRecords.push(r);}if(!c.units.has(r.unit))c.units.set(r.unit,[]);c.units.get(r.unit).push(r);
      if(maxStart==null||r.start>maxStart)maxStart=r.start;
    }
    for(const c of clients.values()){
      c.records.sort((a,b)=>a.start-b.start||a.end-b.end||a.pin.localeCompare(b.pin));
      for(const list of c.units.values())list.sort((a,b)=>a.start-b.start||a.end-b.end||a.pin.localeCompare(b.pin));
    }
    return {records,clients,duplicates,maxStart};
  }
  function metadata(c,cut){
    if(!c)return {partner:'',channel:UNKNOWN,org:''};
    let latest=null,appearance=-Infinity;
    for(const list of c.units.values()){
      const known=list.filter(r=>r.start<cut);if(!known.length)continue;
      const first=known[0].start,last=known[known.length-1];
      if(first>appearance){appearance=first;latest=last;}
    }
    return latest?{partner:latest.partner,channel:classify(latest.partner,latest.center),org:latest.org}:{partner:'',channel:UNKNOWN,org:''};
  }
  function features(c,anchor,cut){
    let first=null,count=0;
    for(const list of c.units.values()){
      let active=false;
      for(const r of list){if(r.start>=anchor||r.start>=cut)continue;if(first==null||r.start<first)first=r.start;if(r.end>=anchor)active=true;}
      if(active)count++;
    }
    const group=age(first,anchor);
    return {first,age:group,kassas:count,cohort:group==='Нет даты'||!count?'Нет данных':group+' / '+(count===1?'1 касса':'2+ кассы')};
  }
  function outcome(list,r,cut,calendar){
    let next=null;
    for(const n of list)if((calendar?Math.floor(n.start)>Math.floor(r.start)&&Math.floor(n.end)>Math.floor(r.end):n.start>r.start&&n.end>r.end)&&(next==null||n.start<next))next=n.start;
    const deadline=Math.floor(r.end)+31;
    return {renewed:next!=null&&next<deadline&&next<cut,mature:deadline<=cut,next};
  }
  function retro(led,product,from,to,cut){
    const rows=[],stats=new Map(),periodComplete=Math.floor(to)+31<=cut;
    const keys=product==='ofd'?COHORTS:['Все клиенты'];
    for(const key of keys)stats.set(key,{key,base:0,renewed:0,notRenewed:0,pending:0,rate:null});
    for(const c of led.clients.values()){
      const events=[];
      for(const list of c.units.values())for(const r of list){
        if(r.start>=cut||r.end<from||r.end>=Math.floor(to)+1)continue;
        let state=outcome(list,r,cut);
        if(product==='onec'&&c.promoRecords){const extra=outcome(r.source==='promo'?c.records:c.promoRecords,r,cut,true);state={...state,renewed:state.renewed||extra.renewed,next:state.next==null?extra.next:extra.next==null?state.next:Math.min(state.next,extra.next)};}
        events.push({...r,...state});
      }
      if(!events.length)continue;
      const anchor=Math.min(...events.map(r=>r.end)),feat=features(c,anchor,cut);
      const key=product==='ofd'?feat.cohort:'Все клиенты';
      if(!stats.has(key))stats.set(key,{key,base:0,renewed:0,notRenewed:0,pending:0,rate:null});
      const s=stats.get(key),renewed=events.some(r=>r.renewed),complete=events.every(r=>r.mature);
      const due=new Set(events.map(r=>r.unit)),unitsRenewed=new Set(events.filter(r=>r.renewed).map(r=>r.unit));
      s.base++;if(!complete)s.pending++;else if(renewed)s.renewed++;else s.notRenewed++;
      rows.push({inn:c.inn,org:events[0].org,cohort:key,anchor,...feat,renewed,complete,due:due.size,unitsRenewed:unitsRenewed.size});
    }
    for(const s of stats.values())s.rate=periodComplete&&s.base>0&&s.pending===0?s.renewed/s.base:null;
    return {rows,stats,periodComplete,product,from,to};
  }
  function resolveChannel(records){
    const channels=[...new Set(records.map(r=>classify(r.partner,r.center)))];
    return {channel:channels.length===1?channels[0]:UNKNOWN,
      partner:[...new Set(records.map(r=>r.partner).filter(Boolean))].join('; '),conflict:channels.length>1};
  }
  const EXCLUSION_HEADERS=['ИНН клиента','КПП клиента','Наименование клиента','Заводской номер ККТ','ЗН ФН','Дата окончания ОФД','Дата окончания ФН','Срок действия текущего кода (1/3/6…мес)','Наличие Обмена с 1С 0/1','Тариф обмена с 1С (1/3/...Мес)','Наличие подключенных автоотчетов плюс (0/1)','Партнер'];
  function parseExclusions(X,wb,file){
    const records=[],issues=[];let sourceRows=0,duplicates=0;const seen=new Map(),conflicts=new Set();
    for(const sheet of wb.SheetNames){
      const ws=wb.Sheets[sheet];if(!ws||!ws['!ref'])continue;const range=X.utils.decode_range(ws['!ref']);if(range.e.r<1)continue;
      if(!EXCLUSION_HEADERS.every((h,c)=>clean(readCell(X,ws,0,c))===h))throw new Error('Не совпали столбцы списка исключений на листе '+sheet+'.');
      for(let row=1;row<=range.e.r;row++){
        const get=c=>readCell(X,ws,row,c);if(EXCLUSION_HEADERS.every((_,c)=>get(c)==null||get(c)===''))continue;sourceRows++;
        const id=inn(get(0)),serial=clean(get(3)),end=date(get(5),!!(wb.Workbook&&wb.Workbook.WBProps&&wb.Workbook.WBProps.date1904)),m=/\d+/.exec(clean(get(7))),months=m?+m[0]:null;
        const r={inn:id,serial,org:clean(get(2)),end:end==null?null:Math.floor(end),months,partner:clean(get(11)),file,sheet,row:row+1};
        if(!id||!serial||end==null||!months){issues.push({...r,status:'Некорректный ИНН, номер, дата или тариф'});continue;}
        const key=id+'|'+serial,prior=seen.get(key);
        if(prior){duplicates++;const conflict=prior.end!==r.end||prior.months!==r.months;if(conflict)conflicts.add(key);issues.push({...r,status:conflict?'Конфликтующий повтор заводского номера — не исключён':'Повтор записи — не учитывается повторно'});continue;}
        seen.set(key,r);records.push(r);
      }
    }
    if(!sourceRows)throw new Error('Список исключений пуст.');
    return {records,issues,sourceRows,duplicates,conflicts,files:[file]};
  }
  const exclusionCache=new WeakMap();
  function matchExclusions(led,input,year,cut){
    const cached=exclusionCache.get(input);if(cached&&cached.led===led&&cached.year===year&&cached.cut===cut)return cached.result;
    const groups=new Map(),excluded=new Set(),report=[];const snapshot=Math.min(cut,day(year));
    if(led)for(const c of led.clients.values())for(const list of c.units.values()){
      const known=list.filter(r=>r.start<snapshot);if(!known.length)continue;
      const end=Math.max(...known.map(r=>r.end)),r=known.filter(r=>r.end===end).at(-1);
      const key=[r.inn,Math.floor(r.end),r.months].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
    }
    const counts=new Map();for(const r of input.records){if(input.conflicts.has(r.inn+'|'+r.serial))continue;const key=[r.inn,r.end,r.months].join('|');counts.set(key,(counts.get(key)||0)+1);}
    for(const r of input.records){
      const key=[r.inn,r.end,r.months].join('|'),matches=groups.get(key)||[];let status,unit='';
      if(input.conflicts.has(r.inn+'|'+r.serial))status='Конфликт дат или тарифов одного заводского номера';
      else if(!led||!led.clients.has(r.inn))status='ИНН отсутствует в базе ОФД';
      else if(!matches.length)status='Нет совпадения по ИНН, дате окончания и тарифу';
      else if(matches.length!==1||counts.get(key)!==1)status='Неоднозначное совпадение — не исключено';
      else if(matches[0].end<day(year)||matches[0].end>=day(year+1))status='Совпало, вне планового года';
      else{status='Исключено';unit=matches[0].unit;excluded.add(r.inn+'|'+unit);}
      const info=metadata(led&&led.clients.get(r.inn),snapshot),direct=unit?matches[0]:null;
      report.push({...r,status,unit,month:month(r.end),ofdPartner:direct?direct.partner:info.partner,channel:direct?classify(direct.partner,direct.center):info.channel});
    }
    report.push(...input.issues.map(r=>{const info=metadata(led&&led.clients.get(r.inn),snapshot);return {...r,month:month(r.end),ofdPartner:info.partner,channel:info.channel};}));
    const result={excluded,report,sourceRows:input.sourceRows,duplicates:input.duplicates,files:input.files};
    exclusionCache.set(input,{led,year,cut,result});return result;
  }
  function filterExclusions(report,year,filters){
    const unique=new Map();for(const r of report){const key=r.inn&&r.serial?r.inn+'|'+r.serial:[r.file,r.sheet,r.row].join('|');if(!unique.has(key))unique.set(key,r);}
    const f=filters||{};return [...unique.values()].filter(r=>(!f.status||f.status==='all'||(r.status==='Исключено')===(f.status==='excluded'))&&(!f.period||f.period==='all'||(r.end!=null&&r.end>=day(year)&&r.end<day(year+1))===(f.period==='plan'))&&(!f.month||month(r.end)===f.month));
  }
  function filterCandidate(r,excluded){
    const endings=r.endings.filter(e=>!excluded.has(r.inn+'|'+e.unit));if(!endings.length)return null;if(endings.length===r.endings.length)return r;
    const anchor=Math.min(...endings.map(e=>e.end)),first=endings.filter(e=>e.end===anchor),info=resolveChannel(first);
    return {...r,endings,anchor,month:month(anchor),channel:info.channel,partner:info.partner,channelConflict:info.conflict,
      dueUnits:endings.length,eligibleUpsellUnits:endings.filter(e=>e.months>0&&e.months<36).length,unknownTariffUnits:endings.filter(e=>e.months==null).length,
      tariffs:[...new Set(first.map(e=>e.months).filter(v=>v!=null))].join(', '),file:first[0].file,sheet:first[0].sheet,sourceRow:first[0].row};
  }
  function candidates(led,ofd,product,year,cut){
    const rows=[];
    // Past-year views use the information available at that year's opening.
    const snapshot=Math.min(cut,day(year));
    for(const c of led.clients.values()){
      const endings=[];
      for(const list of c.units.values()){
        const known=list.filter(r=>r.start<snapshot);if(!known.length)continue;
        const end=Math.max(...known.map(r=>r.end));
        if(end<day(year)||end>=day(year+1))continue;
        const choices=known.filter(r=>r.end===end);let r=choices[choices.length-1];
        if(product==='onec'&&c.promoRecords){const cross=(r.source==='promo'?c.records:c.promoRecords).filter(n=>n.start<snapshot&&Math.floor(n.start)>Math.floor(r.start)&&n.end>r.end);if(cross.length)r=cross.reduce((a,b)=>b.end>a.end?b:a,r);}
        if(r.end<day(year)||r.end>=day(year+1))continue;
        if(product==='onec'&&c.promoRecords&&endings.some(e=>Math.floor(e.start)===Math.floor(r.start)&&Math.floor(e.end)===Math.floor(r.end)&&e.months===r.months))continue;
        endings.push({...r,end:r.end});
      }
      if(!endings.length)continue;
      const anchor=Math.min(...endings.map(r=>r.end));
      const first=endings.filter(r=>r.end===anchor);
      const info=product==='ofd'?resolveChannel(first):metadata(ofd.clients.get(c.inn),snapshot);
      const feat=features(c,anchor,snapshot);
      rows.push({id:product+'|'+year+'|'+c.inn,product,inn:c.inn,
        org:first[0].org||metadata(ofd.clients.get(c.inn),snapshot).org,
        anchor,month:month(anchor),...feat,cohort:product==='ofd'?feat.cohort:'Все клиенты',
        channel:info.channel,partner:info.partner,channelConflict:!!info.conflict,
        channelSource:product==='onec'?'Партнёр ИНН из базы ОФД':'Первое окончание ОФД',
        dueUnits:endings.length,eligibleUpsellUnits:endings.filter(r=>r.months>0&&r.months<36).length,unknownTariffUnits:endings.filter(r=>r.months==null).length,endings,
        tariffs:[...new Set(first.map(r=>r.months).filter(v=>v!=null))].join(', '),
        file:first[0].file,sheet:first[0].sheet,sourceRow:first[0].row,snapshot});
    }
    return rows.sort((a,b)=>a.anchor-b.anchor||a.inn.localeCompare(b.inn));
  }
  function defaults(){return {year:2027,retroFrom:'2025-01-01',retroTo:'2025-12-31',asOf:'',vat:'',upsell:0.05,checks:{ofd:{},onec:{}},manual:{ofd:{},onec:{}},channels:{}};}
  function normalizeParams(raw){
    const d=defaults();if(!raw||typeof raw!=='object')return d;
    const year=+raw.year;if(Number.isInteger(year)&&year>=2000&&year<=2100)d.year=year;
    for(const k of ['retroFrom','retroTo','asOf'])if(date(raw[k])!=null)d[k]=raw[k];
    if(['with','without'].includes(raw.vat))d.vat=raw.vat;
    if(num(raw.upsell)!=null&&num(raw.upsell)>=0&&num(raw.upsell)<=1)d.upsell=num(raw.upsell);
    for(const k of ['checks','manual'])for(const p of ['ofd','onec'])if(raw[k]&&raw[k][p]&&typeof raw[k][p]==='object')d[k][p]={...raw[k][p]};
    if(raw.channels&&typeof raw.channels==='object')d.channels={...raw.channels};return d;
  }
  const cache=new WeakMap();
  function effectiveProb(stats,key,manual){
    const m=manual&&manual[key];
    if(m&&num(m.value)!=null&&num(m.value)>=0&&num(m.value)<=1&&clean(m.reason))return {value:num(m.value),source:'Ручная: '+clean(m.reason)};
    const s=stats.get(key);return {value:s?s.rate:null,source:s&&s.rate!=null?'Ретро':'Нет завершённых данных'};
  }
  function build(ofd,onec,params,exclusions){
    if(params&&['retroFrom','retroTo','asOf'].some(k=>own(params,k)&&date(params[k])==null))throw new Error('Заполните период ретро и дату среза.');
    const p=normalizeParams(params),cut=date(p.asOf),from=date(p.retroFrom),to=date(p.retroTo);
    if(cut==null||from==null||to==null||from>to)throw new Error('Проверьте дату среза и период ретро.');
    const result={params:p,cut,from,to,products:{},warnings:[],channels:[],rows:[]};
    const match=exclusions?matchExclusions(ofd,exclusions,p.year,cut):null;
    for(const product of ['ofd','onec']){
      const led=product==='ofd'?ofd:onec;
      if(!led){result.products[product]={loaded:false,rows:[],retro:null};continue;}
      const key=[product,from,to,cut,p.year].join('|');let analysis=cache.get(led);
      if(!analysis||analysis.key!==key||analysis.ofd!==ofd){analysis={key,ofd,rt:retro(led,product,from,to,cut),rows:candidates(led,ofd||ledger([]),product,p.year,cut)};cache.set(led,analysis);}
      const rt=analysis.rt,rows=analysis.rows.map(r=>product==='ofd'&&match?filterCandidate(r,match.excluded):r).filter(Boolean).map(r=>({...r}));
      for(const row of rows){
        const override=p.channels[row.id];if(CHANNELS.includes(override)){row.channel=override;row.channelSource='Ручной выбор';}
        const prob=effectiveProb(rt.stats,row.cohort,p.manual[product]);
        row.prob=prob.value;row.probSource=prob.source;
        row.check=row.channel===UNKNOWN?null:num(p.checks[product][row.channel]);
        if(row.check!=null&&row.check<0)row.check=null;
        row.expected=row.prob==null?null:row.prob;
        row.baseAmount=row.prob==null||row.check==null?null:row.prob*row.check;
        row.upsellShare=product==='ofd'?(row.unknownTariffUnits?null:row.eligibleUpsellUnits/row.dueUnits):0;
        row.upsellAmount=row.baseAmount==null?null:product==='onec'||p.upsell===0?0:row.upsellShare==null?null:row.baseAmount*p.upsell*row.upsellShare;
        row.amount=row.baseAmount==null||row.upsellAmount==null?null:row.baseAmount+row.upsellAmount;
      }
      const total={base:rows.length,expected:0,money:0,baseMoney:0,upsellMoney:0,missingUpsell:0,missingProb:0,missingCheck:0,missingChannel:0};
      for(const r of rows){if(r.baseAmount!=null)total.baseMoney+=r.baseAmount;if(r.upsellAmount!=null)total.upsellMoney+=r.upsellAmount;else if(r.baseAmount!=null)total.missingUpsell++;}
      for(const r of rows){if(r.expected==null)total.missingProb++;else total.expected+=r.expected;if(r.amount!=null)total.money+=r.amount;if(r.check==null)total.missingCheck++;if(r.channel===UNKNOWN)total.missingChannel++;}
      total.complete=total.missingProb===0&&total.missingCheck===0&&total.missingChannel===0&&total.missingUpsell===0;
      if(total.missingUpsell)result.warnings.push('ОФД: у '+total.missingUpsell+' клиентов неизвестен срок тарифа; сумма с апсейлом не определена.');
      result.products[product]={loaded:true,rows,retro:rt,total};result.rows.push(...rows);
      if(!rt.periodComplete)result.warnings.push((product==='ofd'?'ОФД':'Обмен с 1С')+': период ретро ещё не завершён с учётом 30 дней. Расчётные вероятности не используются.');
    }
    result.channels=CHANNELS.filter(ch=>result.rows.some(r=>r.channel===ch));
    if(!ofd)result.warnings.push('Загрузите основную выгрузку ОФД для расчёта когорт и определения партнёров клиентов.');
    if(!onec)result.warnings.push('Обмен с 1С не загружен. Его план не считается нулевым.');
    if(!p.vat)result.warnings.push('Отметьте, с НДС или без НДС вводятся средние чеки.');
    const unknown=result.rows.filter(r=>r.channel===UNKNOWN).length;
    if(unknown)result.warnings.push('У '+unknown+' строк не определён единственный канал. Выберите его в детализации клиентов.');
    result.complete=!!ofd&&!!onec&&['ofd','onec'].every(k=>result.products[k].total.complete)&&!!p.vat;
    result.money=result.rows.reduce((s,r)=>s+(r.amount==null?0:r.amount),0);
    result.uniqueClients=new Set(result.rows.map(r=>r.inn)).size;
    result.exclusions=match;
    if(match){
      const original=build(ofd,onec,p);result.baseline={money:original.money,knownMoney:original.rows.some(r=>r.amount!=null),complete:original.complete,ofd:original.products.ofd.total||null,onec:original.products.onec.total||null,uniqueClients:original.uniqueClients};
      result.comparison={excludedUnits:match.excluded.size,excludedClients:original.products.ofd.rows.length-result.products.ofd.rows.length,moneyDrop:result.baseline.knownMoney?original.money-result.money:null};
      const unresolved=match.report.filter(r=>r.status!=='Исключено'&&r.status!=='Совпало, вне планового года').length;
      if(unresolved)result.warnings.push('Список без чеков: '+unresolved+' строк не исключены автоматически. Причины доступны в проверке и Excel.');
    }
    return result;
  }
  function aggregate(rows,keyfn){
    const map=new Map();
    for(const r of rows){const key=keyfn(r);let s=map.get(key);if(!s){s={key,base:0,expected:0,money:0,missing:0};map.set(key,s);}s.base++;if(r.expected==null||r.amount==null)s.missing++;if(r.expected!=null)s.expected+=r.expected;if(r.amount!=null)s.money+=r.amount;}
    return [...map.values()].sort((a,b)=>a.key.localeCompare(b.key));
  }
  function buildWithPromos(ofd,onec,params,exclusions,promos){
    if(!promos)return build(ofd,onec,params,exclusions);
    const merged=mergePromos(onec,promos),plan=build(ofd,merged.ledger,params,exclusions),before=onec?build(ofd,onec,params).products.onec:null;
    const snapshot=Math.min(plan.cut,day(plan.params.year)),due=promos.records.filter(r=>r.start<snapshot&&r.end>=day(plan.params.year)&&r.end<day(plan.params.year+1)),ids=new Set(due.map(r=>r.inn));
    const beforeStats=before&&before.retro.stats.get('Все клиенты'),afterStats=plan.products.onec.retro.stats.get('Все клиенты');
    const originalPeriods=new Set((onec?onec.records:[]).map(r=>[r.inn,Math.floor(r.start),Math.floor(r.end),r.months].join('|'))),seen=new Set();
    const report=promos.report.map(r=>{let status=r.status;if(status==='Активирован'){
      const key=[r.inn,Math.floor(r.start),Math.floor(r.end),r.months].join('|');
      status=r.start>=plan.cut?'Активация после среза':originalPeriods.has(key)?'Покрытие уже есть в сверке 1С':seen.has(key)?'Покрытие уже учтено по другому промокоду':'Добавлено в историю 1С';seen.add(key);
    }const info=metadata(ofd&&ofd.clients.get(r.inn),snapshot);return {...r,status,partner:info.partner,channel:info.channel};});
    const related=plan.products.onec.rows.filter(r=>ids.has(r.inn));
    plan.promo={files:promos.files,sourceRows:promos.sourceRows,activated:promos.records.length,inactive:promos.inactive,issues:promos.issues.length,duplicates:promos.duplicates,clients:new Set(promos.records.map(r=>r.inn)).size,addedCoverage:merged.addedCoverage,overlap:merged.overlap,repeatedCoverage:merged.repeatedCoverage,
      expiringCodes:due.length,expiringClients:ids.size,clientsInPlan:related.length,expectedClients:related.some(r=>r.expected==null)?null:related.reduce((s,r)=>s+r.expected,0),beforeStats:beforeStats||null,afterStats,beforeClients:before?before.rows.length:null,afterClients:plan.products.onec.rows.length,report};
    if(!onec){plan.complete=false;plan.warnings.push('Сверка Обмена с 1С не загружена. История и план 1С рассчитаны только по промокодам и неполны.');}
    if(promos.issues.length)plan.warnings.push('Промокоды: '+promos.issues.length+' некорректных строк не включены.');
    return plan;
  }
  function workbook(plan){
    const p=plan.params,F=(f,v,s=8)=>({f,v,s}),V=(v,s)=>({v,s});
    const parameters=[],paramRow=new Map(),probRow=new Map();
    for(const product of ['ofd','onec']){
      const pr=plan.products[product];if(!pr.loaded)continue;
      const channels=[...new Set(pr.rows.map(r=>r.channel))].filter(c=>c!==UNKNOWN).sort();
      for(const ch of channels){paramRow.set(product+'|'+ch,parameters.length+2);parameters.push([product==='ofd'?'ОФД':'Обмен с 1С',ch,'Средний чек на продлившегося клиента',V(num(p.checks[product][ch]),9),'₽ / клиент']);}
      for(const key of product==='ofd'?COHORTS:['Все клиенты']){
        const stat=pr.retro.stats.get(key),eff=effectiveProb(pr.retro.stats,key,p.manual[product]);
        probRow.set(product+'|'+key,parameters.length+2);
        parameters.push([product==='ofd'?'ОФД':'Обмен с 1С',key,eff.source,V(eff.value,eff.source.startsWith('Ручная')?3:5),'Доля клиентов']);
      }
    }
    const upsellParam=parameters.length+2;
    parameters.push(['ОФД','Тарифы менее 36 месяцев','Апсейл к доле суммы по кассам к продлению',V(p.upsell,3),'Доля суммы']);
    const rows=plan.rows.map((r,i)=>{
      const n=i+2,pr=probRow.get(r.product+'|'+r.cohort),cr=paramRow.get(r.product+'|'+r.channel);
      return [r.product==='ofd'?'ОФД':'Обмен с 1С',V(r.inn,7),r.org,r.cohort,r.channel,r.partner,V(r.anchor,6),r.month,r.product==='ofd'?r.kassas:null,r.dueUnits,
        pr?F("IF('Параметры'!D"+pr+'="","",\'Параметры\'!D'+pr+')',r.prob,5):null,
        cr?F("IF('Параметры'!D"+cr+'="","",\'Параметры\'!D'+cr+')',r.check,4):null,
        F('IF(OR(U'+n+'="",V'+n+'=""),"",U'+n+'+V'+n+')',r.amount,4),r.probSource,r.file,r.sheet,r.sourceRow,r.channelSource,
        r.product==='ofd'?r.eligibleUpsellUnits:0,V(r.upsellShare,5),
        F('IF(OR(K'+n+'="",L'+n+'=""),"",K'+n+'*L'+n+')',r.baseAmount,4),
        F('IF(U'+n+'="","",IF(\'Параметры\'!D'+upsellParam+'=0,0,IF(T'+n+'="","",U'+n+'*T'+n+'*\'Параметры\'!D'+upsellParam+')))',r.upsellAmount,4)];
    });
    const count=rows.length+1,range="'Клиенты'!";
    function sumFormula(col,predicate){return count<2?'0':'SUMIFS('+range+col+'$2:'+col+'$'+count+','+predicate+')';}
    function groupSheet(name,groups,column){return {sheetName:name,headers:[name==='По месяцам'?'Месяц':'Канал / когорта','Клиентов продукта','Ожидаемые клиенты','Рассчитанные деньги','Строк без полного расчёта'],rows:groups.map(g=>{
      const text=g.key.replace(/"/g,'""'),pred=range+column+'$2:'+column+'$'+count+',"'+text+'"';
      return [g.key,g.base,F(sumFormula('K',pred),g.expected),F(sumFormula('M',pred),g.money,4),g.missing];
    }),colWidths:[42,24,24,25,32]};}
    const retroRows=[];
    for(const product of ['ofd','onec']){
      const pr=plan.products[product];if(!pr.loaded)continue;
      for(const st of pr.retro.stats.values())retroRows.push([product==='ofd'?'ОФД':'Обмен с 1С',st.key,st.base,st.renewed,st.notRenewed,st.pending,V(st.rate,5)]);
    }
    const desc=[['Год плана',p.year],['Ретро',p.retroFrom+' — '+p.retroTo],['Срез на начало дня',p.asOf],['Средние чеки',p.vat==='with'?'С НДС':p.vat==='without'?'Без НДС':'Не отмечено'],['Формула','Клиенты × вероятность когорты × средний чек канала на одного продлившегося клиента'],['Кассы','На чек дополнительно не умножаются'],['Месяц','Первое окончание покрытия в плановом году, один годовой чек на ИНН в продукте'],['Канал ОФД','Канал покупки тарифа первого окончания. При неоднозначности требуется выбор'],['Канал 1С','Партнёр того же ИНН из ОФД, продукт и чеки отдельные'],['База','Известное покрытие на начало года; для будущего года — на дату среза. Уже продлённые за год плана кассы не включаются'],['Пустые значения','Не заданы. В суммах показана только рассчитанная часть'],['Статус при выгрузке',plan.complete?'Расчёт заполнен':'Расчёт не завершён'],...plan.warnings.map(w=>['Обратите внимание',w])];
    const extra=[];
    if(plan.exclusions){
      extra.push({sheetName:'Исключения',headers:['ИНН','Заводской номер ККТ','Организация','Дата окончания ОФД','Тариф, мес','Статус','РНМ при однозначном совпадении','Файл','Лист','Строка','Партнёр по ОФД','Канал по ОФД','Месяц окончания'],rows:plan.exclusions.report.map(r=>[V(r.inn,7),V(r.serial,7),r.org,V(r.end,6),r.months,r.status,V(r.unit||'',7),r.file,r.sheet,r.row,r.ofdPartner,r.channel,r.month]),colWidths:[18,24,40,23,18,65,30,35,25,12,42,28,22],textCols:[0,1,6]});
      extra.push({sheetName:'Сравнение',headers:['Показатель','Исходный прогноз','После исключений','Разница: исходный минус новый'],rows:[['Клиентов ОФД',plan.baseline.ofd?plan.baseline.ofd.base:null,plan.products.ofd.total?plan.products.ofd.total.base:null,plan.comparison.excludedClients],['Деньги рассчитанной части с апсейлом',V(plan.baseline.knownMoney?plan.baseline.money:null,4),V(plan.baseline.knownMoney?plan.money:null,4),V(plan.comparison.moneyDrop,4)],['Исключено касс ОФД',null,plan.comparison.excludedUnits,null]],colWidths:[55,25,25,36]});
    }
    if(plan.promo){const pr=plan.promo;extra.push({sheetName:'Промокоды',headers:['ИНН','Организация','Активация','Расчётное окончание','Тариф, мес','Результат','Партнёр по ОФД','Канал по ОФД','Файл','Лист','Строка'],rows:pr.report.map(r=>[V(r.inn,7),r.org,V(r.start,6),V(r.end,6),r.months,r.status,r.partner,r.channel,r.file,r.sheet,r.row]),colWidths:[18,40,22,26,18,50,42,28,42,25,12],textCols:[0]});extra.push({sheetName:'Сверка промокодов',headers:['Показатель','Без промокодов','С промокодами'],rows:[['Клиентов ретро',pr.beforeStats?pr.beforeStats.base:null,pr.afterStats.base],['Продлились',pr.beforeStats?pr.beforeStats.renewed:null,pr.afterStats.renewed],['Процент продления',V(pr.beforeStats?pr.beforeStats.rate:null,5),V(pr.afterStats.rate,5)],['Клиентов плана',pr.beforeClients,pr.afterClients],['Активированных промокодов',null,pr.activated],['Промокодов с окончанием в плановом году',null,pr.expiringCodes],['ИНН этих промокодов',null,pr.expiringClients],['Из них ИНН в общем плане',null,pr.clientsInPlan]],colWidths:[55,25,25]});}
    desc.push(['Апсейл','К сумме ОФД пропорционально числу касс к продлению с тарифом менее 36 месяцев; 1С не затрагивает'],['Исключения','Только однозначное совпадение ИНН + даты окончания + тарифа. Заводской номер не приравнивается к РНМ. Когорты и ретро сохраняются']);
    return {sheets:[
      {sheetName:'Описание',headers:['Параметр','Значение'],rows:desc,colWidths:[32,110]},
      {sheetName:'Параметры',headers:['Продукт','Канал / когорта','Показатель / источник','Значение','Единица'],rows:parameters,colWidths:[24,42,55,24,22]},
      {sheetName:'Клиенты',headers:['Продукт','ИНН','Организация','Когорта','Канал','Партнёр','Первое окончание','Месяц','Действующих касс до исключений','Касс / покрытий к продлению','Вероятность','Чек клиента','Сумма с апсейлом','Источник вероятности','Файл','Лист','Строка','Источник канала','Касс с тарифом менее 36 мес','Доля для апсейла','Продления без апсейла','Прибавка за апсейл'],rows,colWidths:[22,18,42,34,29,45,20,16,29,20,18,20,23,45,42,25,12,30,28,22,25,24],textCols:[1]},
      groupSheet('По месяцам',aggregate(plan.rows,r=>r.month),'H'),
      groupSheet('По каналам',aggregate(plan.rows,r=>r.channel),'E'),
      groupSheet('По когортам',aggregate(plan.rows,r=>r.cohort),'D'),
      {sheetName:'Ретро',headers:['Продукт','Когорта','Клиентов','Продлились','Не продлились','Не завершены','Вероятность'],rows:retroRows,colWidths:[24,38,20,20,23,22,20]},
      {sheetName:'Проверки',headers:['Проверка','Значение'],rows:[['Уникальность ИНН в каждом продукте',new Set(plan.rows.map(r=>r.product+'|'+r.inn)).size===plan.rows.length?'Да':'Ошибка'],['Строк клиентов продуктов',plan.rows.length],['Уникальных ИНН двух продуктов',plan.uniqueClients],['Строк без вероятности',F(rows.length?"COUNTBLANK('Клиенты'!K2:K"+count+')':'0',plan.rows.filter(r=>r.prob==null).length)],['Строк без чека',F(rows.length?"COUNTBLANK('Клиенты'!L2:L"+count+')':'0',plan.rows.filter(r=>r.check==null).length)],['Строк без канала',plan.rows.filter(r=>r.channel===UNKNOWN).length],['Деньги рассчитанной части',F(rows.length?"SUM('Клиенты'!M2:M"+count+')':'0',plan.money,4)]],colWidths:[62,28]},...extra
    ]};
  }
  const api={DAY,EPOCH,UNKNOWN,CHANNELS,AGES,COHORTS,EXCLUSION_HEADERS,PROMO_HEADERS,num,day,date,iso,displayDate,inn,age,classify,addMonths,parsePromos,mergePromos,buildWithPromos,filterExclusions,parseWorkbook,parseExclusions,matchExclusions,ledger,metadata,features,outcome,retro,candidates,defaults,normalizeParams,effectiveProb,build,aggregate,workbook};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Planning2=api;
})(typeof window!=='undefined'?window:globalThis);
