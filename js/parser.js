/*
 * Разбор XLSX-выгрузки ОФД в нормализованный массив строк.
 * Принимает уже прочитанную SheetJS-книгу (XLSX.read/XLSX.readFile) — работает
 * одинаково в браузере и в Node, сама библиотека SheetJS сюда не входит.
 *
 * Формат выгрузки: 3 листа (сплит по лимиту Excel в 250k строк), 29 колонок,
 * с ЗАВЕДОМО задвоенным заголовком "Партнер" (текстовое имя партнёра на
 * позиции 19 и денежная сумма на позиции 25) — поэтому колонки читаются по
 * ПОЗИЦИИ, а не по имени, с проверкой заголовков при разборе первого листа.
 */
(function (root) {
  "use strict";

  var EXPECTED_HEADERS = [
    "Перезакреп", "Тип", "PIN код", "Дата создания", "Статус",
    "Срок действия тарифа", "ИНН", "Промокод", "Тип активации", "Дата активации",
    "Дата окончания", "Общая дата окончания", "РНМ ККТ", "Организация", "ИНН организации",
    "КПП организации", "Номер телефона", "Email", "Комментарий", "Партнер",
    "ИНН партнера", "КПП партнера", "Центр продаж", "Тип продаж", "РРЦ",
    "Партнер", "ЦП", "1C", "КА",
  ];

  var IDX = {
    pin: 2, created: 3, status: 4, tariff: 5, innPhys: 6,
    activationType: 8, activated: 9, endDate: 10, overallEnd: 11, rnm: 12,
    org: 13, innOrg: 14, partner: 19, partnerInn: 20, salesCenter: 22, salesType: 23,
  };

  function checkHeader(header) {
    var mismatches = [];
    for (var i = 0; i < EXPECTED_HEADERS.length; i++) {
      if ((header[i] || "").toString().trim() !== EXPECTED_HEADERS[i]) {
        mismatches.push("колонка " + i + ": ожидали «" + EXPECTED_HEADERS[i] + "», нашли «" + header[i] + "»");
      }
    }
    return mismatches;
  }

  function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === "string" && v.trim()) {
      var d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  }

  // Excel-строки иногда приходят с лишними пробелами по краям (ручной ввод/выгрузка) —
  // без нормализации "ООО «Х»" и " ООО «Х» " считаются разными партнёрами и ломают
  // группировки/фильтры по всему инструменту. Числовые ячейки (ИНН и т.п.) не трогаем.
  function cleanStr(v) {
    if (typeof v === "string") {
      var t = v.trim();
      return t === "" ? null : t;
    }
    return v === undefined ? null : v;
  }

  // ИНН иногда хранится в Excel то текстовой ячейкой ("0123456789"), то числовой
  // (123456789 — Excel молча роняет ведущий ноль у числа). Одна и та же организация
  // из-за этого попадала в модель под ДВУМЯ разными ключами (строка vs число) — находка
  // 2026-08-11, на реальных данных инструмент считал 94347 активных клиентов вместо
  // фактических ~89к, целиком объяснялось этим смешением типов. Всегда приводим к строке;
  // если после этого осталось ровно 9 или 11 цифр (у настоящего ИНН длина строго 10 или
  // 12 — юрлицо/физлицо) — значит ведущий ноль был потерян, восстанавливаем его. Проверено
  // на реальных данных: часть восстановленных так значений (433 из выборки) совпадает с
  // уже существующим в базе полноразрядным ИНН той же организации — не догадка, подтверждено.
  function cleanInn(v) {
    var s = cleanStr(v);
    if (s === null) return null;
    s = String(s).trim();
    if (/^\d+$/.test(s) && (s.length === 9 || s.length === 11)) s = "0" + s;
    return s;
  }

  function normalizeRow(cells) {
    return {
      pin: cleanStr(cells[IDX.pin]),
      created: toDate(cells[IDX.created]),
      status: (cells[IDX.status] || "").toString().trim(),
      tariff: cleanStr(cells[IDX.tariff]),
      innPhys: cleanInn(cells[IDX.innPhys]),
      activationType: (cells[IDX.activationType] || "").toString().trim(),
      activated: toDate(cells[IDX.activated]),
      endDate: toDate(cells[IDX.endDate]),
      overallEnd: toDate(cells[IDX.overallEnd]),
      rnm: cleanStr(cells[IDX.rnm]),
      org: cleanStr(cells[IDX.org]),
      innOrg: cleanInn(cells[IDX.innOrg]),
      partner: cleanStr(cells[IDX.partner]),
      partnerInn: cleanInn(cells[IDX.partnerInn]),
      salesCenter: cleanStr(cells[IDX.salesCenter]),
      salesType: cleanStr(cells[IDX.salesType]),
    };
  }

  // XLSX — глобальный объект SheetJS (window.XLSX в браузере, require("xlsx") в Node).
  function parseWorkbook(XLSX, workbook) {
    var rows = [];
    var headerIssues = [];
    workbook.SheetNames.forEach(function (name, sheetIdx) {
      var ws = workbook.Sheets[name];
      if (!ws["!ref"]) return;
      var arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
      if (arr.length === 0) return;
      if (sheetIdx === 0) headerIssues = checkHeader(arr[0]);
      for (var r = 1; r < arr.length; r++) {
        rows.push(normalizeRow(arr[r]));
      }
    });
    return { rows: rows, headerIssues: headerIssues };
  }

  var api = { parseWorkbook: parseWorkbook, normalizeRow: normalizeRow, checkHeader: checkHeader, EXPECTED_HEADERS: EXPECTED_HEADERS };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDParser = api;
})(typeof window !== "undefined" ? window : globalThis);
