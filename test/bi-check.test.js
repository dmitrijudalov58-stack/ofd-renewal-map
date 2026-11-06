const assert=require('node:assert/strict'),M=require('../js/metrics.js'),B=require('../js/planning-v2/bi-check.js');
const dt=(m,d)=>new Date(2025,m-1,d),iv=(a,b)=>({start:a,end:b}),client=(id,intervals)=>({key:id,org:'Client '+id,phys:false,kassas:[{intervals}]}),model=(...clients)=>({clients:new Map(clients.map(c=>[c.key,c]))}),r=(inn,renewed,complete=true)=>({inn,org:'Client '+inn,anchor:45689,complete,renewed});
let m=model(client('1',[iv(dt(1,1),dt(2,1)),iv(dt(2,15),dt(12,31))]),client('2',[iv(dt(1,1),dt(3,1))]));
let rows=[r('1',true),r('2',false)],d=B.compare(M,m,rows,rows,2025,'2025-12-31');
assert.equal(d.state,'matched');assert.equal(d.source.b1Total,1);assert.equal(d.source.sourceMatches,true);assert.equal(d.common,2);assert.equal(d.rate,.5);assert.equal(d.churnRate,.5);assert.equal(d.sum,1);assert.equal(d.differences.length,0);assert.equal(B.compare(M,m,rows,[rows[0],rows[0]],2025,'2025-12-31').state,'error');
// A renewed client can churn later; a non-renewed expiring register can coexist with other coverage.
m=model(client('1',[iv(dt(1,1),dt(2,1)),iv(dt(2,15),dt(3,1))]),client('2',[iv(dt(1,1),dt(12,31))]));
d=B.compare(M,m,rows,rows,2025,'2025-12-31');assert.equal(d.sum,1);assert.equal(d.delta,0);assert.equal(d.state,'different');assert.equal(d.differences.length,2,'Equal counts do not mean complementary membership');assert.ok(d.differences[1].reason.includes('покрытие'));
// Raw B1 preserves every churn, including multiple exits by the same INN.
m=model(client('1',[iv(dt(1,1),dt(2,1)),iv(dt(4,1),dt(5,1)),iv(dt(7,1),dt(12,31))]),client('9',[iv(dt(1,1),dt(2,1))]));
rows=[r('1',true)];d=B.compare(M,m,rows,rows,2025,'2025-12-31');assert.equal(d.source.b1Total,3);assert.equal(d.selectedEvents,2);assert.equal(d.selectedUnique,1);assert.equal(d.repeated,1);assert.equal(d.outside.length,1);assert.equal(d.outside[0].inn,'9');assert.equal(d.sum,2);
assert.equal(B.compare(M,m,rows,[],2025,'2025-12-31').state,'empty');
assert.equal(B.compare(M,m,[r('404',false)],[r('404',false)],2025,'2025-12-31').state,'incomplete');
assert.equal(B.compare(M,m,rows,[r('1',true,false)],2025,'2025-12-31').state,'pending');
assert.equal(B.compare(M,null,rows,rows,2025,'2025-12-31').state,'unavailable');
// Do not use a synthetic complement: real B1 below the grace boundary has no confirmed churn.
m=model(client('1',[iv(dt(1,1),dt(2,1))]));d=B.compare(M,m,[r('1',false,false)],[r('1',false,false)],2025,'2025-02-15');assert.equal(d.source.b1Total,0);assert.equal(d.common,0);assert.equal(d.sum,null);
// Missing membership on one side is explicit and never silently treated as no churn.
m=model(client('1',[iv(dt(1,1),dt(12,31))]));rows=[r('1',true),r('2',false)];d=B.compare(M,m,rows,rows,2025,'2025-12-31');assert.equal(d.common,1);assert.equal(d.missing,1);assert.equal(d.state,'incomplete');assert.equal(d.differences[0].category,'Не сопоставлен');
const brokenModel=model(client('1',[iv(dt(1,1),dt(2,1))]));assert.equal(B.compare({...M,computeGapFlow:()=>({churnByMonth:[99]})},brokenModel,[r('1',false)],[r('1',false)],2025,'2025-12-31').state,'error');
console.log('PASS B1 comparison: exact source flow, shared mature base, membership vs totals, repeats, outside-year-base, missing, pending, empty');
