(function(root){
 'use strict';
 const P=root.Planning2,R=root.Planning2Retro,states=new Map(),cache=new Map(),f=n=>n==null?'—':n.toLocaleString('ru-RU'),pct=n=>n==null?'—':(n*100).toFixed(2).replace('.',',')+'%',esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function options(items,value){return items.map(([v,t])=>'<option value="'+esc(v)+'"'+(v===value?' selected':'')+'>'+esc(t)+'</option>').join('');}
 function card(label,value){return '<div class="card stat"><span class="tiny">'+label+'</span><strong>'+value+'</strong></div>';}
 root.OFDWidgets.WIDGETS['pl2-retrospective']={title:'Ретро: продления, новые клиенты и апсейл',type:'таблица',scope:'ретро',span:true,defaultH:15,
  render:function(model,ctx,id){
   if(root.OFDPlanning2.instances.has(id))root.OFDPlanning2.instances.get(id).destroy();
   const now=ctx&&ctx.asOf||new Date(),defaultDate=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
   const state=states.get(id)||{product:'ofd',year:2025,asOf:defaultDate,renew:{mode:'channel',channels:null,partner:''},fresh:{mode:'channel',channels:null,partner:''},page:0};states.set(id,state);
   const box=document.createElement('div');box.className='planning2 p2-retrospective';
   box.innerHTML='<div class="controls"><label>Продукт<select data-field="product">'+options([['ofd','Коды ОФД'],['onec','Обмен с 1С + промокоды']],state.product)+'</select></label><label>Год<input data-field="year" type="number" min="2000" max="2100" value="'+state.year+'"></label><label>Данные включительно по<input data-field="asOf" type="date" value="'+esc(state.asOf)+'"></label></div><p class="tiny">Один ИНН за год. Продление — хотя бы одна касса в пределах 30 дней, включая досрочное. Текущий список касс без чеков на ретро не влияет.</p><div data-results role="status"></div>';
   const results=box.querySelector('[data-results]');let current=null,selectedRenew=[],selectedNew=[],notices='';
   function filters(key,data){
    const s=state[key],partners=data.partners;
    return '<div class="controls p2-retro-filters" data-filter="'+key+'"><label>Срез<select data-mode>'+options([['channel','Каналы продаж'],['partner','Конкретный партнёр']],s.mode)+'</select></label>'+(s.mode==='channel'?'<div><label><input type="checkbox" data-all'+(s.channels==null?' checked':'')+'> Все каналы — вся база</label><div class="p2-retro-channels">'+data.channels.map(c=>'<label><input type="checkbox" data-channel="'+esc(c)+'"'+(s.channels==null||s.channels.includes(c)?' checked':'')+'> '+esc(c)+'</label>').join('')+'</div></div>':'<div class="p2-partner-search"><label>Поиск по названию или ИНН<input type="search" data-partner-search autocomplete="off" placeholder="Например: ЛК, OFD, Атолл" value="'+esc(s.query||'')+'"></label><div data-partner-suggestions hidden></div></div><label>Партнёр<select data-partner>'+options([['','Выберите партнёра'],...partners.map(p=>[p.key,p.label])],s.partner)+'</select></label>')+'</div>';
   }
   function bindFilters(data){
    results.querySelectorAll('[data-filter]').forEach(el=>{
     const key=el.dataset.filter,s=state[key];
     el.querySelector('[data-mode]').onchange=e=>{s.mode=e.target.value;state.page=0;drawData(data);};
     const all=el.querySelector('[data-all]');if(all)all.onchange=e=>{s.channels=e.target.checked?null:[];state.page=0;drawData(data);};
     el.querySelectorAll('[data-channel]').forEach(c=>c.onchange=()=>{s.channels=[...el.querySelectorAll('[data-channel]:checked')].map(x=>x.dataset.channel);if(s.channels.length===data.channels.length)s.channels=null;state.page=0;drawData(data);});
     const input=el.querySelector('[data-partner-search]'),select=el.querySelector('[data-partner]');
     if(!input)return;
     const suggestions=el.querySelector('[data-partner-suggestions]'),search=el.querySelector('.p2-partner-search');
     function choose(partner){s.partner=partner.key;s.query=partner.label;state.page=0;drawData(data);}
     function suggest(){
      s.query=input.value;const matches=R.findPartners(data.partners,s.query),shown=matches.slice(0,20),selected=data.partners.find(p=>p.key===s.partner);
      const listed=selected&&!matches.some(p=>p.key===selected.key)?[selected,...matches]:matches;
      select.innerHTML=options([['','Выберите партнёра'],...listed.map(p=>[p.key,p.label])],s.partner);
      suggestions.hidden=false;
      suggestions.innerHTML='<p class="tiny" role="status">'+(matches.length?'Найдено: '+f(matches.length)+(matches.length>20?' · показаны первые 20, уточните запрос':'')+'. Выберите партнёра, чтобы применить фильтр.':'Ничего не найдено в загруженных данных. Попробуйте часть названия или ИНН.')+'</p><div class="p2-partner-options" role="group" aria-label="Найденные партнёры">'+shown.map(p=>'<button type="button" data-partner-key="'+esc(p.key)+'">'+esc(p.label)+'</button>').join('')+'</div>';
      suggestions.querySelectorAll('[data-partner-key]').forEach(b=>{
       b.onmousedown=e=>e.preventDefault();
       b.onclick=()=>choose(shown.find(p=>p.key===b.dataset.partnerKey));
       b.onkeydown=e=>{const buttons=[...suggestions.querySelectorAll('button')],i=buttons.indexOf(b);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}if(e.key==='Escape'){input.focus();suggestions.hidden=true;}};
      });
     }
     select.onchange=e=>{const p=data.partners.find(p=>p.key===e.target.value);s.partner=e.target.value;s.query=p?p.label:'';state.page=0;drawData(data);};
     input.oninput=input.onfocus=suggest;
     input.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();suggestions.hidden=true;return;}if(e.key==='ArrowDown'||e.key==='Enter'){e.preventDefault();if(suggestions.hidden)suggest();const first=suggestions.querySelector('button');if(first)first.focus();}};
     search.onfocusout=e=>{if(!search.contains(e.relatedTarget))suggestions.hidden=true;};
    });
   }
   function table(headers,rows){return '<div class="table-scroll"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
   function drawData(data){
    current=data;selectedRenew=R.select(data.rows,state.renew);selectedNew=R.select(data.newRows,state.fresh);const s=R.summarize(selectedRenew),ofd=state.product==='ofd';
    const transitionGroups=new Map();for(const t of s.transitions){const k=t.from+' → '+t.to+' мес';if(!transitionGroups.has(k))transitionGroups.set(k,new Set());transitionGroups.get(k).add(t.inn+'|'+t.unit);}
    const pages=Math.max(1,Math.ceil(s.transitions.length/100));state.page=Math.min(state.page,pages-1);
    results.innerHTML=notices+'<h3>Продления · '+state.year+'</h3>'+filters('renew',data)+'<div class="cards" data-renew-summary>'+card('Годовая база',f(s.due))+card('Уже продлились',f(s.actual))+card('Не продлились',f(s.lost))+card('Ожидают исхода',f(s.pending))+card('Продление по завершённым',pct(s.rate))+'</div><p class="tiny">Для процента завершено '+f(s.closed)+' клиентов, из них продлились '+f(s.closedRenewed)+'. Ещё '+f(s.early)+' уже продлились, но их годовое окно пока не завершено. «Все каналы» включает неопределённые и неоднозначные назначения; при выборе нескольких каналов ИНН не повторяется.</p><h3>Новые клиенты · '+state.year+'</h3>'+filters('fresh',data)+'<div class="cards" data-new-summary>'+card('Новых ИНН',f(selectedNew.length))+'</div><p class="tiny">Первое наблюдаемое подключение за всю загруженную историю. Переход к другому партнёру не считается новым клиентом. Неполная история может завысить число новых.</p><h3>Апсейл · выбранный срез продлений</h3>'+(ofd?'<div class="cards" data-upsell-summary>'+card('Клиентов с апсейлом',f(s.upsellClients))+card('От продлившихся клиентов',pct(s.upsellRate))+card('Касс с апсейлом / продлённых',f(s.upsellRegisters)+' / '+f(s.renewedRegisters))+'</div><p class="tiny">Апсейл — переход на больший срок тарифа, а не подтверждённое увеличение цены покупки. Один клиент и одна касса считаются один раз; ниже перечислены все переходы. Событий с неизвестным или неоднозначным сроком: '+f(s.unknownTariffs)+'. Номер кассы ОФД — РНМ; заводского номера в этой выгрузке нет.</p>'+table(['Переход','Уникальных касс'],[...transitionGroups].map(([k,v])=>[k,v.size]))+'<details data-transitions><summary>Какие кассы перешли · '+f(s.transitions.length)+' переходов</summary>'+table(['ИНН','Клиент','РНМ','Было, мес','Стало, мес','Окончание','Активация продления','Партнёр'],s.transitions.slice(state.page*100,(state.page+1)*100).map(t=>[t.inn,t.org,t.unit,t.from,t.to,P.displayDate(t.end),P.displayDate(t.start),t.partner]))+'<div class="controls"><button data-prev '+(!state.page?'disabled':'')+'>Назад</button><span>Страница '+(state.page+1)+' / '+pages+'</span><button data-next '+(state.page===pages-1?'disabled':'')+'>Далее</button></div></details>':'<p class="tiny">Апсейл по кассам показывается для кодов ОФД. Промокоды Обмена не содержат номера кассы, поэтому достоверный переход конкретной кассы определить нельзя.</p>')+'<p class="tiny">Канал и партнёр продления — при первом окончании в году; нового клиента — при первом подключении. Для Обмена привязка по ИНН к ОФД: первое окончание в выбранном году, иначе последнее известное подключение на дату среза. При неоднозначности клиент доступен в каждом связанном срезе, но в объединении считается один раз. Объединение источников Обмена выполняется по действующим правилам промокодов.</p><button class="btn" data-retro-export>Выгрузить текущие срезы в Excel</button>';
    bindFilters(data);
    for(const [name,step]of [['prev',-1],['next',1]]){const b=results.querySelector('[data-'+name+']');if(b)b.onclick=()=>{state.page+=step;drawData(data);results.querySelector('[data-transitions]').open=true;};}
    results.querySelector('[data-retro-export]').onclick=exportCurrent;
   }
   function exportCurrent(){
    if(!current)return;const describe=q=>q.mode==='partner'?(current.partners.find(p=>p.key===q.partner)?.label||'Партнёр не выбран'):q.channels==null?'Все каналы — вся база':q.channels.join('; ')||'Ни одного канала';const s=R.summarize(selectedRenew),description=[['Год',state.year],['Продукт',state.product==='ofd'?'Коды ОФД':'Обмен с 1С + промокоды'],['Данные включительно по',state.asOf],['Срез продлений',describe(state.renew)],['Срез новых',describe(state.fresh)],['Процент', 'Только завершённые годовые случаи; фактические продления включают досрочные'],['Апсейл','Увеличение срока тарифа; деньги не известны'],['Привязка','Первое окончание в году / первое подключение; Обмен по ИНН к ОФД'],['Исключения','Сегодняшние кассы без чеков не применяются к ретро']];
    const sheets=[{sheetName:'Описание',headers:['Параметр','Значение'],rows:description,colWidths:[32,110]},{sheetName:'Итоги',forceFormulaBook:true,headers:['Показатель','Значение'],rows:[['Годовая база',s.due],['Уже продлились',s.actual],['Не продлились',s.lost],['Ожидают исхода',s.pending],['Завершено',s.closed],['Продлились из завершённых',s.closedRenewed],['Процент продления',{v:s.rate,s:5}],['Досрочные вне завершённых',s.early],['Новые ИНН',selectedNew.length],['Клиентов с апсейлом',state.product==='ofd'?s.upsellClients:null],['Доля клиентов с апсейлом',{v:state.product==='ofd'?s.upsellRate:null,s:5}],['Касс с апсейлом',state.product==='ofd'?s.upsellRegisters:null],['Всего продлённых касс',state.product==='ofd'?s.renewedRegisters:null]],colWidths:[44,24]},
    {sheetName:'Продления',headers:['ИНН','Клиент','Первое окончание','Каналы','Партнёры','Продлился','Окно завершено','Касс к продлению','Касс продлилось'],rows:selectedRenew.map(r=>[r.inn,r.org,P.iso(r.anchor),r.channels.join('; '),r.partners.map(k=>current.partners.find(p=>p.key===k)?.label||k).join('; '),r.renewed?'Да':'Нет',r.complete?'Да':'Нет',r.due,r.unitsRenewed]),textCols:[0],colWidths:[18,42,22,35,48,16,24,22,22]},
    {sheetName:'Новые',headers:['ИНН','Клиент','Первое подключение','Каналы','Партнёры'],rows:selectedNew.map(r=>[r.inn,r.org,P.iso(r.start),r.channels.join('; '),r.partners.map(k=>current.partners.find(p=>p.key===k)?.label||k).join('; ')]),textCols:[0],colWidths:[18,42,24,35,48]},
    {sheetName:'Апсейл кассы',headers:['ИНН','Клиент','РНМ','Было, мес','Стало, мес','Окончание','Активация продления','Партнёр','ИНН партнёра','Канал'],rows:s.transitions.map(t=>[t.inn,t.org,t.unit,t.from,t.to,P.iso(t.end),P.iso(t.start),t.partner,t.partnerInn,t.channel]),textCols:[0,2,8],colWidths:[18,42,24,18,18,22,26,42,18,30]}];
    try{root.OFDExport.downloadXlsx('Ретро_'+state.year,{sheets});}catch(e){alert('Не удалось выгрузить Excel: '+e.message);}
   }
   function sync(){
    const ofd=root.OFDState?.planning2Data,one=root.OFDWidgets.ofd1cGetState()?.planning2Data,promos=root.OFDPlanning2.promoData;
    const parsed=P.date(state.asOf);if(!Number.isInteger(+state.year)||state.year<2000||state.year>2100||parsed==null){results.textContent='Укажите год 2000–2100 и дату среза.';return;}
    const cut=Math.floor(parsed)+1,key=state.product+'|'+state.year+'|'+cut;let cached=cache.get(key);
    if(!cached||cached.ofd!==ofd?.ledger||cached.one!==one?.ledger||cached.promos!==promos){const data=R.build(ofd?.ledger,one?.ledger,promos,state.product,+state.year,cut);cached={ofd:ofd?.ledger,one:one?.ledger,promos,data};cache.clear();cache.set(key,cached);}
    if(!cached.data){results.textContent=state.product==='ofd'?'Загрузите файл ОФД общей кнопкой сверху.':'Загрузите сверку Обмена с 1С или активированные промокоды общей кнопкой сверху.';return;}
    const notes=[];if(state.product==='onec'&&!one?.ledger)notes.push('История Обмена загружена только из промокодов: база и ретро неполны.');if(state.product==='onec'&&!ofd?.ledger)notes.push('Без файла ОФД каналы и партнёры Обмена не определены.');notices=notes.length?'<p class="notice">'+notes.map(esc).join(' ')+'</p>':'';
    drawData(cached.data);
   }
   box.querySelectorAll('[data-field]').forEach(el=>{const update=()=>{const value=el.dataset.field==='year'?+el.value:el.value;if(state[el.dataset.field]===value)return;state[el.dataset.field]=value;state.page=0;sync();};el.oninput=el.onchange=update;});
   const api={syncShared:sync,destroy:()=>root.OFDPlanning2.instances.delete(id)};root.OFDPlanning2.instances.set(id,api);sync();return box;
  },onRemove:function(id){root.OFDPlanning2.instances.delete(id);states.delete(id);}
 };
})(window);
