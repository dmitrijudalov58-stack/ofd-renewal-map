// Тест расчёта «Выгрузка для Маргариты» (metrics.js: aggregateCenterPartners / selectCenterExport /
// isDirectCenterPartner). Синтетические строки, реальный файл не нужен.
// Сверка с реальной выгрузкой (13 745 / 14 307) -- в test/smoke.js.
const Metrics = require("../js/metrics.js");

let failed = 0;
function check(name, ok, extra) {
  console.log(name + ":", ok ? "OK" : "FAIL", ok || extra === undefined ? "" : extra);
  if (!ok) failed++;
}
const D = (s) => new Date(s);
let seq = 0;
function row(o) {
  seq++;
  return Object.assign({
    pin: "pin" + seq, created: null, status: "Зарегистрировано", tariff: "15 месяцев", innPhys: null,
    activationType: "Первичная", activated: null, endDate: null, overallEnd: null, rnm: "rnm" + seq, org: null,
    innOrg: null, phone: null, email: null, partner: null, partnerInn: null, salesCenter: null, salesType: null,
  }, o);
}

// --- isDirectCenterPartner: «партнёр = сам ЦП» по названию ---
const direct = Metrics.isDirectCenterPartner;
check("прямая: Уфа (партнёр без суффикса ЦП)", direct('Представительство АО "Калуга Астрал" в г. Уфа', 'Представительство АО "Калуга Астрал" в г. Уфа ЦП') === true);
check("прямая: Екатеринбург (в названиях отличается только «ООО»)", direct("ОП АСТРАЛ-СОФТ г. Екатеринбург", "ОП ООО АСТРАЛ-СОФТ г. Екатеринбург") === true);
check("прямая: Савукова (скобки)", direct("ОП Калуга Астрал в г. Екатеринбург (Савукова Н.партнер)", "ОП Калуга Астрал в г. Екатеринбург (Савукова Н.)") === true);
check("прямая: Омск (хвост «ОФД» против «ЦП»)", direct('Представительство АО "Калуга Астрал" в г. Омск ОФД', 'Представительство АО "Калуга Астрал" в г. Омск ЦП') === true);
check("не прямая: обычный партнёр", direct("ООО «Ромашка»", 'Представительство АО "Калуга Астрал" в г. Уфа ЦП') === false);
check("не прямая: «АО Калуга Астрал» против Калуга ЦП (для Калуги)", direct('АО "Калуга Астрал"', 'АО "Калуга Астрал" Калуга ЦП (для Калуги)') === false);
check("не прямая: пустые значения", direct(null, "X") === false && direct("", "") === false && direct(undefined, undefined) === false);

// --- список из сообщения Маргариты ---
const list = Metrics.MARGARITA_CENTERS;
check("список Маргариты: 11 уникальных ЦП", Array.isArray(list) && list.length === 11 && new Set(list).size === 11, list && list.length);
check("список Маргариты: Уфа ровно один раз", list.filter((c) => /Уфа/.test(c)).length === 1);

// --- агрегат ---
const CA = 'Представительство АО "Калуга Астрал" в г. Уфа ЦП';
const CB = "ОП ООО АСТРАЛ-СОФТ г. Екатеринбург";
const CX = 'ООО "Иной" ЦП';
const P1 = { partner: "ООО «Ромашка»", partnerInn: "7701", salesCenter: CA };
const rows = [
  // P1: куплено 6 (r1,r2,r3,r4,резерв,отозван), активировано 5 (r1,r2,r3,r4,r7)
  row({ ...P1, created: D("2025-08-20"), activated: D("2025-09-01"), innOrg: "5001", org: "ИП Иванов" }),
  row({ ...P1, created: D("2025-08-20"), activated: D("2025-10-01"), innOrg: "5001", org: "ИП Иванов" }),
  row({ ...P1, created: D("2025-08-25"), activated: D("2025-10-05"), innOrg: "5001", org: "ИП Иванов", tariff: "36 месяцев" }),
  row({ ...P1, created: D("2025-09-01"), activated: D("2025-11-01"), innOrg: "7701", org: "ООО «Ромашка»" }), // клиент = сам партнёр
  row({ ...P1, status: "Новый", created: D("2025-12-01"), rnm: null }),
  row({ ...P1, created: D("2025-07-01"), activated: D("2025-07-15"), innOrg: "5009", org: "Вне периода" }), // вне периода целиком
  row({ ...P1, created: D("2025-07-20"), activated: D("2025-09-10"), innOrg: "5002", org: "ООО «Лотос»", tariff: "13 месяцев" }), // активирован в периоде, создан до
  row({ ...P1, status: "Отозвано", created: D("2025-09-02"), activated: D("2025-09-03"), innOrg: "5003", rnm: null }), // куплено да, активировано нет
  // прямые продажи ЦП
  row({ partner: 'Представительство АО "Калуга Астрал" в г. Уфа', partnerInn: "7000", salesCenter: CA, created: D("2025-09-10"), activated: D("2025-09-15"), innOrg: "5004", org: "ООО «Сатурн»" }),
  row({ partner: "ОП АСТРАЛ-СОФТ г. Екатеринбург", partnerInn: "7002", salesCenter: CB, created: D("2025-09-12"), activated: D("2025-09-16"), innOrg: "5005", org: "ООО «Орбита»" }),
  // партнёр, который только купил (в резерве), без активаций
  row({ partner: "ООО «Вектор»", partnerInn: "7703", salesCenter: CB, status: "Выдан", created: D("2025-09-20"), rnm: null }),
  // ЦП вне списка
  row({ partner: "ООО «Чужой»", partnerInn: "7704", salesCenter: CX, created: D("2025-09-01"), activated: D("2025-09-05"), innOrg: "5006", org: "ООО «Икс»" }),
  // граница периода: 26.10.2026 23:00 входит, 27.10.2026 нет
  row({ partner: "ООО «Граница»", partnerInn: "7705", salesCenter: CA, created: D("2026-10-26T22:00:00"), activated: D("2026-10-26T23:00:00"), innOrg: "5007", org: "ООО «А»" }),
  row({ partner: "ООО «Граница»", partnerInn: "7705", salesCenter: CA, created: D("2026-10-27T01:00:00"), activated: D("2026-10-27T02:00:00"), innOrg: "5008", org: "ООО «Б»" }),
];
const model = Metrics.buildModel(rows);
const FROM = D("2025-08-01T00:00:00"), TO = D("2026-10-26T23:59:59");
const agg = Metrics.aggregateCenterPartners(model, FROM, TO);
const center = (name) => agg.centers.find((c) => c.name === name);
const partnerIn = (cname, inn) => center(cname).partners.find((p) => p.partnerInn === inn);

