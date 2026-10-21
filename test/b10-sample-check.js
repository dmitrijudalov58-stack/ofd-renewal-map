// Независимый оракул: сырые Excel serials, никаких импортов сборщика/BI/date helpers.
// B10_MUTATE=date|kass18 меняет только объект JSON в памяти; ожидаемый exit code = 1.
"use strict";
const fs = require("fs"), crypto = require("crypto"), XLSX = require("xlsx");
const file = process.env.PORTRAIT_TEST_FILE, xlsxFile = process.env.OFD_TEST_FILE;
if (!file || !xlsxFile) {
  console.error("Нужны обе переменные: PORTRAIT_TEST_FILE (JSON схемы 2) и OFD_TEST_FILE (исходная XLSX).");
  process.exit(2);
}
const DAY = 86400000, EPOCH = Date.UTC(1899, 11, 30);
let total = 0, failed = 0, stage = "чтение JSON";
const ok = (condition, message) => {
  total++;
  if (!condition) failed++;
  console.log((condition ? "✓ " : "✗ ") + message);
};
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex");
const text = (v) => v == null ? "" : String(v).trim();
// Самостоятельная нормализация потерянного Excel ведущего нуля (правило парсера).
const innText = (v) => { const s = text(v); return /^\d{9}$|^\d{11}$/.test(s) ? "0" + s : s; };
function serialDay(n) {
  if (n == null || n === "") return null;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("non-numeric date");
  const d = new Date(EPOCH + n * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY;
}
const iso = (day) => day == null ? "—" : new Date(day * DAY).toISOString().slice(0, 10);
function monthsBefore(day, months) {
  const d = new Date(day * DAY);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last)) / DAY;
}
function maxBalance(kassas, anchor) {
  if (anchor == null) return 0;
  const start = monthsBefore(anchor, 18), points = new Set([start]);
  for (const intervals of kassas.values()) for (const iv of intervals) {
    if (iv.start >= start && iv.start <= anchor) points.add(iv.start);
  }
  let max = 0;
  for (const t of points) {
    let count = 0;
    for (const intervals of kassas.values()) {
      if (intervals.some((iv) => iv.start <= t && t < iv.end)) count++;
    }
    max = Math.max(max, count);
  }
  return max;
}
const HEADERS = {
  status: "Статус", rnm: "РНМ ККТ", orgInn: "ИНН организации", physInn: "ИНН",
  start: "Дата активации", end: "Дата окончания", overall: "Общая дата окончания", tariff: "Срок действия тарифа",
};
function columns(header, sheetNumber) {
  const names = header.map((v) => text(v).replace(/\s+/g, " ").toLowerCase());
  const indices = {};
  for (const [key, title] of Object.entries(HEADERS)) {
    const matches = names.flatMap((name, i) => name === title.toLowerCase() ? [i] : []);
    if (matches.length !== 1) {
      // Печатаем только ожидаемый заголовок, никогда не содержимое ячеек/имя листа.
      throw new Error(`header:${sheetNumber}:${title}:${matches.length}`);
    }
    indices[key] = matches[0];
  }
  return indices;
}

