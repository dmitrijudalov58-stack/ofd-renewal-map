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
      c.records.push(r);if(!c.units.has(r.unit))c.units.set(r.unit,[]);c.units.get(r.unit).push(r);
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
  function outcome(list,r,cut){
    let next=null;
    for(const n of list)if(n.start>r.start&&n.end>r.end&&(next==null||n.start<next))next=n.start;
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
        events.push({...r,...outcome(list,r,cut)});
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
        const choices=known.filter(r=>r.end===end),r=choices[choices.length-1];
        endings.push({...r,end});
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
        dueUnits:endings.length,tariffs:[...new Set(first.map(r=>r.months).filter(v=>v!=null))].join(', '),
        file:first[0].file,sheet:first[0].sheet,sourceRow:first[0].row,snapshot});
    }
    return rows.sort((a,b)=>a.anchor-b.anchor||a.inn.localeCompare(b.inn));
  }
  function defaults(){return {year:2027,retroFrom:'2025-01-01',retroTo:'2025-12-31',asOf:'',vat:'',checks:{ofd:{},onec:{}},manual:{ofd:{},onec:{}},channels:{}};}
  function normalizeParams(raw){
    const d=defaults();if(!raw||typeof raw!=='object')return d;
    const year=+raw.year;if(Number.isInteger(year)&&year>=2000&&year<=2100)d.year=year;
    for(const k of ['retroFrom','retroTo','asOf'])if(date(raw[k])!=null)d[k]=raw[k];
    if(['with','without'].includes(raw.vat))d.vat=raw.vat;
    for(const k of ['checks','manual'])for(const p of ['ofd','onec'])if(raw[k]&&raw[k][p]&&typeof raw[k][p]==='object')d[k][p]={...raw[k][p]};
    if(raw.channels&&typeof raw.channels==='object')d.channels={...raw.channels};return d;
  }
  const cache=new WeakMap();
  function effectiveProb(stats,key,manual){
    const m=manual&&manual[key];
    if(m&&num(m.value)!=null&&num(m.value)>=0&&num(m.value)<=1&&clean(m.reason))return {value:num(m.value),source:'Ручная: '+clean(m.reason)};
    const s=stats.get(key);return {value:s?s.rate:null,source:s&&s.rate!=null?'Ретро':'Нет завершённых данных'};
  }
  function build(ofd,onec,params){
    if(params&&['retroFrom','retroTo','asOf'].some(k=>own(params,k)&&date(params[k])==null))throw new Error('Заполните период ретро и дату среза.');
    const p=normalizeParams(params),cut=date(p.asOf),from=date(p.retroFrom),to=date(p.retroTo);
    if(cut==null||from==null||to==null||from>to)throw new Error('Проверьте дату среза и период ретро.');
    const result={params:p,cut,from,to,products:{},warnings:[],channels:[],rows:[]};
    for(const product of ['ofd','onec']){
      const led=product==='ofd'?ofd:onec;
      if(!led){result.products[product]={loaded:false,rows:[],retro:null};continue;}
      const key=[product,from,to,cut,p.year].join('|');let analysis=cache.get(led);
      if(!analysis||analysis.key!==key||analysis.ofd!==ofd){analysis={key,ofd,rt:retro(led,product,from,to,cut),rows:candidates(led,ofd||ledger([]),product,p.year,cut)};cache.set(led,analysis);}
      const rt=analysis.rt,rows=analysis.rows.map(r=>({...r}));
      for(const row of rows){
        const override=p.channels[row.id];if(CHANNELS.includes(override)){row.channel=override;row.channelSource='Ручной выбор';}
        const prob=effectiveProb(rt.stats,row.cohort,p.manual[product]);
        row.prob=prob.value;row.probSource=prob.source;
        row.check=row.channel===UNKNOWN?null:num(p.checks[product][row.channel]);
        if(row.check!=null&&row.check<0)row.check=null;
        row.expected=row.prob==null?null:row.prob;
        row.amount=row.prob==null||row.check==null?null:row.prob*row.check;
      }
      const total={base:rows.length,expected:0,money:0,missingProb:0,missingCheck:0,missingChannel:0};
      for(const r of rows){if(r.expected==null)total.missingProb++;else total.expected+=r.expected;if(r.amount!=null)total.money+=r.amount;if(r.check==null)total.missingCheck++;if(r.channel===UNKNOWN)total.missingChannel++;}
      total.complete=total.missingProb===0&&total.missingCheck===0&&total.missingChannel===0;
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
    return result;
  }
  function aggregate(rows,keyfn){
    const map=new Map();
    for(const r of rows){const key=keyfn(r);let s=map.get(key);if(!s){s={key,base:0,expected:0,money:0,missing:0};map.set(key,s);}s.base++;if(r.expected==null||r.amount==null)s.missing++;if(r.expected!=null)s.expected+=r.expected;if(r.amount!=null)s.money+=r.amount;}
    return [...map.values()].sort((a,b)=>a.key.localeCompare(b.key));
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
    const rows=plan.rows.map((r,i)=>{
      const n=i+2,pr=probRow.get(r.product+'|'+r.cohort),cr=paramRow.get(r.product+'|'+r.channel);
      return [r.product==='ofd'?'ОФД':'Обмен с 1С',V(r.inn,7),r.org,r.cohort,r.channel,r.partner,V(r.anchor,6),r.month,r.kassas,r.dueUnits,
        pr?F("IF('Параметры'!D"+pr+'="","",\'Параметры\'!D'+pr+')',r.prob,5):null,
        cr?F("IF('Параметры'!D"+cr+'="","",\'Параметры\'!D'+cr+')',r.check,4):null,
        F('IF(OR(K'+n+'="",L'+n+'=""),"",K'+n+'*L'+n+')',r.amount,4),r.probSource,r.file,r.sheet,r.sourceRow,r.channelSource];
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
    return {sheets:[
      {sheetName:'Описание',headers:['Параметр','Значение'],rows:desc,colWidths:[32,110]},
      {sheetName:'Параметры',headers:['Продукт','Канал / когорта','Показатель / источник','Значение','Единица'],rows:parameters,colWidths:[24,42,55,24,22]},
      {sheetName:'Клиенты',headers:['Продукт','ИНН','Организация','Когорта','Канал','Партнёр','Первое окончание','Месяц','Действующих касс','Касс к продлению','Вероятность','Чек клиента','Ожидаемая сумма','Источник вероятности','Файл','Лист','Строка','Источник канала'],rows,colWidths:[22,18,42,34,29,45,20,16,20,20,18,20,23,45,42,25,12,30],textCols:[1]},
      groupSheet('По месяцам',aggregate(plan.rows,r=>r.month),'H'),
      groupSheet('По каналам',aggregate(plan.rows,r=>r.channel),'E'),
      groupSheet('По когортам',aggregate(plan.rows,r=>r.cohort),'D'),
      {sheetName:'Ретро',headers:['Продукт','Когорта','Клиентов','Продлились','Не продлились','Не завершены','Вероятность'],rows:retroRows,colWidths:[24,38,20,20,23,22,20]},
      {sheetName:'Проверки',headers:['Проверка','Значение'],rows:[['Уникальность ИНН в каждом продукте',new Set(plan.rows.map(r=>r.product+'|'+r.inn)).size===plan.rows.length?'Да':'Ошибка'],['Строк клиентов продуктов',plan.rows.length],['Уникальных ИНН двух продуктов',plan.uniqueClients],['Строк без вероятности',F(rows.length?"COUNTBLANK('Клиенты'!K2:K"+count+')':'0',plan.rows.filter(r=>r.prob==null).length)],['Строк без чека',F(rows.length?"COUNTBLANK('Клиенты'!L2:L"+count+')':'0',plan.rows.filter(r=>r.check==null).length)],['Строк без канала',plan.rows.filter(r=>r.channel===UNKNOWN).length],['Деньги рассчитанной части',F(rows.length?"SUM('Клиенты'!M2:M"+count+')':'0',plan.money,4)]],colWidths:[62,28]}
    ]};
  }
  const api={DAY,EPOCH,UNKNOWN,CHANNELS,AGES,COHORTS,num,day,date,iso,displayDate,inn,age,classify,parseWorkbook,ledger,metadata,features,outcome,retro,candidates,defaults,normalizeParams,effectiveProb,build,aggregate,workbook};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Planning2=api;
})(typeof window!=='undefined'?window:globalThis);
