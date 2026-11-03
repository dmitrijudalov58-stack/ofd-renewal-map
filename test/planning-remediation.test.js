"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const P = require("../js/planning.js");
const XLSX = require("xlsx");
const { buildXlsx } = require("../js/export.js");

const asOf = new Date(2026, 10, 3);
const end = new Date(2027, 5, 15);
function makePlan(changes = {}) {
  const params = P.defaultParams();
  const code = { pin: "TEST", tariff: "12 месяцев", activated: new Date(2026, 0, 1), endDate: end };
  const kassa = { rnm: "RNM", clientKey: "7700000001", org: "Клиент", channel: "Партнёры", partner: "Партнёр", codes: [code], intervals: [{ start: code.activated, end }] };
  const client = { key: kassa.clientKey, org: kassa.org, phys: false, kassas: [kassa] };
  const model = { kassas: new Map([[kassa.rnm, kassa]]), clients: new Map([[client.key, client]]) };
  Object.assign(params, changes);
  return P.buildPlan(model, asOf, params, [], {}, { file1cName: "сверка.xlsx", sourceFiles: ["источник.xlsx"] });
}
function sheet(spec, name) { return spec.sheets.find((entry) => entry.sheetName === name); }

test("Excel channel formulas include the final detail row beyond 50000", () => {
  const plan = makePlan();
  const base = plan.ofd[0];
  plan.ofd = Array.from({ length: 50001 }, (_, i) => ({ ...base, id: `ofd|${i}` }));
  const spec = P.buildWorkbook(plan, { board: "channels" });
  const channel = sheet(spec, "По каналам").rows.find((row) => row[0] === "Партнёры");
  assert.match(channel[1].f, /\$P\$2:\$P\$50002/);
  assert.match(channel[2].f, /\$Q\$2:\$Q\$50002/);
});

test("invalid or out-of-year month cannot make budget ready", () => {
  const params = P.defaultParams();
  params.vat = "with";
  params.probManual["ofd|12|first"] = 0.5;
  params.checks["c|ofd|Партнёры|12"] = 1000;
  params.events["ofd|RNM"] = { month: "2028-99" };
  const plan = makePlan(params);
  assert.equal(plan.status.ready, false);
  assert.match(plan.status.gaps.join(" "), /месяц/);
});

test("Excel checks and status recalculate after filling a missing price", () => {
  const plan = makePlan({ vat: "with" });
  const spec = P.buildWorkbook(plan);
  const checks = sheet(spec, "Проверки");
  const missing = checks.rows.find((row) => row[0] === "Пустые чеки у строк в плане");
  assert.equal(typeof missing[1].f, "string", "missing count must be a live formula");
  assert.match(missing[1].f, /Продления ОФД/);
  const status = sheet(spec, "Описание и параметры").preamble[1][1];
  assert.match(status.f, /B8/, "status must account for 1C source coverage");
});

test("board export uses exact selected tariff, not overlapping prefix", () => {
  const plan = makePlan();
  const original = plan.ofd[0];
  plan.ofd = [original, { ...original, id: "ofd|OTHER", unit: "OTHER", tariff: 112, tariffLabel: "112 месяцев" }];
  const spec = P.buildWorkbook(plan, { board: "ofd", filter: { tariff: "12 месяцев" } });
  assert.equal(sheet(spec, "Продления ОФД").rows.length, 1);
});

test("board export contains every sheet referenced by its formulas", () => {
  const spec = P.buildWorkbook(makePlan(), { board: "ofd" });
  const names = spec.sheets.map((entry) => entry.sheetName);
  const dependent = ["Ретро ОФД", "По месяцам", "Сводный план", "По каналам"];
  assert.ok(dependent.every((name) => names.includes(name)), `missing: ${dependent.filter((name) => !names.includes(name))}`);
  const calc = sheet(spec, "Описание и параметры").rows.find((row) => row[0].v === "p|g|ofd|Партнёры");
  assert.ok(calc, "general probability row is included with backing retro sheet");
});

test("new tariff without retro has an editable probability row", () => {
  const plan = makePlan();
  assert.ok(plan.paramsRows.some((row) => row.storeKey === "p|d|ofd|Партнёры|12|first" && row.inputKind === "prob"), "forecast tariff is editable in partial mode even with no mature history");
  const spec = P.buildWorkbook(plan);
  assert.ok(sheet(spec, "Описание и параметры").rows.some((row) => row[0].v === "p|d|ofd|Партнёры|12|first"), "same parameter exists in Excel");
});

test("old month outside selected year remains visible but is counted as unassigned", () => {
  const params = P.defaultParams();
  params.probManual["ofd|12|first"] = 0.5;
  params.checks["c|ofd|Партнёры|12"] = 1200;
  const invalid = makePlan({ ...params, events: { "ofd|RNM": { month: "2028-01" } } });
  assert.equal(invalid.status.ready, false);
  const spec = P.buildWorkbook(invalid);
  assert.equal(sheet(spec, "Продления ОФД").rows[0][8], "не назначен");
  assert.equal(sheet(spec, "Продления ОФД").rows[0][26].v, 0);
});

