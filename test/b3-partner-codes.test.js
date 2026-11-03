"use strict";

// Browser-level regression for B3; uses synthetic rows in the same Date realm as the page.
// Run: node test/b3-partner-codes.test.js
const assert = require("node:assert/strict");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const XLSX = require("xlsx");

const HEADERS = ["ИНН партнёра", "Наименование партнёра", "ИНН клиента", "Наименование клиента", "Дата создания", "Дата активации"];
const WIDGET_ID = "b3-partner-codes";

async function loadPage() {
  const dom = await JSDOM.fromFile(path.join(__dirname, "..", "index.html"), {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    url: "file://" + path.join(__dirname, "..", "index.html"),
    beforeParse(win) {
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      const store = Object.create(null);
      Object.defineProperty(win, "localStorage", { configurable: true, value: {
        getItem(key) { return store[key] || null; },
        setItem(key, value) { store[key] = String(value); },
        removeItem(key) { delete store[key]; },
      } });
    },
  });
  const win = dom.window;
  if (win.document.readyState !== "complete") {
    await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
  }
  return { dom, win };
}

function fixture(win) {
  const date = (day, month = 1) => day === null ? null : new win.Date(2026, month, day, 12);
  let index = 0;
  const row = (extra) => ({ pin: "PIN-" + ++index, partner: "Альфа <ООО>", partnerInn: "7700000001",
    innOrg: "0123456789", innPhys: null, org: "Клиент", status: "Зарегистрировано",
    created: date(10), activated: date(11), ...extra });
  return [
    row({ created: date(1), activated: date(15) }),
    row({ status: "Новый", created: date(28), activated: date(28) }),
    row({ status: "Выдан", innOrg: null, innPhys: null, org: null, created: date(10), activated: date(12) }),
    row({ partnerInn: "7700000002", created: date(12), activated: date(13) }),
    row({ partner: "Без ИНН", partnerInn: null, created: date(14), activated: date(14) }),
    row({ status: "Отозвано", created: date(10), activated: date(10) }),
    row({ pin: null, created: date(10), activated: date(10) }),
    row({ pin: null, partner: "Только без PIN", created: date(10) }),
    row({ created: date(31, 0), activated: date(10) }),
    row({ activated: null }),
    row({ partner: "Экспорт Все", partnerInn: "001234567890", created: date(20), activated: date(21) }),
    ...Array.from({ length: 305 }, (_, i) => row({ partner: "Экспорт Все", partnerInn: "001234567890",
      innOrg: String(i).padStart(10, "0"), org: "Клиент " + i, created: date(20), activated: date(21) })),
  ];
}

function fire(win, node, type) { node.dispatchEvent(new win.Event(type, { bubbles: true })); }
function search(win, widget, value) {
  const input = widget.querySelector(".pc-search");
  assert.ok(input, "поле поиска в новом борде");
  input.value = value;
  fire(win, input, "input");
}
function choose(win, widget, text) {
  const option = Array.from(widget.querySelectorAll(".pc-options .pc-option"))
    .find((node) => node.textContent.includes(text));
  assert.ok(option, "вариант партнёра: " + text);
  option.click();
}
function tableRows(widget) {
  return Array.from(widget.querySelectorAll(".pc-table tbody tr"), (tr) =>
    Array.from(tr.cells, (cell) => cell.textContent.trim()));
}
function dateMode(win, widget, mode) {
  const input = widget.querySelector('.pc-date-field[value="' + mode + '"]');
  assert.ok(input, "переключатель даты " + mode);
  input.checked = true;
  fire(win, input, "change");
}

