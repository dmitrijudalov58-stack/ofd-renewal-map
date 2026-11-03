/* Синтетическая модель раздела «Планирование». Реальная выгрузка не нужна. */
const XLSX = require("xlsx");
const { buildXlsx } = require("../js/export.js");
const P = require("../js/planning.js");

let failed = 0;
function check(name, ok, extra) {
  console.log(name + ":", ok ? "OK" : "FAIL", ok ? "" : (extra === undefined ? "" : extra));
  if (!ok) failed++;
}
function d(y, m, day) { return new Date(y, m - 1, day); }
function code(pin, tariff, start, end) {
  return { pin: pin, tariff: tariff, activated: start, endDate: end, sourceFile: "тест.xlsx", sourceSheet: "Лист1", sourceRow: 2 };
}
function kassa(rnm, inn, org, codes, channel) {
  return {
    rnm: rnm, clientKey: inn, org: org, channel: channel || "Партнёры", partner: "Партнёр",
    codes: codes, intervals: codes.map(function (c) { return { start: c.activated, end: c.endDate }; }),
    tariff: codes.length ? codes[codes.length - 1].tariff : "",
  };
}
function modelOf(list) {
  var kassas = new Map(), clients = new Map();
  list.forEach(function (k) {
    kassas.set(k.rnm, k);
    var c = clients.get(k.clientKey);
    if (!c) { c = { key: k.clientKey, org: k.org, phys: false, kassas: [] }; clients.set(k.clientKey, c); }
    c.kassas.push(k);
  });
  return { kassas: kassas, clients: clients };
}
function planOf(list, params, records, asOf) {
  return P.buildPlan(modelOf(list), asOf || d(2026, 11, 3), params || P.defaultParams(), records === undefined ? null : records, {}, { file1cName: records ? "сверка.xlsx" : null, sourceFiles: ["тест.xlsx"] });
}

const asOf = d(2026, 11, 3);
check("грейс: 30-й день ещё незрелый", P.classifyEnd(d(2026, 1, 1), [], d(2026, 1, 31)) === "immature");
check("грейс: 31-й день без покрытия — не продлили", P.classifyEnd(d(2026, 1, 1), [], d(2026, 2, 1)) === "churned");
check("продление в последний день грейса", P.classifyEnd(d(2026, 1, 1), [{ start: d(2026, 1, 31), end: d(2027, 1, 31) }], d(2026, 6, 1)) === "renewed");
check("возврат на 31-й день не становится продлением", P.classifyEnd(d(2026, 1, 1), [{ start: d(2026, 2, 1), end: d(2027, 2, 1) }], d(2026, 6, 1)) === "churned");

const multi = kassa("RNM1", "7700000001", "Альфа", [
  code("PIN1", "12 месяцев", d(2025, 1, 1), d(2026, 1, 1)),
  code("PIN2", "15 месяцев", d(2026, 1, 1), d(2027, 6, 1)),
]);
const other = kassa("RNM2", "7700000001", "Альфа", [code("PIN3", "12 месяцев", d(2025, 3, 1), d(2027, 3, 15))]);
const forward = kassa("RNM3", "7700000002", "Бета", [
  code("PIN4", "12 месяцев", d(2025, 1, 1), d(2026, 1, 1)),
  code("PIN5", "36 месяцев", d(2026, 1, 1), d(2029, 1, 1)),
]);
const base = planOf([multi, other, forward], P.defaultParams(), null, asOf);
check("несколько PIN одной кассы — одно продление", base.ofd.filter(function (e) { return e.unit === "RNM1"; }).length === 1);
const ev1 = base.ofd.filter(function (e) { return e.unit === "RNM1"; })[0];
check("прогноз на дату окончания покрытия и повторный цикл", ev1 && ev1.month === "2027-06" && ev1.cycle === "repeat" && ev1.tariff === 15, JSON.stringify(ev1 && { month: ev1.month, cycle: ev1.cycle, tariff: ev1.tariff }));
check("вторая касса того же ИНН — отдельное событие", base.ofd.some(function (e) { return e.unit === "RNM2" && e.month === "2027-03"; }));
check("продление вперёд за год плана не создаёт событие 2027", !base.ofd.some(function (e) { return e.unit === "RNM3"; }));
check("уникальные ИНН не складывают кассы", base.roll.ofd.innsN === 1 && base.roll.ofd.base === 2, base.roll.ofd.innsN + "/" + base.roll.ofd.base);
check("пустой чек не даёт сумму 0", ev1.amount == null && ev1.expectedQty == null && base.status.label === P.DRAFT);

