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
