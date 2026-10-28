const XLSX = require("xlsx");
const Parser = require("../js/parser.js");
const Metrics = require("../js/metrics.js");

// Тест на реальном файле — требует локальную XLSX-выгрузку ОФД (не входит в репозиторий,
// содержит реальные данные клиентов). Путь передаётся через аргумент или переменную окружения.
const filePath = process.argv[2] || process.env.OFD_TEST_FILE;
if (!filePath) {
  console.error("Укажи путь к тестовой XLSX-выгрузке: node test/smoke.js <путь> (или OFD_TEST_FILE=...)");
  process.exit(1);
}
const wb = XLSX.readFile(filePath, { cellDates: true });

const { rows, headerIssues } = Parser.parseWorkbook(XLSX, wb);
console.log("rows:", rows.length, "headerIssues:", headerIssues);

const model = Metrics.buildModel(rows);
console.log("kassas:", model.kassas.size, "clients:", model.clients.size,
  "reserve:", model.reserveRows.length, "revoked:", model.revokedRows.length);

const asOf = new Date("2026-07-30T23:59:59");
const snap = Metrics.computeSnapshot(model, asOf);
console.log("snapshot:", JSON.stringify(snap, null, 2));

const periodStart = new Date("2025-01-01");
const periodEnd = new Date("2025-12-31T23:59:59");
const flow = Metrics.computeFlow(model, periodStart, periodEnd);
console.log("flow 2025:", JSON.stringify(flow, null, 2));

const channels = Metrics.computeChannels(model, asOf);
console.log("channels (active clients):", channels);

const reserve = Metrics.computeReserve(model, asOf);
console.log("reserve total/older1y:", reserve.total, reserve.olderThanYear);

const risk30 = Metrics.clientsAtRisk(model, asOf, Metrics.daysThresholdFn(asOf, 30));
console.log("clients at risk (30d):", risk30.length);
const kassaRisk30 = Metrics.kassasAtRisk(model, asOf, Metrics.daysThresholdFn(asOf, 30));
console.log("kassas at risk (30d):", kassaRisk30.length);

const partners = Metrics.computePartners(model, asOf);
console.log("partners count:", partners.length);
console.log("top5 partners by clients:", partners.sort((a,b)=>b.clients-a.clients).slice(0,5));

const funnel = Metrics.computeFunnel(model, periodStart, periodEnd);
console.log("funnel 2025:", funnel);

const revokedPeriod = Metrics.computeRevokedInPeriod(model, periodStart, periodEnd);
console.log("revoked in 2025:", revokedPeriod);

const reserveShare = Metrics.computeReserveShare(model, periodStart, periodEnd);
console.log("reserve share 2025:", (reserveShare*100).toFixed(1) + "%");

// Сверка «Каналы — динамика»: на зрелых месяцах (грейс закрыт) разница = новые − отток + возвращённые
// должна равняться реальному изменению базы (baseAtStart след. месяца минус baseAtStart января) по
// каждому каналу. Без возвращённых расходится (Партнёры, янв–авг 2026: −1 944 против 0), 2026-10-13.
let channelNetMismatches = 0;
[asOf.getFullYear(), asOf.getFullYear() - 1].forEach((year) => {
  const perChannel = Metrics.computeChannelsMonthly(model, year, asOf, {});
  Metrics.CHANNELS.forEach((ch) => {
    const series = perChannel[ch];
    let last = -1;
    while (last + 1 < 11 && series[last + 1].ripe) last++;   // последний зрелый месяц; база на 1-е след. месяца нужна, поэтому не дальше ноября
    if (last < 0) return;
    let net = 0;
    for (let m = 0; m <= last; m++) net += series[m].newClients - series[m].churned + series[m].returned;
    const realDelta = series[last + 1].baseAtStart - series[0].baseAtStart;
    const ok = net === realDelta;
    if (!ok) channelNetMismatches++;
    console.log(`channel net ${year} ${ch} янв–${last + 1} мес.: разница ${net}, реальный Δ базы ${realDelta}`, ok ? "OK" : "FAIL");
  });
});
if (channelNetMismatches) {
  console.error("FAIL: разница по каналам не сходится с реальным изменением базы:", channelNetMismatches);
  process.exitCode = 1;
}

