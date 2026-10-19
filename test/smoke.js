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
