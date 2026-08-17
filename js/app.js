/*
 * Оркестрация: загрузка XLSX -> парсинг -> модель -> UI.
 * Обработка целиком в браузере, файл никуда не отправляется.
 */
(function () {
  "use strict";

  // strict (default true) = "рокировка": ориентируемся только на клиентов/кассы с
  // действующим кодом ОФД. rows хранится отдельно, чтобы переключатель мог перестроить
  // модель без повторной загрузки файла.
  window.OFDState = { model: null, ctx: null, rows: null, strict: true, freshness: null, loadTimeAsOf: null };

  var fileInput = document.getElementById("fileInput");
  var filenameLabel = document.getElementById("filenameLabel");
  var loadStatus = document.getElementById("loadStatus");
  var fileLoader = document.getElementById("fileLoader");
  var asofStamp = document.getElementById("asofStamp");
  var demoBanner = document.getElementById("demoBanner");
  var freshnessBanner = document.getElementById("freshnessBanner");
  var periodStartInput = document.getElementById("periodStart");
  var periodEndInput = document.getElementById("periodEnd");
  var applyBtn = document.getElementById("applyRange");
  var asOfInput = document.getElementById("asOfInput");
  var applyAsOfBtn = document.getElementById("applyAsOf");
  var strictToggle = document.getElementById("strictToggle");
  var saveLayoutBtn = document.getElementById("saveLayoutBtn");

  var xlsxLoadPromise = null;
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "js/vendor/xlsx.full.min.js";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Не удалось загрузить библиотеку разбора XLSX")); };
      document.head.appendChild(s);
    });
    return xlsxLoadPromise;
  }

  function setStatus(text, isError) {
    loadStatus.textContent = text;
    loadStatus.className = "load-status" + (isError ? " error" : "");
  }

  function fmtInputDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function currentCtx() {
    var start = new Date(periodStartInput.value + "T00:00:00");
    var end = new Date(periodEndInput.value + "T23:59:59");
    return {
      M: window.OFDMetrics, periodStart: start, periodEnd: end, asOf: window.OFDState.asOf, strict: window.OFDState.strict,
      // loadAsOf -- зафиксирован при загрузке файла, НЕ меняется ни фильтром периода, ни
      // ручным as-of. Для "Клиенты под риском"/"Клиенты к продлению" -- отдел продаж должен
      // видеть факт на сегодня, без путаницы от чужих экспериментов с фильтрами.
      loadAsOf: window.OFDState.loadTimeAsOf,
    };
  }

  function updateAsofStamp(asOf) {
    asofStamp.style.display = "";
    asofStamp.textContent = "as-of · " + asOf.toLocaleDateString("ru-RU") + " " + asOf.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  // Свежесть выгрузки = самая поздняя дата, которую файл вообще видел (created/activated
  // по всем строкам). Если as-of уходит дальше неё — "отток" для месяцев после этой даты
  // не факт, а допущение поверх дыры в данных (нет renewal-событий, потому что выгрузка
  // их просто ещё не застала). Дима согласился жить с этим допущением, но баннер должен
  // об этом явно предупреждать каждый раз.
  function computeFreshness(rows) {
    var max = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.created instanceof Date && (!max || r.created > max)) max = r.created;
      if (r.activated instanceof Date && (!max || r.activated > max)) max = r.activated;
    }
    return max;
  }

  function updateFreshnessBanner() {
    var freshness = window.OFDState.freshness;
    var asOf = window.OFDState.asOf;
    if (!freshness || !asOf || asOf <= freshness) {
      freshnessBanner.classList.add("hidden");
      return;
    }
    freshnessBanner.classList.remove("hidden");
    freshnessBanner.textContent = "⚠ as-of (" + asOf.toLocaleDateString("ru-RU") + ") дальше свежести выгрузки (" + freshness.toLocaleDateString("ru-RU") +
      ") — для дат после " + freshness.toLocaleDateString("ru-RU") + " в файле физически нет событий продления. " +
      "Отток за этот период — предположение поверх дыры в данных (клиент мог продлиться позже даты выгрузки, файл этого ещё не увидел), не факт.";
  }

  function updateStrictButton() {
    var strict = window.OFDState.strict;
    strictToggle.textContent = strict ? "✓ Только действующие" : "⟲ Прежний формат";
    strictToggle.classList.toggle("legacy", !strict);
    strictToggle.title = strict
      ? "Клиент/касса считаются только при действующем (непрерванном) коде ОФД на as-of. Клик — переключиться на прежний формат для сверки."
      : "Прежний формат: резерв физлиц (Новый/Выдан) считается клиентами, кассы — по «Общей дате окончания» без учёта разрывов между кодами. Клик — вернуться к новому правилу.";
  }

  fileInput.addEventListener("change", function (e) {
    var file = e.target.files[0];
    if (!file) return;
    filenameLabel.textContent = file.name;
    fileLoader.classList.add("active");
    setStatus("Загружаю библиотеку разбора…");

    ensureXLSX()
      .then(function () {
        setStatus("Читаю файл…");
        return file.arrayBuffer();
      })
      .then(function (buf) {
        return new Promise(function (resolve) {
          requestAnimationFrame(function () {
            setStatus("Разбираю строки…");
            requestAnimationFrame(function () {
              var wb = window.XLSX.read(buf, { type: "array", cellDates: true });
              resolve(wb);
            });
          });
        });
      })
      .then(function (wb) {
        var parsed = window.OFDParser.parseWorkbook(window.XLSX, wb);
        if (parsed.headerIssues.length) {
          console.warn("Расхождение заголовков колонок:", parsed.headerIssues);
          setStatus("Внимание: формат файла отличается от ожидаемого — см. консоль", true);
        }
        var model = window.OFDMetrics.buildModel(parsed.rows, { strict: window.OFDState.strict });
        var asOf = new Date();

        window.OFDState.model = model;
        window.OFDState.rows = parsed.rows;
        window.OFDState.asOf = asOf;
        window.OFDState.loadTimeAsOf = asOf; // зафиксирован раз и навсегда, для риск-бордов
        window.OFDState.freshness = computeFreshness(parsed.rows);

        var yearStart = new Date(asOf.getFullYear(), 0, 1);
        periodStartInput.value = fmtInputDate(yearStart);
        periodEndInput.value = fmtInputDate(asOf);
        applyBtn.disabled = false;
        asOfInput.value = fmtInputDate(asOf);
        applyAsOfBtn.disabled = false;
        strictToggle.disabled = false;
        saveLayoutBtn.disabled = false;
        updateStrictButton();

        window.OFDState.ctx = currentCtx();

        updateAsofStamp(asOf);
        updateFreshnessBanner();
        demoBanner.classList.add("hidden");
        if (!parsed.headerIssues.length) {
          setStatus(window.OFDWidgets.fmtNum(parsed.rows.length) + " строк · " + window.OFDWidgets.fmtNum(model.clients.size) + " клиентов · " + window.OFDWidgets.fmtNum(model.kassas.size) + " касс");
        }

        // Сохранённая раскладка (кнопка "Сохранить расположение") имеет приоритет --
        // дефолтные 5 виджетов только если раньше ничего не сохраняли (Дима, 2026-08-12).
        if (!window.OFDCanvas.loadSavedLayout()) {
          ["b1-active", "b1-netgrowth", "b1-risk", "b3-channels", "b2-tariff"].forEach(function (id) {
            window.OFDCanvas.addWidget(id);
          });
        }
        fileLoader.classList.remove("active");
      })
      .catch(function (err) {
        console.error(err);
        setStatus("Ошибка чтения файла: " + err.message, true);
        fileLoader.classList.remove("active");
      });
  });

  // Конец периода двигает as-of вслед за собой — Дима хочет "выставил диапазон до 30
  // сентября -> вижу отток за август/июль", без ручной синхронизации двух разных полей.
  // Ручное поле as-of (ниже) остаётся отдельной кнопкой — если нужно сознательно
  // разъединить период и as-of, применяешь его ПОСЛЕ периода, оно её переопределит.
  applyBtn.addEventListener("click", function () {
    if (!window.OFDState.model) return;
    var asOf = new Date(periodEndInput.value + "T23:59:59");
    window.OFDState.asOf = asOf;
    asOfInput.value = periodEndInput.value;
    updateAsofStamp(asOf);
    window.OFDState.ctx = currentCtx();
    updateFreshnessBanner();
    window.OFDCanvas.rerenderAll();
  });

  // as-of по умолчанию = момент загрузки файла (реальное "сейчас"), но выгрузка могла
  // быть снята раньше — тогда данные о продлениях за последние дни в файле попросту
  // отсутствуют, и ретроспективная логика оттока (30/31/91 день) должна отталкиваться
  // от даты снятия выгрузки, а не от текущих часов браузера. Даём переопределить вручную
  // независимо от конца периода (например, посмотреть на диапазон "глазами" другой даты).
  applyAsOfBtn.addEventListener("click", function () {
    if (!window.OFDState.model || !asOfInput.value) return;
    var asOf = new Date(asOfInput.value + "T23:59:59");
    window.OFDState.asOf = asOf;
    window.OFDState.ctx = currentCtx();
    updateAsofStamp(asOf);
    updateFreshnessBanner();
    window.OFDCanvas.rerenderAll();
  });

  saveLayoutBtn.addEventListener("click", function () {
    var ok = window.OFDCanvas.saveLayout();
    var prevText = saveLayoutBtn.textContent;
    saveLayoutBtn.textContent = ok ? "✓ Сохранено" : "Не удалось сохранить";
    setTimeout(function () { saveLayoutBtn.textContent = prevText; }, 1800);
  });

  strictToggle.addEventListener("click", function () {
    if (!window.OFDState.rows) return;
    window.OFDState.strict = !window.OFDState.strict;
    window.OFDState.model = window.OFDMetrics.buildModel(window.OFDState.rows, { strict: window.OFDState.strict });
    window.OFDState.ctx = currentCtx();
    updateStrictButton();
    setStatus(window.OFDWidgets.fmtNum(window.OFDState.rows.length) + " строк · " + window.OFDWidgets.fmtNum(window.OFDState.model.clients.size) + " клиентов · " + window.OFDWidgets.fmtNum(window.OFDState.model.kassas.size) + " касс");
    window.OFDCanvas.rerenderAll();
  });
})();