async function main() {
  const { dom, win } = await loadPage();
  try {
    const rows = fixture(win);
    win.OFDState.rows = rows;
    const ctx = { M: win.OFDMetrics, periodStart: new win.Date(2026, 1, 1),
      periodEnd: new win.Date(2026, 1, 28, 23, 59, 59), asOf: new win.Date(2026, 1, 28) };
    const def = win.OFDWidgets.WIDGETS[WIDGET_ID];
    assert.ok(def, "новый борд зарегистрирован"); // RED until implementation
    assert.equal(def.scope, "период");
    assert.ok(win.document.querySelector('[data-group="b3"] [data-widget="' + WIDGET_ID + '"]'), "пункт в B3");
    const widget = def.render(null, ctx, "test-instance");
    win.document.body.appendChild(widget);
    const download = widget.querySelector(".pc-download");
    assert.ok(download && download.disabled, "Excel заблокирован без выбора");
    assert.equal(tableRows(widget).length, 0, "до выбора таблица пуста");

    search(win, widget, "АЛЬФА");
    assert.equal(widget.querySelectorAll(".pc-options .pc-option").length, 2, "одно название, два ИНН");
    search(win, widget, "только без PIN");
    assert.equal(widget.querySelectorAll(".pc-options .pc-option").length, 0, "строка без PIN не создаёт партнёра в выборе");
    search(win, widget, "00000002");
    assert.equal(widget.querySelectorAll(".pc-options .pc-option").length, 1, "поиск по части ИНН");
    search(win, widget, "Альфа");
    choose(win, widget, "7700000001");
    choose(win, widget, "7700000002");
    assert.equal(widget.querySelectorAll(".pc-selected").length, 2, "можно выбрать двух партнёров");
    assert.equal(download.disabled, false);
    assert.deepEqual(Array.from(widget.querySelectorAll(".pc-table th"), (th) => th.textContent), HEADERS);
    assert.equal(widget.querySelector(".pc-table script"), null, "название экранировано");
    const created = tableRows(widget);
    assert.equal(created.length, 5, "созданные коды, включая неактивированный и без клиента, без отозванного");
    assert.ok(created.some((cells) => cells[2] === "" && cells[3] === ""), "пустые поля клиента допустимы");
    assert.ok(created.some((cells) => cells[4] === "01.02.2026"), "нижняя граница включена");
    assert.ok(created.some((cells) => cells[4] === "28.02.2026"), "верхняя граница включена");

    dateMode(win, widget, "activated");
    const activated = tableRows(widget);
    assert.equal(activated.length, 5, "активированные в периоде включают созданный до периода, исключают без даты");
    assert.ok(activated.some((cells) => cells[4] === "31.01.2026" && cells[5] === "10.02.2026"));
    assert.ok(activated.every((cells) => cells[5] !== ""));
    widget.querySelectorAll(".pc-table th")[4].click();
    assert.equal(tableRows(widget)[0][4], "31.01.2026", "дата создания сортируется хронологически, а не как текст");
    const second = Array.from(widget.querySelectorAll(".pc-selected")).find((node) => node.textContent.includes("7700000002"));
    assert.ok(second, "второй выбранный партнёр виден");
    second.querySelector("button").click();
    assert.equal(widget.querySelectorAll(".pc-selected").length, 1, "удаление одного выбора");
    search(win, widget, "Без ИНН"); choose(win, widget, "Без ИНН");
    search(win, widget, "экспорт все"); choose(win, widget, "001234567890");
    assert.ok(tableRows(widget).length > 0 && tableRows(widget).length <= 300, "экран ограничен");
    assert.match(widget.querySelector(".pc-count").textContent, /311/, "число всех строк показано");

    let captured;
    const original = win.OFDExport.downloadXlsx;
    win.OFDExport.downloadXlsx = (name, spec) => { captured = win.OFDExport.buildXlsx(spec); };
    try { download.click(); } finally { win.OFDExport.downloadXlsx = original; }
    assert.ok(captured, "скачивание Excel использует .xlsx API");
    const workbook = XLSX.read(captured, { type: "array", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    assert.deepEqual(matrix[0], HEADERS, "ровно шесть колонок Excel");
    assert.equal(matrix.length - 1, 311, "Excel содержит все 306 массовых кодов и пять остальных");
    assert.ok(matrix.some((cells) => cells[0] === "001234567890"), "ведущие нули в ИНН");
    assert.ok(matrix.some((cells) => cells[4] === "31.01.2026" && cells[5] === "10.02.2026"), "даты без сдвига");
    assert.equal(sheet.A2.t, "s", "ИНН партнёра записан текстом");

    let workerPath, savedBytes;
    const oldWorker = win.Worker;
    const oldSave = win.OFDExport.downloadXlsxBytes;
    let resolveSave;
    const saved = new Promise((resolve) => { resolveSave = resolve; });
    win.Worker = class {
      constructor(url) { workerPath = url; this.rows = []; }
      postMessage(payload) {
        if (payload.type === "start") this.spec = payload.spec;
        if (payload.type === "rows") this.rows.push(...payload.rows);
        if (payload.type === "finish") {
          const bytes = win.OFDExport.buildXlsx({ ...this.spec, rows: this.rows });
          this.onmessage({ data: { bytes: bytes.buffer } });
        }
      }
      terminate() {}
    };
    win.OFDExport.downloadXlsxBytes = (_, bytes) => { savedBytes = bytes; resolveSave(); };
    try {
      download.click();
      await Promise.race([saved, new Promise((_, reject) => setTimeout(() => reject(new Error("worker export timeout")), 5000))]);
    } finally {
      win.Worker = oldWorker;
      win.OFDExport.downloadXlsxBytes = oldSave;
    }
    assert.equal(workerPath, "js/partner-codes-export-worker.js", "в браузере экспорт запускается в отдельном потоке");
    assert.ok(ArrayBuffer.isView(savedBytes) && savedBytes.byteLength > 0, "результат воркера сохраняется как Excel");

    const nextCtx = { ...ctx, periodStart: new win.Date(2026, 0, 1) };
    let pendingWorker, lateDownloads = 0;
    const previousWorker = win.Worker;
    const previousSave = win.OFDExport.downloadXlsxBytes;
    win.Worker = class {
      constructor() { this.terminated = false; pendingWorker = this; }
      postMessage() {} // an export still running when the board rerenders
      terminate() { this.terminated = true; }
    };
    win.OFDExport.downloadXlsxBytes = () => { lateDownloads++; };
    try {
      download.click();
      const rerendered = def.render(null, nextCtx, "test-instance");
      assert.ok(pendingWorker.terminated, "старый экспорт отменён при смене периода");
      pendingWorker.onmessage({ data: { bytes: savedBytes.buffer } });
      assert.equal(lateDownloads, 0, "ответ старого воркера не скачивает устаревший файл");
      assert.equal(rerendered.querySelectorAll(".pc-selected").length, 3, "выбор переживает смену периода");
      assert.ok(rerendered.querySelector('.pc-date-field[value="activated"]').checked, "режим даты переживает смену периода");
      rerendered.querySelector(".pc-download").click();
      def.onRemove("test-instance");
      assert.ok(pendingWorker.terminated, "удаление борда отменяет выгрузку");
    } finally {
      win.Worker = previousWorker;
      win.OFDExport.downloadXlsxBytes = previousSave;
    }
    console.log("B3 partner codes: PASS");
  } finally { dom.window.close(); }
}

main().catch((error) => { console.error("B3 partner codes: FAIL", error.stack || error); process.exitCode = 1; });
