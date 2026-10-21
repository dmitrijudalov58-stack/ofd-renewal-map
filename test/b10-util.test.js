"use strict";
const fs = require("fs"), vm = require("vm"), XLSX = require("xlsx");
const u = require("../js/portrait-util.js");
let total = 0, fail = 0;
function ok(cond, msg) {
  total++;
  if (!cond) fail++;
  console.log((cond ? "✓ " : "✗ ") + msg);
}

const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../js/portrait-util.js"), "utf8"), browser);
ok(Object.keys(browser.window.OFDPortraitUtil).join() === Object.keys(u).join(), "UMD: браузер и require экспортируют один API");
ok(browser.window.OFDPortraitUtil.iso(browser.window.OFDPortraitUtil.parseISO("2025-01-31")) === "2025-01-31", "UMD: функции работают через window");
ok(u.parseISO("2025-01-31").toISOString() === "2025-01-31T00:00:00.000Z", "parseISO: полночь UTC");
ok(u.iso(u.parseISO("2025-01-31")) === "2025-01-31", "iso: дата UTC");
ok(u.human(u.parseISO("2025-01-31")) === "31.01.2025", "human: дата UTC");

const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([["d"], [45688]]);
ws.A2.z = "dd.mm.yyyy";
XLSX.utils.book_append_sheet(wb, ws, "dates");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
const value = XLSX.read(buf, { cellDates: true }).Sheets.dates.A2.v;
ok(value instanceof Date, "SheetJS: серийное число прочитано как Date");
ok(u.dayISO(value) === "2025-01-31", "dayISO: дата SheetJS после полного XLSX-цикла");
if (process.env.TZ === "Europe/Moscow") {
  ok(u.localDayISO(value) === "2025-01-30", "Москва: наивная локальная дата воспроизводит дефект SheetJS");
}
const activation = new Date(2025, 0, 31, 14, 25), activationTime = +activation;
ok(u.localDayISO(activation) === "2025-01-31", "localDayISO: время активации без сдвига");
ok(u.dayISO(activation) === "2025-02-01", "dayISO: сдвиг непригоден для времени активации");
ok(+activation === activationTime, "преобразование дат не меняет вход");
[null, undefined, "2025-01-31", 45688, new Date(NaN)].forEach((d) => {
  ok(u.dayISO(d) === null && u.localDayISO(d) === null, "даты: некорректный вход " + String(d));
});
[["36 месяцев", 36], ["1 месяц", 1], ["13 месяцев", 13], ["", null], [null, null], [undefined, null], ["Годовой", null]].forEach(([s, n]) => {
  ok(u.tariffMonths(s) === n, "tariffMonths: " + String(s));
});
[["2025-01-31", 1, "2025-02-28"], ["2028-01-31", 1, "2028-02-29"], ["2025-03-31", -1, "2025-02-28"], ["2026-10-21", -18, "2025-04-21"]].forEach(([s, n, expected]) => {
  const d = u.parseISO(s), before = +d;
  ok(u.iso(u.addMonthsClamp(d, n)) === expected && +d === before, "addMonthsClamp: " + s + " + " + n + ", вход сохранён");
});
const asOf = "2026-10-21", w = u.callWindow("2025-01-31", 13, asOf, 30);
ok(w.k === 2, "callWindow: k = 2");
ok(u.human(w.next) === "31.03.2027", "callWindow: следующая дата без накопления сдвига");
ok(u.human(w.start) === "01.03.2027", "callWindow: начало окна");
ok(w.wait === 131 && w.now === false, "callWindow: ожидание 131 день");
ok(u.callWindow("2025-01-31", 13, asOf, 60).wait === 101, "callWindow: ширина 60 дней");
const opened = u.callWindow("2025-01-31", 1, asOf, 30);
ok(opened.now === true && opened.wait === 0, "callWindow: месячный тариф, окно открыто");
[null, "", "abc", "2025-02-30", "2025-13-01", "2025-1-31"].forEach((s) => {
  ok(u.callWindow(s, 13, asOf, 30) === null, "callWindow: некорректное окончание " + s);
});
[null, 0, -1, 1.5, "13", NaN, Infinity].forEach((m) => {
  ok(u.callWindow("2025-01-31", m, asOf, 30) === null, "callWindow: некорректный тариф " + m);
});
ok(u.callWindow("2025-01-31", 1, "2025-02-28", 0).now, "callWindow: дата продления включена, W = 0");
ok(u.callWindow("2025-01-31", 1, "2025-03-01", 0).k === 2, "callWindow: после даты продления выбирается следующий цикл");
ok(u.callWindow("2025-01-31", 13, "2024-01-01", 30).k === 1, "callWindow: k не меньше 1");
ok(u.windowLabel(w).includes("131 дн."), "windowLabel: ожидание");
ok(u.windowLabel({ now: false, wait: 1234 }) === "через " + (1234).toLocaleString("ru-RU") + " дн.", "windowLabel: разделитель тысяч ru-RU");
ok(u.windowLabel(opened) === "Звонить сейчас", "windowLabel: открытое окно");
ok(u.windowDates(w) === "01.03.2027 — 31.03.2027", "windowDates: границы окна");
ok(u.windowLabel(null) === "—" && u.windowDates(null) === "—", "подписи: пустое окно");
["all", "now", "30", "90"].forEach((mode) => {
  ok(u.windowMatch(null, mode, asOf) === (mode === "all"), "windowMatch: пустое окно, " + mode);
});
ok(u.windowMatch(w, "all", asOf), "windowMatch: all пропускает будущее окно");
ok(u.windowMatch(opened, "now", asOf) && !u.windowMatch(w, "now", asOf), "windowMatch: now");
const boundary = u.callWindow("2025-01-20", 1, asOf, 0);
ok(boundary.wait === 30 && u.windowMatch(boundary, "30", asOf), "windowMatch: 30 дней включительно");
ok(u.windowMatch(opened, "30", asOf), "windowMatch: уже открытое окно в ближайших 30 днях");
const later = u.callWindow("2025-01-20", 12, asOf, 30);
ok(!u.windowMatch(later, "30", asOf) && u.windowMatch(later, "90", asOf), "windowMatch: 90 шире 30");
const free = u.kassRange("", ""), from3 = u.kassRange("3", "");
ok(free.from === null && free.to === null && free.error === "" && u.inKassRange(1, free), "kassRange: без границ");
ok(u.inKassRange(3, from3) && !u.inKassRange(2, from3), "inKassRange: от 3 включительно");
ok(u.inKassRange(3, u.kassRange("", "3")) && !u.inKassRange(4, u.kassRange("", "3")), "inKassRange: верхняя граница включительно");
const reversed = u.kassRange("3", "1");
ok(reversed.error === "от больше, чем до" && !u.inKassRange(2, reversed), "kassRange: перевёрнутые границы");
["0", "2.5", "abc", "-1", "Infinity"].forEach((s) => {
  const a = u.kassRange(s, ""), b = u.kassRange("", s);
  ok(a.error === "Укажите целое число касс от 1" && b.error === a.error && !u.inKassRange(3, a), "kassRange: некорректная граница " + s);
});
const head = Object.freeze(["a", "b"]), rows = Object.freeze([Object.freeze(['текст;"цитата"', null]), Object.freeze([undefined, 7])]);
const csv = u.csvString(head, rows);
ok(csv === '\uFEFF"a";"b"\r\n"текст;""цитата""";""\r\n"";"7"', "csvString: BOM, ;, CRLF, кавычки, null и undefined");
const stats = u.t36Stats(Object.freeze({ K: 36, kassas: 100, clients: 20, clients36: 5, M: 80 }));
ok(stats.kassas === 0.36 && stats.clients === 0.25 && stats.coverage === 0.45 && stats.numerator === 36 && stats.growth === 44, "t36Stats: доли, числитель и рост");
const zero = u.t36Stats({ K: 0, kassas: 0, clients: 0, clients36: 0, M: 0 });
ok(zero.coverage === null && zero.kassas === null && zero.clients === null, "t36Stats: нулевые знаменатели");
ok(u.ymLabel(37.9) === "3 г. 1 мес.", "ymLabel: округление вниз");
ok(u.ymLabel(0) === "0 г. 0 мес.", "ymLabel: ноль");
[-1, null, undefined, "37", NaN, Infinity].forEach((m) => {
  ok(u.ymLabel(m) === "—", "ymLabel: некорректное значение " + m);
});
// Ревью: битый as-of или W не должны давать объект с Invalid Date («через NaN дн.»).
ok(u.callWindow("2025-01-31", 13, "не дата", 30) === null, "callWindow: некорректный as-of → null");
ok(u.callWindow("2025-01-31", 13, "2026-10-21", NaN) === null, "callWindow: W = NaN → null");
ok(u.callWindow("2025-01-31", 13, "2026-10-21", 30) !== null, "callWindow: корректные аргументы по-прежнему дают окно");
console.log(fail ? "FAIL " + fail + "/" + total : "OK " + total + "/" + total);
process.exit(fail ? 1 : 0);
