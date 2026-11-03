"use strict";
const fs = require("node:fs");
const XLSX = require("xlsx");
const Parser = require("../js/parser.js");
const Metrics = require("../js/metrics.js");
const Plan = require("../js/planning.js");
const Export = require("../js/export.js");
const source = process.env.OFD_TEST_FILE;
if (!source) throw new Error("Set OFD_TEST_FILE to an authorized local XLSX");
const start = Date.now();
const workbook = XLSX.read(fs.readFileSync(source), { type: "buffer", cellDates: true });
const parsed = Parser.parseWorkbook(XLSX, workbook);
const model = Metrics.buildModel(parsed.rows, { strict: true });
const loaded = Date.now();
const plan = Plan.buildPlan(model, new Date(2026, 10, 3), Plan.defaultParams(), null, {}, { sourceFiles: [source] });
const planned = Date.now();
const spec = Plan.buildWorkbook(plan);
const specified = Date.now();
const bytes = Export.buildXlsx(spec);
const finished = Date.now();
console.log(JSON.stringify({ ofdEvents: plan.ofd.length, retroEvents: plan.retroOfd.events.length,
  retroExportRows: spec.sheets.find((s) => s.sheetName === "Ретро ОФД").rows.length,
  timingsSeconds: { load: (loaded - start) / 1000, plan: (planned - loaded) / 1000,
    spec: (specified - planned) / 1000, xlsx: (finished - specified) / 1000 },
  xlsxMB: Math.round(bytes.byteLength / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }));
