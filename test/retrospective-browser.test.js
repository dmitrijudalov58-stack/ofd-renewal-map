const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const P=require('../js/planning-v2/core.js'),X=require('../js/vendor/xlsx.full.min.js'),parser=require('../js/parser.js'),R=require('../js/planning-v2/retro.js');
const pk=(name,inn)=>R.partnerKey({partner:name,partnerInn:inn});
const {chromium}=require('/Users/dmitrij/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const folder='/private/tmp/retrospective-browser';fs.mkdirSync(folder,{recursive:true});
const d=P.day;
function row(inn,unit,start,end,pin){const r=Array(29).fill(null);r[2]=pin;r[3]=start;r[4]='Зарегистрировано';r[5]=pin==='A2'?'36 месяцев':'15 месяцев';r[8]='Продление';r[9]=start;r[10]=end;r[11]=end;r[12]=unit;r[13]='Тестовая организация';r[14]=inn;r[19]='Партнёр';r[20]='7700000000';r[22]='Центр';return r;}
const a='7700000001',b='7700000003';
const rows=[parser.EXPECTED_HEADERS,
 row(a,'0000000000000001',d(2020),d(2025,2,1),'A1'),row(a,'0000000000000001',d(2025,2,15),d(2027,4,1),'A2'),
 row(a,'0000000000000002',d(2021),d(2025,5,1),'B1'),row(a,'0000000000000002',d(2025,6,5),d(2027,7,1),'B2'),
 row(b,'0000000000000003',d(2022),d(2028),'C1'),row('7700000005','0000000000000005',d(2022),d(2028),'D1')];
// Partners without 2025 events must still be searchable in both blocks.
for(const [id,name,pin]of [['7700000091','АО "Калуга Астрал" (ЛК ОФД)','LK'],['7700000092','ООО "АТОЛ" (ОФД)','ATOL']]){const r=row(id,pin,d(2020),d(2028),pin);r[19]=name;r[20]=id;rows.push(r);}
const pinPartner=row('7700000094','PINS',d(2020),d(2028),'PINS');pinPartner[19]='АО "Калуга Астрал" (Пин-коды)';pinPartner[20]='7700000091';rows.push(pinPartner);
const elkom=row('7700000093','ELKOM',d(2020),d(2028),'ELKOM');elkom[19]='ООО "РУС-ЭЛКОМ" ОФД';elkom[20]='7700000093';rows.push(elkom);
let wb=X.utils.book_new();const sourceSheet=X.utils.aoa_to_sheet(rows);for(let r=2;r<=rows.length;r++)for(const c of ['J','K','L'])sourceSheet[c+r].z='dd.mm.yyyy hh:mm:ss';X.utils.book_append_sheet(wb,sourceSheet,'ОФД');fs.writeFileSync(path.join(folder,'ofd.xlsx'),X.write(wb,{type:'buffer',bookType:'xlsx'}));
wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([
 ['Ключ доступа','ИНН покупателя','Заводской номер ККТ','Начало действия тарифа','Окончание действия тарифа','Количество месяцев','Итоговая сумма','Сумма роялти'],
 ['X1',a,'SN1','2020-01-01','2025-02-01',15,100,10],['X2',a,'SN1','2025-02-02','2027-06-01',15,100,10],
 ['Y1',b,'SN1','2020-01-01','2025-03-01',15,100,10],['Y2',b,'SN1','2025-03-02','2027-08-01',15,100,10]
 ]),'2025-02');fs.writeFileSync(path.join(folder,'onec.xlsx'),X.write(wb,{type:'buffer',bookType:'xlsx'}));
