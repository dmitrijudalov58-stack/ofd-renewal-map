/*
 * Оркестрация: загрузка XLSX -> парсинг -> модель -> UI.
 * Обработка целиком в браузере, файл никуда не отправляется.
 */
(function () {
  "use strict";

  // strict (default true) = "рокировка": ориентируемся только на клиентов/кассы с
  // действующим кодом ОФД. rows хранится отдельно, чтобы переключатель мог перестроить
  // модель без повторной загрузки файла.
  window.OFDState = { model: null, ctx: null, rows: null, strict: true };

  var fileInput = document.getElementById("fileInput");
  var filenameLabel = document.getElementById("filenameLabel");
  var loadStatus = document.getElementById("loadStatus");
  var asofStamp = document.getElementById("asofStamp");
  var demoBanner = document.getElementById("demoBanner");
  var periodStartInput = document.getElementById("periodStart");
  var periodEndInput = document.getElementById("periodEnd");
  var applyBtn = document.getElementById("applyRange");
  var asOfInput = document.getElementById("asOfInput");
  var applyAsOfBtn = document.getElementById("applyAsOf");
  var strictToggle = document.getElementById("strictToggle");

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
    return { M: window.OFDMetrics, periodStart: start, periodEnd: end, asOf: window.OFDState.asOf, strict: window.OFDState.strict };
  }

  function updateAsofStamp(asOf) {
    asofStamp.style.display = "";
    asofStamp.textContent = "as-of · " + asOf.toLocaleDateString("ru-RU") + " " + asOf.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
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

        var yearStart = new Date(asOf.getFullYear(), 0, 1);
        periodStartInput.value = fmtInputDate(yearStart);
        periodEndInput.value = fmtInputDate(asOf);
        applyBtn.disabled = false;
        asOfInput.value = fmtInputDate(asOf);
        applyAsOfBtn.disabled = false;
        strictToggle.disabled = false;
        updateStrictButton();

        window.OFDState.ctx = currentCtx();

        updateAsofStamp(asOf);
        demoBanner.classList.add("hidden");
        if (!parsed.headerIssues.length) {
          setStatus(window.OFDWidgets.fmtNum(parsed.rows.length) + " строк · " + window.OFDWidgets.fmtNum(model.clients.size) + " клиентов · " + window.OFDWidgets.fmtNum(model.kassas.size) + " касс");
        }

        ["b1-active", "b1-netgrowth", "b1-risk", "b3-channels", "b2-renewals"].forEach(function (id) {
          window.OFDCanvas.addWidget(id);
        });
      })
      .catch(function (err) {
        console.error(err);
        setStatus("Ошибка чтения файла: " + err.message, true);
      });
  });

  applyBtn.addEventListener("click", function () {
    if (!window.OFDState.model) return;
    window.OFDState.ctx = currentCtx();
    window.OFDCanvas.rerenderAll();
  });

  // as-of по умолчанию = момент загрузки файла (реальное "сейчас"), но выгрузка могла
  // быть снята раньше — тогда данные о продлениях за последние дни в файле попросту
  // отсутствуют, и ретроспективная логика оттока (30/31/91 день) должна отталкиваться
  // от даты снятия выгрузки, а не от текущих часов браузера. Даём переопределить вручную.
  applyAsOfBtn.addEventListener("click", function () {
    if (!window.OFDState.model || !asOfInput.value) return;
    var asOf = new Date(asOfInput.value + "T23:59:59");
    window.OFDState.asOf = asOf;
    window.OFDState.ctx = currentCtx();
    updateAsofStamp(asOf);
    window.OFDCanvas.rerenderAll();
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