function main() {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.meta.schema !== 2) throw new Error("schema");
  const candidates = data.cand.rows.map((row) => ({ row, inn: text(row[8]), hash: hash(text(row[8])) }))
    .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.inn.localeCompare(b.inn));
  // Выбираем именно клиентов, дубликаты ИНН не должны уменьшать размер выборки.
  // Первые 25 по sha1 почти все однокассовые (kass18 = 1), поэтому добавляем по 10 клиентов, где окно 18 мес. что-то решает:
  // kass18 ≥ 2 и kass18 < максимума касс за историю (r[4]). Все выбираются по sha1, без ПДн в выводе.
  const unique = candidates.filter((c, i, a) => c.inn && a.findIndex((x) => x.inn === c.inn) === i);
  const seen = new Set(), selected = [];
  const take = (list, n) => list.filter((c) => !seen.has(c.inn)).slice(0, n).forEach((c) => { seen.add(c.inn); selected.push(c); });
  take(unique, 25);
  take(unique.filter((c) => c.row[13] >= 2), 10);
  take(unique.filter((c) => c.row[13] < c.row[4]), 10);
  const multi = selected.filter((c) => c.row[13] >= 2).length, narrowed = selected.filter((c) => c.row[13] < c.row[4]).length;
  ok(selected.length >= 40 && multi >= 10 && narrowed >= 10, `детерминированная выборка: ${selected.length} клиентов (25 + до 10 с kass18≥2 + до 10 с kass18<макс. касс); с kass18≥2: ${multi}, с kass18<макс.: ${narrowed}`);
  if (selected.length < 40) return;
  const mutate = process.env.B10_MUTATE;
  if (mutate && !["date", "kass18"].includes(mutate)) throw new Error("mutation");
  if (mutate === "date") {
    const r = selected[0].row;
    r[11] = new Date(Date.parse(r[11] + "T00:00:00Z") + DAY).toISOString().slice(0, 10);
  } else if (mutate === "kass18") selected[0].row[13] += 1;

  stage = "чтение XLSX без cellDates";
  const workbook = XLSX.readFile(xlsxFile); // По умолчанию даты остаются серийными числами.
  const clients = new Map(selected.map((c) => [c.inn, { found: 0, ended: null, tariff: null, rows: [], kassas: new Map(), maxEnd: null }]));
  for (let sheetNumber = 0; sheetNumber < workbook.SheetNames.length; sheetNumber++) {
    stage = "поиск заголовков XLSX";
    const sheet = workbook.Sheets[workbook.SheetNames[sheetNumber]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    const idx = columns(rows[0] || [], sheetNumber + 1);
    stage = "чтение серийных дат выбранных клиентов";
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (text(r[idx.status]) !== "Зарегистрировано" || !text(r[idx.rnm])) continue;
      const inn = innText(r[idx.orgInn]) || innText(r[idx.physInn]), c = clients.get(inn);
      if (!c) continue;
      c.found++;
      const end = serialDay(r[idx.end]), overall = serialDay(r[idx.overall]), start = serialDay(r[idx.start]);
      const match = /\d+/.exec(text(r[idx.tariff])), tariff = match ? Number(match[0]) : null;
      // L одинакова у всех кодов одной кассы, поэтому тариф берём не по L, а по концу кода K (см. ниже).
      if (overall != null) c.rows.push({ overall, end, tariff });
      if (start != null && end != null) {
        const rnm = text(r[idx.rnm]), intervals = c.kassas.get(rnm) || [];
        intervals.push({ start, end }); c.kassas.set(rnm, intervals);
        c.maxEnd = c.maxEnd == null ? end : Math.max(c.maxEnd, end);
      }
    }
  }
  // Дата ухода = максимум L. Последний тариф = тариф кода с максимальным концом кода K среди строк с этим L; при равенстве K — больший срок.
  for (const c of clients.values()) {
    c.ended = c.rows.length ? Math.max(...c.rows.map((r) => r.overall)) : null;
    const last = c.rows.filter((r) => r.overall === c.ended && r.end != null);
    const lastEnd = last.length ? Math.max(...last.map((r) => r.end)) : null;
    const tariffs = last.filter((r) => r.end === lastEnd && r.tariff != null).map((r) => r.tariff);
    c.tariff = tariffs.length ? Math.max(...tariffs) : null;
  }
  stage = "сверка выборки";
  let matched = 0;
  for (let i = 0; i < selected.length; i++) {
    const { row, inn, hash: digest } = selected[i], c = clients.get(inn), prefix = "[" + digest.slice(0, 8) + "]";
    let kass18 = maxBalance(c.kassas, c.ended);
    if (kass18 === 0) kass18 = maxBalance(c.kassas, c.maxEnd);
    const dateOK = c.ended != null && iso(c.ended) === row[11];
    const tariffOK = c.tariff != null && c.tariff === row[12];
    const kassOK = kass18 >= 1 && kass18 === row[13];
    const matches = c.found > 0 && dateOK && tariffOK && kassOK;
    if (matches) matched++;
    if (i < 5) {
      // Значения JSON тоже не печатаем без проверки типа: повреждённая ячейка может содержать ПДн.
      const fileDate = typeof row[11] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row[11]) ? row[11] : "неверная дата";
      const number = (v) => Number.isInteger(v) ? v : "неверное число";
      ok(matches, `${prefix} K/L=${iso(c.maxEnd)}/${iso(c.ended)} тариф=${c.tariff ?? "—"} kass18=${kass18} vs файл L=${fileDate} тариф=${number(row[12])} kass18=${number(row[13])}` +
        (c.found ? "" : "; нет зарегистрированных строк с РНМ в выгрузке"));
    } else if (!matches) {
      ok(false, prefix + (c.found ? ` расхождение: дата=${dateOK}, тариф=${tariffOK}, kass18=${kassOK}` : " нет зарегистрированных строк с РНМ в выгрузке"));
    }
  }
  ok(matched === selected.length, `${matched}/${selected.length} совпало`);
}

try { main(); } catch (e) {
  if (typeof e.message === "string" && e.message.startsWith("header:")) {
    const [, sheet, title, count] = e.message.split(":");
    ok(false, `Лист №${sheet}: ${count === "0" ? "не найден" : "неоднозначен"} обязательный заголовок «${title}».`);
  } else ok(false, "Ошибка этапа «" + stage + "»; содержимое исключения скрыто для защиты ПДн.");
}
console.log(failed ? `FAIL ${failed}/${total}` : `OK ${total}/${total}`);
process.exitCode = failed ? 1 : 0;
