/*
 * Экспорт таблицы виджета в CSV (открывается в Excel как есть — BOM для кириллицы) и в XLSX
 * с выпадающим списком (выгрузка для отдела продаж — CSV выпадающие списки не умеет).
 */
(function (root) {
  "use strict";

  // Значения, начинающиеся с =+-@ (или табом/CR), Excel/LibreOffice трактует как формулу
  // при открытии CSV — источник (годы ручного ввода) не доверенный, экранируем префиксом
  // апострофа (OWASP CSV Injection mitigation), чтобы такая строка осталась просто текстом.
  function csvEscape(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
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

  function safeFileName(name) {
    return name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60);
  }

  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadCSV(name, rows) {
    var csv = toCSV(rows);
    downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }), safeFileName(name) + ".csv");
  }

  // ---------- XLSX (2026-09-28, выгрузка для отдела продаж) ----------
  // Минимальный .xlsx руками: zip без сжатия (method "stored") + 7 XML-частей. SheetJS
  // community-сборка, которая уже лежит в js/vendor, НЕ пишет data validation (выпадающие
  // списки) -- поэтому свой генератор, без новых зависимостей. Строки -- inlineStr (без
  // sharedStrings), значения всегда текст/число, формул нет -- CSV-инъекция неприменима.

  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(s); }

  // files: [{name, data: Uint8Array}] -> Uint8Array zip (stored, флаг UTF-8 имён).
  function zipStored(files) {
    var chunks = [], central = [], offset = 0;
    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    files.forEach(function (f) {
      var nameBytes = utf8(f.name), crc = crc32(f.data), size = f.data.length;
      var common = [].concat(u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0));
      var local = new Uint8Array([].concat(u32(0x04034b50), common));
      chunks.push(local, nameBytes, f.data);
      central.push({ header: [].concat(u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset)), name: nameBytes });
      offset += local.length + nameBytes.length + size;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) {
      var h = new Uint8Array(c.header);
      chunks.push(h, c.name);
      cdSize += h.length + c.name.length;
    });
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(cdStart), u16(0))));
    var total = chunks.reduce(function (s, c) { return s + c.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  function xmlEsc(v) {
    return String(v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // недопустимые в XML 1.0 управляющие символы
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function colLetter(i) {
    var s = "";
    for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }
  function cellXml(ref, v, styleIdx) {
    var st = styleIdx ? ' s="' + styleIdx + '"' : "";
    if (v === null || v === undefined || v === "") return '<c r="' + ref + '"' + st + "/>";
    if (typeof v === "number" && isFinite(v)) return '<c r="' + ref + '"' + st + "><v>" + v + "</v></c>";
    return '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + "</t></is></c>";
  }

  // spec: {sheetName, headers:[str], rows:[[...]], colWidths:[num], textCols:[idx] (числа как
  // текст -- ИНН), listColumn:{index, options:[str], sheetName}} -> Uint8Array .xlsx
  function buildXlsx(spec) {
    var headers = spec.headers, rows = spec.rows, lastCol = colLetter(headers.length - 1);
    var textCols = spec.textCols || [];
    var sheetRows = ['<row r="1">' + headers.map(function (h, i) { return cellXml(colLetter(i) + "1", h, 1); }).join("") + "</row>"];
    rows.forEach(function (r, ri) {
      var n = ri + 2;
      sheetRows.push('<row r="' + n + '">' + r.map(function (v, ci) {
        return cellXml(colLetter(ci) + n, textCols.indexOf(ci) !== -1 && v != null ? String(v) : v, 0);
      }).join("") + "</row>");
    });
    var lastRow = Math.max(2, rows.length + 1);
    var cols = (spec.colWidths || []).map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join("");
    var lc = spec.listColumn;
    var validation = "";
    if (lc) {
      var listRef = "'" + lc.sheetName.replace(/'/g, "''") + "'!$A$1:$A$" + lc.options.length;
      var colL = colLetter(lc.index);
      validation = '<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Статус" error="Выбери значение из списка" sqref="' + colL + "2:" + colL + lastRow + '"><formula1>' + xmlEsc(listRef) + "</formula1></dataValidation></dataValidations>";
    }
    var sheet1 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' + (cols ? "<cols>" + cols + "</cols>" : "") +
      "<sheetData>" + sheetRows.join("") + "</sheetData>" +
      '<autoFilter ref="A1:' + lastCol + (rows.length + 1) + '"/>' + validation + "</worksheet>";
    var files = [];
    var sheetsMeta = [{ name: spec.sheetName, hidden: false }];
    files.push({ name: "xl/worksheets/sheet1.xml", data: utf8(sheet1) });
    if (lc) {
      var sheet2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        lc.options.map(function (o, i) { return '<row r="' + (i + 1) + '">' + cellXml("A" + (i + 1), o, 0) + "</row>"; }).join("") +
        "</sheetData></worksheet>";
      files.push({ name: "xl/worksheets/sheet2.xml", data: utf8(sheet2) });
      sheetsMeta.push({ name: lc.sheetName, hidden: true });
    }
    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheetsMeta.map(function (s, i) { return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '"' + (s.hidden ? ' state="hidden"' : "") + ' r:id="rId' + (i + 1) + '"/>'; }).join("") +
      "</sheets>" + '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' + xmlEsc("'" + spec.sheetName.replace(/'/g, "''") + "'!$A$1:$" + lastCol + "$" + (rows.length + 1)) + "</definedName></definedNames></workbook>";
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetsMeta.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join("") +
      '<Relationship Id="rId' + (sheetsMeta.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF4F1"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheetsMeta.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    return zipStored([
      { name: "[Content_Types].xml", data: utf8(ct) },
      { name: "_rels/.rels", data: utf8(rels) },
      { name: "xl/workbook.xml", data: utf8(wb) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8(wbRels) },
      { name: "xl/styles.xml", data: utf8(styles) },
    ].concat(files));
  }

  function downloadXlsx(name, spec) {
    var bytes = buildXlsx(spec);
    downloadBlob(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), safeFileName(name) + ".xlsx");
  }

  var api = { downloadCSV: downloadCSV, toCSV: toCSV, buildXlsx: buildXlsx, downloadXlsx: downloadXlsx, crc32: crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OFDExport = api;
})(typeof window !== "undefined" ? window : globalThis);
