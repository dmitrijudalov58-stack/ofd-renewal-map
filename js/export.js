/*
 * Экспорт таблицы виджета в CSV (открывается в Excel как есть — BOM для кириллицы).
 */
(function (root) {
  "use strict";

  function csvEscape(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/[",;\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(rows) {
    if (!rows || rows.length === 0) return "";
    var headers = Object.keys(rows[0]);
    var lines = [headers.map(csvEscape).join(";")];
    rows.forEach(function (r) {
      lines.push(headers.map(function (h) { return csvEscape(r[h]); }).join(";"));
    });
    return lines.join("\r\n");
  }

  function downloadCSV(name, rows) {
    var csv = toCSV(rows);
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var safeName = name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
    a.href = url;
    a.download = safeName + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  root.OFDExport = { downloadCSV: downloadCSV, toCSV: toCSV };
})(typeof window !== "undefined" ? window : globalThis);
