'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{JSDOM}=require('jsdom'),X=require('../js/vendor/xlsx.full.min.js');
(async()=>{
 const dom=await JSDOM.fromFile(path.join(__dirname,'..','index.html'),{runScripts:'dangerously',resources:'usable',pretendToBeVisual:true,beforeParse(w){w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};const store={};Object.defineProperty(w,'localStorage',{value:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=String(v),removeItem:k=>delete store[k]}});}});
 const w=dom.window;if(w.document.readyState!=='complete')await new Promise(r=>w.addEventListener('load',r,{once:true}));
 try{
 const date=(y,m,d)=>new w.Date(y,m-1,d),rows=[];
 function add(inn,rnm,months,end,channel){rows.push({status:'Зарегистрировано',pin:rnm,rnm,innOrg:inn,org:'Test',tariff:months+' месяцев',activated:date(2025,1,1),created:date(2025,1,1),endDate:end,overallEnd:end,partner:'Partner '+inn,partnerInn:'7700000099',salesCenter:'Test'});}
 add('7700000001','A',15,date(2027,4,1));add('7700000001','B',36,date(2027,8,1));add('7700000002','C',15,date(2027,5,1));add('7700000003','D',36,date(2028,1,1));
 const M=w.OFDMetrics,model=M.buildModel(rows,{strict:true});model.kassas.forEach(k=>k.channel=k.clientKey==='7700000001'?'Ольга Зибер':'Партнёры');
 const ctx={M,asOf:date(2026,11,6)},id='calendar-regression',host=w.document.createElement('div');w.document.body.appendChild(host);
 function draw(){host.replaceChildren(w.OFDWidgets.WIDGETS['b9-renewal-calendar-channels'].render(model,ctx,id));}
 w.OFDCanvas={rerenderAll:draw};w.XLSX={...X,writeFile:wb=>captured=wb};let captured=null;draw();
 const change=(selector,value)=>{const el=host.querySelector(selector);assert.ok(el,selector);if(el.type==='radio'||el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const cal=M.computeRenewalCalendar(model,ctx.asOf,{unit:'kassa'}),from=cal.months.findIndex(d=>d.getFullYear()===2027&&d.getMonth()===0),to=from+11;
 change('.rc-from',String(from));change('.rc-to',String(to));
 [...host.querySelectorAll('.ch-tab')].find(el=>el.textContent==='Ольга Зибер').click();
 async function download(){captured=null;host.querySelector('.chc-xlsx').click();for(let i=0;i<20&&!captured;i++)await new Promise(r=>setTimeout(r,10));assert.ok(captured);return captured;}
 const table=(wb,name)=>X.utils.sheet_to_json(wb.Sheets[name],{header:1}),sum=(wb,name,col)=>table(wb,name).slice(4).reduce((s,r)=>s+(typeof r[col]==='number'?r[col]:0),0);
 let wb=await download();
 assert.equal(sum(wb,'Сводка',6),2,'Export must sum to the two visible cash registers, without subtotal/detail doubling');
 assert.equal(wb.SheetNames.includes('Партнёры'),false,'Unselected channels must not be exported');
 assert.ok(wb.SheetNames.includes('По тарифам'));
 assert.equal(table(wb,'Сводка').slice(4).length,12,'Exactly selected months');
 assert.equal(sum(wb,'По тарифам',6),2,'Tariff detail agrees with monthly summary');
 change('input[value="table"]',true);assert.ok(host.querySelector('.rc-from'),'Date range remains accessible in table view');
 assert.equal(host.querySelector('.table-scroll tbody').rows.length,12,'Table and export share the chosen range');
 change('input[value="client"]',true);wb=await download();assert.equal(sum(wb,'Сводка',6),1,'One INN for two cash registers');
 change('.chc-tariff','15');wb=await download();assert.equal(sum(wb,'Сводка',6),0,'Selected tariff applies to export');
 change('.chc-tariff','36');wb=await download();assert.equal(sum(wb,'Сводка',6),1);
 w.OFDWidgets.ofd1cDadataSetState({records:new w.Map([['7700000001',{status:'LIQUIDATED'}]]),fileName:'test.json'});draw();
 change('.chc-liq',true);wb=await download();assert.equal(sum(wb,'Сводка',6),0);assert.equal(sum(wb,'Сводка',7),1,'Liquidated INN remains visible in exclusion count');
 console.log('PASS channel calendar: selected channels, months, units, tariffs, exclusions; summable totals without duplicate detail');
 }finally{dom.window.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