check("агрегат: ровно три ЦП (Уфа, Екатеринбург, чужой)", agg.centers.length === 3 && !!center(CA) && !!center(CB) && !!center(CX), agg.centers.map((c) => c.name));
const p1 = partnerIn(CA, "7701");
check("P1: куплено 6 (любые статусы по дате создания, включая резерв и отозванные)", p1.bought === 6, p1.bought);
check("P1: активировано 5 (только «Зарегистрировано» по дате активации, отозванный не считается)", p1.activated === 5, p1.activated);
check("P1: клиентов 3 (уникальные ИНН среди активированных)", p1.clients === 3, p1.clients);
check("P1: 4 строки детализации (клиент × тариф)", p1.detail.length === 4, p1.detail.length);
check("P1: сумма PIN детализации = активировано", p1.detail.reduce((a, d) => a + d.pins, 0) === p1.activated);
const ivanov15 = p1.detail.find((d) => d.clientInn === "5001" && d.tariff === "15 месяцев");
const ivanov36 = p1.detail.find((d) => d.clientInn === "5001" && d.tariff === "36 месяцев");
check("P1: клиент 5001 — 2 PIN на 15 мес. и 1 PIN на 36 мес. отдельными строками", ivanov15 && ivanov15.pins === 2 && ivanov36 && ivanov36.pins === 1);
check("P1: флаг «клиент = партнёр» только у клиента с ИНН партнёра", p1.detail.filter((d) => d.self).length === 1 && p1.detail.find((d) => d.self).clientInn === "7701");
check("P1: не прямая", p1.direct === false);
check("прямая Уфа помечена direct", partnerIn(CA, "7000").direct === true);
check("прямая Екатеринбург помечена direct (ООО в названии ЦП)", partnerIn(CB, "7002").direct === true);
const vektor = partnerIn(CB, "7703");
check("партнёр только с покупкой: есть в агрегате, активировано 0, клиентов 0, куплено 1", vektor && vektor.activated === 0 && vektor.clients === 0 && vektor.bought === 1 && vektor.detail.length === 0);
const border = partnerIn(CA, "7705");
check("граница периода: 26.10 23:00 входит, 27.10 нет (активировано 1, куплено 1)", border.activated === 1 && border.bought === 1, JSON.stringify([border.activated, border.bought]));

// --- выбор ЦП и режим «прямые» ---
const sel = new Set([CA, CB]);
const noDirect = Metrics.selectCenterExport(agg, sel, false);
check("без прямых: партнёры P1, Вектор, Граница (3 строки сводки)", noDirect.summary.length === 3, noDirect.summary.map((r) => r.partner));
check("без прямых: прямые партнёры не попали ни в сводку, ни в детализацию",
  !noDirect.summary.some((r) => r.direct) && !noDirect.detail.some((r) => r.direct));
