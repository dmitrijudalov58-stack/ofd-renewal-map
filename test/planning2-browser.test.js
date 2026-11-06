const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const P=require('../js/planning-v2/core.js'),X=require('../js/vendor/xlsx.full.min.js'),parser=require('../js/parser.js');
const {chromium}=require('/Users/dmitrij/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const folder='/private/tmp/planning2-web-browser';fs.mkdirSync(folder,{recursive:true});
const d=P.day;
function row(inn,unit,start,end,pin){const r=Array(29).fill(null);r[2]=pin;r[3]=start;r[4]='Зарегистрировано';r[5]='15 месяцев';r[8]='Продление';r[9]=start;r[10]=end;r[11]=end;r[12]=unit;r[13]='Тестовая организация';r[14]=inn;r[19]='Партнёр';r[20]='7700000000';r[22]='Центр';return r;}
const a='7700000001',b='7700000003';
const rows=[parser.EXPECTED_HEADERS,
 row(a,'0000000000000001',d(2020),d(2025,2,1),'A1'),row(a,'0000000000000001',d(2025,2,15),d(2027,4,1),'A2'),
 row(a,'0000000000000002',d(2021),d(2025,5,1),'B1'),row(a,'0000000000000002',d(2025,6,5),d(2027,7,1),'B2'),
 row(b,'0000000000000003',d(2022),d(2028),'C1')];
let wb=X.utils.book_new();const sourceSheet=X.utils.aoa_to_sheet(rows);for(let r=2;r<=rows.length;r++)for(const c of ['J','K','L'])sourceSheet[c+r].z='dd.mm.yyyy hh:mm:ss';X.utils.book_append_sheet(wb,sourceSheet,'ОФД');fs.writeFileSync(path.join(folder,'ofd.xlsx'),X.write(wb,{type:'buffer',bookType:'xlsx'}));
wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([
 ['Ключ доступа','ИНН покупателя','Заводской номер ККТ','Начало действия тарифа','Окончание действия тарифа','Количество месяцев','Итоговая сумма','Сумма роялти'],
 ['X1',a,'SN1','2020-01-01','2025-02-01',15,100,10],['X2',a,'SN1','2025-02-02','2027-06-01',15,100,10],
 ['Y1',b,'SN1','2020-01-01','2025-03-01',15,100,10],['Y2',b,'SN1','2025-03-02','2027-08-01',15,100,10]
 ]),'2025-02');fs.writeFileSync(path.join(folder,'onec.xlsx'),X.write(wb,{type:'buffer',bookType:'xlsx'}));
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
 assert.equal(await reference.locator('details[data-group="b12"] [data-widget]').count(),5);
 assert.equal(await reference.locator('#planning2Link').count(),0);

 const integratedErrors=[];reference.on('pageerror',e=>integratedErrors.push(e.message));
 await reference.locator('#fileInput').setInputFiles(path.join(folder,'ofd.xlsx'));
 await reference.waitForFunction(()=>window.OFDState&&OFDState.planning2Data&&OFDState.ctx);
 await reference.evaluate(()=>['checks','retro','channels','months','clients'].forEach(t=>OFDCanvas.addWidget('pl2-'+t)));
 await reference.waitForFunction(()=>OFDPlanning2.instances.size===5);
 await reference.locator('#ofd1cFileInput').setInputFiles(path.join(folder,'onec.xlsx'));
 await reference.waitForFunction(()=>[...OFDPlanning2.instances.values()].every(a=>a.state.onec));
 const settings=reference.locator('.p2-integrated[data-p2-tab="checks"]');
 await settings.locator('#asOf').fill('2026-11-02');await settings.locator('#asOf').dispatchEvent('change');
 await settings.locator('#vat').selectOption('with');
 for(const [product,value]of [['ofd','1000'],['onec','7000']]){
  const input=settings.locator('[data-check="'+product+'"][data-channel="Партнёры"]');await input.fill(value);await input.dispatchEvent('change');
 }
 assert.deepEqual(await reference.evaluate(()=>[...OFDPlanning2.instances.values()].map(a=>a.state.plan.money)),[15000,15000,15000,15000,15000]);
 assert.equal(await reference.locator('.p2-integrated[data-p2-tab="retro"] tr[data-cohort]').count(),8);
 assert.equal(await reference.locator('.p2-integrated[data-p2-tab="months"] tbody tr').count(),12);
 const downloadIntegrated=reference.waitForEvent('download');await settings.locator('#export').click();await (await downloadIntegrated).saveAs(path.join(folder,'integrated-export.xlsx'));
 const integratedXlsx=X.read(fs.readFileSync(path.join(folder,'integrated-export.xlsx')),{type:'buffer',cellFormula:true});
 assert.equal(integratedXlsx.Sheets['Проверки'].B8.v,15000);
 // Removing a board unregisters its subscriptions; restoring renders the same model.
 await reference.locator('[data-widget-id="pl2-clients"] .remove-btn').click();
 assert.equal(await reference.evaluate(()=>OFDPlanning2.instances.size),4);
 await reference.evaluate(()=>OFDCanvas.addWidget('pl2-clients'));
 assert.equal(await reference.evaluate(()=>OFDPlanning2.instances.size),5);
 assert.deepEqual(integratedErrors,[]);
 await reference.screenshot({path:path.join(folder,'integrated.png'),fullPage:true});
 await reference.close();
 await context.clearCookies();
 // Standalone regression starts with clean, isolated parameters.
 const cleaner=await context.newPage();await cleaner.goto(origin+'/');await cleaner.evaluate(()=>localStorage.removeItem('ofd.planning2.oksana.v1'));await cleaner.close();

 const page=await context.newPage(),errors=[],network=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))network.push(r.url());});
 await page.goto(origin+'/docs/planning/v2.html');
 await page.waitForFunction(()=>!!window.OksanaPlanning);
 assert.equal(await page.locator('#export').isDisabled(),true);
 await page.locator('#ofdFile').setInputFiles(path.join(folder,'ofd.xlsx'));
 await page.waitForFunction(()=>window.OksanaPlanning.state.ofd&&!window.OksanaPlanning.state.busy);
 await page.locator('#asOf').fill('2026-11-02');await page.locator('#asOf').dispatchEvent('change');
 await page.locator('#onecFile').setInputFiles(path.join(folder,'onec.xlsx'));
 await page.waitForFunction(()=>window.OksanaPlanning.state.onec&&!window.OksanaPlanning.state.busy);
 await page.locator('#vat').selectOption('with');
 for(const [product,value]of [['ofd','1000'],['onec','7000']]){
  const input=page.locator('[data-check="'+product+'"][data-channel="Партнёры"]');await input.fill(value);await input.dispatchEvent('change');
 }
 let summary=await page.evaluate(()=>({money:OksanaPlanning.state.plan.money,ofd:OksanaPlanning.state.plan.products.ofd.rows.length,onec:OksanaPlanning.state.plan.products.onec.rows.length,complete:OksanaPlanning.state.plan.complete}));
 assert.deepEqual(summary,{money:15000,ofd:1,onec:2,complete:true});
 await page.locator('#retroFrom').fill('2026-01-01');await page.locator('#retroFrom').dispatchEvent('change');
 assert.equal(await page.locator('#export').isDisabled(),true);assert.equal(await page.evaluate(()=>OksanaPlanning.state.plan),null);
 await page.locator('#retroFrom').fill('2025-01-01');await page.locator('#retroFrom').dispatchEvent('change');
 assert.equal(await page.evaluate(()=>OksanaPlanning.state.plan.money),15000);
 await page.screenshot({path:path.join(folder,'checks.png'),fullPage:true});
 await page.locator('[data-tab="channels"]').click();assert.equal(await page.locator('#view tbody tr').count(),1);
 await page.screenshot({path:path.join(folder,'channels.png'),fullPage:true});
 await page.locator('[data-tab="months"]').click();assert.equal(await page.locator('#view tbody tr').count(),12);
 await page.screenshot({path:path.join(folder,'months.png'),fullPage:true});
 await page.locator('[data-tab="retro"]').click();assert.equal(await page.locator('#view tr[data-cohort]').count(),8);
 const cohort=page.locator('tr[data-cohort="5+ лет / 2+ кассы"]');
 await cohort.locator('.reason').fill('Проверка сценария');await cohort.locator('.reason').dispatchEvent('change');
 const p=page.locator('tr[data-cohort="5+ лет / 2+ кассы"] .prob');await p.fill('50');await p.dispatchEvent('change');
 assert.equal(await page.evaluate(()=>OksanaPlanning.state.plan.products.ofd.rows[0].amount),500);
 await page.locator('[data-reset="5+ лет / 2+ кассы"]').click();
 assert.equal(await page.evaluate(()=>OksanaPlanning.state.plan.products.ofd.rows[0].amount),1000);
 await page.screenshot({path:path.join(folder,'retro.png'),fullPage:true});
 await page.locator('[data-tab="clients"]').click();await page.locator('#productView').selectOption('onec');
 assert.equal(await page.locator('#view tbody tr').count(),2);
 await page.locator('#query').fill(b);assert.equal(await page.locator('#view tbody tr').count(),1);
 await page.screenshot({path:path.join(folder,'clients.png'),fullPage:true});
 await page.locator('[data-tab="checks"]').click();
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;
 const out=path.join(folder,'browser-export.xlsx');await download.saveAs(out);
 const result=X.read(fs.readFileSync(out),{type:'buffer',cellFormula:true});
 assert.equal(result.Sheets['Клиенты'].M2.v,1000);assert.equal(result.Sheets['Клиенты'].M3.v,7000);
 assert.equal(result.Sheets['Клиенты'].M4.v,7000);assert.equal(result.Sheets['Проверки'].B8.v,15000);
 await page.reload();await page.waitForFunction(()=>!!window.OksanaPlanning);
 assert.equal(await page.evaluate(()=>OksanaPlanning.state.params.checks.onec['Партнёры']),7000);
 assert.equal(await page.evaluate(()=>OksanaPlanning.state.params.checks.ofd['Партнёры']),1000);
 assert.equal(await page.evaluate(()=>OksanaPlanning.state.ofd),null);
 assert.equal(await page.evaluate(()=>localStorage.getItem('ofd.planning.v1')),null);
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:path.join(folder,'mobile.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 console.log('PASS WEB BROWSER: real file-input uploads, product prices, months, manual probabilities, search, Excel download, reload persistence, mobile layout, no external requests');

 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
