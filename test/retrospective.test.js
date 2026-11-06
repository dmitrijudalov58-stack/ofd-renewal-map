const assert=require('node:assert/strict'),P=require('../js/planning-v2/core.js'),R=require('../js/planning-v2/retro.js'),d=P.day;
const r=(inn,unit,start,end,months,partner='Партнёр',partnerInn='P')=>({inn,unit,start,end,months,partner,partnerInn,pin:[inn,unit,start,end,partner].join('-'),org:'Client '+inn,center:''});
const old=r('1','A',d(2024),d(2025,2,1),15),next=r('1','A',d(2025,2,15),d(2028,2,15),36);
const records=[old,next,r('1','B',d(2024),d(2025,3,1),15),r('1','B',d(2025,3,2),d(2028,3,2),36),
 r('2','A',d(2024),d(2025,5,1),15),r('2','A',d(2025,6,1),d(2028),36), // day31 is not renewal/upsell
 r('3','A',d(2024),d(2025,6,1),15),r('3','A',d(2025,6,2),d(2026,9,2),15), // no upsell
 r('4','A',d(2025,7,1),d(2026),15), // truly new
 r('5','A',d(2020),d(2025,8,1),15,'Ольга Зибер','O'),r('5','B',d(2020),d(2025,8,1),15), // mixed attribution
 r('6','A',d(2020),d(2025,9,1),15,'',''), // unknown
 r('7','A',d(2024),d(2025,10,15),15),r('7','A',d(2025,10,16),d(2028),36), // early/unfinished
 r('8','A',d(2024),d(2025,12,1),15), // pending
];
const ofd=P.ledger(records),data=R.build(ofd,null,null,'ofd',2025,d(2025,11,1));
let all=R.select(data.rows,{mode:'channel',channels:null}),s=R.summarize(all);
assert.equal(all.length,P.retro(ofd,'ofd',d(2025),d(2025,12,31),d(2025,11,1)).rows.length);
assert.equal(s.due,7);assert.equal(s.actual,3);assert.equal(s.pending,1);assert.equal(s.lost,3);assert.equal(s.closed,5);assert.equal(s.closedRenewed,2);assert.equal(s.early,1);assert.equal(s.rate,2/5);
assert.equal(s.upsellClients,2);assert.equal(s.upsellRate,2/3);assert.equal(s.upsellRegisters,3);assert.equal(s.renewedRegisters,4);assert.equal(s.transitions.length,3);
const a=R.select(data.rows,{mode:'channel',channels:['Ольга Зибер','Партнёры']});assert.equal(new Set(a.map(r=>r.inn)).size,a.length);assert.equal(a.filter(r=>r.inn==='5').length,1);
assert.equal(R.select(data.rows,{mode:'channel',channels:[]}).length,0);assert.equal(R.select(data.rows,{mode:'channel',channels:[P.UNKNOWN]}).length,1);
assert.equal(R.select(data.rows,{mode:'partner',partner:R.partnerKey({partner:'Ольга Зибер',partnerInn:'O'})}).length,1);assert.equal(R.select(data.rows,{mode:'partner',partner:R.partnerKey({partner:'Партнёр',partnerInn:'P'})}).length,6);
assert.deepEqual(data.newRows.map(r=>r.inn),['4']);
// Same INN moving channels does not become new, and duplicate rows don't change results.
assert.equal(R.build(P.ledger([...records,old,next]),null,null,'ofd',2025,d(2025,11,1)).rows.length,s.due);
const later=R.build(ofd,null,null,'ofd',2025,d(2026,2,1));assert.equal(R.summarize(later.rows).pending,0);
// Same register can upsell twice: two events, one cash register and one client.
const repeated=P.ledger([r('9','X',d(2024),d(2025,1,1),1),r('9','X',d(2025,1,2),d(2025,4,2),3),r('9','X',d(2025,4,3),d(2026,4,3),12)]);
const repeatStats=R.summarize(R.build(repeated,null,null,'ofd',2025,d(2026,2,1)).rows);assert.equal(repeatStats.upsellClients,1);assert.equal(repeatStats.upsellRegisters,1);assert.equal(repeatStats.transitions.length,2);
// Unknown tariffs must remain unknown, not become zero-month upsells.
const unknown=P.ledger([r('9','X',d(2024),d(2025,1,1),null),r('9','X',d(2025,1,2),d(2026),36)]);assert.equal(R.summarize(R.build(unknown,null,null,'ofd',2025,d(2026)).rows).upsellClients,0);
const base=P.ledger([r('1','SN',d(2024),d(2025,2,1),12)]),promos={records:[{...r('1','promo-client:1',d(2025,2,2),d(2026,2,2),12),source:'promo'}]};
const merged=R.build(ofd,base,promos,'onec',2025,d(2026));assert.equal(R.summarize(merged.rows).actual,1);assert.equal(merged.rows[0].partners.includes(R.partnerKey({partner:'Партнёр',partnerInn:'P'})),true);assert.equal(R.summarize(merged.rows).transitions.length,0);
assert.equal(R.build(null,null,null,'ofd',2025,d(2026)),null);
// Partner label variants must not duplicate the same underlying transition.
const variants=P.ledger([old,{...old,partner:'Renamed partner'},next]);assert.equal(R.summarize(R.build(variants,null,null,'ofd',2025,d(2026)).rows).transitions.length,1);
const advance=P.ledger([r('10','A',d(2024),d(2025,6,1),15),r('10','A',d(2025,1,1),d(2028),36)]);assert.equal(R.summarize(R.build(advance,null,null,'ofd',2025,d(2025,2,1)).rows).upsellClients,1);
const directory=[{key:'lk',label:'АО «Калуга Астрал» (ЛК ОФД) · 7700000091'},{key:'atol',label:'ООО «АТОЛ» (ОФД) · 7700000092'}];
for(const term of ['ЛК','лк','LK'])assert.deepEqual(R.findPartners(directory,term).map(p=>p.key),['lk']);
for(const term of ['Атолл','АТОЛ','atoll','Атол ОФД'])assert.deepEqual(R.findPartners(directory,term).map(p=>p.key),['atol']);
assert.equal(R.findPartners(directory,'OFD').length,2);assert.equal(R.findPartners(directory,'7700000091')[0].key,'lk');assert.equal(R.findPartners(directory,'never-matches').length,0);
const dormant=r('20','Q',d(2024),d(2028),36,'ООО «АТОЛ» (ОФД)','7700000092');
const future=r('21','Q',d(2027),d(2028),12,'Not yet known','future');
const expanded=R.build(P.ledger([...records,dormant,future]),null,null,'ofd',2025,d(2025,11,1));
assert.equal(R.findPartners(expanded.partners,'Атолл').length,1);assert.equal(R.select(expanded.rows,{mode:'partner',partner:R.partnerKey(dormant)}).length,0);assert.equal(R.findPartners(expanded.partners,'Not yet known').length,0);assert.equal(expanded.rows.length,data.rows.length);assert.equal(expanded.partners.filter(p=>p.key==='unknown').length,1);
const audit=R.reconcile(data.rows,s);assert.equal(audit.state,'ok');assert.equal(audit.rate,.4);assert.equal(audit.churnRate,.6);assert.equal(audit.annualGap,0);assert.equal(audit.closedGap,0);
const wrong=R.reconcile(data.rows,{...s,actual:s.actual+1});assert.equal(wrong.ok,false);assert.equal(wrong.state,'error');assert.equal(wrong.annualGap,-1);
assert.equal(R.reconcile(data.rows,{...s,rate:.99}).ok,false);
assert.equal(R.reconcile([...data.rows,data.rows[0]]).state,'error','Balanced arithmetic must not hide duplicate INNs');
assert.equal(R.reconcile([{...data.rows[0],unitsRenewed:999}]).state,'error');
assert.equal(R.reconcile([]).state,'empty');assert.equal(R.reconcile([]).rate,null);
const waiting=data.rows.filter(r=>!r.complete);assert.equal(R.reconcile(waiting).state,'pending');assert.equal(R.reconcile(waiting).rate,null);assert.equal(R.reconcile(waiting).annualGap,0);
const lkName='АО "Калуга Астрал" (ЛК ОФД)',pinName='АО "Калуга Астрал" (Пин-коды)',sharedInn='7700000080';
const splitRecords=[r('31','A',d(2024),d(2025,2,1),15,lkName,sharedInn),r('31','A',d(2025,2,2),d(2028),36,lkName,sharedInn),r('32','B',d(2024),d(2025,3,1),15,pinName,sharedInn),r('33','C',d(2025,4,1),d(2026),15,lkName,sharedInn),r('34','D',d(2025,4,1),d(2026),15,pinName,sharedInn)];
const splitData=R.build(P.ledger(splitRecords),null,null,'ofd',2025,d(2026));
const lkKey=R.partnerKey(splitRecords[0]),pinKey=R.partnerKey(splitRecords[2]);assert.notEqual(lkKey,pinKey);assert.equal(splitData.partners.filter(p=>p.inn===sharedInn).length,2);
assert.deepEqual(R.select(splitData.rows,{mode:'partner',partner:lkKey}).map(r=>r.inn),['31']);assert.deepEqual(R.select(splitData.rows,{mode:'partner',partner:pinKey}).map(r=>r.inn),['32']);
assert.deepEqual(R.select(splitData.newRows,{mode:'partner',partner:lkKey}).map(r=>r.inn),['33']);assert.deepEqual(R.select(splitData.newRows,{mode:'partner',partner:pinKey}).map(r=>r.inn),['34']);assert.equal(R.summarize(splitData.rows).due,2);
assert.equal(splitData.partners.some(p=>p.label.includes(' / ')),false);assert.equal(R.findPartners(splitData.partners,sharedInn).length,2);
assert.deepEqual(R.findPartners([...splitData.partners,{key:'elkom',label:'ООО "РУС-ЭЛКОМ" ОФД · 7700000081'}],'лк офд').map(p=>p.key),[lkKey]);
assert.notEqual(R.partnerKey({partner:lkName,partnerInn:'other'}),lkKey);
const splitOne=R.build(P.ledger(splitRecords),P.ledger([r('31','SN',d(2024),d(2025,2,1),15),r('32','SN',d(2024),d(2025,3,1),15)]),null,'onec',2025,d(2026));assert.deepEqual(R.select(splitOne.rows,{mode:'partner',partner:lkKey}).map(r=>r.inn),['31']);
console.log('PASS retrospective: annual INNs, all/union/empty/partner/unknown filters, new clients, pending and early, cash/client upsell, duplicates, tariff gaps, promo INN linkage');
