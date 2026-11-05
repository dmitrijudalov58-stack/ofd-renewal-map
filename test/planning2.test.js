const assert=require('node:assert/strict'),fs=require('node:fs'),P=require('../js/planning-v2/core.js'),X=require('../js/vendor/xlsx.full.min.js'),E=require('../js/export.js');
const d=P.day;
function r(inn,unit,start,end,pin,extra={}){return {inn,unit,start,end,pin,overall:null,months:15,partner:'Партнёр',partnerInn:'7700000000',org:'Клиент '+inn,center:'',file:'test.xlsx',sheet:'Лист1',row:2,...extra};}
let tests=0;function test(name,fn){fn();tests++;console.log('OK',name);}
test('Даты, границы когорт и ведущие нули',()=>{assert.equal(P.date('31.12.2025'),d(2025,12,31));assert.equal(P.date('2025-02-30'),null);assert.equal(P.age(d(2024,2,10),d(2025,2,9)),'<1 года');assert.equal(P.age(d(2024,2,10),d(2025,2,10)),'1–<3 лет');assert.equal(P.inn('123456789'),'0123456789');assert.equal(P.num(''),null);assert.equal(P.num('0'),0);});
test('Пустые месячные листы 1С не становятся клиентами и не мешают наполненным',()=>{const wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([['Ключ доступа']]),'Пустой');X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([['Ключ доступа','ИНН покупателя','Заводской номер ККТ','Начало действия тарифа','Окончание действия тарифа','Количество месяцев','Итоговая сумма','Сумма роялти'],['X','7700000001','SN','2024-01-01','2025-04-01',15,100,50]]),'Месяц');assert.equal(P.parseWorkbook(X,wb,'onec','1c.xlsx').records.length,1);});
test('30-й день целиком входит, 31-й — нет',()=>{const a=r('1','a',d(2024),d(2025), 'a');const b=r('1','a',d(2025,1,31)+.9,d(2026),'b');assert.equal(P.outcome([a,b],a,d(2026)).renewed,true);b.start=d(2025,2,1);assert.equal(P.outcome([a,b],a,d(2026)).renewed,false);});
const fixture=[
 r('1','a',d(2020),d(2025,2,1),'a1'),r('1','a',d(2025,2,15),d(2027,4,1),'a2'),
 r('1','b',d(2021),d(2025,5,1),'b1'),r('1','b',d(2025,6,5),d(2027,7,1),'b2'),
 r('2','c',d(2020),d(2025,3,1),'c1'),
 r('3','z',d(2022),d(2028),'z1'),
];
const led=P.ledger(fixture),params={...P.defaults(),asOf:'2026-11-02',vat:'with'};
test('Ретро по ИНН, частичное продление и отсутствие подглядывания',()=>{const rt=P.retro(led,'ofd',d(2025),d(2025,12,31),d(2026,11,2));const a=rt.rows.find(r=>r.inn==='1');assert.equal(a.renewed,true);assert.equal(a.unitsRenewed,1);assert.equal(a.due,2);assert.equal(a.kassas,2);assert.equal(rt.rows.length,2);assert.equal(rt.stats.get('5+ лет / 2+ кассы').rate,1);const fut=P.ledger([...fixture,r('1','new',d(2025,8),d(2028),'new')]);assert.equal(P.retro(fut,'ofd',d(2025),d(2025,12,31),d(2026,11,2)).rows.find(r=>r.inn==='1').kassas,2);});
test('Один ИНН в год, первый месяц, нулевой/пустой чек, формула без касс',()=>{let plan=P.build(led,null,params);assert.equal(plan.products.ofd.rows.length,1);const a=plan.rows[0];assert.equal(a.month,'2027-04');assert.equal(a.dueUnits,2);assert.equal(a.amount,null);const p=P.normalizeParams(params);p.checks.ofd['Партнёры']=1000;plan=P.build(led,null,p);assert.equal(plan.rows[0].amount,1000);p.checks.ofd['Партнёры']=0;assert.equal(P.build(led,null,p).rows[0].amount,0);assert.equal(P.build(led,null,p).complete,false);});
test('Привязка канала к первому окончанию, неоднозначность и ручное разрешение',()=>{const data=P.ledger([...fixture,r('1','d',d(2024),d(2027,4,1),'d',{partner:'АО "Калуга Астрал" (ЛК ОФД)'})]);const p=P.normalizeParams(params);let plan=P.build(data,null,p);assert.equal(plan.rows[0].channel,P.UNKNOWN);p.channels[plan.rows[0].id]='Корп';p.checks.ofd['Корп']=2000;plan=P.build(data,null,p);assert.equal(plan.rows[0].channel,'Корп');assert.equal(plan.rows[0].amount,2000);});
test('1С: отдельные чеки, тот же серийный номер у разных ИНН, канал ИНН без окончания ОФД',()=>{const one=P.ledger([
 r('1','SN',d(2020),d(2025,2,1),'x1'),r('1','SN',d(2025,2,2),d(2027,6,1),'x2'),
 r('3','SN',d(2020),d(2025,3,1),'y1'),r('3','SN',d(2025,3,2),d(2027,8,1),'y2'),
 r('9','SN',d(2020),d(2027,9,1),'z')]);
 const p=P.normalizeParams(params);p.checks.ofd['Партнёры']=1000;p.checks.onec['Партнёры']=7000;
 const plan=P.build(led,one,p);assert.equal(plan.products.onec.rows.length,3);assert.equal(plan.products.onec.retro.rows.length,2);assert.equal(plan.products.onec.retro.stats.get('Все клиенты').rate,1);assert.equal(plan.products.onec.rows.find(r=>r.inn==='3').channel,'Партнёры');assert.equal(plan.products.onec.rows.find(r=>r.inn==='3').amount,7000);assert.equal(plan.products.onec.rows.find(r=>r.inn==='9').amount,null);assert.equal(plan.products.ofd.rows[0].amount,1000);});