const withProb = P.defaultParams();
withProb.probManual["ofd|15|repeat"] = 0.5;
withProb.probManual["ofd|12|first"] = 0;
withProb.checks["c|ofd|Партнёры|15"] = 1000;
withProb.checks["c|ofd|Партнёры|12"] = 0;
withProb.vat = "with";
const priced = planOf([multi, other], withProb, null, asOf);
const p1 = priced.ofd.filter(function (e) { return e.unit === "RNM1"; })[0];
const p2 = priced.ofd.filter(function (e) { return e.unit === "RNM2"; })[0];
check("ручная вероятность и чек дают дробное ожидание", p1.expectedQty === 0.5 && p1.amount === 500 && p1.probSource === "ручной", p1.amount);
check("явный ноль чека и вероятности остаётся нулём", p2.expectedQty === 0 && p2.amount === 0, p2.amount);
withProb.events["ofd|RNM1"] = { excluded: true, comment: "не берём", month: "2027-08" };
const excluded = planOf([multi], withProb, null, asOf).ofd[0];
check("исключение обнуляет ожидание и не подменяет дату основания", excluded.included === 0 && excluded.expectedQty === 0 && excluded.month === "2027-08" && excluded.baseDate.getMonth() === 5);

const mature = P.aggregateRetro([{ product: "ofd", tariff: 12, cycle: "first", status: "зрелое", outcome: "продлили", inn: "1" }, { product: "ofd", tariff: 12, cycle: "first", status: "зрелое", outcome: "не продлили", inn: "2" }, { product: "ofd", tariff: 12, cycle: "first", status: "незрелое", outcome: "", inn: "3" }]);
const seg = mature["ofd|12|first"];
check("зрелая база = продлили + не продлили, незрелые вне знаменателя", seg.mature === 2 && seg.renewed === 1 && seg.churned === 1 && seg.immature === 1 && seg.prob === 0.5);

const rec = function (inn, serial, start, end, months) {
  return { inn: inn, kktSerial: serial, tariffStart: start, tariffEnd: end, months: months, sheetName: "Сверка" };
};
const active = kassa("RNM9", "7700000009", "Гамма", [code("P9", "12 месяцев", d(2024, 1, 1), d(2027, 2, 1))]);
const buyerK = kassa("RNM8", "7700000008", "Дельта", [code("P8", "12 месяцев", d(2024, 1, 1), d(2027, 4, 1))]);
const records = [
  rec("7700000008", "SN1", d(2025, 1, 1), d(2027, 5, 1), 12),
  rec("7700000010", "SN1", d(2025, 1, 1), d(2027, 7, 1), 6),
  rec("7700000011", "", d(2025, 1, 1), d(2027, 1, 1), 12),
  rec("7700000099", "SN9", d(2025, 1, 1), d(2027, 1, 1), 12),
];
const params = P.defaultParams();
params.vat = "without";
params.checks["v|upsell|Партнёры"] = 0.25;
params.checks["c|upsell|Партнёры|"] = 4000;
params.upsell["7700000009"] = { selected: true, month: null };
const one = planOf([active, buyerK], params, records, asOf);
check("покупатель 1С не попадает в первую продажу", !one.upsell.some(function (r) { return r.inn === "7700000008"; }));
check("одинаковый заводской номер у разных ИНН — разные продления", one.onec.filter(function (e) { return e.unit === "SN1"; }).length === 1 && one.exclusions.some(function (e) { return e.inn === "7700000010" && e.reason.indexOf("базе ОФД") >= 0; }));
check("нет заводского номера — исключение, не одна касса", one.exclusions.some(function (e) { return e.inn === "7700000011" && e.reason.indexOf("завод") >= 0; }));
check("несопоставленный ИНН не в бюджете 1С", !one.onec.some(function (e) { return e.inn === "7700000099"; }));
const up = one.upsell.filter(function (r) { return r.inn === "7700000009"; })[0];
check("без месяца первая продажа остаётся в годе как неназначенная", up && up.included === 1 && up.month === "не назначен" && up.expectedQty === 0.25 && up.amount === 1000, up && up.amount);
check("без файла 1С кандидаты не становятся нулевой базой", planOf([active], P.defaultParams(), null, asOf).upsell.length === 0);

