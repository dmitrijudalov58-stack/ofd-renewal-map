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
  var updateBanner = document.getElementById("updateBanner");
  var freshnessBanner = document.getElementById("freshnessBanner");
  var dedupeBanner = document.getElementById("dedupeBanner");
  var layoutConvertedBanner = document.getElementById("layoutConvertedBanner");
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

  // Признак "то же самое содержимое" для строки -- всё, кроме сравниваемого отдельно PIN.
  function rowSignature(r) {
    return [
      r.status, r.tariff, r.innPhys, r.activationType, r.rnm, r.org, r.innOrg,
      r.partner, r.partnerInn, r.salesCenter, r.salesType,
      r.created ? r.created.getTime() : null,
      r.activated ? r.activated.getTime() : null,
      r.endDate ? r.endDate.getTime() : null,
      r.overallEnd ? r.overallEnd.getTime() : null,
    ].join("|");
  }

  // Сводит строки из НЕСКОЛЬКИХ выгрузок в одну, без потери и без задвоения кодов.
  // entries -- [{ row, fileTime }], fileTime = file.lastModified исходного файла (когда
  // платформа выгрузила именно эту копию -- прокси для "какая версия свежее").
  // Точный дубль (тот же PIN, ВСЕ поля совпадают) -- отбрасывается молча, это ожидаемо
  // при пересекающихся годовых выгрузках (один и тот же код мог попасть в оба файла).
  // Тот же PIN, но РАЗНОЕ содержимое -- это уже не дубль, а код, успевший смениться между
  // двумя скачиваниями (например резерв -> зарегистрирован); тут молча брать первую
  // попавшуюся версию нельзя -- побеждает строка из файла с более поздним lastModified,
  // а сам факт конфликта не прячется (баннер + консоль), чтобы Дима мог перепроверить.
  function mergeRowEntries(entries) {
    var byPin = new Map();
    var out = [];
    var exactDupCount = 0;
    var conflictCount = 0;
    var conflictPins = [];
    for (var i = 0; i < entries.length; i++) {
      var row = entries[i].row;
      var fileTime = entries[i].fileTime;
      if (!row.pin) { out.push(row); continue; } // нечего сверять -- никогда не дедуплицируем
      var sig = rowSignature(row);
      var prev = byPin.get(row.pin);
      if (!prev) {
        var idx = out.length;
        out.push(row);
        byPin.set(row.pin, { sig: sig, fileTime: fileTime, idx: idx });
      } else if (prev.sig === sig) {
        exactDupCount++;
      } else {
        conflictCount++;
        if (conflictPins.length < 50) conflictPins.push(row.pin);
        if (fileTime >= prev.fileTime) {
          out[prev.idx] = row;
          byPin.set(row.pin, { sig: sig, fileTime: fileTime, idx: prev.idx });
        }
      }
    }
    return { rows: out, exactDupCount: exactDupCount, conflictCount: conflictCount, conflictPins: conflictPins };
  }

  // Читает и парсит файлы ПОСЛЕДОВАТЕЛЬНО (не Promise.all) -- статус обновляется по ходу
  // ("файл 2 из 5"), и не держим в памяти все ArrayBuffer сразу при "без ограничений по весу".
  function readAndParseFiles(files) {
    var entries = [];
    var headerIssues = [];
    var idx = 0;
    function next() {
      if (idx >= files.length) return Promise.resolve();
      var file = files[idx];
      var fileNo = idx + 1;
      idx++;
      setStatus("Читаю файл " + fileNo + " из " + files.length + " (" + file.name + ")…");
      return file.arrayBuffer().then(function (buf) {
        return new Promise(function (resolve) {
          requestAnimationFrame(function () {
            setStatus("Разбираю файл " + fileNo + " из " + files.length + " (" + file.name + ")…");
            requestAnimationFrame(function () {
              var wb = window.XLSX.read(buf, { type: "array", cellDates: true });
              var parsed = window.OFDParser.parseWorkbook(window.XLSX, wb);
              if (parsed.headerIssues.length) {
                headerIssues = headerIssues.concat(parsed.headerIssues.map(function (m) { return file.name + ": " + m; }));
              }
              for (var i = 0; i < parsed.rows.length; i++) {
                entries.push({ row: parsed.rows[i], fileTime: file.lastModified || 0 });
              }
              resolve();
            });
          });
        });
      }).then(next);
    }
    return next().then(function () {
      return { entries: entries, headerIssues: headerIssues };
    });
  }

  function updateDedupeBanner(fileCount, merged) {
    if (fileCount < 2 || !merged.conflictCount) {
      dedupeBanner.classList.add("hidden");
      return;
    }
    dedupeBanner.classList.remove("hidden");
    dedupeBanner.textContent = "⚠ " + merged.conflictCount + " код(ов) встретились в разных файлах с РАЗНЫМ содержимым (не точный дубль — статус/дата успели смениться между скачиваниями). " +
      "Оставлена версия из файла с более поздней датой изменения. PIN для проверки — в консоли браузера.";
    console.warn("Конфликтующие PIN между файлами (показаны первые " + merged.conflictPins.length + " из " + merged.conflictCount + "):", merged.conflictPins);
  }

  fileInput.addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files);
    if (!files.length) return;
    filenameLabel.textContent = files.length === 1 ? files[0].name : files.length + " файлов";
    fileLoader.classList.add("active");
    setStatus("Загружаю библиотеку разбора…");

    ensureXLSX()
      .then(function () {
        return readAndParseFiles(files);
      })
      .then(function (parsedFiles) {
        if (parsedFiles.headerIssues.length) {
          console.warn("Расхождение заголовков колонок:", parsedFiles.headerIssues);
          setStatus("Внимание: формат файла отличается от ожидаемого — см. консоль", true);
        }
        var merged = mergeRowEntries(parsedFiles.entries);
        var model = window.OFDMetrics.buildModel(merged.rows, { strict: window.OFDState.strict });
        var asOf = new Date();

        window.OFDState.model = model;
        window.OFDState.rows = merged.rows;
        window.OFDState.asOf = asOf;
        window.OFDState.loadTimeAsOf = asOf; // зафиксирован раз и навсегда, для риск-бордов
        window.OFDState.freshness = computeFreshness(merged.rows);

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
        updateDedupeBanner(files.length, merged);
        demoBanner.classList.add("hidden");
        if (!parsedFiles.headerIssues.length) {
          var statusParts = [];
          if (files.length > 1) statusParts.push(files.length + " файлов");
          statusParts.push(window.OFDWidgets.fmtNum(merged.rows.length) + " строк");
          statusParts.push(window.OFDWidgets.fmtNum(model.clients.size) + " клиентов");
          statusParts.push(window.OFDWidgets.fmtNum(model.kassas.size) + " касс");
          if (merged.exactDupCount) statusParts.push(window.OFDWidgets.fmtNum(merged.exactDupCount) + " дублей пропущено");
          setStatus(statusParts.join(" · "));
        }

        // Сохранённая раскладка (кнопка "Сохранить расположение") имеет приоритет --
        // дефолтные 5 виджетов только если раньше ничего не сохраняли (Дима, 2026-08-12).
        var layoutResult = window.OFDCanvas.loadSavedLayout();
        if (!layoutResult.restored) {
          ["b1-active", "b1-netgrowth", "b1-risk", "b3-channels", "b2-tariff"].forEach(function (id) {
            window.OFDCanvas.addWidget(id);
          });
        }
        if (layoutResult.converted) {
          layoutConvertedBanner.classList.remove("hidden");
          layoutConvertedBanner.textContent = "↻ Раскладка перенесена на новую сетку (миграция на GridStack) — проверь расположение виджетов, при необходимости подвинь/доресайзь и сохрани заново.";
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

  // Баннер "есть обновление" (Дима, 2026-09-04): "уходит время на загрузку файлов -- хочу
  // уведомление, что прошёл деплой". Сверяет /version.json (кладёт deploy.sh при каждом
  // деплое) с тем, что было при открытии страницы. ЯВНО не пытаемся сохранить загруженный
  // файл при обновлении -- Дима согласился на этот риск ("не нужно переусложнять систему"),
  // клик по кнопке -- обычный location.reload(), файл придётся загрузить заново.
  var UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 минут
  var initialBuildId = null;

  function checkForUpdate() {
    if (typeof fetch !== "function") return;
    fetch("/version.json?_=" + Date.now(), { cache: "no-store" }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (!data || !data.build) return;
      if (initialBuildId === null) { initialBuildId = data.build; return; }
      if (data.build !== initialBuildId && updateBanner.classList.contains("hidden")) {
        updateBanner.innerHTML = '↻ На сервере новая версия сайта. <button type="button" class="refresh-chart-btn" id="updateReloadBtn">Обновить страницу</button>';
        updateBanner.classList.remove("hidden");
        document.getElementById("updateReloadBtn").addEventListener("click", function () { location.reload(); });
      }
    }).catch(function () { /* нет сети/сервер недоступен -- не критично, узнаем при следующей проверке */ });
  }
  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkForUpdate();
  });

  // Раздел "B8 Обмен с 1С" (Дима, 2026-09-04) -- виден ТОЛЬКО учётной записи u5yhjzlpy, для
  // всех остальных группа в библиотеке остаётся display:none (class="hidden-1c" в
  // index.html). ВАЖНО: это проверка на клиенте (по логину из Basic Auth через
  // /api/whoami) -- HTML группы физически приходит в браузер любому залогиненному
  // пользователю, просто скрыт стилями/JS. Не крипто-защита, а "не показывать по
  // умолчанию" -- ровно то, что Дима назвал "закрыт тоглами".
  var RESTRICTED_1C_USERNAME = "u5yhjzlpy";
  if (typeof fetch === "function") {
    fetch("/api/whoami").then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (data && data.username === RESTRICTED_1C_USERNAME) {
        var group = document.getElementById("board1cGroup");
        if (group) group.classList.remove("hidden-1c");
      }
    }).catch(function () { /* не удалось узнать логин -- раздел остаётся скрыт, это safe-default */ });
  }
})();
