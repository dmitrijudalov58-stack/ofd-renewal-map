(function (root) {
  "use strict";

  var DAY = 86400000;
  function pad(n) { return String(n).padStart(2, "0"); }
  function parseISO(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(NaN);
    var d = new Date(s + "T00:00:00.000Z");
    return Number.isFinite(+d) && iso(d) === s ? d : new Date(NaN);
  }
  function iso(d) { return String(d.getUTCFullYear()).padStart(4, "0") + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function human(d) { return pad(d.getUTCDate()) + "." + pad(d.getUTCMonth() + 1) + "." + String(d.getUTCFullYear()).padStart(4, "0"); }
  function localDayISO(d) {
    if (!(d instanceof Date) || !Number.isFinite(+d)) return null;
    return String(d.getFullYear()).padStart(4, "0") + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function dayISO(d) {
    if (!(d instanceof Date) || !Number.isFinite(+d)) return null;
    // SheetJS может вернуть конец предыдущих суток для даты без времени.
    return localDayISO(new Date(+d + 12 * 3600e3));
  }
  function tariffMonths(s) {
    var match = String(s == null ? "" : s).match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }
  function addMonthsClamp(d, n) {
    var first = new Date(+d);
    first.setUTCDate(1);
    first.setUTCHours(0, 0, 0, 0);
    first.setUTCMonth(first.getUTCMonth() + n);
    var last = new Date(+first);
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    first.setUTCDate(Math.min(d.getUTCDate(), last.getUTCDate()));
    return first;
  }
  function callWindow(endedISO, months, asOfISO, W) {
    var end = parseISO(endedISO), asOf = parseISO(asOfISO);
    if (!Number.isFinite(+end) || !Number.isFinite(+asOf) || !Number.isFinite(W) || !Number.isInteger(months) || months <= 0) return null;
    var diff = (asOf.getUTCFullYear() - end.getUTCFullYear()) * 12 + asOf.getUTCMonth() - end.getUTCMonth();
    var k = Math.max(1, Math.floor(diff / months)), next = addMonthsClamp(end, k * months);
    // Каждый цикл считаем от исходной даты, сохраняя её день месяца.
    while (next < asOf) { k++; next = addMonthsClamp(end, k * months); }
    var start = new Date(+next - W * DAY), wait = Math.max(0, Math.round((start - asOf) / DAY));
    return { k: k, next: next, start: start, wait: wait, now: asOf >= start && asOf <= next };
  }
  function windowLabel(w) { return w === null ? "—" : w.now ? "Звонить сейчас" : "через " + w.wait.toLocaleString("ru-RU") + " дн."; }
  function windowDates(w) { return w === null ? "—" : human(w.start) + " — " + human(w.next); }
  function windowMatch(w, mode, asOfISO) {
    if (mode === "all") return true;
    if (w === null) return false;
    if (mode === "now") return !!w.now;
    return (mode === "30" || mode === "90") && w.start <= new Date(+parseISO(asOfISO) + Number(mode) * DAY);
  }
  function kassRange(fromStr, toStr) {
    var from = fromStr === "" ? null : Number(fromStr), to = toStr === "" ? null : Number(toStr);
    var invalid = [from, to].some(function (v) { return v !== null && (!Number.isInteger(v) || v < 1); });
    return { from: from, to: to, error: invalid ? "Укажите целое число касс от 1" : from !== null && to !== null && from > to ? "от больше, чем до" : "" };
  }
  function inKassRange(n, range) {
    return !range.error && (range.from === null || n >= range.from) && (range.to === null || n <= range.to);
  }
  function q(s) { return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"'; }
  function csvString(head, rows) {
    return "\uFEFF" + [head].concat(rows).map(function (r) { return r.map(q).join(";"); }).join("\r\n");
  }
  function t36Stats(s) {
    return { kassas: s.kassas === 0 ? null : s.K / s.kassas, clients: s.clients === 0 ? null : s.clients36 / s.clients,
      coverage: s.M === 0 ? null : s.K / s.M, numerator: s.K, growth: s.M - s.K };
  }
  function ymLabel(months) {
    if (!Number.isFinite(months) || months < 0) return "—";
    var r = Math.floor(months);
    return Math.floor(r / 12) + " г. " + r % 12 + " мес.";
  }

  var api = {
    parseISO: parseISO,
    iso: iso,
    human: human,
    dayISO: dayISO,
    localDayISO: localDayISO,
    tariffMonths: tariffMonths,
    addMonthsClamp: addMonthsClamp,
    callWindow: callWindow,
    windowLabel: windowLabel,
    windowDates: windowDates,
    windowMatch: windowMatch,
    kassRange: kassRange,
    inKassRange: inKassRange,
    csvString: csvString,
    t36Stats: t36Stats,
    ymLabel: ymLabel
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDPortraitUtil = api;
})(typeof window !== "undefined" ? window : globalThis);
