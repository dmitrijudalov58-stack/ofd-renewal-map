const assert=require('node:assert/strict'),P=require('../js/planning-v2/core.js'),T=require('../js/planning-v2/retention.js'),B=require('../js/planning-v2/bi-check.js'),M=require('../js/metrics.js'),d=P.day;
const rec=(inn,unit,start,end)=>({inn,unit,start,end,pin:[inn,unit,start,end].join('-'),org:'Client '+inn,months:12,partner:'P',partnerInn:'P',center:''});
const row=(inn,renewed=true,complete=true)=>({inn,org:'Client '+inn,anchor:d(2025,1,1),renewed,complete});
const records=[
 rec('1','A',d(2024),d(2025,5,4)),rec('1','A',d(2025,6,3)+14/24,d(2027)), // whole day30
 rec('2','B',d(2024),d(2025,2,1)),rec('2','C',d(2024),d(2027)), // another register preserves coverage
 rec('3','D',d(2024),d(2025,2,1)),rec('3','D',d(2025,4,1),d(2025,5,1)),rec('3','D',d(2025,7,1),d(2027)), // repeated exits / return
 rec('4','E',d(2024),d(2025,3,1)),rec('4','E',d(2025,4,1),d(2027)), // day31
 rec('5','F',d(2024),d(2025,12,20)), // incomplete at cutoff
 rec('6','G',d(2024),d(2025,6,1)),rec('6','G',d(2025,1,1),d(2027)) // advance renewal stays covered
];
const ledger=P.ledger(records),rows=T.build(ledger,[row('1'),row('2',false),row('3'),row('4',false),row('5',false,false),row('6')],2025,d(2026,1,1)),s=T.summarize(rows);
assert.equal(s.closed,5);assert.equal(s.retained,3);assert.equal(s.churn,2);assert.equal(s.unfinished,1);assert.equal(s.returned,2);assert.equal(s.rate,.6);assert.equal(s.rate+s.churnRate,1);
assert.equal(rows[1].retained,true);assert.equal(rows[1].renewed,false);assert.equal(rows[2].retained,false);assert.equal(rows[2].renewed,true);assert.equal(rows[2].retentionEvents.length,2);assert.equal(rows[5].retained,true);
assert.equal(T.reconcile(rows).state,'ok');assert.equal(T.reconcile(rows,{...s,retained:s.retained+1}).state,'error');assert.equal(T.reconcile([...rows,rows[0]]).state,'error');assert.equal(T.reconcile([{...rows[0],retained:false}]).state,'error');assert.equal(T.reconcile([]).state,'empty');assert.equal(T.reconcile([rows[4]]).state,'pending');
assert.equal(T.reconcile(T.build(ledger,[row('missing')],2025,d(2026))).state,'error');
const calendarGap=T.gaps([{start:d(2024),end:d(2025,5,4)},{start:d(2025,6,3)+23.999/24,end:d(2027)}],d(2026));assert.equal(calendarGap[0].status,'safe');
assert.equal(T.gaps([{start:d(2024),end:d(2025,5,4)},{start:d(2025,6,4),end:d(2027)}],d(2026))[0].status,'churned');
// Unknown future activations must not cure a historical gap.
const futureLedger=P.ledger([rec('7','Q',d(2024),d(2025,1,1)),rec('7','Q',d(2025,3,1),d(2027))]);assert.equal(T.build(futureLedger,[row('7')],2025,d(2025,2,15))[0].retained,false);
const jsDate=n=>{const t=new Date((n-25569)*86400000);return new Date(t.getUTCFullYear(),t.getUTCMonth(),t.getUTCDate(),t.getUTCHours(),t.getUTCMinutes(),t.getUTCSeconds());};
const model=M.buildModel(records.map(r=>({status:'Зарегистрировано',rnm:r.unit,innOrg:r.inn,activated:jsDate(r.start),endDate:jsDate(r.end),tariff:'12',org:r.org})),{strict:true});
const c=B.compareRetention(M,model,rows,rows,2025,'2025-12-31');assert.equal(c.state,'matched');assert.equal(c.common,5);assert.equal(c.retained,3);assert.equal(c.calendarChurn,2);assert.equal(c.biChurn,3);assert.equal(c.adjustments.length,1);assert.equal(c.adjustments[0].inn,'1');assert.ok(c.adjustments[0].boundaryDates.includes('14:00'));assert.equal(c.differences.length,0);assert.equal(c.sum,1);assert.equal(c.source.b1Total,4);assert.equal(c.selectedEvents,4);assert.equal(c.selectedUnique,3);assert.equal(c.repeated,1);
assert.equal(B.compareRetention(M,model,rows,[],2025,'2025-12-31').state,'empty');assert.equal(B.compareRetention(M,null,rows,rows,2025,'2025-12-31').state,'unavailable');assert.equal(B.compareRetention(M,model,rows,[rows[4]],2025,'2025-12-31').state,'pending');assert.equal(B.compareRetention(M,model,rows,[rows[0],rows[0]],2025,'2025-12-31').state,'error');
const missing=T.build(ledger,[row('404')],2025,d(2026));assert.equal(B.compareRetention(M,model,missing,missing,2025,'2025-12-31').state,'incomplete');
// Balanced totals must not conceal two wrong client outcomes.
const swapped=[{...rows[1],retained:false,retentionEvents:[{}]},{...rows[2],retained:true,retentionEvents:[]}],mismatch=B.compareRetention(M,model,rows,swapped,2025,'2025-12-31');assert.equal(mismatch.sum,1);assert.equal(mismatch.state,'different');assert.equal(mismatch.differences.length,2);
assert.equal(T.NOTE.join(' ').includes('Старый B1'),false,'Approved explanatory text excludes removed sentence');
// Inclusive as-of includes the entire last grace day in BOTH independent models.
const tail=P.ledger([rec('8','TAIL',d(2024),d(2025,1,1))]),tailRows=T.build(tail,[row('8',false)],2025,d(2025,2,1)),tailModel=M.buildModel([{status:'Зарегистрировано',rnm:'TAIL',innOrg:'8',activated:new Date(2024,0,1),endDate:new Date(2025,0,1)}],{strict:true});
assert.equal(B.compareRetention(M,tailModel,tailRows,tailRows,2025,'2025-01-31').state,'matched');assert.equal(B.compareRetention(M,tailModel,tailRows,tailRows,2025,'2025-01-31').calendarChurn,1);
// A non-midnight expiry can make rounded elapsed days disagree in the opposite direction.
const reverseRecords=[rec('9','REV',d(2024),d(2025,1,1)+23/24),rec('9','REV',d(2025,2,1),d(2027))],reverseRows=T.build(P.ledger(reverseRecords),[row('9',false)],2025,d(2026)),reverseModel=M.buildModel(reverseRecords.map(r=>({status:'Зарегистрировано',rnm:r.unit,innOrg:r.inn,activated:jsDate(r.start),endDate:jsDate(r.end)})),{strict:true}),reverse=B.compareRetention(M,reverseModel,reverseRows,reverseRows,2025,'2025-12-31');
assert.equal(reverse.state,'matched');assert.equal(reverse.biChurn,0);assert.equal(reverse.calendarChurn,1);assert.equal(reverse.adjustments.length,1);assert.ok(reverse.adjustments[0].reason.includes('после 30-го'));assert.ok(reverse.adjustments[0].boundaryDates.includes('23:00'));
console.log('PASS retention: all-register coverage, advance renewal, day30/31, cutoff, repeats/returns, pending/missing/empty, independent B1/calendar outcomes, per-INN integrity and approved note');