test('Ручная вероятность требует причины и не загрязняет исходный ретро-кэш',()=>{const p=P.normalizeParams(params);p.checks.ofd['Партнёры']=1000;p.manual.ofd['5+ лет / 2+ кассы']={value:.2,reason:''};assert.equal(P.build(led,null,p).rows[0].prob,1);p.manual.ofd['5+ лет / 2+ кассы'].reason='Сценарий';assert.equal(P.build(led,null,p).rows[0].amount,200);delete p.manual.ofd['5+ лет / 2+ кассы'];assert.equal(P.build(led,null,p).rows[0].amount,1000);});
test('Незакрытый период не выдаёт расчётную вероятность',()=>{const p=P.normalizeParams(params);p.retroTo='2026-12-31';assert.equal(P.build(led,null,p).rows[0].prob,null);});
test('Пустой период не подменяется другим периодом',()=>{assert.throws(()=>P.build(led,null,{...params,retroFrom:''}),/Заполните/);assert.throws(()=>P.build(led,null,{...params,asOf:''}),/Заполните/);});
test('Уже продлённые за плановый год не попадают в базу; прошлый год имеет свой снимок',()=>{const more=P.ledger([...fixture,r('1','a',d(2026,6),d(2029),'future')]);assert.equal(P.build(more,null,params).rows[0].month,'2027-07');const p={...params,year:2025};assert.equal(P.build(more,null,p).products.ofd.rows.length,2);});
test('Excel: все листы, формулы, пустой чек, суммы и текстовые ИНН',()=>{const plan=P.build(led,null,params),spec=P.workbook(plan),bytes=E.buildXlsx(spec);const wb=X.read(bytes,{type:'array',cellFormula:true});assert.equal(wb.SheetNames.length,8);assert.ok(wb.Sheets['Клиенты'].M2.f.includes('K2*L2'));assert.equal(wb.Sheets['Клиенты'].B2.t,'s');assert.equal(wb.Sheets['Клиенты'].M2.v,'');assert.ok(wb.Sheets['Проверки'].B8.f.includes('SUM'));fs.writeFileSync('/private/tmp/planning2-test.xlsx',bytes);});
test('Пустая плановая база экспортируется с корректными стилями и нулём, а не ошибкой',()=>{const p={...params,year:2030};const plan=P.build(led,null,p);const wb=X.read(E.buildXlsx(P.workbook(plan)),{type:'array'});assert.equal(plan.rows.length,0);assert.equal(wb.Sheets['Проверки'].B8.v,0);});
console.log('PASS',tests,'tests');
if(process.env.OFD_REAL_FILE){
 const t=Date.now();console.log('REAL: reading source');const wb=X.read(fs.readFileSync(process.env.OFD_REAL_FILE),{type:'buffer',dense:true,cellDates:false});
 const parsed=P.parseWorkbook(X,wb,'ofd','ОФД.xlsx');const data=P.ledger(parsed.records);
 const rt=P.retro(data,'ofd',d(2025),d(2025,12,31),d(2026,11,2));
 if(process.env.P2_REFERENCE_FILE){const old=JSON.parse(fs.readFileSync(process.env.P2_REFERENCE_FILE,'utf8'));assert.equal(rt.rows.length,old.clients);assert.equal(rt.rows.filter(r=>r.renewed).length,old.renewed);for(const group of old.cohorts){const st=rt.stats.get(group.group);assert.equal(st.base,group.clients);assert.equal(st.renewed,group.renewed);}}
 const plan=P.build(data,null,params);assert.equal(new Set(plan.rows.map(r=>r.inn)).size,plan.rows.length);
 const p=P.normalizeParams(params);for(const ch of P.CHANNELS)p.checks.ofd[ch]=1000;
 const priced=P.build(data,null,p);assert.ok(priced.rows.every(r=>r.amount==null||Math.abs(r.amount-r.prob*1000)<1e-8));
 const renewed=rt.rows.filter(r=>r.renewed).length;
 console.log('PASS REAL',{clients2025:rt.rows.length,renewed2025:renewed,plan2027:plan.rows.length,unresolvedChannels:plan.products.ofd.total.missingChannel,ms:Date.now()-t});
 fs.writeFileSync('/private/tmp/planning2-real-summary.json',JSON.stringify({retro:rt.rows.length,renewed,plan:plan.rows.length,unknown:plan.products.ofd.total.missingChannel}));
}
