(function(root){
  'use strict';
  const P=root.Planning2,V=root.Planning3;
  const KEY='ofd.planning3.v1';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const num=(value,d=0)=>value==null?'—':value.toLocaleString('ru-RU',{maximumFractionDigits:d});
  const pct=value=>value==null?'—':num(value*100,2)+'%';
  const rub=value=>value==null?'—':num(value,2)+' ₽';
  const table=(headers,rows)=>'<div class="scroll"><table><thead><tr>'+headers.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  let saved={};
  try{saved=JSON.parse(localStorage.getItem(KEY))||{};}catch{}
  let inactive=null,cached=null;
  const views=new Map();
  const fields=[
    ['partner','Чек Партнёры, ₽/ИНН',354],['agents','Чек Пенигина — ОП, ₽/ИНН',381],
    ['atolRate','Атол, продление %',55,100],['atolCheck','Чек Атол, ₽/ИНН',60],
    ['checksMoney','1С Чеки ОФД · поступления 2027, ₽',1371000],['checksQty','1С Чеки ОФД · штук'],
    ['integratorBase','Интеграторы · ориентир 2027, ₽',14700000],
    ['integratorRenew','Интеграторы · продления, ₽'],['integratorConnect','Интеграторы · подключения, ₽'],
    ['kktActual','Услуги ККТ · факт 2026, ₽'],['kktPlan','Услуги ККТ · план 2027, ₽']
  ];
  function parseNumber(value,max){
    const n=P.num(value);
    return n!=null&&n>=0&&(max==null||n<=max)?n:null;
  }
  function assumptions(){
    const result={};
    for(const [key,,initial,max] of fields)result[key]=parseNumber(saved[key]??initial,max);
    result.atolRate=result.atolRate==null?null:result.atolRate/100;
    result.checks={'Партнёры':result.partner,'Пенигина — ОП':result.agents};
    return result;
  }
  function save(key,value){
    saved[key]=value;
    try{localStorage.setItem(KEY,JSON.stringify(saved));}catch{}
  }

  function data(){
    const ofd=root.OFDState?.planning2Data?.ledger||null;
    const onec=root.OFDWidgets.ofd1cGetState()?.planning2Data?.ledger||null;
    const promos=root.OFDPlanning2.promoData;
    const p=P.defaults();
    const latest=[ofd?.maxStart,onec?.maxStart].filter(Number.isFinite);
    if(!latest.length&&promos?.records.length)latest.push(promos.records.reduce((max,r)=>Math.max(max,r.start),-Infinity));
    const asOf=latest.length?P.iso(Math.floor(Math.max(...latest))+1):'';
    const params={...p,year:Number(saved.year??p.year),asOf:saved.asOf||asOf,retroFrom:saved.retroFrom??p.retroFrom,retroTo:saved.retroTo??p.retroTo};
    if(!ofd&&!onec&&!promos)return {params,ofd,onec,plan:null};
    const key=JSON.stringify(params);
    if(!cached||cached.key!==key||cached.ofd!==ofd||cached.onec!==onec||cached.promos!==promos||cached.inactive!==inactive){
      cached={key,ofd,onec,promos,inactive,plan:V.build(ofd,onec,promos,inactive,params)};
    }
    return {params,ofd,onec,plan:cached.plan};
  }

  function render(view){
    const {box,month,product,cohort,order,online,out,actions,status}=view;
    let model;
    actions.disabled=true;
    view.rows=[];
    try{model=data();}catch(error){out.textContent=error.message;return;}
    const {params,ofd,onec,plan}=model;
    for(const key of ['year','asOf','retroFrom','retroTo'])box.querySelector('[data-param="'+key+'"]').value=params[key];
    const a=assumptions();
    const summary=plan&&ofd?V.summarize(plan,a).map(r=>[
      'Коды ОФД · '+r.name,num(r.base),num(r.expected,2)+(r.missingRate?' · без процента: '+num(r.missingRate):''),
      r.name==='Собственный'?'Обогащение в 1С':rub(r.money)
    ]):[['Коды ОФД','Загрузите выгрузку ОФД','—','—']];
    const oneBase=plan?.oneLoaded?plan.oneRows.length:null;
    summary.push(['Обмен с 1С',num(oneBase),oneBase==null||plan.oneRate==null?'—':num(oneBase*plan.oneRate,2)+' · '+pct(plan.oneRate),'Обогащение в 1С']);
    summary.push(['1С Чеки ОФД',num(a.checksQty),'Подключения по данным 1С',rub(a.checksMoney)+' · ориентир']);
    summary.push(['Интеграторы','—','Продления '+rub(a.integratorRenew)+' · подключения '+rub(a.integratorConnect),
      a.integratorRenew==null||a.integratorConnect==null?rub(a.integratorBase)+' · ориентир':rub(a.integratorRenew+a.integratorConnect)]);
    summary.push(['Услуги ККТ','—','Факт 2026: '+rub(a.kktActual),rub(a.kktPlan)+' · отдельная строка']);
    let html=ofd&&plan?'<h3>Коды ОФД: '+num(plan.rows.length)+' ИНН к продлению за год</h3>':'';
    html+=table(['Направление','База, ИНН / шт.','Ожидаемые продления / вводные','Поступления'],summary);
    if(!plan){out.innerHTML=html;return;}

    const salesCohorts=plan.sales?.cohorts.filter(c=>c.family==='own')||[];
    if(salesCohorts.length){
      html+='<details><summary>Годовой прогноз собственного канала по когортам</summary>'+
        table(['Когорта','ИНН к продлению','ИНН в ретро','Продлились в ретро','Ретро','Прогноз, ИНН'],
          salesCohorts.map(c=>[c.label,num(c.base),num(c.retro.base),num(c.retro.renewed),pct(c.retro.rate),num(c.expected,2)]))+'</details>';
    }
    const isOne=product.value==='onec';
    const details=isOne?plan.oneDetails:plan.ofdDetails;
    const rate=isOne?plan.oneUnitRate:plan.ofdUnitRate;
    const prior=cohort.value;
    const labels=!isOne?[...new Set(details.map(r=>r.cohort))].sort():[];
    cohort.innerHTML='<option value="">Все когорты</option>'+labels.map(v=>'<option>'+esc(v)+'</option>').join('');
    cohort.value=labels.includes(prior)?prior:'';
    cohort.disabled=isOne;
    order.disabled=isOne;
    online.disabled=isOne;
    const counts=Array.from({length:12},()=>0);
    for(const row of details)counts[Number(row.month.slice(5,7))-1]++;
    html+='<h3>Кассы по месяцам окончания · '+(isOne?'Обмен с 1С':'собственный канал')+'</h3>'+
      '<p class="tiny">Ретро по продлениям покрытий той же кассы: '+pct(rate)+'. '+
      (isOne?(onec?'Помесячно показаны покрытия с номером ККТ. Без связи с кассой: '+num(plan.oneMissing)+'.':'Загрузите сверку 1С для расчёта по кассам.') :
        (plan.match?'Исключено по загруженному списку во всей базе: '+num(plan.match.excluded.size)+'.':'Загрузите список неактивных, чтобы подтвердить состав активной базы.'))+'</p>'+
      table(isOne?['Месяц','Касс к продлению','Ожидаем продлить касс']:
        ['Месяц','Собственные кассы к продлению','Ожидаем продлить собственных','Партнёрские кассы','Кассы Атола','Кассы без канала'],
        counts.map((count,index)=>{
          const loaded=isOne?!!onec:!!ofd;
          const row=[params.year+'-'+String(index+1).padStart(2,'0'),loaded?num(count):'—',rate==null?'—':num(count*rate,2)];
          const other=plan.otherMonths[index];
          return isOne?row:row.concat(loaded?[num(other.partner),num(other.atol),num(other.unknown)]:['—','—','—']);
        }));
    if(!isOne&&ofd)html+='<p class="tiny">Колонки Партнёры и Атол показывают окончания касс. Ставки в годовой сводке применяются к ИНН.</p>';
    if(isOne&&!onec||!isOne&&!ofd){out.innerHTML=html;return;}
    const selected=month.value?params.year+'-'+month.value:String(params.year);
    const rows=details.filter(r=>(!month.value||r.month===selected)&&(isOne||((!cohort.value||r.cohort===cohort.value)&&(!online.checked||r.online))));
    const groups=new Map();
    for(const row of rows){
      if(!groups.has(row.inn))groups.set(row.inn,[]);
      groups.get(row.inn).push(row);
    }
    const grouped=[...groups.values()];
    if(!isOne&&order.value!=='date'){
      grouped.sort((a,b)=>a[0].prob==null?(b[0].prob==null?0:1):b[0].prob==null?-1:(a[0].prob-b[0].prob)*(order.value==='low'?1:-1));
    }
    view.rows=grouped.flat();
    actions.disabled=!view.rows.length||(!isOne&&!plan.match);
    if(!isOne&&plan.match){
      const unmatched=plan.match.report.filter(r=>r.status!=='Исключено'&&r.status!=='Совпало, вне планового года').length;
      if(unmatched)html+='<p class="tiny">Строк списка без надёжного совпадения: '+num(unmatched)+'. Они не исключены.</p>';
    }
    view.year=params.year;
    view.oneRate=plan.oneRate;
    html+='<h3>Список за '+esc(selected)+'</h3><p class="tiny">Касс: '+num(rows.length)+' · прогноз: '+num(rate==null?null:rows.length*rate,2)+
      (!isOne&&!plan.match?' · для выгрузки загрузите список неактивных.':'')+'</p>'+
      table(['ИНН','Организация','Касса','Подключена','Окончание','Тариф, мес.','Когорта / ретро ИНН','Активность','Онлайн'],
        view.rows.slice(0,100).map(r=>[r.inn,r.org,r.unit,P.displayDate(r.connected),P.displayDate(r.end),num(r.tariff),
        isOne?pct(plan.oneRate):r.cohort+' · '+pct(r.prob),isOne?'—':r.partial?'ИНН частично активен':r.activity,isOne?'—':r.online?'Да':'Нет']));
    if(rows.length>100)html+='<p class="tiny">На экране первые 100 касс. В Excel попадут все строки выборки.</p>';
    out.innerHTML=html;
  }
  function refresh(){for(const v of views.values())render(v);}
  root.addEventListener('planning2-promos-change',refresh);

  root.OFDWidgets.WIDGETS['pl3-summary']={
    title:'Планирование 3.0',type:'таблица',scope:'план',span:true,defaultH:15,
    render(model,ctx,id){
      const box=document.createElement('div');
      box.className='planning2 p2-integrated';
      const p=P.defaults();
      box.innerHTML='<p class="tiny">Использует общие загрузки ОФД и Обмена с 1С. Годовой план считается по уникальным ИНН; помесячная карта — по кассам.</p>'+
        '<div class="controls"><label>Год<input type="number" min="2000" max="2100" data-param="year" value="'+esc(saved.year??p.year)+'"></label>'+
        ['asOf','retroFrom','retroTo'].map((key,i)=>'<label>'+['Срез на начало дня','Начало ретро','Конец ретро'][i]+'<input type="date" data-param="'+key+'" value="'+esc(saved[key]??p[key])+'"></label>').join('')+'</div>'+
        '<details><summary>Средние чеки и вводные по остальным направлениям</summary>'+
        '<p class="tiny">Начальные чеки — из 2.0; ставки Атола и денежные ориентиры — из контракта. Партнёры: 60%. ККТ указывается отдельно после сверки с финансами.</p><div class="controls">'+
        fields.map(([key,label,initial,max])=>'<label>'+esc(label)+'<input type="number" min="0" step="'+(key==='checksQty'?'1':'0.01')+'" '+(max?'max="'+max+'"':'')+' data-assumption="'+key+'" value="'+esc(saved[key]??initial)+'"></label>').join('')+'</div></details>'+
        '<div class="controls"><label>Неактивные кассы ОФД<input type="file" data-file accept=".xlsx,.xls"></label><button type="button" class="btn" data-clear>Снять список</button></div>'+
        '<div class="controls"><label>Продукт списка<select data-product><option value="ofd">Коды ОФД</option><option value="onec">Обмен с 1С</option></select></label>'+
        '<label>Месяц выгрузки<select data-month><option value="">Весь год</option>'+Array.from({length:12},(_,i)=>{const m=String(i+1).padStart(2,'0');return '<option>'+m+'</option>';}).join('')+'</select></label>'+
        '<label>Когорта<select data-cohort></select></label><label>Порядок<select data-order><option value="date">По дате окончания</option><option value="low">Сначала низкий %</option><option value="high">Сначала высокий %</option></select></label>'+
        '<label><input type="checkbox" data-online> Только онлайн</label><button class="btn" type="button" data-export disabled>Выгрузить список в Excel</button></div>'+
        '<p data-status role="status" class="tiny"></p><div data-output></div>';
      const get=k=>box.querySelector('[data-'+k+']');
      const view={box,month:get('month'),product:get('product'),cohort:get('cohort'),order:get('order'),online:get('online'),out:get('output'),actions:get('export'),status:get('status')};
      const previous=views.get(id);
      if(previous){
        for(const key of ['month','product','order'])view[key].value=previous[key].value;
        view.online.checked=previous.online.checked;
      }
      views.set(id,view);
      box.addEventListener('change',event=>{
        const input=event.target;
        if(input.dataset.param){save(input.dataset.param,input.value);refresh();}
        else if(input.dataset.assumption){if(input.reportValidity()){save(input.dataset.assumption,input.value);refresh();}}
        else if([view.month,view.product,view.cohort,view.order,view.online].includes(input))render(view);
      });
      get('file').addEventListener('change',async event=>{
        const input=event.target,file=input.files[0];
        if(!file)return;
        input.disabled=true;
        try{
          const bytes=await file.arrayBuffer();
          inactive=P.parseExclusions(root.XLSX,root.XLSX.read(bytes,{type:'array',dense:true}),file.name);
          refresh();
          view.status.textContent='Загружен список: '+file.name+' · строк: '+inactive.sourceRows;
        }catch(error){view.status.textContent=error.message;}
        finally{input.disabled=false;input.value='';}
      });
      get('clear').addEventListener('click',()=>{inactive=null;view.status.textContent='Список снят.';refresh();});
      view.actions.addEventListener('click',()=>{
        const isOne=view.product.value==='onec';
        const headers=['ИНН','Организация','Касса','Первое подключение кассы','Начало тарифа','Окончание тарифа','Тариф, мес.','Когорта','Ретро ИНН, %','Статус активности','Частично активен','Онлайн'];
        const rows=view.rows.map(r=>[r.inn,r.org,r.unit,P.displayDate(r.connected),P.displayDate(r.start),P.displayDate(r.end),r.tariff,
          isOne?'':r.cohort,(isOne?view.oneRate:r.prob)==null?'':(isOne?view.oneRate:r.prob)*100,isOne?'':r.activity,isOne?'':r.partial?'Да':'Нет',isOne?'':r.online?'Да':'Нет']);
        try{root.OFDExport.downloadXlsx('Планирование_3_'+view.year+(view.month.value?'-'+view.month.value:'')+'_'+view.product.value,{sheets:[{sheetName:'Кассы',headers,rows}]});}
        catch(error){view.status.textContent=error.message;}
      });
      render(view);
      if(previous?.cohort.value){view.cohort.value=previous.cohort.value;render(view);}
      return box;
    },
    onRemove(id){views.delete(id);}
  };
  root.OFDPlanning3={refresh};
})(window);
