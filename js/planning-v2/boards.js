/* Native GridStack section. Source data stays browser-local. */
(function(root){
 'use strict';
 const P=root.Planning2,instances=new Map();
 const template="<div class=\"planning2 p2-integrated\"><div class=\"p2-settings\">    <div class=\"controls threshold-row\">\n     <label>Год плана<input id=\"year\" type=\"number\" min=\"2000\" max=\"2100\"></label>\n     <label>Ретро с<input id=\"retroFrom\" type=\"date\"></label><label>Ретро по<input id=\"retroTo\" type=\"date\"></label>\n     <label>Срез на начало дня<input id=\"asOf\" type=\"date\"></label>\n     <label>Средние чеки<select id=\"vat\"><option value=\"\">НДС не отмечен</option><option value=\"with\">С НДС</option><option value=\"without\">Без НДС</option></select></label>\n    </div>\n    <div id=\"status\" role=\"status\" aria-live=\"polite\">Загрузите ОФД и сверку Обмена с 1С кнопками сверху. Файлы обрабатываются локально в браузере.</div>\n    <details class=\"p2-files\"><summary>Загруженные данные</summary><p><strong>ОФД:</strong> <span id=\"ofdMeta\">Файл не выбран</span></p><p><strong>Обмен с 1С:</strong> <span id=\"onecMeta\">Файл не выбран</span></p></details><section id=\"promoInfo\" class=\"p2-promo-info\"></section>\n   </div><div class=\"p2-actions\"><button id=\"export\" class=\"btn primary\" disabled>Выгрузить план в Excel</button></div><input id=\"ofdFile\" type=\"file\" hidden><input id=\"onecFile\" type=\"file\" hidden><nav id=\"tabs\" hidden></nav><div id=\"warnings\"></div><section id=\"summary\" class=\"cards\"></section><section id=\"adjustments\" class=\"p2-adjustments\"><div class=\"controls\"><label>Апсейл ОФД, %<input id=\"upsell\" type=\"number\" min=\"0\" max=\"100\" step=\"0.1\"></label><label class=\"btn\">Загрузить список без чеков<input id=\"exclusionsFile\" type=\"file\" accept=\".xlsx,.xls\" hidden></label><button id=\"exclusionsClear\" class=\"btn\" type=\"button\">Убрать исключения</button></div><p class=\"tiny\">Апсейл применяется к доле суммы по кассам к продлению с тарифом меньше 36 месяцев. Когорты и ретро сохраняются. Обмен с 1С не меняется.</p><p id=\"exclusionsInfo\" class=\"tiny\">Список исключений не загружен.</p><div id=\"comparison\"></div><details id=\"exclusionsReview\" hidden><summary>Проверка сопоставления касс</summary><div id=\"exclusionsRows\"></div></details></section><div id=\"view\"></div></div>";
 function parse(X,wb,product,file){try{return Object.assign(P.parseWorkbook(X,wb,product,file),{files:[file]});}catch(e){return {records:[],issues:[],files:[file],error:e.message};}}
 function parseBuffer(X,buffer,product,file){
  // Read raw serials: the legacy cellDates conversion can shift calendar days.
  try{return parse(X,X.read(buffer,{type:'array',dense:true,cellDates:false}),product,file);}
  catch(e){return {records:[],issues:[],files:[file],error:e.message};}
 }
 function combine(parts){
  const records=[],issues=[],files=[],errors=[];
  for(const part of parts||[]){for(const r of part.records)records.push(r);for(const i of part.issues)issues.push(i);files.push(...part.files);if(part.error)errors.push(part.error);}
  if(!records.length&&!errors.length)errors.push('В файле нет корректных записей для Планирования 2.0.');
  return {ledger:errors.length?null:P.ledger(records),issues,files,error:errors.join(' ')};
 }
 let cached=null;
 function build(ofd,onec,params){
  const key=JSON.stringify(params);
  if(!cached||cached.ofd!==ofd||cached.onec!==onec||cached.key!==key||cached.exclusions!==root.OFDPlanning2.exclusionData||cached.promos!==root.OFDPlanning2.promoData)cached={ofd,onec,key,exclusions:root.OFDPlanning2.exclusionData,promos:root.OFDPlanning2.promoData,plan:P.buildWithPromos(ofd,onec,params,root.OFDPlanning2.exclusionData,root.OFDPlanning2.promoData)};
  return cached.plan;
 }
 function refresh(){instances.forEach(api=>api.syncShared());}
 root.OFDPlanning2={parse,parseBuffer,combine,build,refresh,instances,exclusionData:null,promoData:null,setExclusions:function(data){this.exclusionData=data;refresh();},setPromos:function(data){this.promoData=data;refresh();root.dispatchEvent(new Event('planning2-promos-change'));}};
 [['checks','Параметры, средние чеки и сводный план'],['retro','Когорты и вероятности'],['channels','Каналы и когорты'],['months','План по месяцам'],['clients','Клиенты по ИНН']].forEach(([tab,title])=>{
  root.OFDWidgets.WIDGETS['pl2-'+tab]={title:'Планирование 2.0 — '+title,type:'таблица',scope:'план',span:true,defaultH:10,
   render:function(model,ctx,id){
    if(instances.has(id))instances.get(id).destroy();
    const holder=document.createElement('div');holder.innerHTML=template;const box=holder.firstElementChild;
    box.dataset.p2Tab=tab;
    if(tab!=='checks'){box.querySelector('.p2-settings').hidden=true;box.querySelector('#summary').hidden=true;box.querySelector('#warnings').hidden=true;box.querySelector('#adjustments').hidden=true;box.querySelector('.p2-actions').hidden=true;}
    box.querySelector('#status').textContent='Данные загружаются общими кнопками ОФД и Обмен с 1С вверху сайта.';
    const api=root.mountPlanning2(box,{integrated:true,tab});instances.set(id,api);return box;
   },
   onRemove:function(id){if(instances.has(id))instances.get(id).destroy();instances.delete(id);}
  };
 });
})(window);