const wbSpec = P.buildWorkbook(priced, { exportedAt: d(2026, 11, 3) });
const names = wbSpec.sheets.map(function (s) { return s.sheetName; });
check("в книге все обязательные листы", ["Описание и параметры", "Сводный план", "Продления ОФД", "Продления 1С", "Допродажи 1С", "Ретро ОФД", "Ретро 1С", "По месяцам", "По каналам", "Исключения", "Проверки"].every(function (n) { return names.indexOf(n) >= 0; }), names.join(","));
const ofdSheet = wbSpec.sheets.filter(function (s) { return s.sheetName === "Продления ОФД"; })[0];
const amount = ofdSheet.rows[0][16];
const checkCell = ofdSheet.rows[0][14];
check("средний чек строки ссылается на лист параметров", checkCell && checkCell.f.indexOf("Описание и параметры") >= 0, checkCell && checkCell.f);
check("сумма строки — формула от чека и количества, кэш 500", amount && amount.f.indexOf("P2") >= 0 && amount.v === 500, amount && amount.v);
const bytes = buildXlsx(wbSpec);
const wb = XLSX.read(Buffer.from(bytes), { type: "buffer", cellFormula: true });
const cell = wb.Sheets["Продления ОФД"].Q2;
check("xlsx открывается: чек ссылается на параметры, сумма закэширована", (function () {
  var o = wb.Sheets["Продления ОФД"].O2;
  var q = wb.Sheets["Продления ОФД"].Q2;
  return o && String(o.f).indexOf("Описание и параметры") >= 0 && q && q.v === 500;
})(), JSON.stringify(wb.Sheets["Продления ОФД"].O2));
check("ИНН в книге — текст", wb.Sheets["Продления ОФД"].B2.t === "s" || typeof wb.Sheets["Продления ОФД"].B2.v === "string");
const month = wb.Sheets["По месяцам"];
check("июнь 2027 в месячном листе несёт кэш 500", month.D7 && month.D7.v === 500, month.D7 && month.D7.v);
check("статус черновика, пока не всё заполнено", String(wb.Sheets["Описание и параметры"].B2.v).indexOf("Черновик") >= 0, wb.Sheets["Описание и параметры"].B2.v);

const full = P.defaultParams();
full.vat = "with";
full.probManual["ofd|15|repeat"] = 1;
full.checks["c|ofd|Партнёры|15"] = 10;
const readyBase = planOf([multi], full, [
  rec("7700000098", "ZZ", d(2024, 1, 1), d(2028, 1, 1), 12),
], asOf);
/* файл 1С есть, но выбранных допродаж нет и продлений 1С в 2027 нет: чеки этих пустых направлений не требуются */
check("заполненный ОФД и отметка НДС дают статус для согласования, пустой год 1С не считается нулём-дырой", readyBase.status.ready && readyBase.roll.ofd.money === 10, readyBase.status.label + " " + readyBase.status.gaps.join("; "));

if (process.env.OFD_TEST_FILE) {
  const fs = require("fs");
  const Parser = require("../js/parser.js");
  const Metrics = require("../js/metrics.js");
  const buf = fs.readFileSync(process.env.OFD_TEST_FILE);
  const parsed = Parser.parseWorkbook(XLSX, XLSX.read(buf, { type: "buffer", cellDates: true }));
  const real = Metrics.buildModel(parsed.rows, { strict: true });
  const t0 = Date.now();
  const realPlan = P.buildPlan(real, asOf, P.defaultParams(), null, {}, { sourceFiles: [process.env.OFD_TEST_FILE] });
  console.log("реальный файл, мс:", Date.now() - t0, "продлений 2027:", realPlan.ofd.length, "ретро-событий:", realPlan.retroOfd.events.length, "исключений:", realPlan.exclusions.length);
  check("реальный файл строится и не подставляет чек", realPlan.ofd.length > 0 && realPlan.ofd.every(function (e) { return e.check == null; }));
  check("ключи прогноза уникальны", new Set(realPlan.ofd.map(function (e) { return e.id; })).size === realPlan.ofd.length);
}

if (failed) { console.log("ПРОВАЛОВ:", failed); process.exit(1); }
console.log("planning.test.js: все проверки прошли");
