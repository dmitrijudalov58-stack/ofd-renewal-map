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