test("large retro totals remain formulas grounded in compact event counts", () => {
  const plan = makePlan();
  const event = { product: "ofd", inn: "7700000001", tariff: 12, cycle: "first", end: asOf, unitId: "RNM", status: "зрелое", outcome: "продлили" };
  plan.retroOfd.events = Array.from({ length: 20001 }, () => ({ ...event }));
  const spec = P.buildWorkbook(plan);
  const retro = sheet(spec, "Ретро ОФД");
  const segment = retro.preamble.find((row) => row[0] === "ofd|12|first");
  assert.ok(retro.rows.length > 0 && retro.rows.length < 20001, "compressed source rows are present");
  assert.match(segment[3].f, /SUMIFS/);
  assert.equal(retro.headers[9], "Число событий");
});

test("retro board export includes a filtered view and complete backing sheets", () => {
  const plan = makePlan();
  const events = [
    { product: "ofd", tariff: 12, cycle: "first", status: "зрелое", outcome: "продлили", inn: "1", end: asOf, unitId: "A" },
    { product: "ofd", tariff: 112, cycle: "repeat", status: "зрелое", outcome: "не продлили", inn: "2", end: asOf, unitId: "B" },
  ];
  plan.retroOfd = { events, segments: P.aggregateRetro(events) };
  const spec = P.buildWorkbook(plan, { board: "retro", filter: { retroTariff: "12", retroCycle: "first" } });
  assert.ok(sheet(spec, "Ретро ОФД"), "full underlying retro remains for parameter formulas");
  const filtered = sheet(spec, "Отбор ретро ОФД");
  assert.ok(filtered, "filtered view exists");
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.preamble.filter((r) => typeof r[0] === "string" && r[0].startsWith("ofd|")).length, 1);
});


test("partial exports do not expose unfiltered forecast or retro customers", () => {
  const plan = makePlan();
  const first = { ...plan.ofd[0], inn: "7700000001", org: "Первый клиент", unit: "RNM-1", id: "ofd|first" };
  const second = { ...plan.ofd[0], inn: "7700000002", org: "Второй клиент", unit: "RNM-2", id: "ofd|second" };
  plan.ofd = [first, second];
  const retroEvents = [
    { product: "ofd", inn: first.inn, tariff: 12, cycle: "first", status: "зрелое", outcome: "продлили", end: asOf, unitId: first.unit },
    { product: "ofd", inn: second.inn, tariff: 12, cycle: "first", status: "зрелое", outcome: "продлили", end: asOf, unitId: second.unit },
  ];
  plan.retroOfd = { events: retroEvents, segments: P.aggregateRetro(retroEvents) };
  const filtered = P.buildWorkbook(plan, { board: "ofd", filter: { q: first.inn } });
  const filteredForecast = sheet(filtered, "Продления ОФД");
  const filteredRetro = sheet(filtered, "Ретро ОФД");
  assert.equal(filteredForecast.rows.length, 1, "forecast detail follows the selected search");
  assert.equal(filteredRetro.rows.some((row) => row[0]?.v === second.inn), false, "partial backing retro does not expose another customer");
  assert.equal(filteredRetro.rows.some((row) => row[0]?.v === first.inn), false, "partial backing retro is aggregate-only");
  assert.equal(Buffer.from(buildXlsx(filtered)).includes(Buffer.from(second.inn)), false, "no other customer INN anywhere in the XLSX");

  const retroSlice = P.buildWorkbook(plan, { board: "retro", filter: { retroTariff: "12", retroCycle: "first" } });
  assert.equal(sheet(retroSlice, "Продления ОФД").rows.length, 0, "retro slice has no unrelated forecast detail");
  assert.equal(sheet(retroSlice, "Ретро ОФД").rows.length, 1, "backing retro is anonymized into groups");
  assert.equal(sheet(retroSlice, "Отбор ретро ОФД").rows.length, 2, "selected retro detail remains available");
});

test("month-filtered export excludes rows absent from the screen", () => {
  const plan = makePlan();
  const included = { ...plan.ofd[0], month: "2027-06", included: true };
  const excluded = { ...included, id: "ofd|excluded", inn: "7700000002", included: false };
  plan.ofd = [included, excluded];
  const spec = P.buildWorkbook(plan, { board: "ofd", filter: { month: "2027-06" } });
  assert.equal(sheet(spec, "Продления ОФД").rows.length, 1);
});

test("persisted planning parameters reject invalid money, probabilities and year", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem() { return JSON.stringify({ year: "2028oops", vat: "with", checks: { "c|ofd|Партнёры|12": -100, "v|upsell|Партнёры": 4 }, probManual: { "ofd|12|first": 3 }, events: { "ofd|RNM": { month: "2028-99" } } }); } };
  try {
    const params = P.loadParams();
    assert.equal(params.year, 2027);
    assert.equal(params.checks["c|ofd|Партнёры|12"], undefined);
    assert.equal(params.checks["v|upsell|Партнёры"], undefined);
    assert.equal(params.probManual["ofd|12|first"], undefined);
    assert.equal(params.events["ofd|RNM"].month, "2028-99", "invalid old month remains visible for correction");
  } finally { globalThis.localStorage = original; }
});

test("failed local storage writes are reported rather than shown as saved", () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { setItem() { throw new Error("Storage full"); } };
  try { assert.equal(P.saveParams(P.defaultParams()), false); }
  finally { globalThis.localStorage = original; }
});