// «Календарь продлений по каналам» (2026-10-19): разрез по каналам и исключение
// ликвидированных не должны менять итог календаря. Статусы DaData здесь синтетические --
// проверяется арифметика (сохранение суммы, история не тронута), не реальные ликвидации.
{
  const tariffs = Metrics.allTariffsSorted(model);
  const calAsOf = asOf;
  const chOf = (c) => (c && c.kassas.length ? c.kassas[c.kassas.length - 1].channel || "Партнёры" : "Партнёры");
  const synthLiquidated = (inn) => parseInt(String(inn).slice(-1), 10) % 5 === 0;
  const totalOf = (buckets, key) => buckets.total.reduce((a, m) => a + m[key], 0);
  const KEYS = ["new", "renewedFirst", "renewedRepeat", "churn", "pending", "forecast"];
  let calMismatches = 0;
  ["kassa", "client"].forEach((unit) => {
    const base = Metrics.computeRenewalCalendar(model, calAsOf, { unit, tariffs });
    const grouped = Metrics.computeRenewalCalendar(model, calAsOf, {
      unit, tariffs, groupOf: (k, c) => chOf(c), isLiquidated: synthLiquidated,
    });
    KEYS.forEach((key) => {
      const groupsSum = Object.values(grouped.groups).reduce((a, g) => a + totalOf(g.buckets, key), 0);
      const excluded = key === "forecast"
        ? Object.values(grouped.groups).reduce((a, g) => a + totalOf({ total: g.excluded.total }, key), 0)
        : 0;
      const ok = totalOf(base.buckets, key) === groupsSum + excluded;
      if (!ok) calMismatches++;
      console.log(`calendar by channel ${unit} ${key}: B7 ${totalOf(base.buckets, key)} = каналы ${groupsSum}` + (excluded ? ` + исключено ${excluded}` : ""), ok ? "OK" : "FAIL");
    });
  });
  // Раскрытие по клику обязано совпадать с бакетами (расчёт и drill не должны разойтись):
  // канал «Партнёры», самый нагруженный будущий месяц самого крупного тарифа.
  ["kassa", "client"].forEach((unit) => {
    const cal = Metrics.computeRenewalCalendar(model, calAsOf, {
      unit, tariffs, groupOf: (k, c) => chOf(c), isLiquidated: synthLiquidated,
    });
    const g = cal.groups["Партнёры"];
    const t = tariffs[0];
    let best = -1;
    cal.months.forEach((m, i) => { if (m > calAsOf && (best < 0 || g.buckets[t][i].forecast > g.buckets[t][best].forecast)) best = i; });
    const filterOpts = {
      kassaFilter: (k, c) => (c ? chOf(c) : k.channel || "Партнёры") === "Партнёры",
      clientFilter: (c) => chOf(c) === "Партнёры",
      isLiquidated: synthLiquidated,
    };
    const drill = Metrics.renewalCalendarDrill(model, calAsOf, cal.months[best], t, "forecast", unit, false, filterOpts).length;
    const ok = drill === g.buckets[t][best].forecast;
    if (!ok) calMismatches++;
    console.log(`calendar drill ${unit} Партнёры ${t} мес: раскрытие ${drill} = бакет ${g.buckets[t][best].forecast}`, ok ? "OK" : "FAIL");
  });
  if (calMismatches) {
    console.error("FAIL: календарь по каналам не сходится с общим календарём:", calMismatches);
    process.exitCode = 1;
  }
}

