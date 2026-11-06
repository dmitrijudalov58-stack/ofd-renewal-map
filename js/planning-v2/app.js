(function(){
 window.mountPlanning2=function(container,options){
 options=options||{};
 'use strict';
 const P=window.Planning2,$=id=>container.querySelector('[id="'+id+'"]'),KEY='ofd.planning2.oksana.v1';
 const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=(v,d=0)=>v==null?'Не задано':v.toLocaleString('ru-RU',{maximumFractionDigits:d});
 const pct=v=>v==null?'Нет данных':fmt(v*100,2)+'%';
 const money=v=>v==null?'Не задано':fmt(v,2)+' ₽';
 const title=p=>p==='ofd'?'ОФД':'Обмен с 1С';
 let saved=null;try{saved=JSON.parse(localStorage.getItem(KEY)||'null');}catch(e){}
 const state={params:P.normalizeParams(saved),ofd:null,onec:null,meta:{},exclusions:null,plan:null,tab:options.tab||'checks',product:'ofd',query:'',channel:'',onlyUnknown:false,busy:false};
 function persist(){try{localStorage.setItem(KEY,JSON.stringify(state.params));if(options.integrated)window.dispatchEvent(new CustomEvent('planning2-params',{detail:api}));}catch(e){status('Параметры рассчитаны, но браузер не разрешил их сохранить. Экспортируйте план в Excel.');}}
 function status(message,error=false){$('status').textContent=message;$('status').className=error?'error':'';}
 function syncInputs(){for(const k of ['year','retroFrom','retroTo','asOf','vat'])$(k).value=state.params[k];$('upsell').value=state.params.upsell*100;}
 function calculate(){
  if(!state.ofd&&!state.onec){state.plan=null;render();return;}
  try{state.plan=(options.integrated?window.OFDPlanning2:P).build(state.ofd,state.onec,state.params,state.exclusions);render();status('План пересчитан. '+(state.plan.complete?'Параметры заполнены.':'Проверьте незаполненные параметры.'));}catch(e){state.plan=null;render();status(e.message,true);}
 }
 function card(product){
  const pr=state.plan.products[product];if(!pr.loaded)return '<article class="card stat"><h3>'+title(product)+'</h3><div class="number">Нет файла</div><p class="tiny">Загрузите исходные данные продукта</p></article>';
  const t=pr.total;
  const value=pr.rows.length&&!pr.rows.some(r=>r.amount!=null)?null:t.money;
  return '<article class="card stat"><h3>'+title(product)+' <span class="tag '+(t.complete?'':'pending')+'">'+(t.complete?'Расчёт заполнен':'Есть незаполненное')+'</span></h3><div class="number">'+money(value)+'</div><div class="meta"><span>Клиентов: '+fmt(t.base)+'</span><span>Ожидается: '+(t.missingProb?'Не завершено':fmt(t.expected,2))+'</span></div>'+(product==='ofd'?'<p class="tiny">Продления: '+money(pr.rows.length&&!pr.rows.some(r=>r.baseAmount!=null)?null:t.baseMoney)+' · Апсейл: '+money(pr.rows.length&&!pr.rows.some(r=>r.upsellAmount!=null)?null:t.upsellMoney)+'</p>':'')+(t.complete?'':'<p class="tiny">Показана рассчитанная часть. Без чека: '+t.missingCheck+', без вероятности: '+t.missingProb+'.</p>')+'</article>';
 }
 function productSelect(){return '<select class="product-select" id="productView" aria-label="Продукт"><option value="ofd" '+(state.product==='ofd'?'selected':'')+'>ОФД</option><option value="onec" '+(state.product==='onec'?'selected':'')+'>Обмен с 1С</option></select>';}
 function table(headers,rows){return '<div class="scroll"><table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
 function checksView(){
  const plan=state.plan;
  const rows=P.CHANNELS.map(ch=>'<tr><td>'+esc(ch)+'</td>'+['ofd','onec'].map(p=>'<td><input aria-label="Средний чек '+title(p)+' '+esc(ch)+'" class="money" type="number" min="0" step="0.01" data-check="'+p+'" data-channel="'+esc(ch)+'" value="'+esc(state.params.checks[p][ch]??'')+'" placeholder="Не задано"></td>').join('')+'</tr>');
  return '<h2>Средний чек на продлившегося клиента</h2><p class="intro">Один чек на канал для каждого продукта. Он применяется ко всем когортам канала. Формула: клиенты × вероятность продления × средний чек. На количество касс дополнительно не умножаем.</p>'+table(['Канал продаж','ОФД, ₽ / клиент','Обмен с 1С, ₽ / клиент'],rows)+'<p class="tiny">Чеки и ручные настройки сохраняются отдельно от действующего инструмента. Исходные файлы после закрытия страницы нужно выбрать заново.</p>';
 }
 function retroView(){
  const pr=state.plan.products[state.product];
  if(!pr.loaded)return productSelect()+'<div class="empty">Загрузите файл '+title(state.product)+'</div>';
  const rows=[...pr.retro.stats.values()].map(s=>{
   const manual=state.params.manual[state.product][s.key]||{};
   return '<tr data-cohort="'+esc(s.key)+'"><td>'+esc(s.key)+'</td><td class="num">'+fmt(s.base)+'</td><td class="num">'+fmt(s.renewed)+'</td><td class="num">'+fmt(s.pending)+'</td><td class="num">'+pct(s.rate)+'</td><td><input class="prob" aria-label="Ручная вероятность '+esc(s.key)+'" type="number" min="0" max="100" step="0.01" value="'+(manual.value==null?'':esc(manual.value*100))+'" placeholder="Ретро"></td><td><input class="reason" aria-label="Причина ручной вероятности '+esc(s.key)+'" value="'+esc(manual.reason||'')+'" placeholder="Причина ручного изменения"></td><td><button class="reset" data-reset="'+esc(s.key)+'">Вернуть ретро</button></td></tr>';
  });
  return '<div class="section-title"><h2>Когорты и вероятности</h2>'+productSelect()+'</div><p class="intro">ОФД: восемь групп по наблюдаемому сроку с нами и числу действующих касс. Обмен с 1С: один процент по ИНН. Клиент продлился, если продлена хотя бы одна заканчивавшаяся касса заранее или не позднее 30-го дня после окончания. Ручной процент применяется только вместе с причиной.</p>'+table(['Когорта','Клиентов','Продлились','Не завершены','По ретро','Вручную, %','Причина',''],rows);
 }
 function channelsView(){
  const pr=state.plan.products[state.product];if(!pr.loaded)return productSelect()+'<div class="empty">Загрузите файл продукта</div>';
  const groups=P.aggregate(pr.rows,r=>r.channel+'\t'+r.cohort);
  return '<div class="section-title"><h2>Когорты внутри каналов</h2>'+productSelect()+'</div><p class="intro">Вероятность одна для когорты во всех каналах. Средний чек определяется каналом и продуктом.</p>'+table(['Канал','Когорта','Клиентов','Вероятность','Средний чек','Ожидаемых клиентов','Рассчитанная сумма'],groups.map(g=>{
   const [ch,cohort]=g.key.split('\t'),sample=pr.rows.find(r=>r.channel===ch&&r.cohort===cohort);
   return '<tr><td>'+esc(ch)+'</td><td>'+esc(cohort)+'</td><td class="num">'+fmt(g.base)+'</td><td class="num">'+pct(sample.prob)+'</td><td class="num">'+money(sample.check)+'</td><td class="num">'+(sample.prob==null?'Не задано':fmt(g.expected,2))+'</td><td class="num">'+money(g.missing===g.base?null:g.money)+(g.missing?' <span class="missing">· неполно</span>':'')+'</td></tr>';
  }));
 }
 function monthsView(){
  const rows=[];for(let m=1;m<=12;m++){
   const key=state.params.year+'-'+String(m).padStart(2,'0');
   const blocks=['ofd','onec'].map(p=>{const pr=state.plan.products[p];if(!pr.loaded)return '<td colspan="3" class="muted">Нет файла</td>';const rs=pr.rows.filter(r=>r.month===key),g=P.aggregate(rs,()=>key)[0]||{base:0,expected:0,money:0,missing:0};return '<td class="num">'+fmt(g.base)+'</td><td class="num">'+(rs.some(r=>r.prob==null)?'Не задано':fmt(g.expected,2))+'</td><td class="num">'+money(g.base&&g.missing===g.base?null:g.money)+(g.missing?' · неполно':'')+'</td>';}).join('');
   rows.push('<tr><td>'+key+'</td>'+blocks+'</tr>');
  }
  return '<h2>План по месяцам</h2><p class="intro">Вся ожидаемая годовая сумма клиента отнесена на месяц первого окончания покрытия. В следующих месяцах этот годовой чек не повторяется.</p>'+table(['Месяц','Клиентов ОФД','Ожидается ОФД','ОФД, ₽','Клиентов 1С','Ожидается 1С','1С, ₽'],rows);
 }
 function clientsView(){
  const pr=state.plan.products[state.product];if(!pr.loaded)return productSelect()+'<div class="empty">Загрузите файл продукта</div>';
  const q=state.query.toLowerCase();
  const all=pr.rows.filter(r=>(!q||(r.inn+' '+r.org+' '+r.partner).toLowerCase().includes(q))&&(!state.onlyUnknown||r.channel===P.UNKNOWN));
  return '<h2>Клиенты плана</h2><p class="intro">Одна строка на ИНН в продукте. Для 1С партнёр и канал определяются по клиенту ОФД. Если канал неизвестен или неоднозначен, выберите его вручную. В Excel выгружаются все строки.</p><div class="toolbar">'+productSelect()+'<input id="query" type="search" aria-label="Поиск клиентов" placeholder="ИНН, организация или партнёр" value="'+esc(state.query)+'"><label class="tiny"><input id="unknownOnly" type="checkbox" '+(state.onlyUnknown?'checked':'')+'> Только без канала</label><span class="tiny">Показано '+Math.min(200,all.length)+' из '+fmt(all.length)+'</span></div>'+table(['ИНН / клиент','Когорта','Первое окончание','Канал','Касс к продлению','Вероятность','Чек клиента','Ожидаемая сумма'],all.slice(0,200).map(r=>'<tr><td><strong>'+esc(r.inn)+'</strong><br>'+esc(r.org)+'</td><td>'+esc(r.cohort)+'</td><td class="nowrap">'+P.displayDate(r.anchor)+'</td><td><select data-client-channel="'+esc(r.id)+'" aria-label="Канал клиента '+esc(r.inn)+'"><option value="">Не определён</option>'+P.CHANNELS.map(ch=>'<option '+(r.channel===ch?'selected':'')+' value="'+esc(ch)+'">'+esc(ch)+'</option>').join('')+'</select><div class="tiny">'+esc(r.partner||'Партнёр не найден')+'</div></td><td class="num">'+r.dueUnits+'</td><td class="num">'+pct(r.prob)+'</td><td class="num">'+money(r.check)+'</td><td class="num">'+money(r.amount)+'</td></tr>'));
 }
 function renderView(){
  if(!state.plan){$('view').innerHTML='<div class="empty">Начните с загрузки исходных файлов.<br>Чеки можно вводить после загрузки; выдуманных цен и вероятностей нет.</div>';return;}
  const views={checks:checksView,retro:retroView,channels:channelsView,months:monthsView,clients:clientsView};$('view').innerHTML=views[state.tab]();
  const pv=$('productView');if(pv)pv.addEventListener('change',()=>{state.product=pv.value;renderView();});
  container.querySelectorAll('[data-check]').forEach(el=>el.addEventListener('change',()=>{
   const n=P.num(el.value);if(n!=null&&n<0){el.setCustomValidity('Чек не может быть отрицательным');el.reportValidity();return;}el.setCustomValidity('');
   state.params.checks[el.dataset.check][el.dataset.channel]=n;persist();calculate();
  }));
  container.querySelectorAll('tr[data-cohort]').forEach(row=>{
   const change=()=>{const value=P.num(row.querySelector('.prob').value),reason=row.querySelector('.reason').value.trim();if(value!=null&&(value<0||value>100)){status('Вероятность должна быть от 0 до 100%.',true);return;}state.params.manual[state.product][row.dataset.cohort]={value:value==null?null:value/100,reason};persist();calculate();};
   row.querySelector('.prob').addEventListener('change',change);row.querySelector('.reason').addEventListener('change',change);
  });
  container.querySelectorAll('[data-reset]').forEach(el=>el.addEventListener('click',()=>{delete state.params.manual[state.product][el.dataset.reset];persist();calculate();}));
  container.querySelectorAll('[data-client-channel]').forEach(el=>el.addEventListener('change',()=>{if(el.value)state.params.channels[el.dataset.clientChannel]=el.value;else delete state.params.channels[el.dataset.clientChannel];persist();calculate();}));
  const q=$('query');if(q)q.addEventListener('input',()=>{state.query=q.value;const pos=q.selectionStart;renderView();$('query').focus();$('query').setSelectionRange(pos,pos);});
  const unknown=$('unknownOnly');if(unknown)unknown.addEventListener('change',()=>{state.onlyUnknown=unknown.checked;renderView();});
 }
 function render(){
  const plan=state.plan;$('export').disabled=!plan||state.busy;
  if(!plan){$('summary').innerHTML='';$('warnings').innerHTML='';renderAdjustments();renderView();return;}
  $('warnings').innerHTML=plan.warnings.length?'<aside class="notice">'+plan.warnings.map(w=>'<p>'+esc(w)+'</p>').join('')+'</aside>':'';
  const totalMoney=plan.rows.length&&!plan.rows.some(r=>r.amount!=null)?null:plan.money;
  $('summary').innerHTML=card('ofd')+card('onec')+'<article class="card stat"><h3>Два продукта <span class="tag '+(plan.complete?'':'pending')+'">'+(plan.complete?'Расчёт заполнен':'Рассчитанная часть')+'</span></h3><div class="number">'+money(totalMoney)+'</div><p class="tiny">'+fmt(plan.uniqueClients)+' уникальных ИНН в объединённой базе. Один клиент может покупать оба продукта.</p></article>';
  renderAdjustments();renderView();
 }
 function renderAdjustments(){
  const plan=state.plan,data=options.integrated?window.OFDPlanning2.exclusionData:state.exclusions;
  $('exclusionsClear').disabled=!data;
  $('exclusionsInfo').textContent=data?data.files.join('; ')+' · строк '+fmt(data.sourceRows)+' · повторов '+fmt(data.duplicates)+'. Исключаются только однозначные совпадения ИНН + даты окончания + тарифа.':'Список исключений не загружен.';
  $('comparison').innerHTML='';$('exclusionsRows').innerHTML='';$('exclusionsReview').hidden=true;
  if(!plan||!plan.exclusions)return;
  const b=plan.baseline,c=plan.comparison,ofd=plan.products.ofd.total;
  const known=b.knownMoney;
  $('comparison').innerHTML=table(['Показатель','Исходный прогноз','После исключений','Разница: исходный минус новый'],[
   '<tr><td>Клиентов ОФД</td><td class="num">'+fmt(b.ofd?b.ofd.base:null)+'</td><td class="num">'+fmt(ofd?ofd.base:null)+'</td><td class="num">'+fmt(c.excludedClients)+'</td></tr>',
   '<tr><td>Сумма двух продуктов с апсейлом'+(!b.complete||!plan.complete?' · рассчитанная часть':'')+'</td><td class="num">'+money(known?b.money:null)+'</td><td class="num">'+money(known?plan.money:null)+'</td><td class="num">'+money(known?c.moneyDrop:null)+'</td></tr>'
  ])+'<p class="tiny">Исключено касс ОФД: '+fmt(c.excludedUnits)+'. Если у ИНН остались кассы к продлению, клиент сохраняется с одним средним чеком; сумма не уменьшается пропорционально числу исключённых касс. Апсейл пересчитывается по оставшимся кассам.</p>';
  const report=plan.exclusions.report,counts=new Map();for(const r of report)counts.set(r.status,(counts.get(r.status)||0)+1);
  $('exclusionsReview').hidden=false;
  $('exclusionsRows').innerHTML=table(['Результат','Касс / строк'],[...counts].map(([s,n])=>'<tr><td>'+esc(s)+'</td><td class="num">'+fmt(n)+'</td></tr>'))+'<p class="tiny">Первые 100 строк; полный список и причины — в Excel.</p>'+table(['ИНН','Заводской номер','Окончание','Тариф, мес','Результат'],report.slice(0,100).map(r=>'<tr><td>'+esc(r.inn)+'</td><td>'+esc(r.serial)+'</td><td>'+P.displayDate(r.end)+'</td><td>'+esc(r.months)+'</td><td>'+esc(r.status)+'</td></tr>'));
 }
 async function loadExclusions(file){
  if(!file||state.busy)return;state.busy=true;$('exclusionsFile').disabled=true;status('Читаю список касс без чеков…');await new Promise(r=>setTimeout(r,30));
  try{const wb=XLSX.read(await file.arrayBuffer(),{type:'array',dense:true,cellDates:false}),data=P.parseExclusions(XLSX,wb,file.name);
   if(options.integrated)window.OFDPlanning2.setExclusions(data);else{state.exclusions=data;calculate();}
   status('Список загружен. Проверьте сравнение и результаты сопоставления.');
  }catch(e){status(e.message,true);}finally{state.busy=false;$('exclusionsFile').disabled=false;$('export').disabled=!state.plan;}
 }
 $('exclusionsFile').addEventListener('change',e=>loadExclusions(e.target.files[0]));
 $('exclusionsClear').addEventListener('click',()=>{if(options.integrated)window.OFDPlanning2.setExclusions(null);else{state.exclusions=null;calculate();}$('exclusionsFile').value='';});
 $('upsell').addEventListener('change',()=>{const n=P.num($('upsell').value);if(n==null||n<0||n>100){status('Введите апсейл от 0 до 100%.',true);$('upsell').setCustomValidity('От 0 до 100%');$('upsell').reportValidity();return;}$('upsell').setCustomValidity('');if(state.params.upsell===n/100)return;state.params.upsell=n/100;persist();calculate();});
 async function loadFiles(files,product){
  if(!files.length||state.busy)return;state.busy=true;$('export').disabled=true;
  $('ofdFile').disabled=$('onecFile').disabled=true;status('Читаю '+title(product)+'. Большая выгрузка может обрабатываться несколько минут…');
  await new Promise(r=>setTimeout(r,40));
  try{
   const parsed=[],issues=[];let sourceRows=0;
   for(const file of files){const buffer=await file.arrayBuffer();const wb=XLSX.read(buffer,{type:'array',dense:true,cellDates:false});const result=P.parseWorkbook(XLSX,wb,product,file.name);for(const r of result.records)parsed.push(r);for(const issue of result.issues)issues.push(issue);sourceRows+=result.sourceRows;await new Promise(r=>setTimeout(r,10));}
   const led=P.ledger(parsed);if(!led.records.length)throw new Error('В выбранных файлах нет корректных строк '+title(product)+'. Найдено строк: '+sourceRows+', исключено: '+issues.length+'. Нужна наполненная исходная выгрузка.');state[product]=led;state.meta[product]={files:files.map(f=>f.name),issues,sourceRows};
   if(!state.params.asOf&&led.maxStart!=null){state.params.asOf=P.iso(Math.floor(led.maxStart));syncInputs();}
   $(product==='ofd'?'ofdMeta':'onecMeta').textContent=files.map(f=>f.name).join('; ')+' · '+fmt(led.clients.size)+' ИНН · '+fmt(led.records.length)+' записей · исключено '+fmt(issues.length)+' · повторов '+fmt(led.duplicates);
   persist();calculate();status(title(product)+' загружен. Введите средние чеки по каналам и проверьте ретро.');
  }catch(e){status(e.message||String(e),true);}finally{state.busy=false;$('ofdFile').disabled=$('onecFile').disabled=false;$('export').disabled=!state.plan;}
 }
 for(const product of ['ofd','onec'])$(product==='ofd'?'ofdFile':'onecFile').addEventListener('change',e=>loadFiles([...e.target.files],product));
 for(const k of ['year','retroFrom','retroTo','asOf','vat'])$(k).addEventListener('change',()=>{
  if(k==='year'&&(!Number.isInteger(+$(k).value)||+$(k).value<2000||+$(k).value>2100)){state.plan=null;render();status('Год плана должен быть от 2000 до 2100.',true);return;}
  state.params[k]=k==='year'?+$(k).value:$(k).value;persist();calculate();
 });
 $('tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b)return;state.tab=b.dataset.tab;container.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el===b));renderView();});
 $('export').addEventListener('click',async()=>{
  if(!state.plan||state.busy)return;$('export').disabled=true;status('Готовлю Excel со всеми клиентами и формулами…');await new Promise(r=>setTimeout(r,30));
  try{OFDExport.downloadXlsx('Планирование_2_Оксана_'+state.params.year,P.workbook(state.plan));status('Excel сформирован. Пустые чеки и вероятности сохранены пустыми.');}catch(e){status('Не удалось выгрузить Excel: '+e.message,true);}finally{$('export').disabled=false;}
 });
 const api={state,loadFiles,loadExclusions,calculate,render,syncShared:function(){
  if(!options.integrated)return;
  const shared=window.OFDState||{},one=window.OFDWidgets.ofd1cGetState();
  state.ofd=shared.planning2Data&&shared.planning2Data.ledger||null;
  state.onec=one.planning2Data&&one.planning2Data.ledger||null;
  for(const product of ['ofd','onec']){
   const data=product==='ofd'?shared.planning2Data:one.planning2Data;
   $(product==='ofd'?'ofdMeta':'onecMeta').textContent=data?(data.error||data.files.join('; ')+' · '+fmt(data.ledger.clients.size)+' ИНН · исключено '+fmt(data.issues.length)):'Файл не выбран';
  }
  if(!state.params.asOf&&state.ofd&&state.ofd.maxStart!=null)state.params.asOf=P.iso(Math.floor(state.ofd.maxStart));
  syncInputs();calculate();
  const errors=[shared.planning2Data,one.planning2Data].filter(x=>x&&x.error).map(x=>x.error);
  if(errors.length)status(errors.join(' '),true);
 }};
 const onParams=e=>{if(e.detail===api)return;try{state.params=P.normalizeParams(JSON.parse(localStorage.getItem(KEY)));syncInputs();calculate();}catch(e){status(e.message,true);}};
 if(options.integrated)window.addEventListener('planning2-params',onParams);
 api.destroy=()=>window.removeEventListener('planning2-params',onParams);
 window.OksanaPlanning=api;syncInputs();render();if(options.integrated)api.syncShared();return api;
 };
 if(document.body.classList.contains('planning2'))window.mountPlanning2(document.body);
})();
