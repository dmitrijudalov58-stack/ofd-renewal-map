"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const P = require("../js/planning.js");

function fixture() {
  const end = new Date(2027, 5, 15);
  const kassas = [12, 36].map((tariff, i) => {
    const code = { pin: `PIN${i}`, tariff: `${tariff} месяцев`, activated: new Date(2026, 0, 1), endDate: end };
    return { rnm: `RNM${i}`, clientKey: `770000000${i}`, org: `Клиент ${i}`, channel: "Партнёры", codes: [code], intervals: [{ start: code.activated, end }] };
  });
  return { kassas: new Map(kassas.map((k) => [k.rnm, k])), clients: new Map(kassas.map((k) => [k.clientKey, { key: k.clientKey, org: k.org, phys: false, kassas: [k] }])) };
}
function plan(params, records = null) { return P.buildPlan(fixture(), new Date(2026, 10, 3), params, records, {}, { file1cName: records ? "1c.xlsx" : null }); }

 test("general check and probability apply to all tariffs; private falls back to general", () => {
  const params = P.defaultParams();
  params.checks["c|ofd|Партнёры|all"] = 1000;
  params.probManual["g|ofd|Партнёры"] = 0.5;
  params.checks["c|ofd|Партнёры|12"] = 3000;
  params.probManual["ofd|12|first"] = 0.9;
  const general = plan(params);
  assert.deepEqual(general.ofd.map((row) => row.amount), [500, 500]);
  const partial = plan({ ...params, priceMode: "partial" });
  assert.deepEqual(partial.ofd.map((row) => row.amount), [2700, 500]);
  const spec = P.buildWorkbook(partial);
  const sheet = spec.sheets.find((entry) => entry.sheetName === "Описание и параметры");
  assert.equal(sheet.preamble[11][1], "Частный");
  assert.ok(sheet.rows.some((row) => row[0].v === "c|ofd|Партнёры|all"));
  assert.match(sheet.rows.find((row) => row[0].v === "c|ofd|Партнёры|12")[8].f, /\$B\$12/);
});

test("new 1C sale uses observed buyer share and no historical tariff prices", () => {
  const params = P.defaultParams();
  params.checks["c|upsell|Партнёры|all"] = 2000;
  params.upsell["7700000001"] = { selected: true, month: "2027-04" };
  const records = [{ inn: "7700000000", kktSerial: "SN", tariffStart: new Date(2026, 0, 1), tariffEnd: new Date(2027, 5, 15), months: 12, sheetName: "1C" }];
  const result = plan(params, records);
  assert.equal(result.upsell.length, 1);
  assert.equal(result.upsell[0].prob, 0.5);
  assert.equal(result.upsell[0].amount, 1000);
  assert.equal(plan(P.defaultParams(), records).upsell[0].check, null);
});