check("без прямых: итого активировано 6 (5 + 1 Граница)", noDirect.totals.activated === 6, noDirect.totals.activated);
check("без прямых: итого куплено 8 (6 + 1 Вектор + 1 Граница)", noDirect.totals.bought === 8, noDirect.totals.bought);
check("без прямых: итого партнёров 3", noDirect.totals.partners === 3);
check("без прямых: итого клиентов 4 (5001, 7701, 5002, 5007)", noDirect.totals.clients === 4, noDirect.totals.clients);
const withDirect = Metrics.selectCenterExport(agg, sel, true);
check("с прямыми: 5 партнёров в сводке", withDirect.summary.length === 5, withDirect.summary.length);
check("с прямыми: итого активировано 8 (6 + две прямые)", withDirect.totals.activated === 8, withDirect.totals.activated);
check("с прямыми: итого куплено 10", withDirect.totals.bought === 10, withDirect.totals.bought);
check("с прямыми: флаг direct на строках сводки соответствует партнёрам", withDirect.summary.filter((r) => r.direct).length === 2);
check("ЦП вне выбора не попадает в выгрузку", !withDirect.summary.some((r) => r.center === CX) && !withDirect.detail.some((r) => r.center === CX));
check("сводка: сумма «Активировано» = сумма «PIN» детализации",
  withDirect.summary.reduce((a, r) => a + r.activated, 0) === withDirect.detail.reduce((a, r) => a + r.pins, 0));
const empty = Metrics.selectCenterExport(agg, new Set(), true);
check("пустой выбор ЦП: пустая выгрузка, нули в итогах", empty.summary.length === 0 && empty.detail.length === 0 && empty.totals.activated === 0 && empty.totals.bought === 0 && empty.totals.clients === 0);

// --- перебор: каждая выбранная строка сводки согласована с детализацией ---
const mismatch = withDirect.summary.filter((s) => {
  const ds = withDirect.detail.filter((d) => d.center === s.center && d.partnerInn === s.partnerInn);
  const pins = ds.reduce((a, d) => a + d.pins, 0);
  const clients = new Set(ds.map((d) => d.clientInn)).size;
  return pins !== s.activated || clients !== s.clients;
});
check("каждая строка сводки сходится с детализацией (PIN и число клиентов)", mismatch.length === 0, JSON.stringify(mismatch));

// --- замечания ревью (2026-10-28) ---
check("прямая: хвост «ЦП» перед скобками (normCenter его не срезает)", direct('АО "Калуга Астрал" Калуга ЦП', 'АО "Калуга Астрал" Калуга ЦП (для Калуги)') === true);

// один ИНН у обычного партнёра и у самого офиса в одном ЦП: в одну строку не сливаются, порядок строк не важен
{
  const MIX_INN = "6663003127";
  const mkRows = () => [
    row({ partner: "АСТРАЛ-СОФТ ООО", partnerInn: MIX_INN, salesCenter: CB, created: D("2025-09-01"), activated: D("2025-09-02"), innOrg: "5101", org: "ООО «А»" }),
    row({ partner: "ОП АСТРАЛ-СОФТ г. Екатеринбург", partnerInn: MIX_INN, salesCenter: CB, created: D("2025-09-03"), activated: D("2025-09-04"), innOrg: "5102", org: "ООО «Б»" }),
    row({ partner: "ОП АСТРАЛ-СОФТ г. Екатеринбург", partnerInn: MIX_INN, salesCenter: CB, created: D("2025-09-05"), activated: D("2025-09-06"), innOrg: "5103", org: "ООО «В»" }),
  ];
  [["прямые строки в конце", mkRows()], ["прямые строки в начале", mkRows().reverse()]].forEach(([label, rs]) => {
    const a = Metrics.aggregateCenterPartners(Metrics.buildModel(rs), FROM, TO);
    const partners = a.centers.find((c) => c.name === CB).partners;
    const dir = partners.find((p) => p.direct), reg = partners.find((p) => !p.direct);
    check(`смешанная группа (${label}): две строки сводки, прямая = 2 PIN, обычная = 1 PIN`, partners.length === 2 && dir && dir.activated === 2 && reg && reg.activated === 1, JSON.stringify(partners.map((p) => [p.partner, p.direct, p.activated])));
    const nd = Metrics.selectCenterExport(a, new Set([CB]), false);
    check(`смешанная группа (${label}): «без прямых» оставляет только обычную строку`, nd.totals.activated === 1 && nd.summary.length === 1 && nd.summary[0].partner === "АСТРАЛ-СОФТ ООО", JSON.stringify(nd.totals));
  });
}

// строки без ИНН клиента: активированы, но «клиентом» не считаются
{
  const rs = [
    row({ partner: "ООО «Без ИНН»", partnerInn: "7800", salesCenter: CA, created: D("2025-09-01"), activated: D("2025-09-02"), org: "Неизвестный 1" }),
    row({ partner: "ООО «Без ИНН»", partnerInn: "7800", salesCenter: CA, created: D("2025-09-01"), activated: D("2025-09-03"), org: "Неизвестный 2" }),
  ];
  const a = Metrics.aggregateCenterPartners(Metrics.buildModel(rs), FROM, TO);
  const p = a.centers[0].partners[0];
  check("без ИНН клиента: активировано 2, клиентов 0", p.activated === 2 && p.clients === 0, JSON.stringify([p.activated, p.clients]));
  check("без ИНН клиента: итого клиентов 0", Metrics.selectCenterExport(a, new Set([CA]), true).totals.clients === 0);
}

if (failed) { console.error("FAIL: center-export.test.js, провалов:", failed); process.exitCode = 1; }
else console.log("center-export.test.js: всё OK");