const promoBook=X.utils.book_new();X.utils.book_append_sheet(promoBook,X.utils.aoa_to_sheet([P.PROMO_HEADERS,['2026-05-01','Client','7700000005','','12 months','PROMO1','Активирован','2026-05-01','A-System'],['2026-05-01','Client','7700000005','','12 months','PROMO2','Активирован','2026-05-01','A-System'],['2026-09-01','Client',b,'','12 months','PROMO3','Активирован','2026-09-01','A-System'],['2026-09-01','','','','12 months','PROMO4','Не активирован','','A-System']]),'promo');fs.writeFileSync(path.join(folder,'promos.xlsx'),X.write(promoBook,{type:'buffer',bookType:'xlsx'}));
async function main(){
 const http=require('node:http'),base=path.resolve(__dirname,'..');
 const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/whoami'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({username:'test'}));return;}
  if(url.pathname==='/api/overrides'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({overrides:null,customChannels:[]}));return;}
  if(url.pathname==='/version.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({build:'planning2-test'}));return;}
  const file=path.resolve(base,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(base+path.sep)||file.includes(path.sep+'.git'+path.sep)){res.writeHead(404);res.end();return;}
  try{res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch(e){res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;

 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Europe/Moscow',acceptDownloads:true});
 const reference=await context.newPage();await reference.goto(origin+'/');
 assert.equal(await reference.locator('details[data-group="b12"] [data-widget]').count(),6);
 assert.equal(await reference.locator('#planning2Link').count(),0);


 const errors=[];reference.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack)});reference.on('dialog',async dialog=>{console.error('DIALOG',dialog.message());await dialog.dismiss();});
 await reference.locator('#fileInput').setInputFiles(path.join(folder,'ofd.xlsx'));
 await reference.waitForFunction(()=>OFDState.planning2Data&&OFDState.ctx);
 await reference.evaluate(()=>OFDCanvas.addWidget('pl2-retrospective'));
 const board=reference.locator('.p2-retrospective');
 const change=async(key,value)=>{await board.locator('[data-field="'+key+'"]').fill(value);await board.locator('[data-field="'+key+'"]').dispatchEvent('change');};
 await change('asOf','2026-11-06');
 const cards=selector=>board.locator(selector+' .card strong').allTextContents();
 for(const key of ['renew','fresh']){
  const filter=board.locator('[data-filter="'+key+'"]');await filter.locator('[data-mode]').selectOption('partner');
  const input=filter.locator('[data-partner-search]'),suggestions=filter.locator('[data-partner-suggestions]');
  await input.fill('OFD');assert.equal(await suggestions.locator('button').count(),3);assert.equal(await suggestions.isVisible(),true);
  if(process.env.RETRO_QA_DIR){fs.mkdirSync(process.env.RETRO_QA_DIR,{recursive:true});await filter.screenshot({path:path.join(process.env.RETRO_QA_DIR,key+'-partner-search.png'),style:'.topbar{visibility:hidden}'});}
  for(const term of ['ЛК','lk','лк офд']){await input.fill(term);assert.equal(await suggestions.locator('button').count(),1);assert.ok((await suggestions.innerText()).includes('Калуга Астрал'));}
  await suggestions.locator('button').click();assert.equal(await filter.locator('[data-partner]').inputValue(),pk('АО \"Калуга Астрал\" (ЛК ОФД)','7700000091'));
  assert.equal((await cards(key==='renew'?'[data-renew-summary]':'[data-new-summary]'))[0],'0');
  await input.fill('Атолл');assert.equal(await suggestions.locator('button').count(),1);assert.ok((await suggestions.innerText()).includes('АТОЛ'));
  await input.press('ArrowDown');await reference.keyboard.press('Enter');assert.equal(await filter.locator('[data-partner]').inputValue(),pk('ООО \"АТОЛ\" (ОФД)','7700000092'));
  await input.fill('not-in-file');assert.ok((await suggestions.innerText()).includes('Ничего не найдено'));assert.equal(await suggestions.locator('button').count(),0);
  await input.fill('7700000091');assert.equal(await suggestions.locator('button').count(),2);assert.ok((await suggestions.innerText()).includes('Пин-коды'));assert.ok(!(await suggestions.innerText()).includes(' / '));await input.press('Escape');assert.equal(await suggestions.isVisible(),false);
  await filter.locator('[data-mode]').selectOption('channel');
 }

 assert.deepEqual(await cards('[data-renew-summary]'),['1','1','0','0','100,00%']);
 await board.locator('[data-internal-check]').evaluate(el=>el.open=true);
 assert.equal(await board.locator('[data-reconciliation="ok"]').count(),1);assert.ok((await board.locator('[data-reconciliation]').innerText()).includes('без продления 0,00%'));
 assert.deepEqual(await cards('[data-retention-summary]'),['1','1','0','100,00%','0,00%','0']);
 await board.locator('[data-retention-note]').evaluate(el=>el.open=true);assert.ok((await board.locator('[data-retention-note]').innerText()).includes('Продление тарифа показываем отдельно.'));assert.equal((await board.locator('[data-retention-note]').innerText()).includes('Старый B1 не меняем'),false);
 assert.equal(await board.locator('[data-bi-check="matched"]').count(),1);
 await reference.evaluate(()=>{window.originalBIModel=OFDState.model;OFDState.model=OFDMetrics.buildModel(OFDState.rows.filter(r=>r.pin!=='A2'),{strict:true});OFDPlanning2.refresh();});
 assert.equal(await board.locator('[data-bi-check="different"]').count(),1);await board.locator('[data-bi-details]').evaluate(el=>el.open=true);assert.ok((await board.locator('[data-bi-details]').innerText()).includes(a));
 const biDownload=reference.waitForEvent('download');await board.locator('[data-retro-export]').click();await (await biDownload).saveAs(path.join(folder,'bi-differences.xlsx'));
 const biResult=X.read(fs.readFileSync(path.join(folder,'bi-differences.xlsx')),{type:'buffer'});assert.equal(biResult.Sheets['Сверка B1'].B2.v,'Есть расхождения');assert.equal(biResult.Sheets['Сверка B1 по ИНН'].A2.v,a);assert.equal(biResult.Sheets['Сверка B1 по ИНН'].G2.v,1);
 if(process.env.RETRO_QA_DIR)await board.locator('[data-bi-check]').screenshot({path:path.join(process.env.RETRO_QA_DIR,'bi-differences.png'),style:'.topbar{visibility:hidden}'});
 await reference.evaluate(()=>{OFDState.model=originalBIModel;delete window.originalBIModel;OFDPlanning2.refresh();});assert.equal(await board.locator('[data-bi-check="matched"]').count(),1);await board.locator('[data-internal-check]').evaluate(el=>el.open=true);
 if(process.env.RETRO_QA_DIR)await board.locator('[data-bi-check]').screenshot({path:path.join(process.env.RETRO_QA_DIR,'bi-comparison.png'),style:'.topbar{visibility:hidden}'});
 if(process.env.RETRO_QA_DIR){await board.locator('[data-reconciliation]').screenshot({path:path.join(process.env.RETRO_QA_DIR,'reconciliation.png'),style:'.topbar{visibility:hidden}'});}
 await reference.evaluate(()=>{window.originalRetroSummary=Planning2Retro.summarize;Planning2Retro.summarize=rows=>{const s=originalRetroSummary(rows);return {...s,actual:s.actual+1};};OFDPlanning2.refresh();});
 assert.equal(await board.locator('[data-reconciliation="error"]').count(),1);
 await reference.evaluate(()=>{Planning2Retro.summarize=originalRetroSummary;delete window.originalRetroSummary;OFDPlanning2.refresh();});
 assert.equal(await board.locator('[data-reconciliation="ok"]').count(),1);
 await change('year','2028');assert.equal(await board.locator('[data-reconciliation="pending"]').count(),1);await change('year','2025');
 assert.equal(await board.locator('[data-bi-check="matched"]').count(),1);

 assert.deepEqual(await cards('[data-upsell-summary]'),['1','100,00%','1 / 1']);
 await board.locator('[data-transitions] summary').click();assert.ok((await board.locator('[data-transitions]').innerText()).includes('0000000000000001'));
 await board.locator('[data-filter="renew"] [data-all]').uncheck();assert.equal((await cards('[data-renew-summary]'))[0],'0');assert.equal(await board.locator('[data-reconciliation="empty"]').count(),1);assert.equal(await board.locator('[data-bi-check="empty"]').count(),1);
 await board.locator('[data-filter="renew"] [data-channel="Партнёры"]').check();assert.equal((await cards('[data-renew-summary]'))[0],'1');
 assert.equal((await cards('[data-new-summary]'))[0],'0');
 await board.locator('[data-filter="renew"] [data-mode]').selectOption('partner');
 await board.locator('[data-filter="renew"] [data-partner-search]').fill('7700000000');
 assert.equal(await board.locator('[data-filter="renew"] [data-partner-suggestions] button').count(),1);
 await board.locator('[data-filter="renew"] [data-partner]').selectOption(pk('Партнёр','7700000000'));
 assert.equal((await cards('[data-renew-summary]'))[0],'1');
 const dp=reference.waitForEvent('download');await board.locator('[data-retro-export]').click();await (await dp).saveAs(path.join(folder,'retro.xlsx'));
 const result=X.read(fs.readFileSync(path.join(folder,'retro.xlsx')),{type:'buffer',cellNF:true});
 assert.ok(result.Sheets['Сверка B1']);assert.equal(result.Sheets['Сверка B1 по ИНН'].A2.v,a);
 assert.equal(result.Sheets['Итоги'].B2.v,1);assert.equal(result.Sheets['Итоги'].B8.z,'0.00%');assert.equal(result.Sheets['Продления'].A2.t,'s');assert.equal(result.Sheets['Апсейл кассы'].C2.v,'0000000000000001');assert.equal(result.Sheets['Апсейл кассы'].E2.v,36);
 await board.locator('[data-field="product"]').selectOption('onec');await reference.locator('#ofd1cFileInput').setInputFiles(path.join(folder,'onec.xlsx'));
 await reference.waitForFunction(()=>document.querySelector('[data-renew-summary] .card strong')?.textContent==='2');
 assert.equal(await board.locator('[data-bi-check]').count(),0,'B1 OFD must not be compared with 1C');
 await change('year','2026');assert.equal((await cards('[data-new-summary]'))[0],'0');
 await reference.locator('#promoFileInput').setInputFiles(path.join(folder,'promos.xlsx'));
 await reference.waitForFunction(()=>document.querySelector('[data-new-summary] .card strong')?.textContent==='1');
 const oneDownload=reference.waitForEvent('download');await board.locator('[data-retro-export]').click({timeout:5000});await (await oneDownload).saveAs(path.join(folder,'one-retro.xlsx'));
 await board.locator('[data-field="product"]').selectOption('ofd');await change('year','2025');
 // Replacing shared data must rebuild the board while preserving chosen filters.
 const changed=X.utils.book_new();const extra=row('7700000007','SN7',d(2024),d(2025,4,1),'E1');X.utils.book_append_sheet(changed,X.utils.aoa_to_sheet([...rows,extra]),'ОФД');fs.writeFileSync(path.join(folder,'ofd-replaced.xlsx'),X.write(changed,{type:'buffer',bookType:'xlsx'}));
 await reference.locator('#fileInput').setInputFiles(path.join(folder,'ofd-replaced.xlsx'));
 await reference.waitForFunction(()=>document.querySelector('[data-renew-summary] .card strong')?.textContent==='2');
 assert.equal(await board.locator('[data-bi-check]').count(),1);
 assert.equal(await board.locator('[data-filter="renew"] [data-mode]').inputValue(),'partner');
 // Real input fixture: day30 after noon is a B1 event, but calendar retention stays matched.
 const boundaryRows=[...rows,extra,row('7700000008','0000000000000008',d(2024),d(2025,5,4),'G1'),row('7700000008','0000000000000008',d(2025,6,3)+14/24,d(2027),'G2')],boundaryBook=X.utils.book_new(),boundarySheet=X.utils.aoa_to_sheet(boundaryRows);
 for(let r=2;r<=boundaryRows.length;r++)for(const c of ['J','K','L'])boundarySheet[c+r].z='dd.mm.yyyy hh:mm:ss';X.utils.book_append_sheet(boundaryBook,boundarySheet,'ОФД');fs.writeFileSync(path.join(folder,'ofd-boundary.xlsx'),X.write(boundaryBook,{type:'buffer',bookType:'xlsx'}));
 await reference.locator('#fileInput').setInputFiles(path.join(folder,'ofd-boundary.xlsx'));await reference.waitForFunction(()=>document.querySelector('[data-renew-summary] .card strong')?.textContent==='3');
 assert.deepEqual(await cards('[data-retention-summary]'),['3','2','1','66,67%','33,33%','0']);assert.equal(await board.locator('[data-bi-check="matched"]').count(),1);
 await board.locator('[data-bi-boundaries]').evaluate(el=>el.open=true);assert.ok((await board.locator('[data-bi-boundaries]').innerText()).includes('7700000008'));assert.ok((await board.locator('[data-bi-boundaries]').innerText()).includes('14:00:00'));
 const boundaryDownload=reference.waitForEvent('download');await board.locator('[data-retro-export]').click();await (await boundaryDownload).saveAs(path.join(folder,'retention-boundary.xlsx'));
 const boundaryResult=X.read(fs.readFileSync(path.join(folder,'retention-boundary.xlsx')),{type:'buffer'});assert.equal(boundaryResult.Sheets['Сверка B1'].B2.v,'Совпало');assert.equal(boundaryResult.Sheets['Граница 30-го дня'].A2.v,'7700000008');assert.equal(boundaryResult.Sheets['Граница 30-го дня'].A2.t,'s');assert.equal(X.utils.sheet_to_json(boundaryResult.Sheets['Удержание']).length,3);assert.ok(X.utils.sheet_to_json(boundaryResult.Sheets['Описание']).some(r=>r['Значение']==='Продление тарифа показываем отдельно.'));
 await reference.setViewportSize({width:390,height:844});
 await reference.waitForTimeout(300);
 assert.equal(await board.evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,'Board itself fits mobile width');
 await reference.setViewportSize({width:1440,height:1050});
 const out=process.env.RETRO_QA_DIR||folder;fs.mkdirSync(out,{recursive:true});await board.screenshot({path:path.join(out,'retro-board.png'),style:'.topbar{visibility:hidden}'});
 assert.deepEqual(errors,[]);console.log('PASS Chrome retrospective: visible partner suggestions in both blocks, Cyrillic/Latin/duplicate letters/INN, zero-year partner, click/keyboard selection, shared uploads/replacement, filters and partner INN, cash upsell, promo refresh, XLSX values/text IDs, mobile');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
