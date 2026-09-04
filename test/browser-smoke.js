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
      // jsdom блокирует реальный localStorage для file:// (opaque origin) -- нужен свой
      // in-memory шим, иначе OFDChannelCalc (перезакрепление партнёров, localStorage-
      // persistence) падает на первом обращении (SKILL.md, гоча №9).
      var store = Object.create(null);
      // jsdom определяет localStorage как accessor-свойство (только чтение для file://) --
      // прямое присваивание кидает DOMException, нужен defineProperty поверх него.
      Object.defineProperty(win, "localStorage", {
        configurable: true,
        value: {
          getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setItem: function (k, v) { store[k] = String(v); },
          removeItem: function (k) { delete store[k]; },
        },
      });
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

  // 9) Борды каналов продаж (B5) -- обычные виджеты холста (не сайдбар-панель, снесённая
  // 2026-08-19 по фидбэку Димы "неудобно"). Ставим 2 из 3 (Оля Зибер, Партнёры), проверяем
  // список партнёров + override в localStorage + перемещение между карточками + порядок
  // метрик (кассы -> тарифы -> деньги -> отток, п.9 требования Димы).
  win.localStorage.removeItem("ofd-channel-overrides-v1");
  // Все 3 борда уже на холсте -- цикл п.1 добавил КАЖДЫЙ id из WIDGETS, включая эти три.
  const olyaNode = win.document.querySelector('[data-widget-id="b5-revenue-olya"]');
  const partnersNode = win.document.querySelector('[data-widget-id="b5-revenue-partners"]');

  // Оба борда открыты ОДНОВРЕМЕННО -- так Дима реально держит их на холсте (2026-08-20:
  // 3 борда рядом, ожидает live-sync между ними, не ручной "⟳" на каждом по отдельности).
  olyaNode.querySelector(".cc-toggle").dispatchEvent(new win.Event("click", { bubbles: true }));
  partnersNode.querySelector(".cc-toggle").dispatchEvent(new win.Event("click", { bubbles: true }));
  const olyaRows = olyaNode.querySelectorAll(".cc-partner-row");
  console.log("cc: список партнёров канала непустой:", olyaRows.length > 0 ? "OK" : "FAIL", olyaRows.length);
  if (olyaRows.length === 0) ok = false;

  // снимаем первого партнёра "Ольги Зибер" (пока "Свободных" ещё нет -- единственная
  // группа в списке "В канале", берём первый чекбокс)
  const firstCb = olyaNode.querySelector('.cc-partner-row input[type="checkbox"]');
  const movedName = firstCb.dataset.partner;
  firstCb.checked = false;
  firstCb.dispatchEvent(new win.Event("change", { bubbles: true }));
  const storedOverrides = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
  const overrideWritten = Object.prototype.hasOwnProperty.call(storedOverrides, movedName) && storedOverrides[movedName] === "";
  console.log("cc: снятие партнёра пишет override в localStorage:", overrideWritten ? "OK" : "FAIL");
  if (!overrideWritten) ok = false;

  const stillCheckedInOlya = Array.from(olyaNode.querySelectorAll('.cc-partner-row input[type="checkbox"]')).find((cb) => cb.dataset.partner === movedName && cb.checked);
  console.log("cc: своя карточка сразу переносит партнёра в «Свободные»:", !stillCheckedInOlya ? "OK" : "FAIL");
  if (stillCheckedInOlya) ok = false;

  // теперь в списке ЕСТЬ и "Свободные" (только что снятый), и "В канале" -- группа
  // "Свободные" должна идти ПЕРВОЙ (Дима, дословно из исходного ТЗ: "чтобы их выводило
  // наверх списка, они же ниже -- те, что за ней уже закреплены"; порядок был перепутан
  // на предыдущем заходе -- "В канале" стояло сверху).
  const firstGroupLabel = olyaNode.querySelector(".cc-group-label");
  console.log("cc: группа «Свободные» идёт первой в списке:", firstGroupLabel && /Свободные/.test(firstGroupLabel.textContent) ? "OK" : "FAIL", firstGroupLabel && firstGroupLabel.textContent);
  if (!firstGroupLabel || !/Свободные/.test(firstGroupLabel.textContent)) ok = false;

  // ДРУГОЙ борд ("Партнёры"), уже открытый, обновился САМ -- без клика по "⟳"
  const freedCb = Array.from(partnersNode.querySelectorAll('.cc-partner-row input[type="checkbox"]')).find((cb) => cb.dataset.partner === movedName);
  console.log("cc: снятый партнёр появился свободным в другом борде БЕЗ «⟳» (live-sync):", freedCb && !freedCb.checked ? "OK" : "FAIL");
  if (!freedCb || freedCb.checked) ok = false;

  // поиск фильтрует список
  const beforeSearch = partnersNode.querySelectorAll(".cc-partner-row").length;
  partnersNode.querySelector(".cc-search").value = "zzz-нет-такого-партнёра-zzz";
  partnersNode.querySelector(".cc-search").dispatchEvent(new win.Event("input", { bubbles: true }));
  const afterSearch = partnersNode.querySelectorAll(".cc-partner-row").length;
  console.log("cc: поиск фильтрует список:", beforeSearch > 0 && afterSearch === 0 ? "OK" : "FAIL", beforeSearch, "->", afterSearch);
  if (!(beforeSearch > 0 && afterSearch === 0)) ok = false;

  // «Выделить всех»/«Убрать всех» в обычном списке (Дима, 2026-09-04) -- сужаем поиском
  // ровно до movedName (сейчас свободен), чтобы затронуть ОДНОГО партнёра и потом вернуть
  // состояние обратно -- иначе ниже по файлу "касс/клиентов к продлению" разъедутся.
  olyaNode.querySelector(".cc-search").value = movedName;
  olyaNode.querySelector(".cc-search").dispatchEvent(new win.Event("input", { bubbles: true }));
  olyaNode.querySelector(".cc-select-all").dispatchEvent(new win.Event("click", { bubbles: true }));
  const storedAfterSelectAll = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
  console.log("cc: «Выделить всех» закрепляет видимых (отфильтрованных) партнёров за каналом:", storedAfterSelectAll[movedName] === "Ольга Зибер" ? "OK" : "FAIL", storedAfterSelectAll[movedName]);
  if (storedAfterSelectAll[movedName] !== "Ольга Зибер") ok = false;

  olyaNode.querySelector(".cc-select-none").dispatchEvent(new win.Event("click", { bubbles: true }));
  const storedAfterSelectNone = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
  console.log("cc: «Убрать всех» освобождает видимых (отфильтрованных) партнёров:", storedAfterSelectNone[movedName] === "" ? "OK" : "FAIL", storedAfterSelectNone[movedName]);
  if (storedAfterSelectNone[movedName] !== "") ok = false;
  olyaNode.querySelector(".cc-search").value = "";
  olyaNode.querySelector(".cc-search").dispatchEvent(new win.Event("input", { bubbles: true }));

  // 9б) Панель "Массовое назначение по Центру продаж" (Дима+Оксана, 2026-09-02). Тестируем
  // на olyaNode -- ищем реальную кассу с channel === "Ольга Зибер" (её точный список
  // партнёров) И непустым salesCenter, берём этот ЦП как гарантированный тест-кейс
  // (не полагаемся на алфавитный порядок allSalesCentersSorted -- первый по алфавиту ЦП
  // может не иметь ни одного кандидата, эффективно уже сидящего в этом канале).
  const allCenters = win.OFDMetrics.allSalesCentersSorted(model);
  console.log("cp: есть значения Центра продаж:", allCenters.length > 0 ? "OK" : "FAIL", allCenters.length);
  if (allCenters.length === 0) ok = false;

  let seedCenter = null;
  model.kassas.forEach((k) => { if (!seedCenter && k.channel === "Ольга Зибер" && k.salesCenter) seedCenter = k.salesCenter; });
  console.log("cp: нашёлся ЦП с кандидатом уже в канале «Ольга Зибер»:", seedCenter ? "OK" : "FAIL", seedCenter);
  if (!seedCenter) ok = false;

  olyaNode.querySelector(".cc-cp-toggle").dispatchEvent(new win.Event("click", { bubbles: true }));
  const cpCenterCbs = olyaNode.querySelectorAll(".cc-cp-center");
  console.log("cp: список ЦП в панели совпадает с данными:", cpCenterCbs.length === allCenters.length ? "OK" : "FAIL", cpCenterCbs.length, "vs", allCenters.length);
  if (cpCenterCbs.length !== allCenters.length) ok = false;

  if (seedCenter) {
    const expectedCandidates = win.OFDMetrics.partnersBySalesCenters(model, new Set([seedCenter]));
    const centerCb = Array.from(cpCenterCbs).find((cb) => cb.value === seedCenter);
    centerCb.checked = true;
    olyaNode.querySelector(".cc-cp-preview-btn").dispatchEvent(new win.Event("click", { bubbles: true }));

    // "Показать только свободных" отмечен по умолчанию (Дима, 2026-09-04) -- снимаем, чтобы
    // сверить ПОЛНЫЙ список кандидатов с независимым расчётом (как было в предыдущей версии).
    const onlyFreeCb = olyaNode.querySelector(".cc-cp-only-free");
    onlyFreeCb.checked = false;
    onlyFreeCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    const allRows = olyaNode.querySelectorAll(".cc-cp-partner");
    console.log("cp: превью партнёров по ЦП (без фильтра) сходится с расчётом:", allRows.length === expectedCandidates.length ? "OK" : "FAIL", allRows.length, "vs", expectedCandidates.length);
    if (allRows.length !== expectedCandidates.length) ok = false;

    // "Выделить всех" / "Убрать всех" (Дима, 2026-09-04) -- действуют на текущий видимый список.
    olyaNode.querySelector(".cc-cp-select-all").dispatchEvent(new win.Event("click", { bubbles: true }));
    const allCheckedAfterSelectAll = Array.from(olyaNode.querySelectorAll(".cc-cp-partner")).every((cb) => cb.checked);
    console.log("cp: «Выделить всех» отмечает все видимые чекбоксы:", allCheckedAfterSelectAll ? "OK" : "FAIL");
    if (!allCheckedAfterSelectAll) ok = false;

    olyaNode.querySelector(".cc-cp-select-none").dispatchEvent(new win.Event("click", { bubbles: true }));
    const noneCheckedAfterSelectNone = Array.from(olyaNode.querySelectorAll(".cc-cp-partner")).every((cb) => !cb.checked);
    console.log("cp: «Убрать всех» снимает все видимые чекбоксы:", noneCheckedAfterSelectNone ? "OK" : "FAIL");
    if (!noneCheckedAfterSelectNone) ok = false;

    // Свежий клик "Показать партнёров" -- сбрасывает превью к дефолтным галочкам (иначе после
    // «Убрать всех» выше ничего не отмечено, и тест "хотя бы один по умолчанию отмечен" ниже
    // провалился бы из-за ДЕЙСТВИЙ САМОГО ТЕСТА, а не бага продукта).
    olyaNode.querySelector(".cc-cp-preview-btn").dispatchEvent(new win.Event("click", { bubbles: true }));
    const onlyFreeCb2 = olyaNode.querySelector(".cc-cp-only-free");
    // Возвращаем "только свободных" -- независимо сверяем, что видимый список сузился до
    // (eff === channelName || eff === "Партнёры"), т.е. скрыты партнёры, занятые ДРУГИМ каналом.
    onlyFreeCb2.checked = true;
    onlyFreeCb2.dispatchEvent(new win.Event("change", { bubbles: true }));
    const rowsFull = win.OFDMetrics.computePartnersByChannel(model, win.OFDState.ctx.asOf, { strict: win.OFDState.ctx.strict });
    const autoMapFull = new Map(rowsFull.map((r) => [r.name, r.channel]));
    const storedNow = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
    function expectedEff(name) {
      if (Object.prototype.hasOwnProperty.call(storedNow, name)) return storedNow[name];
      const auto = autoMapFull.get(name);
      return ["Ольга Зибер", "Лариса Пенигина", "Партнёры"].indexOf(auto) !== -1 ? auto : "Партнёры";
    }
    const expectedFreeCount = expectedCandidates.filter((n) => expectedEff(n) === "Ольга Зибер" || expectedEff(n) === "Партнёры").length;
    const shownFreeCount = olyaNode.querySelectorAll(".cc-cp-partner").length;
    console.log("cp: «только свободных» скрывает занятых другим каналом:", shownFreeCount === expectedFreeCount ? "OK" : "FAIL", shownFreeCount, "vs", expectedFreeCount);
    if (shownFreeCount !== expectedFreeCount) ok = false;

    const previewRows = olyaNode.querySelectorAll(".cc-cp-partner");
    const checkedPreview = Array.from(previewRows).find((cb) => cb.checked);
    console.log("cp: хотя бы один кандидат уже эффективно в канале (checkbox отмечен по умолчанию):", checkedPreview ? "OK" : "FAIL");
    if (!checkedPreview) ok = false;

    if (checkedPreview) {
      const excludedName = checkedPreview.dataset.partner;
      checkedPreview.checked = false;
      olyaNode.querySelector(".cc-cp-apply-btn").dispatchEvent(new win.Event("click", { bubbles: true }));
      const storedAfterCp = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
      console.log("cp: снятие галочки явно выталкивает партнёра в «Партнёры»:", storedAfterCp[excludedName] === "Партнёры" ? "OK" : "FAIL", storedAfterCp[excludedName]);
      if (storedAfterCp[excludedName] !== "Партнёры") ok = false;

      // live-sync -- партнёр должен появиться в обычном списке "Партнёры" на ДРУГОМ уже
      // открытом борде СРАЗУ, без "⟳" (тот же ccBroadcastAssignmentChanged, что и у обычных
      // чекбоксов). Сбрасываем поиск на partnersNode -- предыдущий тест оставил его с
      // заведомо-пустым термином "zzz-...", иначе список отфильтрован в 0 строк.
      partnersNode.querySelector(".cc-search").value = "";
      partnersNode.querySelector(".cc-search").dispatchEvent(new win.Event("input", { bubbles: true }));
      const nowInPartners = Array.from(partnersNode.querySelectorAll('.cc-partner-row input[type="checkbox"]')).find((cb) => cb.dataset.partner === excludedName && cb.checked);
      console.log("cp: live-sync -- вытолкнутый партнёр сразу отмечен в «Партнёры» на другом борде:", nowInPartners ? "OK" : "FAIL");
      if (!nowInPartners) ok = false;

      // возвращаем состояние как было ДО этого блока (тем же путём -- через панель), иначе
      // ниже по файлу "касс/клиентов к продлению" сверяются вручную и не знают про это
      // исключение -- разъедутся с ручным расчётом, который знает только про movedName.
      if (excludedName !== movedName) {
        const rowAgain = Array.from(olyaNode.querySelectorAll(".cc-cp-partner")).find((cb) => cb.dataset.partner === excludedName);
        if (rowAgain) {
          rowAgain.checked = true;
          olyaNode.querySelector(".cc-cp-apply-btn").dispatchEvent(new win.Event("click", { bubbles: true }));
        }
      }
    }
  }

  // свой период "с-по" на борде (Дима, 2026-08-19: "будущие продления", не общий фильтр шапки)
  olyaNode.querySelector(".cc-from").value = "2025-01-01";
  olyaNode.querySelector(".cc-from").dispatchEvent(new win.Event("change", { bubbles: true }));
  olyaNode.querySelector(".cc-to").value = "2025-12-31";
  olyaNode.querySelector(".cc-to").dispatchEvent(new win.Event("change", { bubbles: true }));
  olyaNode.querySelector(".cc-check").value = "1000";
  olyaNode.querySelector(".cc-check").dispatchEvent(new win.Event("input", { bubbles: true }));

  // до ввода % оттока -- блок оттока должен быть пуст (не "0 касс", а placeholder)
  let ccMetrics = olyaNode.querySelectorAll(".cc-metric");
  console.log("cc: 5 блоков метрик (кассы/клиенты/тарифы/деньги/отток):", ccMetrics.length === 5 ? "OK" : "FAIL", ccMetrics.length);
  if (ccMetrics.length !== 5) ok = false;
  const kassasLabelFirst = ccMetrics.length && /Касс к продлению/.test(ccMetrics[0].textContent);
  const clientsLabelSecond = ccMetrics.length > 1 && /Клиентов к продлению/.test(ccMetrics[1].textContent);
  const hasTariffChart = ccMetrics.length > 2 && ccMetrics[2].querySelector(".chart-svg") != null;
  const revenueFourth = ccMetrics.length > 3 && /Прогноз выручки/.test(ccMetrics[3].textContent);
  console.log("cc: порядок метрик кассы->клиенты->тарифы->деньги:", kassasLabelFirst && clientsLabelSecond && hasTariffChart && revenueFourth ? "OK" : "FAIL");
  if (!(kassasLabelFirst && clientsLabelSecond && hasTariffChart && revenueFourth)) ok = false;

  const churnEmptyBlock = ccMetrics[4];
  const churnIsEmptyPlaceholder = /Укажи % оттока/.test(churnEmptyBlock.textContent) && !/\d+\s*касс/.test(churnEmptyBlock.textContent);
  console.log("cc: отток пуст, пока % не введён:", churnIsEmptyPlaceholder ? "OK" : "FAIL");
  if (!churnIsEmptyPlaceholder) ok = false;

  // независимая сверка числа касс/клиентов к продлению (после снятия movedName из Оли
  // Зибер), period -- СВОЙ период борда (не ctx.periodStart/periodEnd)
  const olyaRowsAuto = win.OFDMetrics.computePartnersByChannel(model, win.OFDState.ctx.asOf, { strict: win.OFDState.ctx.strict })
    .filter((r) => r.channel === "Ольга Зибер" && r.name !== movedName).map((r) => r.name);
  const ownFrom = new Date("2025-01-01T00:00:00"), ownTo = new Date("2025-12-31T23:59:59");
  const expectedKassasArr = win.OFDMetrics.computeChannelForecastKassas(model, new Set(olyaRowsAuto), ownFrom, ownTo);
  const expectedKassas = expectedKassasArr.length;
  const expectedClients = new Set(expectedKassasArr.map((k) => k.clientKey)).size;
  const shownKassas = parseInt((ccMetrics[0].querySelector(".stat-value").textContent || "").replace(/\s/g, ""), 10);
  const shownClients = parseInt((ccMetrics[1].querySelector(".stat-value").textContent || "").replace(/\s/g, ""), 10);
  console.log("cc: расчёт касс к продлению сходится с ручной сверкой:", shownKassas === expectedKassas ? "OK" : "FAIL", shownKassas, "vs", expectedKassas);
  if (shownKassas !== expectedKassas) ok = false;
  console.log("cc: расчёт клиентов к продлению сходится с ручной сверкой:", shownClients === expectedClients ? "OK" : "FAIL", shownClients, "vs", expectedClients);
  if (shownClients !== expectedClients) ok = false;

  // ввод % оттока -- касс_в_оттоке = round(касс_к_продлению * %), сумма = касс_в_оттоке * чек
  olyaNode.querySelector(".cc-churn").value = "10";
  olyaNode.querySelector(".cc-churn").dispatchEvent(new win.Event("input", { bubbles: true }));
  ccMetrics = olyaNode.querySelectorAll(".cc-metric");
  const churnFilledBlock = ccMetrics[4];
  const expectedLostKassas = Math.round(expectedKassas * 0.10);
  const expectedLostMoney = expectedLostKassas * 1000;
  const shownLostKassas = parseInt((churnFilledBlock.querySelector(".stat-value").textContent || "").replace(/\D/g, ""), 10);
  const shownLostMoney = parseInt((churnFilledBlock.querySelector(".stat-label").textContent.match(/≈\s*([\d\s]+)\s*₽/) || [])[1]?.replace(/\s/g, "") || "-1", 10);
  console.log("cc: после ввода % оттока считает касс_в_оттоке и сумму:", shownLostKassas === expectedLostKassas && shownLostMoney === expectedLostMoney ? "OK" : "FAIL", shownLostKassas, "vs", expectedLostKassas, "|", shownLostMoney, "vs", expectedLostMoney);
  if (shownLostKassas !== expectedLostKassas || shownLostMoney !== expectedLostMoney) ok = false;

  // 10) Кастомный борд "Новый канал" (B5, 2026-08-20) -- пустой борд с переименованием
  // текстовым полем, партнёры персистятся как обычно (ccOverrides), само ИМЯ -- через
  // instanceId + def.getPersistState/applyPersistState (3-й заход API dnd.js, теперь
  // обоснованно: "каналов может быть больше 3", каждый со своим именем).
  win.OFDCanvas.addWidget("b5-revenue-custom");
  const customNodes = win.document.querySelectorAll('[data-widget-id="b5-revenue-custom"]');
  const customNode = customNodes[customNodes.length - 1];

  const placeholderShown = /Введи название канала/.test(customNode.textContent);
  console.log("custom: пустой борд показывает плейсхолдер до ввода имени:", placeholderShown ? "OK" : "FAIL");
  if (!placeholderShown) ok = false;

  const CUSTOM_NAME = "Тестовый канал " + Math.random().toString(36).slice(2, 6);
  const nameInput = customNode.querySelector(".cc-name-input");
  nameInput.value = CUSTOM_NAME;
  nameInput.dispatchEvent(new win.Event("change", { bubbles: true }));
  const hasAccordionAfterName = !!customNode.querySelector(".cc-toggle");
  console.log("custom: после ввода имени появляется аккордеон партнёров:", hasAccordionAfterName ? "OK" : "FAIL");
  if (!hasAccordionAfterName) ok = false;

  customNode.querySelector(".cc-toggle").dispatchEvent(new win.Event("click", { bubbles: true }));
  const customFirstCb = customNode.querySelector('.cc-partner-row input[type="checkbox"]');
  const customPartnerName = customFirstCb.dataset.partner;
  customFirstCb.checked = true;
  customFirstCb.dispatchEvent(new win.Event("change", { bubbles: true }));
  const overridesAfterCustomAssign = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
  console.log("custom: назначение партнёра в кастомный канал пишет override:", overridesAfterCustomAssign[customPartnerName] === CUSTOM_NAME ? "OK" : "FAIL");
  if (overridesAfterCustomAssign[customPartnerName] !== CUSTOM_NAME) ok = false;

  // переименование мигрирует уже назначенного партнёра на новое имя (не теряет)
  const RENAMED = CUSTOM_NAME + " (переименован)";
  nameInput.value = RENAMED;
  nameInput.dispatchEvent(new win.Event("change", { bubbles: true }));
  const overridesAfterRename = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
  console.log("custom: переименование переносит партнёра на новое имя:", overridesAfterRename[customPartnerName] === RENAMED ? "OK" : "FAIL");
  if (overridesAfterRename[customPartnerName] !== RENAMED) ok = false;

  // getPersistState/applyPersistState -- та же механика, что dnd.js saveLayout/
  // loadSavedLayout используют внутри (проверяем напрямую, без второго JSDOM-окна --
  // дорого перепарсивать XLSX ради симуляции полной перезагрузки страницы)
  const customInstanceId = customNode.closest(".grid-stack-item").dataset.instanceId;
  const savedCustom = win.OFDWidgets.WIDGETS["b5-revenue-custom"].getPersistState(customInstanceId);
  console.log("custom: getPersistState отдаёт текущее имя:", savedCustom === RENAMED ? "OK" : "FAIL", savedCustom);
  if (savedCustom !== RENAMED) ok = false;

  win.OFDCanvas.addWidget("b5-revenue-custom", null, null, null, null, savedCustom);
  const restoredNodes = win.document.querySelectorAll('[data-widget-id="b5-revenue-custom"]');
  const restoredNode = restoredNodes[restoredNodes.length - 1];
  const restoredNameValue = restoredNode.querySelector(".cc-name-input").value;
  console.log("custom: восстановленный борд (addWidget+customState) сразу с именем:", restoredNameValue === RENAMED ? "OK" : "FAIL", restoredNameValue);
  if (restoredNameValue !== RENAMED) ok = false;
  const restoredHasAccordion = !!restoredNode.querySelector(".cc-toggle");
  console.log("custom: восстановленный борд сразу показывает партнёров (не плейсхолдер):", restoredHasAccordion ? "OK" : "FAIL");
  if (!restoredHasAccordion) ok = false;

  // удаление борда освобождает его партнёра (видно свободным у остальных)
  customNode.querySelector(".remove-btn").click();
  const overridesAfterRemove = JSON.parse(win.localStorage.getItem("ofd-channel-overrides-v1") || "{}");
  console.log("custom: удаление борда освобождает партнёра:", overridesAfterRemove[customPartnerName] === "" ? "OK" : "FAIL");
  if (overridesAfterRemove[customPartnerName] !== "") ok = false;

  // 11) "Топ оттока по партнёрам" (b3-churn-top, 2026-08-20): новая колонка "0-30 дней
  // (грейс)" + клик по партнёру -> drill-down таблица касс этого партнёра, оканчивающихся
  // в текущем месяце (РНМ/ИНН/Наименование/Тариф/Дата окончания).
  const churnTopNode = win.document.querySelector('[data-widget-id="b3-churn-top"]');
  const churnTopHeaders = Array.from(churnTopNode.querySelectorAll("th")).map((th) => th.textContent);
  const hasPendingColumn = churnTopHeaders.some((h) => /0-30 дней/.test(h));
  console.log("b3-churn-top: колонка «0-30 дней (грейс)» есть:", hasPendingColumn ? "OK" : "FAIL", churnTopHeaders);
  if (!hasPendingColumn) ok = false;

  const churnFirstRow = churnTopNode.querySelector("tbody tr");
  const churnPartnerName = churnFirstRow.children[0].textContent;
  churnFirstRow.dispatchEvent(new win.Event("click", { bubbles: true }));
  const churnDrillTable = churnTopNode.querySelector(".expand-scroll table");
  const drillHeaders = churnDrillTable ? Array.from(churnDrillTable.querySelectorAll("th")).map((th) => th.textContent) : [];
  const drillHeadersOk = ["РНМ", "ИНН", "Наименование", "Тариф", "Дата окончания"].every((h) => drillHeaders.includes(h));
  console.log("b3-churn-top: клик по партнёру открывает drill-down с нужными колонками:", drillHeadersOk ? "OK" : "FAIL", drillHeaders);
  if (!drillHeadersOk) ok = false;

  const nowForDrill = new Date();
  const expectedDrillRows = win.OFDMetrics.computePartnerKassasInMonth(model, churnPartnerName, nowForDrill.getFullYear(), nowForDrill.getMonth()).length;
  const shownDrillRows = churnDrillTable ? churnDrillTable.querySelectorAll("tbody tr").length : -1;
  console.log("b3-churn-top: число строк drill-down сходится с ручной сверкой:", shownDrillRows === expectedDrillRows ? "OK" : "FAIL", shownDrillRows, "vs", expectedDrillRows);
  if (shownDrillRows !== expectedDrillRows) ok = false;

  // 12) "Распределение продлений по клиентам" (b2-renewdist-clients, 2026-08-20) --
  // копия b2-renewdist, но во главе клиент: нет РНМ/Дата окончания/Статус, продлений
  // клиента = сумма продлений по всем его кассам.
  const renewClientsNode = win.document.querySelector('[data-widget-id="b2-renewdist-clients"]');
  const renewClientsHeaders = Array.from(renewClientsNode.querySelectorAll("th")).map((th) => th.textContent);
  const expectedHeaders = ["ИНН клиента", "Наименование", "Партнёр", "Касс", "Продлений", "Тариф"];
  const forbiddenHeaders = ["РНМ", "Окончание", "Статус"]; // "Статус" -- заголовок таблицы (не фильтр в controls), его тут нет
  const headersMatch = expectedHeaders.every((h) => renewClientsHeaders.includes(h)) && forbiddenHeaders.every((h) => !renewClientsHeaders.includes(h));
  console.log("b2-renewdist-clients: колонки без РНМ/Окончания/Статуса, с Касс/Продлений/Тариф:", headersMatch ? "OK" : "FAIL", renewClientsHeaders);
  if (!headersMatch) ok = false;

  // дефолт фильтра "Статус" -- "только активные" (Дима, 2026-08-20: "значения выглядят
  // сильно завышенно, нужно приземлить")
  const statusFilterDefault = renewClientsNode.querySelector(".f-status").value;
  console.log("b2-renewdist-clients: фильтр «Статус» по умолчанию «активные»:", statusFilterDefault === "active" ? "OK" : "FAIL", statusFilterDefault);
  if (statusFilterDefault !== "active") ok = false;

  // независимая сверка: сумма продлений + число касс случайного клиента (снимаем фильтр
  // "Статус" на "все", чтобы найти клиента гарантированно, независимо от его активности)
  const sampleClient = Array.from(model.clients.values()).find((c) => !c.phys && c.kassas.length > 1);
  const expectedRenewals = sampleClient.kassas.reduce((sum, k) => sum + k.renewals, 0);
  renewClientsNode.querySelector(".f-status").value = "";
  renewClientsNode.querySelector(".f-status").dispatchEvent(new win.Event("change", { bubbles: true }));
  renewClientsNode.querySelector(".f-inn").value = sampleClient.key;
  renewClientsNode.querySelector(".f-inn").dispatchEvent(new win.Event("input", { bubbles: true }));
  const filteredRow = renewClientsNode.querySelector("tbody tr");
  const shownRenewals = filteredRow ? parseInt(filteredRow.children[4].textContent.replace(/\s/g, ""), 10) : null;
  const shownKassaCount = filteredRow ? parseInt(filteredRow.children[3].textContent.replace(/\s/g, ""), 10) : null;
  console.log("b2-renewdist-clients: продления клиента = сумма по его кассам:", shownRenewals === expectedRenewals ? "OK" : "FAIL", shownRenewals, "vs", expectedRenewals);
  if (shownRenewals !== expectedRenewals) ok = false;
  console.log("b2-renewdist-clients: колонка «Касс» = число касс клиента:", shownKassaCount === sampleClient.kassas.length ? "OK" : "FAIL", shownKassaCount, "vs", sampleClient.kassas.length);
  if (shownKassaCount !== sampleClient.kassas.length) ok = false;
  renewClientsNode.querySelector(".f-inn").value = "";
  renewClientsNode.querySelector(".f-inn").dispatchEvent(new win.Event("input", { bubbles: true }));
  renewClientsNode.querySelector(".f-status").value = "active";
  renewClientsNode.querySelector(".f-status").dispatchEvent(new win.Event("change", { bubbles: true }));

  console.log("JS runtime errors caught:", errors.length, errors.slice(0, 5));
  if (errors.length) ok = false;

  console.log(ok ? "\nSMOKE OK" : "\nSMOKE FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
