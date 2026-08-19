// jsdom-смоук: грузит настоящий index.html + все <script src>, включая vendored xlsx,
// В ОДНОМ realm — иначе instanceof Date между Node-модулем xlsx и jsdom window ломается
// и даёт ложные нули (проверено на практике при отладке этого теста).
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// Требует локальную XLSX-выгрузку ОФД (не входит в репозиторий, содержит реальные данные клиентов).
const XLSX_PATH = process.argv[2] || process.env.OFD_TEST_FILE;

async function main() {
  if (!XLSX_PATH) {
    console.error("Укажи путь к тестовой XLSX-выгрузке: node test/browser-smoke.js <путь> (или OFD_TEST_FILE=...)");
    process.exit(1);
  }
  const dom = await JSDOM.fromFile(path.join(__dirname, "..", "index.html"), {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    url: "file://" + path.join(__dirname, "..", "index.html"),
    // ResizeObserver -- нет в jsdom, а GridStack (миграция dnd.js) создаёт его условно при
    // sizeToContent/columnOpts. beforeParse -- страница выполняет свои <script> уже на
    // загрузке, после JSDOM.fromFile шимить поздно.
    beforeParse(win) {
      win.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    },
  });
  const win = dom.window;

  await new Promise((resolve) => {
    if (win.document.readyState === "complete") resolve();
    else win.addEventListener("load", resolve);
  });

  const errors = [];
  win.addEventListener("error", (e) => errors.push(e.error ? e.error.stack || e.message : e.message));

  const xlsxSrc = fs.readFileSync(path.join(__dirname, "..", "js/vendor/xlsx.full.min.js"), "utf8");
  win.eval(xlsxSrc);

  if (!win.XLSX || !win.OFDParser || !win.OFDMetrics || !win.OFDWidgets || !win.OFDCanvas) {
    console.error("Библиотеки не загрузились:", {
      xlsx: !!win.XLSX, parser: !!win.OFDParser, metrics: !!win.OFDMetrics, widgets: !!win.OFDWidgets, canvas: !!win.OFDCanvas,
    });
    process.exit(1);
  }

  const buf = fs.readFileSync(XLSX_PATH);
  const wb = win.XLSX.read(buf, { type: "buffer", cellDates: true });
  const { rows, headerIssues } = win.OFDParser.parseWorkbook(win.XLSX, wb);
  console.log("rows:", rows.length, "headerIssues:", headerIssues);

  const model = win.OFDMetrics.buildModel(rows);
  const asOf = new win.Date("2026-07-30T23:59:59");
  win.OFDState.model = model;
  win.OFDState.asOf = asOf;
  win.OFDState.ctx = {
    M: win.OFDMetrics,
    periodStart: new win.Date("2025-01-01"),
    periodEnd: new win.Date("2025-12-31T23:59:59"),
    asOf: asOf,
  };

  var ok = true;

  // 1) все 25 виджетов рендерятся без ошибок
  const ids = Object.keys(win.OFDWidgets.WIDGETS);
  let failed = 0;
  for (const id of ids) {
    try {
      win.OFDCanvas.addWidget(id);
      const node = win.document.querySelector('[data-widget-id="' + id + '"]');
      if (!node) throw new Error("виджет не появился в DOM");
      const html = node.innerHTML;
      if (/\bNaN\b/.test(html)) console.warn("  [warn] NaN в выводе:", id);
      if (/Invalid Date/.test(html)) console.warn("  [warn] Invalid Date в выводе:", id);
    } catch (e) {
      failed++; ok = false;
      console.error("  [FAIL]", id, "-", e.message);
    }
  }
  console.log("виджетов отрендерено:", ids.length, "провалов:", failed);

  // 2) сверка ключевых чисел с независимо посчитанными через чистый Node-скрипт
  const snap = win.OFDMetrics.computeSnapshot(model, asOf);
  const risk30 = win.OFDMetrics.clientsAtRisk(model, asOf, win.OFDMetrics.daysThresholdFn(asOf, 30));
  console.log("activeClients:", snap.activeClients, "(ожидали 92983)", snap.activeClients === 92983 ? "OK" : "MISMATCH");
  console.log("clientsAtRisk 30d:", risk30.length, "(ожидали 11890)", risk30.length === 11890 ? "OK" : "MISMATCH");
  if (snap.activeClients !== 92983 || risk30.length !== 11890) ok = false;

  // 3) интерактив: смена порога дней в risk-таблице меняет число совпадений ("найдено N")
  const riskNode = win.document.querySelector('[data-widget-id="b1-risk"]');
  const daysInput = riskNode.querySelector(".days-input");
  function foundCount() {
    var m = /найдено ([\d\s]+)/.exec(riskNode.querySelector(".widget-body").textContent);
    return m ? parseInt(m[1].replace(/\s/g, ""), 10) : null;
  }
  const before = foundCount();
  daysInput.value = "7";
  daysInput.dispatchEvent(new win.Event("input", { bubbles: true }));
  const after = foundCount();
  console.log("risk-таблица «найдено»: 30д ->", before, ", 7д ->", after, before > after ? "OK" : "FAIL (должно уменьшиться)");
  if (!(before > after)) ok = false;

  // 4) B4 годы: клик по столбцу раскрывает месяцы
  const yearsNode = win.document.querySelector('[data-widget-id="b4-years"]');
  const bar = yearsNode.querySelector(".mark-bar");
  bar.dispatchEvent(new win.Event("click", { bubbles: true }));
  const detailDiv = yearsNode.querySelector(".widget-body > div > div:last-child");
  const detailHTML = detailDiv ? detailDiv.innerHTML : "";
  console.log("b4-years раскрытие по клику:", detailHTML.length > 20 ? "OK" : "FAIL", "(" + detailHTML.slice(0, 40).replace(/\s+/g, " ") + ")");
  if (detailHTML.length <= 20) ok = false;

  // 5) сортировка таблицы по клику на заголовок "Продлений" (колонка 3 в kassaDetailTable)
  const renewNode = win.document.querySelector('[data-widget-id="b2-tariff"]'); // b2-renewals удалён (п.16)
  const th = renewNode.querySelectorAll("th")[3];
  const firstBefore = renewNode.querySelector("tbody tr td:nth-child(4)").textContent;
  th.dispatchEvent(new win.Event("click", { bubbles: true }));
  const firstAfter = renewNode.querySelector("tbody tr td:nth-child(4)").textContent;
  console.log("сортировка по клику: было", firstBefore, "-> стало", firstAfter, firstBefore !== firstAfter ? "OK" : "FAIL");
  if (firstBefore === firstAfter) ok = false;

  // 5b) фастфильтр партнёра в kassaDetailTable уменьшает "найдено"
  function foundCountIn(node) {
    var m = /найдено ([\d\s]+)/.exec(node.querySelector(".widget-body").textContent);
    return m ? parseInt(m[1].replace(/\s/g, ""), 10) : null;
  }
  const renewBefore = foundCountIn(renewNode);
  const partnerSelect = renewNode.querySelector(".f-partner");
  const somePartner = partnerSelect.options[1].value;
  partnerSelect.value = somePartner;
  partnerSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
  const renewAfter = foundCountIn(renewNode);
  console.log("kassaDetailTable фильтр «" + somePartner + "»: найдено", renewBefore, "->", renewAfter, renewBefore > renewAfter ? "OK" : "FAIL");
  if (!(renewBefore > renewAfter)) ok = false;

  // 5c) b3-channels: выбор канала показывает таблицу партнёров, экспорт переключается
  const chanNode = win.document.querySelector('[data-widget-id="b3-channels"]');
  const chanSelect = chanNode.querySelector(".f-channel");
  chanSelect.value = "Ольга Зибер";
  chanSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
  const chanRows = chanNode.querySelectorAll("tbody tr").length;
  const chanExport = chanNode.querySelector(".widget-body").firstElementChild._getExportRows();
  console.log("b3-channels фильтр «Ольга Зибер»: строк в таблице", chanRows, ", в экспорте", chanExport.length, chanRows > 0 && chanExport.length === chanRows ? "OK" : "FAIL");
  if (!(chanRows > 0 && chanExport.length === chanRows)) ok = false;

  // 5d) b4-years: клик по году → клик по месяцу → таблица партнёров + переключение экспорта
  const yearsNode2 = win.document.querySelector('[data-widget-id="b4-years"]');
  const yearBar = yearsNode2.querySelector(".mark-bar");
  yearBar.dispatchEvent(new win.Event("click", { bubbles: true }));
  const monthBars = yearsNode2.querySelectorAll(".widget-body > div > div:nth-child(3) .mark-bar");
  const exportBeforeMonth = yearsNode2.querySelector(".widget-body").firstElementChild._getExportRows().length;
  if (monthBars.length) monthBars[0].dispatchEvent(new win.Event("click", { bubbles: true }));
  const exportAfterMonth = yearsNode2.querySelector(".widget-body").firstElementChild._getExportRows();
  console.log("b4-years клик по месяцу: экспорт был", exportBeforeMonth, "строк (все партнёры), стал", exportAfterMonth.length, "строк (этот месяц)", monthBars.length > 0 ? "OK" : "FAIL (нет столбцов месяцев)");
  if (monthBars.length === 0) ok = false;

  // 5e) b4-funnel: новые подписи и партиция Создано = Активировано+Неактивировано+Отозвано
  const funnelNode = win.document.querySelector('[data-widget-id="b4-funnel"]');
  const hasNotActivatedLabel = /Неактивировано/.test(funnelNode.textContent);
  const funnel2025 = win.OFDMetrics.computeFunnel(model, new win.Date("2025-01-01"), new win.Date("2025-12-31T23:59:59"));
  const partitionOk = funnel2025.activated + funnel2025.notActivated + funnel2025.revoked === funnel2025.created;
  console.log("b4-funnel: подпись «Неактивировано»", hasNotActivatedLabel ? "OK" : "FAIL", "· партиция Создано", partitionOk ? "OK" : "FAIL", funnel2025);
  if (!hasNotActivatedLabel || !partitionOk) ok = false;

  // 6) экспорт CSV отдаёт непустые данные
  const exportHost = riskNode.querySelector(".widget-body").firstElementChild;
  const csvRows = exportHost._getExportRows ? exportHost._getExportRows() : null;
  const csv = csvRows ? win.OFDExport.toCSV(csvRows) : "";
  console.log("экспорт CSV: строк —", csvRows ? csvRows.length : 0, csv.split("\r\n")[0]);
  if (!csvRows || csvRows.length === 0) ok = false;

  // 7) применение периода пересчитывает все карточки на холсте (rerenderAll)
  win.document.getElementById("periodStart").value = "2024-01-01";
  win.document.getElementById("periodEnd").value = "2024-12-31";
  win.OFDState.ctx = { M: win.OFDMetrics, periodStart: new win.Date("2024-01-01"), periodEnd: new win.Date("2024-12-31T23:59:59"), asOf };
  win.OFDCanvas.rerenderAll();
  const stillThere = win.document.querySelectorAll('[data-widget-id]').length;
  console.log("после rerenderAll виджетов на холсте:", stillThere, stillThere === ids.length ? "OK" : "FAIL");
  if (stillThere !== ids.length) ok = false;

  // 8) rerenderAll не должен показывать СЫРОЙ HTML текстом -- найдено Димой 2026-08-18:
  // виджеты, чей render() возвращает HTML-строку (не DOM Node, напр. statBlock()/карточки
  // b1-active) шли через createTextNode() вместо innerHTML-парсинга -- на экране был виден
  // буквальный "<div class=..." как текст. Тихий баг, БЕЗ исключения -- предыдущая версия
  // этого теста его не ловила (проверяла только errors.length и что виджет остался в DOM,
  // не корректность содержимого). Проверяем на b1-active (карточка, string-render) явно.
  const activeAfterRerender = win.document.querySelector('[data-widget-id="b1-active"]');
  const hasRealStatValue = !!activeAfterRerender.querySelector(".stat-value");
  const hasRawHtmlAsText = /<div class="stat-value">/.test(activeAfterRerender.textContent);
  console.log("после rerenderAll b1-active -- настоящий DOM (не сырой HTML текстом):", hasRealStatValue && !hasRawHtmlAsText ? "OK" : "FAIL");
  if (!hasRealStatValue || hasRawHtmlAsText) ok = false;

  // 9) B5 калькулятор потенциальной выручки: взаимоисключение партнёров между двумя
  // инстансами на холсте, персистентность состояния через rerenderAll (instanceId-based
  // per-instance state, см. dnd.js/widgets.js, 2026-08-19), освобождение партнёра при
  // удалении карточки (def.onRemove-хук).
  function rcCheckboxFor(node, name) {
    var labels = node.querySelectorAll('.threshold-row label');
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === name && labels[i].querySelector('input[type="checkbox"]')) {
        return labels[i].querySelector("input");
      }
    }
    return null;
  }
  const rc1 = win.document.querySelector('[data-widget-id="b5-revenue-calc"]'); // с шага 1
  win.OFDCanvas.addWidget("b5-revenue-calc");
  const rcAll = win.document.querySelectorAll('[data-widget-id="b5-revenue-calc"]');
  const rc2 = rcAll[rcAll.length - 1];

  const rc1Checkboxes = rc1.querySelectorAll('.threshold-row input[type="checkbox"]');
  const rc1FirstLabel = rc1Checkboxes[0].closest("label");
  const rc1PartnerName = rc1FirstLabel.textContent.trim();
  rc1Checkboxes[0].checked = true;
  rc1Checkboxes[0].dispatchEvent(new win.Event("change", { bubbles: true }));

  const rc2SameCb = rcCheckboxFor(rc2, rc1PartnerName);
  console.log("b5 взаимоисключение партнёров:", rc2SameCb && rc2SameCb.disabled ? "OK" : "FAIL");
  if (!rc2SameCb || !rc2SameCb.disabled) ok = false;

  rc1.querySelector(".rc-check").value = "5000";
  rc1.querySelector(".rc-check").dispatchEvent(new win.Event("input", { bubbles: true }));
  rc1.querySelector(".rc-from").value = "2025-01-01";
  rc1.querySelector(".rc-from").dispatchEvent(new win.Event("change", { bubbles: true }));
  rc1.querySelector(".rc-to").value = "2025-12-31";
  rc1.querySelector(".rc-to").dispatchEvent(new win.Event("change", { bubbles: true }));

  win.OFDCanvas.rerenderAll();
  // rc1 -- та же самая ссылка на .widget-узел, что и до rerenderAll: dnd.js подменяет
  // только .widget-body ВНУТРИ него (см. renderWidgetBody), сам узел не пересоздаётся.
  const checkPreserved = rc1.querySelector(".rc-check").value === "5000";
  const partnerCbAfter = rc1.querySelectorAll('.threshold-row input[type="checkbox"]')[0];
  const partnerPreserved = !!(partnerCbAfter && partnerCbAfter.checked);
  console.log("b5 состояние переживает rerenderAll:", checkPreserved && partnerPreserved ? "OK" : "FAIL");
  if (!checkPreserved || !partnerPreserved) ok = false;

  rc1.querySelector(".remove-btn").click();
  const freedCb = rcCheckboxFor(rc2, rc1PartnerName);
  console.log("b5 удаление освобождает партнёра:", freedCb && !freedCb.disabled ? "OK" : "FAIL");
  if (!freedCb || freedCb.disabled) ok = false;

  console.log("JS runtime errors caught:", errors.length, errors.slice(0, 5));
  if (errors.length) ok = false;

  console.log(ok ? "\nSMOKE OK" : "\nSMOKE FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