// «Выгрузка для Маргариты» (2026-10-28): расчёт по модели сверяется с НЕЗАВИСИМЫМ пересчётом по
// сырым строкам (без buildModel) -- ловит потерю/задвоение PIN. Период: с 01.08.2025 по последнюю
// дату в файле (как по умолчанию в виджете), все 11 ЦП из её сообщения, прямые включены.
// Жёсткие числа (13 745 / 14 307 / 8 927 / 8 304) посчитаны отдельным скриптом на файле от
// 26.10.2026 и проверяются ТОЛЬКО на нём.
{
  const FROM = new Date("2025-08-01T00:00:00");
  let fresh = null;
  rows.forEach((r) => {
    if (r.created instanceof Date && (!fresh || r.created > fresh)) fresh = r.created;
    if (r.activated instanceof Date && (!fresh || r.activated > fresh)) fresh = r.activated;
  });
  const TO = new Date(fresh.getFullYear(), fresh.getMonth(), fresh.getDate(), 23, 59, 59);
  const sel = new Set(Metrics.MARGARITA_CENTERS);
  const agg = Metrics.aggregateCenterPartners(model, FROM, TO);
  const all = Metrics.selectCenterExport(agg, sel, true);
  const noDirect = Metrics.selectCenterExport(agg, sel, false);

  const inR = (d) => d instanceof Date && d >= FROM && d <= TO;
  let rawAct = 0, rawBought = 0, skippedNoRnm = 0;
  rows.forEach((r) => {
    if (!sel.has(r.salesCenter)) return;
    if (r.status === "Зарегистрировано" && !r.rnm) { if (inR(r.activated) || inR(r.created)) skippedNoRnm++; return; } // модель их не хранит
    if (r.status === "Зарегистрировано" && inR(r.activated)) rawAct++;
    if (inR(r.created)) rawBought++;
  });
  const detailPins = all.detail.reduce((a, d) => a + d.pins, 0);
  const summaryAct = all.summary.reduce((a, s) => a + s.activated, 0);
  const found = Metrics.MARGARITA_CENTERS.filter((c) => agg.centers.some((x) => x.name === c));
  const directPartners = all.summary.filter((s) => s.direct).length;
  console.log(`margarita export ${FROM.toLocaleDateString("ru-RU")}-${TO.toLocaleDateString("ru-RU")}: ЦП найдено ${found.length} из ${Metrics.MARGARITA_CENTERS.length}, строк сводки ${all.summary.length} (прямых ${directPartners}), строк детализации ${all.detail.length}`);
  console.log(`margarita export итого: активировано ${all.totals.activated}, куплено ${all.totals.bought}, клиентов ${all.totals.clients}; без прямых: активировано ${noDirect.totals.activated}, куплено ${noDirect.totals.bought}; пропущено моделью (зарег. без РНМ): ${skippedNoRnm}`);

  let exportMismatches = 0;
  const expect = (name, ok, extra) => { console.log("margarita export " + name + ":", ok ? "OK" : "FAIL", ok ? "" : extra); if (!ok) exportMismatches++; };
  expect("все 11 ЦП найдены в файле", found.length === Metrics.MARGARITA_CENTERS.length, Metrics.MARGARITA_CENTERS.filter((c) => !found.includes(c)));
  expect("активировано = независимый пересчёт по строкам", all.totals.activated === rawAct, `${all.totals.activated} против ${rawAct}`);
  expect("куплено = независимый пересчёт по строкам", all.totals.bought === rawBought, `${all.totals.bought} против ${rawBought}`);
  expect("сумма PIN детализации = активировано", detailPins === all.totals.activated, `${detailPins} против ${all.totals.activated}`);
  expect("сумма «Активировано» сводки = активировано", summaryAct === all.totals.activated, `${summaryAct} против ${all.totals.activated}`);
  expect("режим «без прямых» не больше режима «с прямыми»", noDirect.totals.activated <= all.totals.activated && noDirect.totals.bought <= all.totals.bought);
  expect("клиентов (уникальных ИНН) не больше PIN", all.totals.clients <= all.totals.activated);
  if (TO.getFullYear() === 2026 && TO.getMonth() === 9 && TO.getDate() === 26) {
    expect("файл 26.10.2026: активировано 13 745", all.totals.activated === 13745, all.totals.activated);
    expect("файл 26.10.2026: куплено 14 307", all.totals.bought === 14307, all.totals.bought);
    expect("файл 26.10.2026: строк детализации 8 927", all.detail.length === 8927, all.detail.length);
    expect("файл 26.10.2026: клиентов 8 304", all.totals.clients === 8304, all.totals.clients);
  }
  if (exportMismatches) {
    console.error("FAIL: выгрузка для Маргариты не сходится:", exportMismatches);
    process.exitCode = 1;
  }
}
