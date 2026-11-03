"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const XLSX = require("xlsx");
const P = require("../js/planning.js");
const { buildXlsx } = require("../js/export.js");

const params = P.defaultParams();
params.vat = "with";
params.probManual["g|ofd|Партнёры"] = 0.5;
params.checks["c|ofd|Партнёры|all"] = 1000;
const kassa = {
  rnm: "RNM_TEST", clientKey: "7700000001", org: "Тестовый клиент", channel: "Партнёры", partner: "Тест",
  codes: [{ pin: "TEST", tariff: "12 месяцев", activated: new Date(2026, 0, 1), endDate: new Date(2027, 5, 15) }],
  intervals: [{ start: new Date(2026, 0, 1), end: new Date(2027, 5, 15) }],
};
const model = { kassas: new Map([[kassa.rnm, kassa]]), clients: new Map([[kassa.clientKey, { key: kassa.clientKey, org: kassa.org, phys: false, kassas: [kassa] }]]) };
const plan = P.buildPlan(model, new Date(2026, 10, 3), params, [], {}, { file1cName: "тестовая-сверка.xlsx", sourceFiles: ["тест-офд.xlsx"] });
assert.equal(plan.status.ready, true);
const bytes = buildXlsx(P.buildWorkbook(plan));
const file = path.resolve(__dirname, "..", "tmp", "plans", "planning-excel-test.xlsx");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, bytes);
const workbookXml = execFileSync("unzip", ["-p", file, "xl/workbook.xml"], { encoding: "utf8" });
assert.ok(workbookXml.indexOf("</definedNames>") < workbookXml.indexOf("<calcPr"), "calcPr follows definedNames as specified by OOXML");
const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellFormula: true });
assert.equal(workbook.Sheets["Сводный план"].E2.v, 500);
assert.equal(workbook.Sheets["По месяцам"].D7.v, 500);
assert.ok(workbook.Sheets["Описание и параметры"].B2.f.includes("Проверки"));
const priceRow = Array.from({ length: 50 }, (_, i) => i + 14).find((i) => workbook.Sheets["Описание и параметры"]["A" + i]?.v === "c|ofd|Партнёры|all");
assert.ok(priceRow, "price input present in the workbook");
console.log(JSON.stringify({ file, priceCell: "G" + priceRow, initialMoney: 500, updatedPrice: 2000, expectedMoney: 1000 }));
