// Смоук на синтетике: TZ=Europe/Moscow node test/b10-build-smoke.js
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");
const XLSX = require("xlsx");
const { EXPECTED_HEADERS } = require("../js/parser.js");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "tmp/b10-smoke");
const oldPath = path.join(os.homedir(), "Downloads/portrait-data.json");
const statOld = () => fs.existsSync(oldPath) ? fs.statSync(oldPath, { bigint: true }) : null;
const before = statOld();
let n = 0, failed = 0;
function ok(cond, msg) {
  n++; if (!cond) failed++;
  console.log((cond ? "✓ " : "✗ ") + msg);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const phone = "+7 (000) 000-00-01", email = "smoke1@example.invalid";
const inns = ["9999000011", "9999000012"];
const serial = (date) => (Date.parse(date + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86400000;

fs.mkdirSync(DIR, { recursive: true });
const xlsxPath = path.join(DIR, "ОФД Подключение 01.01.2017-15.09.2026.xlsx");
const rows = [];
function add(inn, start, end, tariff) {
  const row = Array(EXPECTED_HEADERS.length).fill("");
  row[2] = "9999-PIN-" + (rows.length + 1);
  row[3] = serial(start);
  row[4] = "Зарегистрировано"; row[5] = tariff;
  row[9] = serial(start) + 0.6; // Активация с настоящим временем 14:24.
  row[10] = row[11] = serial(end); // K/L: даты без времени.
  row[12] = "9999-RNM-" + (rows.length + 1);
  row[13] = "Вымышленная организация " + inn; row[14] = inn;
  row[16] = phone; row[17] = email;
  row[19] = "Вымышленный партнёр 9999"; row[20] = "9999000099";
  row[22] = "Вымышленный центр 9999"; row[23] = "Продление";
  rows.push(row);
}
add(inns[0], "2024-01-31", "2027-01-31", "36 месяцев");
add(inns[0], "2026-01-31", "2027-01-31", "13 месяцев");
add(inns[1], "2022-01-31", "2023-01-31", "12 месяцев");
add(inns[1], "2024-01-31", "2025-01-31", "13 месяцев");
add(inns[1], "2024-06-30", "2025-01-31", "13 месяцев");
const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([EXPECTED_HEADERS, ...rows]);
for (let r = 2; r <= rows.length + 1; r++) {
  for (const col of ["D", "K", "L"]) ws[col + r].z = "dd.mm.yyyy";
  ws["J" + r].z = "dd.mm.yyyy hh:mm";
}
XLSX.utils.book_append_sheet(wb, ws, "ОФД");
XLSX.writeFile(wb, xlsxPath);
fs.writeFileSync(path.join(DIR, "cache.json"), JSON.stringify(Object.fromEntries(inns.map((inn) =>
  [inn, { org: "Вымышленный клиент " + inn, okved: "47.11", region: "Москва" }]))));
fs.writeFileSync(path.join(DIR, "raw.ndjson"), inns.map((inn) => JSON.stringify({ inn,
  response: { suggestions: [{ data: { inn, type: "LEGAL", kpp: "999901001",
    state: { status: "ACTIVE", registration_date: Date.UTC(2018, 0, 1) },
    address: { data: { region_kladr_id: "7700000000000" } }
  } }] }
})).join("\n") + "\n");

// Защита действует и на старом сборщике в красной фазе: реальный raw не открывается.
const guardPath = path.join(DIR, "guard.cjs");
fs.writeFileSync(guardPath, `"use strict";
const fs = require("fs"), path = require("path");
const rootRaw = path.resolve("dadata-raw.ndjson");
for (const method of ["createReadStream", "readFileSync", "openSync"]) {
  const original = fs[method];
  fs[method] = function(file, ...args) {
    if (typeof file === "string" && path.resolve(file) === rootRaw)
      throw new Error("SMOKE: DADATA_RAW_FILE ignored; root raw read blocked");
    return original.call(this, file, ...args);
  };
}
require("child_process").spawnSync = () => { throw new Error("SMOKE: python must be skipped"); };
globalThis.fetch = () => { throw new Error("SMOKE: network must not be used"); };
`);

const outputs = [];
for (const withContacts of [false, true]) {
  const label = withContacts ? "с контактами" : "без контактов";
  const outPath = path.join(DIR, withContacts ? "portrait-data-contacts.json" : "portrait-data.json");
  fs.rmSync(outPath, { force: true }); // Старый результат не должен сделать тест зелёным.
  const result = spawnSync("node", ["--require", guardPath, "scripts/build-portrait-data.js",
    "--xlsx", xlsxPath, "--out", outPath, ...(withContacts ? ["--active-contacts"] : [])], {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
    env: { ...process.env, TZ: "Europe/Moscow", TMPDIR: DIR, TMP: DIR, TEMP: DIR,
      DADATA_CACHE_FILE: path.join(DIR, "cache.json"), DADATA_RAW_FILE: path.join(DIR, "raw.ndjson"),
      PORTRAIT_SMOKE_STOP: "before-model" }
  });
  ok(result.status === 0, label + ": код возврата 0");
  if (result.status !== 0) console.log(result.error || result.stderr);
  ok(!/ReferenceError/.test(result.stderr || ""), label + ": нет ReferenceError");
  ok(!/SMOKE:/.test(result.stderr || ""), label + ": raw/Python/сеть изолированы");
  ok(fs.existsSync(outPath), label + ": файл создан");
  let out = null;
  try { out = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch (_) { /* Проверки ниже покажут сбой. */ }
  ok(out?.meta?.schema === 2, label + ": meta.schema === 2");
  for (const key of ["t36", "lifeC", "ip", "act"]) ok(out?.[key] != null, label + ": есть " + key);
  const active = out?.act?.rows?.[0], candidate = out?.cand?.rows?.[0];
  ok(out?.act?.rows?.length === 1, label + ": один действующий клиент");
  ok(active?.length === 13, label + ": 13 полей act");
  ok(active?.[1] === inns[0] && active?.[6] === 2, label + ": действующий ИНН и две кассы");
  ok(active?.[0] === "Вымышленный клиент " + inns[0], label + ": имя из DaData-кэша");
  ok(active?.[2] === "999901001", label + ": КПП из raw");
  ok(out?.act?.contacts === withContacts, label + ": act.contacts");
  ok(active?.[10] === (withContacts ? phone : ""), label + ": телефон");
  ok(active?.[11] === (withContacts ? email : ""), label + ": email");
  ok(result.stdout.includes("контакты действующих: " + (withContacts ? "включены" : "выключены")), label + ": сообщение о контактах");
  ok(out?.cand?.rows?.length === 1, label + ": один кандидат");
  ok(candidate?.length === 14, label + ": 14 полей cand");
  ok(candidate?.[4] === 3, label + ": все три кассы за историю");
  ok(candidate?.[8] === inns[1], label + ": ИНН кандидата");
  ok(candidate?.[9] === phone && candidate?.[10] === email, label + ": контакты кандидата сохранены");
  ok(candidate?.[11] === "2025-01-31", label + ": дата ухода из Excel");
  ok(candidate?.[12] === 13, label + ": последний тариф 13 месяцев");
  ok(candidate?.[13] === 2, label + ": две кассы в окне 18 месяцев");
  ok(candidate?.[7] === 500, label + ": фиктивный скор 0.5");
  ok(out?.model != null && same(out.model, {}), label + ": пустой out.model");
  ok(out?.t36?.C?.K === 1 && out?.t36?.C?.kassas === 2, label + ": непустой t36");
  ok(out?.lifeC?.seg?.C?.clients === 2, label + ": lifeC.seg включает действующего и ушедшего");
  ok(out?.lifeC?.chan?.length === 5 && out.lifeC.chan.some((c) => c.clients > 0), label + ": пять каналов и непустая база");
  ok(out?.ip?.clients === 0, label + ": оба клиента ЮЛ");
  ok(Array.isArray(out?.life) && out.life.length > 0, label + ": старый out.life сохранён");
  ok(result.stdout.includes("DaData raw: 2"), label + ": прочитан мини-raw");
  ok(result.stdout.includes("act: 1") && result.stdout.includes("без kass18: 0"), label + ": итоговая статистика");
  ok(out?.meta?.asOf === "2026-09-15" && out?.meta?.fnsMonth === "2026-08", label + ": as-of и локальный месяц ФНС");
  outputs.push(out);
}
ok(outputs.every(Boolean) && same(outputs[0].cand, outputs[1].cand), "флаг контактов не меняет кандидатов");
const after = statOld();
ok(before === null ? after === null : after !== null && before.mtimeNs === after.mtimeNs && before.size === after.size,
  "Downloads/portrait-data.json: наличие, mtime и размер не изменились");
console.log((failed ? "FAIL " + failed : "OK " + n) + "/" + n);
if (failed) process.exit(1);
