"use strict";

// The Excel builder runs in a browser worker so a large export does not block the UI thread.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const XLSX = require("xlsx");

const root = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(root, "js/partner-codes-export-worker.js"), "utf8");
const exportSource = fs.readFileSync(path.join(root, "js/export.js"), "utf8");
let message;
const sandbox = { TextEncoder, Uint8Array, console, postMessage(value) { message = value; } };
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
sandbox.importScripts = function (name) {
  assert.equal(name, "export.js", "worker imports the local Excel builder");
  vm.runInContext(exportSource, context, { filename: "export.js" });
};
vm.runInContext(workerSource, context, { filename: "partner-codes-export-worker.js" });
assert.equal(typeof sandbox.onmessage, "function", "worker accepts messages");
sandbox.onmessage({ data: { type: "start", spec: { sheetName: "Коды партнёров", headers: ["ИНН партнёра", "Клиент"], textCols: [0] } } });
sandbox.onmessage({ data: { type: "rows", rows: [["001234567890", "=SUM(A1:A9)"]] } });
sandbox.onmessage({ data: { type: "rows", rows: [["7700000001", "Без клиента"]] } });
sandbox.onmessage({ data: { type: "finish" } });
assert.ok(message && message.bytes, "worker returns a transferable XLSX buffer");
const wb = XLSX.read(new Uint8Array(message.bytes), { type: "array" });
const values = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
assert.deepEqual(values, [["ИНН партнёра", "Клиент"], ["001234567890", "=SUM(A1:A9)"], ["7700000001", "Без клиента"]]);
assert.equal(wb.Sheets[wb.SheetNames[0]].B2.f, undefined, "formula-like client name remains text");
assert.equal(typeof require("../js/export.js").downloadXlsxBytes, "function", "UI can save the bytes returned by the worker");
console.log("partner-code Excel worker: PASS");
