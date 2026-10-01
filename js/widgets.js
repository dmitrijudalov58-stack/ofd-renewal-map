/*
 * Рендер виджетов: DOM-слой поверх js/metrics.js.
 * Каждый виджет — запись в WIDGETS: { title, type, scope, span, render(model, ctx) -> HTMLElement }.
 * ctx = { M, periodStart, periodEnd, asOf } — M это root.OFDMetrics.
 */
(function (root) {
  "use strict";

  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  function fmtNum(n) { return (n || 0).toLocaleString("ru-RU"); }
  function fmtDate(d) { return d instanceof Date ? d.toLocaleDateString("ru-RU") : "—"; }
  function isoDateForInput(d) {
    if (!(d instanceof Date)) return "";
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }
  function fmtPct(x) { return (x * 100).toFixed(1) + "%"; }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  // Партнёры/организации — реальные строки из выгрузки, не наш контролируемый текст;
  // экранируем перед вставкой как HTML (названия с "&"/"<" не должны ломать разметку).
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function riskPill(days) {
    if (days <= 7) return '<span class="status-pill crit"><span class="dot"></span>критично · ' + days + ' дн.</span>';
    if (days <= 30) return '<span class="status-pill warn"><span class="dot"></span>риск · ' + days + ' дн.</span>';
    return '<span class="status-pill good"><span class="dot"></span>норма · ' + days + ' дн.</span>';
  }
  // Текстовые (не HTML) варианты пилюль -- для колонки "Статус" в CSV-выгрузке по кассам.
  function riskPillText(days) {
    if (days <= 7) return "критично · " + days + " дн.";
    if (days <= 30) return "риск · " + days + " дн.";
    return "норма · " + days + " дн.";
  }
  function overduePillText(days) {
    if (days > 60) return days + " дн. в оттоке";
    if (days > 30) return days + " дн. в оттоке";
    return days + " дн.";
  }

  // ---------- переиспользуемые чарты ----------

  // однотонный горизонтальный список (для сравнимых по величине корзин с прямыми подписями).
  // Серая полоса — не отдельные данные, а шкала: длина закрашенной части = доля от максимума
  // в списке. Подпись под списком поясняет это явно, плюс opts.caption для доп. контекста единиц.
  // Настоящий горизонтальный бар-чарт (SVG), не div-полоски с бледной заливкой —
  // на светло-сером фоне пастельные оттенки почти не читались, особенно на малых процентах.
  function barList(rows, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    var defaultColor = opts.color || "var(--s1)";
    var labelW = 128, rowH = 30, padTop = 6, padRight = 66, w = 520;
    var barAreaW = w - labelW - padRight;
    var h = rows.length * rowH + padTop * 2;
    var parts = [];
    parts.push('<line class="baseline" x1="' + labelW + '" y1="' + padTop + '" x2="' + labelW + '" y2="' + (h - padTop) + '"></line>');
    rows.forEach(function (r, i) {
      var y = padTop + i * rowH + rowH / 2;
      var barW = Math.max(3, (r.value / max) * barAreaW);
      var color = r.color || defaultColor;
      parts.push('<text class="row-label" x="' + (labelW - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(r.label) + '</text>');
      parts.push('<rect x="' + labelW + '" y="' + (y - 7) + '" width="' + barW.toFixed(1) + '" height="14" rx="3" fill="' + color + '"><title>' + esc(r.label) + ': ' + fmtNum(r.value) + '</title></rect>');
      parts.push('<text class="value-label" x="' + (labelW + barW + 8).toFixed(1) + '" y="' + (y + 4) + '">' + fmtNum(r.value) + '</text>');
    });
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" role="img" aria-label="' + (opts.caption || 'распределение') + '">' + parts.join("") + '</svg>';
    return opts.caption ? svg + '<div class="stat-label" style="margin-top:6px">' + opts.caption + '</div>' : svg;
  }

  // Бакеты фильтра "Продлений" (Дима, 2026-08-18) — заменили числовой "Продлений от N" на
  // явные чекбоксы: раньше 0, введённый в поле, был неотличим от пустого поля (оба давали
  // "фильтр выключен", изолировать именно "0 продлений" было нельзя) — отсюда жалоба
  // "фильтрация не идёт от нуля". Мультивыбор — объединение (ИЛИ) отмеченных бакетов.
  var RENEWAL_BUCKETS = [
    { id: "0", label: "0", test: function (n) { return n === 0; } },
    { id: "1-2", label: "1-2", test: function (n) { return n >= 1 && n <= 2; } },
    { id: "3-5", label: "3-5", test: function (n) { return n >= 3 && n <= 5; } },
    { id: "6+", label: "6+", test: function (n) { return n >= 6; } },
  ];

  // Таблица касс с фастфильтрами (партнёр / тариф / статус / ИНН клиента / бакет продлений) —
  // общий компонент для "Кассы и продления" и таблиц-раскрытий под распределениями (B2).
  function kassaDetailTable(kassaArray, asOf, opts) {
    opts = opts || {};
    var limit = opts.limit || 150;
    // opts.M/opts.strict — единое определение "действующая касса" (metrics.js isKassaAlive/
    // kassaDeadline), совпадает с тем, что используют риск-листы и снэпшот-метрики.
    var M = opts.M, strict = opts.strict;
    function aliveOf(k) { return M ? M.isKassaAlive(k, asOf, strict) : !!(k.overallEnd && k.overallEnd >= asOf); }
    function deadlineOf(k) { return M ? M.kassaDeadline(k, asOf, strict) : (k.overallEnd && k.overallEnd >= asOf ? k.overallEnd : null); }
    var partners = Array.from(new Set(kassaArray.map(function (k) { return k.partner || "—"; }))).sort();
    var tariffs = Array.from(new Set(kassaArray.map(function (k) { return k.tariff || "—"; }))).sort();
    var wrap = el('<div></div>');
    var controls = el(
      '<div class="threshold-row">' +
      '<label>Партнёр <select class="f-partner"><option value="">все</option>' +
      partners.map(function (p) { return '<option>' + esc(p) + '</option>'; }).join("") + '</select></label>' +
      '<label>Тариф <select class="f-tariff"><option value="">все</option>' +
      tariffs.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join("") + '</select></label>' +
      '<label>Статус <select class="f-status"><option value="">все</option><option value="alive">активна</option><option value="lapsed">не действует</option></select></label>' +
      '<label>ИНН клиента <input type="text" class="f-inn" placeholder="поиск" style="width:110px"></label>' +
      '<span style="display:flex;gap:8px;align-items:center;color:var(--muted)">Продлений:' +
      RENEWAL_BUCKETS.map(function (b) { return '<label style="display:flex;gap:3px;align-items:center;color:var(--ink)"><input type="checkbox" class="f-ren" value="' + b.id + '"> ' + b.label + '</label>'; }).join("") +
      '</span>' +
      '</div>'
    );
    var tableHolder = el('<div></div>');
    var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
    wrap.appendChild(controls);
    wrap.appendChild(tableHolder);
    wrap.appendChild(expandArea);

    function apply() {
      var pf = controls.querySelector(".f-partner").value;
      var tf = controls.querySelector(".f-tariff").value;
      var sf = controls.querySelector(".f-status").value;
      var innf = controls.querySelector(".f-inn").value.trim().toLowerCase();
      var checkedBuckets = Array.from(controls.querySelectorAll(".f-ren:checked")).map(function (cb) { return cb.value; });
      var activeBuckets = RENEWAL_BUCKETS.filter(function (b) { return checkedBuckets.indexOf(b.id) !== -1; });
      var filtered = kassaArray.filter(function (k) {
        var alive = aliveOf(k);
        if (pf && (k.partner || "—") !== pf) return false;
        if (tf && (k.tariff || "—") !== tf) return false;
        if (sf === "alive" && !alive) return false;
        if (sf === "lapsed" && alive) return false;
        if (innf && !(k.clientKey || "").toLowerCase().includes(innf)) return false;
        if (activeBuckets.length && !activeBuckets.some(function (b) { return b.test(k.renewals); })) return false;
        return true;
      });
      filtered.sort(function (a, b) { return b.renewals - a.renewals; });
      var top = filtered.slice(0, limit);
      var rows = top.map(function (k) {
        // "Окончание" -- ВСЕГДА дата окончания последнего тарифа (прошедшая или будущая,
        // k.overallEnd), не прячем её за пустотой, когда касса уже в оттоке (п.17.2,
        // 2026-08-06). Статус-пилюля отдельно берёт живую дедлайн-логику (deadlineOf).
        var deadline = deadlineOf(k);
        var status;
        if (deadline) {
          status = riskPill(daysBetween(asOf, deadline));
        } else {
          // Не действует прямо сейчас -- но это ещё не значит "отток" (п.1, метрики
          // 2026-08-06): 0-30 дней после даты окончания -- грейс, продление ещё может
          // спасти, финальный отток не подтверждён и никуда не засчитывается. Раньше
          // пилюля сразу красным писала "в оттоке" с первого дня просрочки -- расходилось
          // с формулой оттока (churnStatusFromEnd) и путало Диму визуально (2026-09-09).
          var overdueDays = daysBetween(k.overallEnd, asOf);
          status = M && M.kassaChurnStatus(k, asOf) === "pending"
            ? '<span class="status-pill warn"><span class="dot"></span>грейс · ' + overdueDays + ' дн.</span>'
            : '<span class="status-pill crit"><span class="dot"></span>' + overdueDays + ' дн. в оттоке</span>';
        }
        var row = [k.rnm, k.clientKey || "—", k.partner || "—", k.renewals];
        if (!opts.hideTariff) row.push(k.tariff || "—");
        row.push(fmtDate(k.overallEnd), status);
        return row;
      });
      tableHolder.innerHTML = "";
      expandArea.innerHTML = "";
      tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(filtered.length) + (filtered.length > top.length ? " · показаны первые " + top.length + ", остальное — через экспорт" : "") + ' · клик по строке — история тарифов кассы</div>'));
      var headers = opts.hideTariff
        ? [{ label: "РНМ" }, { label: "ИНН клиента" }, { label: "Партнёр" }, { label: "Продлений", num: true }, { label: "Окончание" }, { label: "Статус", html: true }]
        : [{ label: "РНМ" }, { label: "ИНН клиента" }, { label: "Партнёр" }, { label: "Продлений", num: true }, { label: "Тариф" }, { label: "Окончание" }, { label: "Статус", html: true }];
      var tableWrap = makeSortableTable(headers, rows);
      tableHolder.appendChild(tableWrap);
      // клик по строке -> хронология кодов этой кассы (дата активации -> тариф -> дата окончания),
      // паттерн раскрытия как в b4-partners. Строки таблицы после сортировки переставляются по DOM,
      // поэтому РНМ берём из самой ячейки, а не из индекса top[i].
      tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function () {
          var rnm = tr.children[0].textContent;
          var k = kassaArray.find(function (x) { return x.rnm === rnm; });
          if (!k) return;
          // k.codes -- только коды со статусом "Зарегистрировано" (см. buildModel), статус
          // в хронологии не показываем, он всегда один и тот же
          var codeRows = k.codes.map(function (code, i) {
            var end = M ? M.individualEnd(code) : code.endDate;
            return [i + 1, fmtDate(code.activated), code.tariff || "—", fmtDate(end)];
          });
          expandArea.innerHTML = "";
          expandArea.appendChild(el('<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px;margin-bottom:6px"><b>РНМ ' + esc(rnm) + '</b> · история кодов (' + k.codes.length + ')</div>'));
          expandArea.appendChild(makeSortableTable([{ label: "#", num: true }, { label: "Активирован" }, { label: "Тариф" }, { label: "Окончание" }], codeRows));
        });
      });
      wrap._getExportRows = function () {
        return filtered.map(function (k) {
          var alive = aliveOf(k);
          var row = { РНМ: k.rnm, ИННКлиента: k.clientKey || "", Партнёр: k.partner || "", Продлений: k.renewals };
          if (!opts.hideTariff) row.Тариф = k.tariff || "";
          row.ОбщаяДатаОкончания = fmtDate(k.overallEnd);
          // Тот же грейс-фикс, что и в статус-пилюле на экране (2026-09-09) — экспорт не
          // должен расходиться с тем, что видно в таблице.
          row.Статус = alive ? "активна" : (M && M.kassaChurnStatus(k, asOf) === "pending" ? "грейс (0-30 дн.)" : "в оттоке");
          return row;
        });
      };
      wrap._getFilteredKassas = function () { return filtered; };
    }
    controls.addEventListener("change", apply);
    controls.addEventListener("input", apply);
    apply();
    return wrap;
  }

  // Клиентская версия kassaDetailTable (2026-08-20, "Распределение продлений по
  // клиентам") -- во главе КЛИЕНТ (ИНН), не касса. РНМ/дата окончания/статус убраны
  // сознательно (Дима): у клиента может быть НЕСКОЛЬКО касс с разными датами/статусами,
  // единого значения нет. Тариф оставлен -- последней по дате активации кассы клиента
  // (тоже не единственный, но представительный, тот же принцип, что и c.partner в buildModel).
  function clientRenewalDetailTable(clientArray, opts) {
    opts = opts || {};
    var limit = opts.limit || 150;
    var partners = Array.from(new Set(clientArray.map(function (c) { return c.partner || "—"; }))).sort();
    var wrap = el('<div></div>');
    var controls = el(
      '<div class="threshold-row">' +
      '<label>Партнёр <select class="f-partner"><option value="">все</option>' +
      partners.map(function (p) { return '<option>' + esc(p) + '</option>'; }).join("") + '</select></label>' +
      // Дефолт "активные" (не "все", как у остальных фильтров) -- сырые числа по ВСЕМ
      // клиентам (включая давно отвалившихся с историческими продлениями) выглядели
      // завышенными (Дима, 2026-08-20: "нужно приземлить эту историю").
      '<label>Статус <select class="f-status"><option value="active" selected>только активные</option><option value="">все</option></select></label>' +
      '<label>ИНН клиента <input type="text" class="f-inn" placeholder="поиск" style="width:110px"></label>' +
      '<span style="display:flex;gap:8px;align-items:center;color:var(--muted)">Продлений:' +
      RENEWAL_BUCKETS.map(function (b) { return '<label style="display:flex;gap:3px;align-items:center;color:var(--ink)"><input type="checkbox" class="f-ren" value="' + b.id + '"> ' + b.label + '</label>'; }).join("") +
      '</span>' +
      '</div>'
    );
    var tableHolder = el('<div></div>');
    wrap.appendChild(controls);
    wrap.appendChild(tableHolder);

    function apply() {
      var pf = controls.querySelector(".f-partner").value;
      var sf = controls.querySelector(".f-status").value;
      var innf = controls.querySelector(".f-inn").value.trim().toLowerCase();
      var checkedBuckets = Array.from(controls.querySelectorAll(".f-ren:checked")).map(function (cb) { return cb.value; });
      var activeBuckets = RENEWAL_BUCKETS.filter(function (b) { return checkedBuckets.indexOf(b.id) !== -1; });
      var filtered = clientArray.filter(function (c) {
        if (pf && (c.partner || "—") !== pf) return false;
        if (sf === "active" && !c.active) return false;
        if (innf && !(c.key || "").toLowerCase().includes(innf)) return false;
        if (activeBuckets.length && !activeBuckets.some(function (b) { return b.test(c.renewals); })) return false;
        return true;
      });
      filtered.sort(function (a, b) { return b.renewals - a.renewals; });
      var top = filtered.slice(0, limit);
      var rows = top.map(function (c) { return [c.key, c.org || "—", c.partner || "—", c.kassaCount, c.renewals, c.tariff || "—"]; });
      tableHolder.innerHTML = "";
      tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(filtered.length) + (filtered.length > top.length ? " · показаны первые " + top.length + ", остальное — через экспорт" : "") + '</div>'));
      tableHolder.appendChild(makeSortableTable(
        [{ label: "ИНН клиента" }, { label: "Наименование" }, { label: "Партнёр" }, { label: "Касс", num: true }, { label: "Продлений", num: true }, { label: "Тариф" }],
        rows
      ));
      wrap._getExportRows = function () {
        return filtered.map(function (c) { return { ИННКлиента: c.key, Наименование: c.org || "", Партнёр: c.partner || "", Касс: c.kassaCount, Продлений: c.renewals, Тариф: c.tariff || "" }; });
      };
      wrap._getFilteredClients = function () { return filtered; };
    }
    controls.addEventListener("change", apply);
    controls.addEventListener("input", apply);
    apply();
    return wrap;
  }

  // линия + область по месячному ряду, две серии опционально (categorical slot1/slot2)
  function lineChart(months, series, opts) {
    opts = opts || {};
    var w = 520, h = 150, padL = 34, padR = 18, padT = 16, padB = 24;
    var allVals = [].concat.apply([], series.map(function (s) { return s.values; }));
    var maxV = Math.max.apply(null, allVals.concat([1]));
    // minV -- 0 всегда входит в диапазон (обычный случай "все значения >=0" не меняется:
    // нижняя граница как и раньше 0), НО если реальные данные уходят в минус (напр.
    // "Накопительно"/"Дельта изменения" в текущем ещё не закрытом месяце может провалиться
    // в минус из-за разрыва между новыми и оттоком) -- граница растягивается вниз, чтобы
    // минимум тоже попадал в видимую область. Раньше без этого y(v) для отрицательных v
    // уезжал далеко за h (150) и обрезался SVG по умолчанию -- НЕ лечилось ресайзом
    // карточки, т.к. дело не в размере, а в формуле шкалы (Дима, скрин 2026-09-23).
    var minV = Math.min.apply(null, allVals.concat([0]));
    var range = (maxV - minV) || 1;
    var n = months.length;
    var x = function (i) { return n <= 1 ? padL : padL + (i / (n - 1)) * (w - padL - padR); };
    var y = function (v) { return padT + (1 - (v - minV) / range) * (h - padT - padB); };
    var yZero = y(0);

    function pathFor(values) {
      return values.map(function (v, i) { return (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
    }

    var svgParts = [];
    svgParts.push('<line class="gridline" x1="' + padL + '" y1="' + (padT) + '" x2="' + (w - padR) + '" y2="' + (padT) + '"></line>');
    svgParts.push('<line class="gridline" x1="' + padL + '" y1="' + (padT + (h - padT - padB) / 2) + '" x2="' + (w - padR) + '" y2="' + (padT + (h - padT - padB) / 2) + '"></line>');
    svgParts.push('<line class="baseline" x1="' + padL + '" y1="' + yZero.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + yZero.toFixed(1) + '"></line>');

    series.forEach(function (s) {
      var d = pathFor(s.values);
      if (opts.area) {
        var areaD = d + " L" + x(n - 1).toFixed(1) + "," + yZero.toFixed(1) + " L" + x(0).toFixed(1) + "," + yZero.toFixed(1) + " Z";
        svgParts.push('<path class="mark-area" style="fill:' + s.color + '" d="' + areaD + '"></path>');
      }
      svgParts.push('<path class="mark-line" style="stroke:' + s.color + '" d="' + d + '"></path>');

      // точка + подсказка на каждый месяц (не только на последней) — крупный прозрачный
      // круг под маленькой видимой точкой расширяет зону наведения
      s.values.forEach(function (v, i) {
        var cx = x(i).toFixed(1), cy = y(v).toFixed(1);
        var tip = (s.tooltips && s.tooltips[i]) ? s.tooltips[i] : (MONTHS_SHORT[months[i].getMonth()] + " " + months[i].getFullYear() + ": " + fmtNum(v));
        svgParts.push('<circle cx="' + cx + '" cy="' + cy + '" r="9" fill="transparent" style="cursor:pointer"><title>' + esc(tip) + '</title></circle>');
        svgParts.push('<circle class="mark-dot" style="fill:' + s.color + '" cx="' + cx + '" cy="' + cy + '" r="2.5" pointer-events="none"></circle>');
      });

      var lastI = n - 1;
      svgParts.push('<circle class="mark-dot" style="fill:' + s.color + '" cx="' + x(lastI).toFixed(1) + '" cy="' + y(s.values[lastI]).toFixed(1) + '" r="3.5" pointer-events="none"></circle>');
      // text-anchor=end + x-6 (не +6) -- подпись растёт ВЛЕВО от последней точки. С ростом
      // вправо большое число (напр. накопительное "93 083" в "Прирост базы") вылезало за
      // правый край viewBox и обрезалось SVG по умолчанию -- ресайз карточки не спасал,
      // т.к. вся SVG масштабируется пропорционально (Дима, 2026-09-22).
      svgParts.push('<text class="value-label" text-anchor="end" x="' + (x(lastI) - 6).toFixed(1) + '" y="' + (y(s.values[lastI]) - 6).toFixed(1) + '">' + fmtNum(s.values[lastI]) + '</text>');
    });

    var step = Math.max(1, Math.ceil(n / 7));
    for (var i = 0; i < n; i += step) {
      svgParts.push('<text class="tick-label" x="' + x(i).toFixed(1) + '" y="' + (h - 6) + '">' + MONTHS_SHORT[months[i].getMonth()] + '</text>');
    }

    var legend = "";
    if (series.length > 1) {
      legend = '<div class="chart-legend">' + series.map(function (s) {
        return '<span class="lg-item"><span class="lg-swatch" style="background:' + s.color + '"></span>' + s.label + '</span>';
      }).join("") + '</div>';
    }

    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" role="img" aria-label="динамика по месяцам">' +
      svgParts.join("") + '</svg>' + legend;
  }

  function barChartVertical(items, opts) {
    opts = opts || {};
    var w = 520, h = 170, padL = 34, padR = 10, padT = 16, padB = 30;
    var n = items.length;
    var maxV = Math.max.apply(null, items.map(function (d) { return d.value; }).concat([1]));
    var slot = (w - padL - padR) / n;
    var barW = Math.min(38, slot * 0.6);
    var y = function (v) { return padT + (1 - v / maxV) * (h - padT - padB); };
    var parts = [];
    parts.push('<line class="baseline" x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padR) + '" y2="' + (h - padB) + '"></line>');
    items.forEach(function (d, i) {
      var cx = padL + slot * i + slot / 2;
      var barH = (h - padB) - y(d.value);
      var color = opts.color || "var(--s1)";
      parts.push('<rect class="mark-bar" style="fill:' + color + '" x="' + (cx - barW / 2).toFixed(1) + '" y="' + y(d.value).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(1, barH).toFixed(1) + '" rx="3"><title>' + d.label + ": " + fmtNum(d.value) + '</title></rect>');
      parts.push('<text class="value-label" x="' + cx.toFixed(1) + '" y="' + (y(d.value) - 5).toFixed(1) + '" text-anchor="middle">' + (d.valueLabel || fmtNum(d.value)) + '</text>');
      parts.push('<text class="tick-label" x="' + cx.toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle">' + d.label + '</text>');
    });
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" role="img">' + parts.join("") + '</svg>';
  }

  // Таблица Месяц/Новые/Отток/Нетто с пометкой "неполные" у месяцев, которые ещё не
  // "дозрели" (см. metrics.js monthResolved — 31+ день от as-of с последнего дня месяца).
  // Без этого недавние месяцы выглядят как "отток пропал", хотя на деле его ещё рано
  // считать окончательным. Переиспользуется в netgrowth и партнёрских бордах.
  function monthlyFlowTable(series, ctx) {
    var anyPending = false;
    var rows = series.months.map(function (m, i) {
      var resolved = ctx.M.monthResolved(m, ctx.asOf);
      if (!resolved) anyPending = true;
      var net = series.newByMonth[i] - series.churnByMonth[i];
      var sign = net > 0 ? "+" : "";
      var churnText = fmtNum(series.churnByMonth[i]);
      var netText = sign + fmtNum(net);
      var churnCell = resolved ? churnText : '<span style="color:var(--muted)">' + churnText + ' <i style="font-style:normal">· неполные</i></span>';
      var netCell = resolved ? netText : '<span style="color:var(--muted)">' + netText + '</span>';
      return [MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear(), fmtNum(series.newByMonth[i]), churnCell, netCell];
    });
    var wrap = el("<div></div>");
    if (anyPending) {
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:6px">Серым — месяц ещё не «дозрел» (с его последнего дня не прошло 31 день от as-of), отток за него ещё может увеличиться</div>'));
    }
    wrap.appendChild(makeSortableTable(
      [{ label: "Месяц" }, { label: "Новые", num: true }, { label: "Отток", num: true, html: true }, { label: "Нетто", num: true, html: true }],
      rows
    ));
    return wrap;
  }

  // Таблица с 3 градациями оттока (п.3.1, 2026-08-06): факт. отток (30+ дней, красным),
  // не продлились (0-30 дней, оранжевым в скобках рядом с фактическим — п.3.2), прогноз
  // (будущие месяцы, серым — просто счёт кодов, статус ещё не известен). Тумблер % —
  // делит на activeTotal ("Активные клиенты сейчас"), п.3.4.
  // Столбчатый график + таблица Месяц/Число по месяцам, опционально с раскрытием по
  // клику на строку (список клиентов за этот месяц). Для вкладок "Новые"/"Отток"/
  // "Возвращённые" внутри "Прирост базы" (п.3.5, 2026-08-06).
  // Раскрытие месяца в "Прирост базы" -- список сущностей настоящей таблицей: колонки
  // + сортировка по клику на заголовок (makeSortableTable) + фаст-фильтры по ключевым
  // полям (список может быть большим, сотни-тысячи строк на месяц). Замена прежнего
  // плоского текстового списка через renderLine (п. "шлифовка", 2026-08-06).
  var DEFAULT_DRILL_COLUMNS = [
    { label: "ИНН", key: "key" },
    { label: "Наименование", key: "org" },
    { label: "ИНН партнёра", key: "partnerInn" },
    { label: "Партнёр", key: "partner" },
    { label: "Активных касс", key: "activeKassas", num: true },
    { label: "Дата прихода", key: "arrivedAt", date: true },
    { label: "Дата ухода", key: "leftAt", date: true }
  ];
  var DEFAULT_DRILL_FILTERS = [
    { label: "ИНН", key: "key" },
    { label: "Наименование", key: "org" },
    { label: "Партнёр", key: "partner" }
  ];
  // Отдельный набор колонок для вкладки "Отток" (2026-08-06) -- там вместо
  // прихода/ухода нужны дата окончания (по которой считался отток) и то, сколько у
  // клиента ЕЩЁ осталось действующих касс (для полного оттока клиента это всегда 0 --
  // отток клиента = отток ВСЕХ его касс, выводим явно по просьбе Димы).
  var CLIENT_CHURN_COLUMNS = [
    { label: "ИНН", key: "key" },
    { label: "Наименование", key: "org" },
    { label: "ИНН партнёра", key: "partnerInn" },
    { label: "Партнёр", key: "partner" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "Осталось активных касс", key: "activeKassas", num: true }
  ];

  // columns: [{label, key, num, date}], filterFields: [{label, key}] -- текстовые
  // фаст-фильтры, объединяются по И (AND). date:true -- значение форматируется fmtDate()
  // (как и везде в приложении, сортировка по дате -- строкой в формате ДД.ММ.ГГГГ, тот же
  // компромисс, что и в остальных таблицах с датами). На экране показываем первые `limit`
  // строк отфильтрованного списка (полный список export'ом не покрыт -- это раскрытие
  // внутри виджета, не отдельная таблица), фильтры сужают выборку до нужных строк.
  // onRowClick(innString) -- опционально (2026-09-07, борд "Прирост базы Обмен с 1С"):
  // клик по строке передаёт значение ПЕРВОЙ колонки как есть (везде это ИНН -- ключ,
  // сортировка makeSortableTable переставляет DOM, поэтому берём textContent ячейки, не
  // индекс исходного массива, тот же приём, что и в остальных кликабельных таблицах файла).
  // Не ломает других вызывающих -- параметр не передаётся нигде, кроме нового кода.
  function renderDrillTable(container, list, columns, filterFields, entityLabel, monthLabel, limit, onRowClick) {
    var controls = filterFields.length ? el(
      '<div class="threshold-row" style="margin-top:8px">' +
      filterFields.map(function (f, i) {
        return '<label>' + esc(f.label) + ' <input type="text" class="drill-f" data-key="' + i + '" placeholder="поиск" style="width:120px"></label>';
      }).join("") +
      '</div>'
    ) : null;
    var countLine = el('<div style="font-size:12px;padding:6px 0"></div>');
    var tableHolder = el('<div></div>');
    var header = el('<div style="border-top:2px solid var(--ink);padding-top:8px;font-size:12px"><b>' + esc(monthLabel) + '</b></div>');
    container.innerHTML = "";
    container.appendChild(header);
    if (controls) container.appendChild(controls);
    container.appendChild(countLine);
    container.appendChild(tableHolder);

    function apply() {
      var inputs = controls ? controls.querySelectorAll(".drill-f") : [];
      var filters = filterFields.map(function (f, i) { return inputs[i] ? inputs[i].value.trim().toLowerCase() : ""; });
      var filtered = list.filter(function (item) {
        return filterFields.every(function (f, i) {
          if (!filters[i]) return true;
          return String(item[f.key] == null ? "" : item[f.key]).toLowerCase().indexOf(filters[i]) !== -1;
        });
      });
      var top = filtered.slice(0, limit);
      countLine.textContent = entityLabel + ": " + fmtNum(filtered.length) + (filtered.length > top.length ? " · показаны первые " + top.length + " — сузьте фильтром" : "");
      tableHolder.innerHTML = "";
      if (!top.length) {
        tableHolder.appendChild(el('<div style="padding:6px 0;color:var(--muted)">нет данных</div>'));
        return;
      }
      // html: !!c.html -- БЕЗ этого makeSortableTable экранирует готовую разметку через
      // esc() (не знало о c.html, тот флаг терялся при построении headers) -- найдено
      // 2026-09-17 на цветной score-пилюле борда C: вместо <span class="status-pill">
      // на экране был буквальный HTML-текст. Тот же класс бага, что гоча №10 в SKILL.md
      // (statBlock()-строка через createTextNode вместо innerHTML), только здесь по цепочке
      // renderDrillTable -> makeSortableTable, не в safeRenderBody.
      var headers = columns.map(function (c) { return { label: c.label, num: !!c.num, html: !!c.html }; });
      var rows = top.map(function (item) {
        return columns.map(function (c) {
          var v = item[c.key];
          if (c.date) return v ? fmtDate(v) : "—";
          return (v == null || v === "") ? "—" : v;
        });
      });
      var scrollWrap = el('<div class="expand-scroll"></div>');
      var tableWrap = makeSortableTable(headers, rows);
      scrollWrap.appendChild(tableWrap);
      tableHolder.appendChild(scrollWrap);
      if (onRowClick) {
        tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
          tr.style.cursor = "pointer";
          tr.addEventListener("click", function () { onRowClick(tr.children[0].textContent); });
        });
      }
    }

    if (controls) controls.querySelectorAll(".drill-f").forEach(function (inp) { inp.addEventListener("input", apply); });
    apply();
  }

  // opts: { entityLabel: "клиентов"|"касс", columns, filterFields, limit, activeTotal } --
  // columns/filterFields по умолчанию под клиентскую форму drilldown-объекта, задаются
  // явно для кассовой (см. вызовы b2-netgrowth). activeTotal (2026-08-07) -- если задан,
  // над таблицей появляется тот же тумблер Числа/%, что и на вкладке "Накопительно"
  // (gradientFlowTable) -- ТОЛЬКО для таблицы, столбчатый график остаётся в штуках
  // (единообразно с "Накопительно", где график тоже не переключается).
  // opts.activeTotalByMonth — массив того же размера что months: знаменатель для % СВОЕГО
  // месяца (действующих на конец этого месяца), не одно фиксированное число на все строки
  // (п.5, 2026-08-11).
  function monthlyCountBoard(months, counts, countLabel, color, drilldownFn, opts) {
    opts = opts || {};
    var entityLabel = opts.entityLabel || "клиентов";
    var columns = opts.columns || DEFAULT_DRILL_COLUMNS;
    var filterFields = opts.filterFields || DEFAULT_DRILL_FILTERS;
    var limit = opts.limit || 300;
    var exportTitle = opts.exportTitle || (countLabel + " " + entityLabel);
    var activeTotalByMonth = opts.activeTotalByMonth;
    var wrap = el("<div></div>");
    var items = months.map(function (m, i) { return { label: MONTHS_SHORT[m.getMonth()] + " " + String(m.getFullYear()).slice(2), value: counts[i] }; });
    wrap.appendChild(el(barChartVertical(items, { color: color })));

    var toggle = null;
    if (activeTotalByMonth != null) {
      var pvId = "pctcount-" + Math.random().toString(36).slice(2, 7);
      toggle = el(
        '<div class="threshold-row" style="margin-top:10px">' +
        '<label><input type="radio" name="' + pvId + '" value="abs" checked> Числа</label>' +
        '<label><input type="radio" name="' + pvId + '" value="pct"> % от действующих ' + entityLabel + ' на конец СВОЕГО месяца</label>' +
        '</div>'
      );
      wrap.appendChild(toggle);
    }
    function fmtCell(n, i) {
      if (!toggle || !toggle.querySelector('input[value="pct"]').checked) return fmtNum(n);
      var denom = activeTotalByMonth[i];
      return denom > 0 ? fmtPct(n / denom) : "—";
    }

    var tableHolder = el('<div style="margin-top:10px"></div>');
    var expandArea = el('<div style="margin-top:10px"></div>');
    // cardHolder -- ТОЛЬКО когда задан opts.onRowClick (2026-09-07, "Прирост базы Обмен с
    // 1С"): отдельная область ПОД раскрытой месячной таблицей для карточки конкретного
    // клиента по клику на ИНН, не смешивается с самой таблицей (иначе следующий клик по
    // другому месяцу стирал бы уже открытую карточку вместе с таблицей одним innerHTML="").
    var cardHolder = opts.onRowClick ? el('<div style="margin-top:10px"></div>') : null;
    var rowsData = months.map(function (m, i) { return { label: MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear(), month: m, count: counts[i] }; });

    function renderTable() {
      tableHolder.innerHTML = "";
      var tableWrap = makeSortableTable([{ label: "Месяц" }, { label: countLabel, num: true }], rowsData.map(function (r, i) { return [r.label, fmtCell(r.count, i)]; }));
      tableHolder.appendChild(tableWrap);
      if (drilldownFn) {
        tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
          tr.style.cursor = "pointer";
          tr.addEventListener("click", function () {
            var label = tr.children[0].textContent;
            var r = rowsData.find(function (x) { return x.label === label; });
            if (!r) return;
            var list = drilldownFn(r.month);
            if (cardHolder) cardHolder.innerHTML = "";
            renderDrillTable(expandArea, list, columns, filterFields, entityLabel, label, limit, opts.onRowClick ? function (inn) { opts.onRowClick(inn, cardHolder); } : undefined);
          });
        });
      }
    }
    if (toggle) toggle.addEventListener("change", renderTable);
    renderTable();

    wrap.appendChild(tableHolder);
    wrap.appendChild(expandArea);
    if (cardHolder) wrap.appendChild(cardHolder);
    if (drilldownFn) {
      wrap.appendChild(el('<div class="stat-label" style="margin-top:6px">Клик по строке — список ' + entityLabel + ' за этот месяц</div>'));
      // "Скачать" -- полный список ЗА ВЕСЬ ПЕРИОД одним файлом (Дима, 2026-08-18), не
      // только раскрытый месяц. Поля — те же, что в таблице раскрытия (columns), выгрузка
      // без лимита (лимит 300 только для раскрытия на экране, тут построчных обработчиков
      // клика нет — не тот случай, что крашит jsdom/браузер, см. SKILL.md гоча №6).
      var downloadBtn = el('<button class="refresh-chart-btn" style="margin-top:8px">Скачать (весь период)</button>');
      downloadBtn.addEventListener("click", function () {
        var allItems = [];
        months.forEach(function (m) { allItems = allItems.concat(drilldownFn(m) || []); });
        var exportRows = allItems.map(function (item) {
          var row = {};
          columns.forEach(function (c) {
            var v = item[c.key];
            row[c.label.replace(/\s+/g, "")] = c.date ? (v ? fmtDate(v) : "") : (v == null ? "" : v);
          });
          return row;
        });
        if (root.OFDExport) root.OFDExport.downloadCSV(exportTitle, exportRows);
      });
      wrap.appendChild(downloadBtn);
    }
    return wrap;
  }

  // Для каждого месяца из months — действующих (клиентов или касс) на КОНЕЦ этого месяца
  // (последний день месяца, 23:59:59), через computeSnapshot с тем же asOf-датой. Нужно,
  // чтобы % считался от базы своего месяца, а не от одного зафиксированного "сейчас" на
  // все строки — п.5, 2026-08-11.
  // Для ТЕКУЩЕГО (ещё не закончившегося) и будущих месяцев конец месяца — дата, которой
  // ещё не наступило: берём min(конец месяца, ctx.asOf), иначе досчитываем на дни вперёд,
  // которых в данных ещё физически нет (та же логика, по которой убрали "Прогноз",
  // п.3 — не забегаем по датам, которых ещё не было). Для прошлых месяцев это не меняет
  // ничего (там конец месяца всегда раньше asOf). Найдено и поправлено 2026-08-11 —
  // раньше "Кол-во клиентов" за текущий месяц не совпадало с "Активные клиенты сейчас".
  function activeCountsAtMonthEnds(model, months, ctx, byKassa) {
    return months.map(function (m) {
      var monthEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
      var end = monthEnd < ctx.asOf ? monthEnd : ctx.asOf;
      var snap = ctx.M.computeSnapshot(model, end, { strict: ctx.strict });
      return byKassa ? snap.activeKassas : snap.activeClients;
    });
  }

  // activeByMonth — массив того же размера что series.months: действующие (клиенты или
  // кассы) на КОНЕЦ КАЖДОГО месяца (не одно фиксированное "сейчас" на все строки) — п.5,
  // 2026-08-11. % оттока/% притока считаются от знаменателя СВОЕГО месяца, не текущего.
  // opts (необязательно, пока только b1-netgrowth) -- {realDeltaByMonth, graceColumn,
  // graceByMonth, returnedByMonth}. Без opts поведение НЕ меняется ни на йоту
  // (b2-netgrowth/b8-1c-growth продолжают работать как раньше, видят "сырой"
  // series.graceByMonth). graceByMonth (если передан) заменяет series.graceByMonth только
  // для отображения в колонке "Грейс" — используется в b1-netgrowth, чтобы показать ПОЛНЫЙ
  // грейс (текущий незакрытый + уже закрывшиеся короткие разрывы, см.
  // computeClosedGraceByMonth в metrics.js), а не только текущий. Раньше (2026-09-08) тут
  // была ещё колонка "Временный разрыв" (residualByMonth) — убрана 2026-09-09 по решению
  // Димы: отток считается от currentEnd, который сдвигается будущими продлениями — это
  // осознанный риск динамических данных ("плюс-минус похоже на правду"), не баг, который
  // нужно было патчить остатком. Вместо него — прозрачные "Грейс" и "Вернувшиеся" колонки
  // (см. WIDGETS["b1-netgrowth"]).
  function gradientFlowTable(series, activeByMonth, unitLabel, opts) {
    opts = opts || {};
    var wrap = el("<div></div>");
    var tableHolder = el('<div></div>');
    wrap.appendChild(tableHolder);

    function pct(n, denom) {
      return denom > 0 ? fmtPct(n / denom) : "—";
    }

    function render() {
      var rows = series.months.map(function (m, i) {
        var denom = activeByMonth[i];
        var officialNet = series.newByMonth[i] - series.churnByMonth[i];
        var net = opts.realDeltaByMonth ? opts.realDeltaByMonth[i] : officialNet;
        var sign = net > 0 ? "+" : "";
        var churnCell;
        if (opts.graceColumn) {
          churnCell = fmtNum(series.churnByMonth[i]);
        } else {
          churnCell = '<span style="color:var(--crit)">' + fmtNum(series.churnByMonth[i]) + '</span>';
          if (series.graceByMonth[i] > 0) {
            churnCell += ' <span style="color:var(--warn)">(' + fmtNum(series.graceByMonth[i]) + ' не продлились)</span>';
          }
        }
        var row = [
          MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear(),
          fmtNum(series.newByMonth[i]),
          churnCell,
        ];
        if (opts.graceColumn) row.push(fmtNum((opts.graceByMonth || series.graceByMonth)[i]));
        if (opts.returnedByMonth) row.push(fmtNum(opts.returnedByMonth[i] || 0));
        row.push(sign + fmtNum(net)); // fmtNum сам ставит "-" на отрицательных (toLocaleString) --
                                       // Math.abs() тут был БАГОМ (2026-09-08): стирал минус на
                                       // любом отрицательном net. Задело все 3 борда на этой функции.
        row.push(fmtNum(denom));
        row.push(pct(series.churnByMonth[i], denom));
        row.push(pct(series.newByMonth[i], denom));
        return row;
      });
      var headers = [
        { label: "Месяц" }, { label: "Новые" },
        opts.graceColumn ? { label: "Отток", num: true } : { label: "Факт. отток (не продлились)", html: true },
      ];
      if (opts.graceColumn) headers.push({ label: "Грейс (0-30 дней)", num: true });
      if (opts.returnedByMonth) headers.push({ label: "Вернувшиеся", num: true });
      headers.push({ label: "Дельта изменения" });
      headers.push({ label: "Кол-во " + unitLabel, num: true });
      headers.push({ label: "% оттока", num: true });
      headers.push({ label: "% притока", num: true });
      tableHolder.innerHTML = "";
      tableHolder.appendChild(makeSortableTable(headers, rows));
    }
    render();
    var note = opts.graceColumn
      ? '«Отток» — подтверждённый (30+ дней, не продлились). «Грейс» — ещё не продлились (0-30 дней), может стать оттоком позже. «Вернувшиеся» — сколько из оттока ИМЕННО этого месяца уже продлились к текущему моменту (то же понятие, что «Возврат»/«Возвращённые клиенты»).'
      : 'Красным — подтверждённый отток (30+ дней). Оранжевым в скобках — ещё не продлились (0-30 дней), может стать оттоком позже.';
    note += ' «Кол-во ' + unitLabel + '» — действующих на КОНЕЦ соответствующего месяца (не сейчас) — от этого числа считаются % оттока/притока в той же строке.';
    if (opts.realDeltaByMonth) note += ' «Дельта изменения» — реальная разница «Кол-во ' + unitLabel + '» между этим и прошлым месяцем (не Новые−Отток напрямую — отток привязан к текущей дате окончания, которая может сдвигаться будущими продлениями).';
    wrap.appendChild(el('<div class="stat-label" style="margin-top:6px">' + note + '</div>'));
    return wrap;
  }

  function statBlock(value, label, small) {
    return '<div class="stat-value' + (small ? " small" : "") + '">' + value + '</div><div class="stat-label">' + label + '</div>';
  }

  function makeSortableTable(headers, rows, opts) {
    opts = opts || {};
    var id = "t" + Math.random().toString(36).slice(2, 8);
    var thead = "<tr>" + headers.map(function (h, i) {
      return '<th data-col="' + i + '" data-type="' + (h.num ? "num" : "str") + '">' + esc(h.label) + "</th>";
    }).join("") + "</tr>";
    var tbody = rows.map(function (r) {
      return "<tr>" + r.map(function (cell, i) {
        // "html:true" — колонка уже содержит готовую разметку (статус-пилюли и т.п.), не экранируем.
        var content = headers[i].html ? cell : esc(cell);
        return '<td class="' + (headers[i].num ? "num" : "") + '">' + content + "</td>";
      }).join("") + "</tr>";
    }).join("");
    var wrap = el('<div class="table-scroll"><table class="wtable" id="' + id + '"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>');
    var table = wrap.querySelector("table");
    var dir = {};
    table.querySelectorAll("th").forEach(function (th) {
      th.addEventListener("click", function () {
        var col = parseInt(th.dataset.col, 10);
        var type = th.dataset.type;
        dir[col] = !dir[col];
        var tbody = table.querySelector("tbody");
        var rowsArr = Array.from(tbody.querySelectorAll("tr"));
        rowsArr.sort(function (ra, rb) {
          var a = ra.children[col].textContent.replace(/\s/g, "").replace(",", ".");
          var b = rb.children[col].textContent.replace(/\s/g, "").replace(",", ".");
          if (type === "num") { a = parseFloat(a) || 0; b = parseFloat(b) || 0; }
          // dir[col]=true после первого клика всегда означает "по возрастанию",
          // независимо от того, в каком порядке строки были на экране до клика
          if (a < b) return dir[col] ? -1 : 1;
          if (a > b) return dir[col] ? 1 : -1;
          return 0;
        });
        rowsArr.forEach(function (r) { tbody.appendChild(r); });
      });
    });
    return wrap;
  }

  // ---------- каркас карточки ----------

  // remove-btn слушатель НЕ вешается здесь -- переехал в dnd.js (Fix 7, миграция на
  // GridStack): удаление виджета обязано звать grid.removeWidget(), не node.remove(),
  // иначе пустой grid-item остаётся в GridStack-engine навсегда (призрачная ячейка).
  // dnd.js читает [data-widget-id] с узла и там же навешивает обработчик крестика.
  function widgetShell(id, title, type, scope, bodyHTML, footHTML) {
    var scopeClass = scope === "период" ? "wchip period" : "wchip";
    var node = el(
      '<div class="widget" data-widget-id="' + id + '">' +
      '<div class="widget-head"><span class="grip">⋮⋮</span><h3>' + title + '</h3>' +
      '<span class="wchip">' + type + '</span><span class="' + scopeClass + '">' + scope + '</span>' +
      '<button class="refresh-widget-btn" aria-label="Обновить" title="Обновить борд — если данные выглядят не так или борд завис после смены фильтра">⟳</button>' +
      '<button class="remove-btn" aria-label="Убрать виджет">×</button></div>' +
      '<div class="widget-body"></div>' +
      (footHTML ? '<div class="widget-foot">' + footHTML + '</div>' : '') +
      '</div>'
    );
    node.querySelector(".widget-body").appendChild(bodyHTML instanceof Node ? bodyHTML : el('<div>' + bodyHTML + '</div>'));
    return node;
  }

  // ---------- реестр виджетов ----------

  var WIDGETS = {};

  WIDGETS["b1-active"] = {
    title: "Активные клиенты сейчас", type: "карточка", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeSnapshot(model, ctx.asOf, { strict: ctx.strict });
      return statBlock(fmtNum(s.activeClients), "уникальных ИНН с действующим кодом ОФД · снэпшот на as-of · всего в базе " + fmtNum(s.totalClients));
    },
  };

  WIDGETS["b1-new"] = {
    title: "Новые клиенты за период", type: "карточка + график", scope: "период", span: true,
    render: function (model, ctx) {
      // per-gap модель (2026-09-10) -- computeFlow.new/computeMonthlySeries заменены на
      // computeGapFlow (каждый разрыв классифицируется по своей дате, а не по currentEnd,
      // см. metrics.js). "reanim" (0-90 дней) -- отдельная, информационная карточка про
      // скорость возврата, не участвует в балансе оттока -- оставлена на старой clientReturnInfo.
      var flow = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, false);
      var totalNew = series.newByMonth.reduce(function (a, b) { return a + b; }, 0);
      var head = '<div class="stat-row">' +
        '<div>' + statBlock(fmtNum(totalNew), "новые (раньше не было)", true) + '</div>' +
        '<div>' + statBlock(fmtNum(flow.clients.reanim), "вернувшиеся (31–90 дней после ухода)", true) + '</div>' +
        '</div>';
      var chart = lineChart(series.months, [{ label: "Новые", values: series.newByMonth, color: "var(--s1)" }], { area: true });
      return '<div>' + head + '<div style="margin-top:10px">' + chart + '</div></div>';
    },
  };

  WIDGETS["b1-churn"] = {
    title: "Отток клиентов за период", type: "карточка + график", scope: "период", span: true,
    render: function (model, ctx) {
      // per-gap модель (2026-09-10) -- см. b1-new выше и HISTORY.md.
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, false);
      var totalChurn = series.churnByMonth.reduce(function (a, b) { return a + b; }, 0);
      var head = statBlock(fmtNum(totalChurn), "клиентов не продлились 30+ дней (по факту разрыва, включая тех, кто позже вернулся — см. «Вернувшиеся»)", true);
      var chart = lineChart(series.months, [{ label: "Отток", values: series.churnByMonth, color: "var(--s2)" }], { area: true });
      var note = '<div class="stat-label" style="margin-top:6px">Каждый разрыв покрытия учтён в месяце, когда он произошёл, даже если клиент позже вернулся — «Отток» этого месяца зафиксирован навсегда. Последние ~30 дней периода могут быть занижены, пока грейс ещё не разрешился.</div>';
      return '<div>' + head + '<div style="margin-top:10px">' + chart + '</div>' + note + '</div>';
    },
  };

  WIDGETS["b1-reanim"] = {
    // Заменено с "Реанимированные клиенты" (карточка) на "Возвращённые клиенты" (список),
    // п.1 2026-08-06. Окно 91 день - 3 года (0-90 дней = "Вернувшиеся", см. b1-new).
    title: "Возвращённые клиенты", type: "таблица", scope: "период", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:6px">Вернулись в окне 91 день – 3 года после окончания последнего тарифа (0-90 дней — см. «Вернувшиеся» в «Новые клиенты за период»)</div>'));
      var returned = ctx.M.computeReturnedClients(model, ctx.periodStart, ctx.periodEnd);
      returned.sort(function (a, b) { return b.returnDate - a.returnDate; });
      var top = returned.slice(0, 150);
      var body = top.map(function (r) {
        return [r.partnerInn || "—", r.partner || "—", r.key, r.org || "—", r.days, r.kassaCount];
      });
      var tableHolder = el('<div></div>');
      tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(returned.length) + (returned.length > top.length ? " · показаны первые " + top.length + ", остальное — через экспорт" : "") + '</div>'));
      tableHolder.appendChild(makeSortableTable(
        [{ label: "ИНН партнёра" }, { label: "Наименование партнёра" }, { label: "ИНН клиента" }, { label: "Наименование клиента" }, { label: "Дней после возврата", num: true }, { label: "Касс сейчас", num: true }],
        body
      ));
      wrap.appendChild(tableHolder);
      wrap._getExportRows = function () {
        return returned.map(function (r) { return { ИННПартнёра: r.partnerInn || "", НаименованиеПартнёра: r.partner || "", ИННКлиента: r.key, НаименованиеКлиента: r.org || "", ДнейПослеВозврата: r.days, КассСейчас: r.kassaCount }; });
      };
      return wrap;
    },
    exportable: true,
  };

  // ---------- "Прирост базы" -- per-gap модель (Дима, 2026-09-10, см. HISTORY.md) ----------
  //
  // Заменяет ВСЮ цепочку правок 2026-09-08/09 (currentEnd-based Отток/Грейс + "Временный
  // разрыв" + "Вернувшиеся"-заплатка): та цепочка патчила симптом (несовпадение Новые-Отток
  // с реальным снэпшотом), не причину. Причина -- Отток считался по currentEnd (максимум по
  // всей жизни клиента), который сдвигается будущими продлениями и стирает разрыв из
  // статистики того месяца, где он реально произошёл. Доказано численно на 3 реальных
  // клиентах (см. HISTORY.md) -- баг классификации, не "естественная погрешность".
  //
  // Теперь: computeGapFlow/computeGapActiveCount (metrics.js) классифицируют КАЖДЫЙ разрыв
  // в истории клиента отдельно (safe/churned/pending), и "Активные"/"Дельта" тоже считаются
  // по этой же, единой модели (грейс-осведомлённый снэпшот, computeGapActiveCount) --
  // поэтому Дельта = Новые − Отток − Грейс + Вернувшиеся сходится ТОЧНО, без остатка,
  // проверено на реальных данных вручную построчно перед тем как писать этот код.
  WIDGETS["b1-netgrowth"] = {
    // Переименован "Нетто-прирост базы" -> "Прирост базы" (п.3.3). Только клиенты (ИНН) --
    // не кассы, зеркало для касс -- b2-netgrowth.
    title: "Прирост базы", type: "график", scope: "период", span: true,
    render: function (model, ctx) {
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, false);
      function monthEndClamped(m) {
        var end = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
        return end < ctx.asOf ? end : ctx.asOf;
      }
      var activeByMonth = series.months.map(function (m) { return ctx.M.computeGapActiveCount(model, monthEndClamped(m), ctx.asOf, false); });
      var boundaryPrev = ctx.M.computeGapActiveCount(model, monthEndClamped(ctx.M.addMonths(series.months[0], -1)), ctx.asOf, false);
      var realDeltaByMonth = series.months.map(function (m, i) { return activeByMonth[i] - (i === 0 ? boundaryPrev : activeByMonth[i - 1]); });
      var returnedSeries = null; // считается лениво -- полный перебор клиентов, не нужен пока вкладка не открыта
      var returnedActiveByMonth = null; // считается лениво вместе с returnedSeries -- свой months-массив

      var wrap = el("<div></div>");
      // случайный суффикс в name -- если тот же виджет перетащат на холст дважды, radio-группы
      // не должны конфликтовать между инстансами (иначе клик в одном снимет выбор в другом)
      var ngId = "ngview-" + Math.random().toString(36).slice(2, 7);
      var tabs = el(
        '<div class="threshold-row" style="margin-bottom:10px">' +
        '<label><input type="radio" name="' + ngId + '" value="cum" checked> Накопительно</label>' +
        '<label><input type="radio" name="' + ngId + '" value="new"> Новые клиенты</label>' +
        '<label><input type="radio" name="' + ngId + '" value="churn"> Отток клиентов</label>' +
        '<label><input type="radio" name="' + ngId + '" value="returned"> Возвращённые клиенты</label>' +
        '</div>'
      );
      var viewHolder = el('<div></div>');
      wrap.appendChild(tabs);
      wrap.appendChild(viewHolder);

      function renderCumView() {
        // Накопительная линия строится по РЕАЛЬНОЙ разнице снэпшотов "Активных"
        // (realDeltaByMonth), а не по Новые-Отток -- график буквально повторяет форму
        // "Активных на конец месяца".
        var cum = [], net = realDeltaByMonth, acc = 0;
        for (var i = 0; i < series.months.length; i++) { acc += net[i]; cum.push(acc); }
        var tooltips = series.months.map(function (m, i) {
          var sign = net[i] > 0 ? "+" : "";
          return MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear() + ": прирост " + sign + fmtNum(net[i]) + " · накопительно " + fmtNum(cum[i]);
        });
        var chart = lineChart(series.months, [{ label: "Накопительно", values: cum, color: "var(--s1)", tooltips: tooltips }], { area: true });
        var v = el("<div></div>");
        v.appendChild(el('<div>' + chart + '</div>'));
        var tableHolder = el('<div style="margin-top:14px"></div>');
        tableHolder.appendChild(gradientFlowTable(series, activeByMonth, "клиентов", {
          realDeltaByMonth: realDeltaByMonth,
          graceColumn: true, // series.graceByMonth теперь уже полный (per-gap) -- override не нужен
          returnedByMonth: series.returnedByMonth,
        }));
        v.appendChild(tableHolder);
        return v;
      }

      function renderView() {
        var v = tabs.querySelector('input:checked').value;
        viewHolder.innerHTML = "";
        if (v === "cum") {
          viewHolder.appendChild(renderCumView());
        } else if (v === "new") {
          viewHolder.appendChild(monthlyCountBoard(series.months, series.newByMonth, "Новых", "var(--s1)", function (m) { return ctx.M.clientsNewInMonth(model, m, ctx.asOf); }, { activeTotalByMonth: activeByMonth, exportTitle: "Прирост базы — новые клиенты" }));
        } else if (v === "churn") {
          viewHolder.appendChild(monthlyCountBoard(series.months, series.churnByMonth, "Отток", "var(--crit)", function (m) { return ctx.M.clientsChurnedInMonthGap(model, m, ctx.asOf); }, { columns: CLIENT_CHURN_COLUMNS, activeTotalByMonth: activeByMonth, exportTitle: "Прирост базы — отток клиентов" }));
        } else if (v === "returned") {
          if (!returnedSeries) {
            returnedSeries = ctx.M.computeReturnedByMonth(model, ctx.periodStart, ctx.periodEnd);
            returnedActiveByMonth = activeCountsAtMonthEnds(model, returnedSeries.months, ctx, false);
          }
          viewHolder.appendChild(monthlyCountBoard(returnedSeries.months, returnedSeries.countByMonth, "Возвращённых", "var(--s2)", function (m) { return ctx.M.clientsReturnedInMonth(model, m, ctx.asOf); }, { activeTotalByMonth: returnedActiveByMonth, exportTitle: "Прирост базы — возвращённые клиенты" }));
        }
      }
      tabs.addEventListener("change", renderView);
      renderView();
      return wrap;
    },
  };

  WIDGETS["b1-kassdist"] = {
    // Игнорирует переключатель "Режим" (strict/legacy) — всегда только действующие по
    // новой формуле оттока. Раньше путало (150648 под legacy vs 92983 "Активные клиенты
    // сейчас") — см. находку 2026-08-06.
    title: "Распределение по числу касс", type: "график", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeActiveSnapshot(model, ctx.asOf);
      var b = s.kassaCountBuckets;
      return barList([
        { label: "1 касса", value: b["1"], color: "#3987e5" },
        { label: "2–3 кассы", value: b["2-3"], color: "#256abf" },
        { label: "4–9 касс", value: b["4-9"], color: "#184f95" },
        { label: "10+ касс", value: b["10+"], color: "#104281" },
      ], { caption: "действующие клиенты (не в оттоке) · сумма " + fmtNum(s.activeClients) });
    },
  };

  function overduePill(days) {
    if (days > 60) return '<span class="status-pill crit"><span class="dot"></span>' + days + ' дн. в оттоке</span>';
    if (days > 30) return '<span class="status-pill warn"><span class="dot"></span>' + days + ' дн. в оттоке</span>';
    return '<span class="status-pill good"><span class="dot"></span>' + days + ' дн.</span>';
  }

  // Общий рендер таблицы+раскрытия+выгрузки для "Клиенты под риском" и "Клиенты к
  // продлению после окончания" — одинаковая колонка-спека (п.10/14, 2026-08-06):
  // ИНН клиента, наименование, касс к продлению, ИНН партнёра, наименование партнёра,
  // дата окончания, статус. Клик по строке -> разбивка по кассам с последним тарифом.
  // rows: [{key, org, partner, partnerInn, kassasToRenew, end, statusHtml, exportDays}]
  function renderClientListTable(tableHolder, expandArea, rows, wrap, model) {
    // На ЭКРАНЕ рисуем разумный лимит (тысячи строк с обработчиком клика на каждую кладут
    // и jsdom, и настоящий браузер) — выгрузка (_getExportRows) всегда полная, без среза.
    var limit = 150;
    var top = rows.slice(0, limit);
    var body = top.map(function (r) {
      return [r.key, r.org || "—", r.kassasToRenew, r.partnerInn || "—", r.partner || "—", fmtDate(r.end), r.statusHtml];
    });
    tableHolder.innerHTML = "";
    expandArea.innerHTML = "";
    tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(rows.length) + (rows.length > top.length ? " · показаны первые " + top.length + ", остальное — через экспорт" : "") + ' · клик по строке — разбивка по кассам с последним тарифом</div>'));
    var tableWrap = makeSortableTable(
      [{ label: "ИНН клиента" }, { label: "Наименование клиента" }, { label: "Касс к продлению", num: true }, { label: "ИНН партнёра" }, { label: "Наименование партнёра" }, { label: "Окончание" }, { label: "Статус", html: true }],
      body
    );
    tableHolder.appendChild(tableWrap);
    tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", function () {
        var inn = tr.children[0].textContent;
        var r = top.find(function (x) { return x.key === inn; });
        var client = model.clients.get(inn);
        if (!r || !client) return;
        var kassaRows = client.kassas.map(function (k) { return [k.rnm, k.tariff || "—", fmtDate(k.overallEnd)]; });
        expandArea.innerHTML = "";
        expandArea.appendChild(el('<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px;margin-bottom:6px"><b>ИНН ' + esc(inn) + '</b> (' + esc(r.org || "—") + ') · касс всего: ' + client.kassas.length + '</div>'));
        expandArea.appendChild(makeSortableTable([{ label: "РНМ" }, { label: "Тариф" }, { label: "Окончание" }], kassaRows));
      });
    });
    wrap._getExportRows = function () {
      // Одна строка = один РНМ (Дима, 2026-08-18: "у каждого РНМ должна быть дата
      // окончания"), кассы одного клиента идут подряд одна под другой (порядок клиентов
      // в rows сохраняется, кассы каждого добавляются все разом перед следующим клиентом).
      // r.kassaDetails -- список именно ТЕХ касс, что попали в порог (риск/просрочка), не
      // весь портфель клиента; заполняется вызывающим виджетом (b1-risk/b1-churned).
      var out = [];
      rows.forEach(function (r) {
        if (r.kassaDetails && r.kassaDetails.length) {
          r.kassaDetails.forEach(function (kd) {
            out.push({
              ИННКлиента: r.key, НаименованиеКлиента: r.org || "",
              ИННПартнёра: r.partnerInn || "", НаименованиеПартнёра: r.partner || "",
              РНМКассы: kd.rnm, Тариф: kd.tariff || "—",
              ДатаОкончания: fmtDate(kd.end), Статус: kd.statusText || "",
            });
          });
        } else {
          // фолбэк -- на случай если вызывающий виджет не передал kassaDetails
          var client = model.clients.get(r.key);
          var kassas = client ? client.kassas : [];
          var tariffs = kassas.map(function (k) { return k.tariff || "—"; }).join("\n");
          var rnms = kassas.map(function (k) { return k.rnm; }).join("\n");
          out.push({
            ИННКлиента: r.key, НаименованиеКлиента: r.org || "", КассКПродлению: r.kassasToRenew,
            ИННПартнёра: r.partnerInn || "", НаименованиеПартнёра: r.partner || "",
            Окончание: fmtDate(r.end), Дней: r.exportDays,
            КассыРНМ: rnms, ТарифыПоКассам: tariffs,
          });
        }
      });
      return out;
    };
  }

  WIDGETS["b1-risk"] = {
    // Всегда от даты ЗАГРУЗКИ ФАЙЛА (loadAsOf), НЕ от фильтра периода и не от
    // редактируемого as-of наверху — отдел продаж должен видеть факт на сегодня без
    // путаницы от чужих экспериментов с фильтрами. Полная выгрузка (без среза топ-100).
    title: "Клиенты «под риском»", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var asOf = ctx.loadAsOf || ctx.asOf;
      var wrap = el('<div></div>');
      var controlsId = "risk-days-" + Math.random().toString(36).slice(2, 7);
      var partnerOptions = Array.from(new Set(Array.from(model.clients.values()).filter(function (c) { return !c.phys; }).map(function (c) { return c.partner || "—"; }))).sort();
      // Грейс 0-30 дней (Дима, 2026-08-25) -- отдельный, ни от чего не зависящий счётчик:
      // клиенты/кассы, у которых дедлайн УЖЕ прошёл, но подтверждённым оттоком (31+ дней)
      // ещё не считаются -- та же логика, что и в "Просроченные клиенты" (clientsOverdue).
      // Всегда от даты ЗАГРУЗКИ ФАЙЛА, не от фильтра периода.
      var graceStat = el('<div class="stat-label" style="margin-bottom:6px"></div>');
      var grace = ctx.M.clientsOverdue(model, asOf, 0, 30);
      var graceKassas = grace.reduce(function (sum, r) { return sum + r.kassasToRenew; }, 0);
      graceStat.textContent = "В грейсе 0-30 дней (уже не продлились, отток ещё не подтверждён): " + fmtNum(grace.length) + " клиентов · " + fmtNum(graceKassas) + " касс";
      var controls = el(
        '<div class="threshold-row">' +
        '<label title="Точка отсчёта для ретроспективного запроса — например «кто заканчивается в августе», даже если сегодня уже середина месяца. Жив/дедлайн кассы считается НА ЭТУ дату, не на сегодня. Пусто — как раньше, всё считается от сегодня (as-of).">с даты <input type="date" class="from-input"></label>' +
        '<label><input type="radio" name="' + controlsId + '" checked> дней до окончания <input type="number" value="30" min="1" class="days-input"></label>' +
        '<label><input type="radio" name="' + controlsId + '"> дата окончания <input type="date" class="date-input"></label>' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '</div>'
      );
      // Интервал дней (Дима, 2026-08-25, фикс 2026-08-25) -- ДОБАВЛЕН рядом с контролами
      // выше, не заменяет их. Как только заполнен хоть один край -- становится ГЛАВНЫМ
      // режимом отбора (радио/дата-порог выше игнорируются ПОЛНОСТЬЮ), иначе интервал
      // упирался в потолок радио (по умолчанию 30 дней) и выглядел как "не применяется",
      // если границы интервала выходили за него (найдено Димой на боевом сайте).
      var intervalControls = el(
        '<div class="threshold-row" style="margin-top:6px">' +
        '<label title="Как только заполнено хоть одно поле -- этот интервал становится ГЛАВНЫМ отбором, контролы выше («дней до окончания» / «дата окончания») игнорируются. Показывает все кассы, у которых «дней до дедлайна» попадает в этот диапазон. Оба поля пустые — работают контролы выше, как раньше.">интервал дней до окончания: от <input type="number" class="interval-from" style="width:70px"> до <input type="number" class="interval-to" style="width:70px"></label>' +
        '<span class="interval-summary stat-label"></span>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
      var caption = el('<div class="stat-label" style="margin-bottom:6px"></div>');
      wrap.appendChild(graceStat);
      wrap.appendChild(caption);
      wrap.appendChild(controls);
      wrap.appendChild(intervalControls);
      wrap.appendChild(tableHolder);
      wrap.appendChild(expandArea);

      function renderTable() {
        var daysRadio = controls.querySelector('input[type="radio"]');
        var days = parseInt(controls.querySelector(".days-input").value, 10) || 30;
        var dateVal = controls.querySelector(".date-input").value;
        var fromVal = controls.querySelector(".from-input").value;
        var from = fromVal ? new Date(fromVal + "T00:00:00") : null;
        // "с даты" -- не просто фильтр поверх результата, а сама точка отсчёта запроса:
        // жив/дедлайн кассы (kassaDeadline) считается НА эту дату, иначе кассы, уже
        // просроченные к РЕАЛЬНОМУ сегодня, отвалятся ещё до применения порога.
        var refDate = from || asOf;
        var pf = controls.querySelector(".f-partner").value;

        var ivFrom = parseFloat(intervalControls.querySelector(".interval-from").value);
        var ivTo = parseFloat(intervalControls.querySelector(".interval-to").value);
        var hasIv = !isNaN(ivFrom) || !isNaN(ivTo);
        var lo = isNaN(ivFrom) ? -Infinity : ivFrom, hi = isNaN(ivTo) ? Infinity : ivTo;

        // Интервал -- ГЛАВНЫЙ отбор, если заполнен: deadlineFn пропускает ЛЮБУЮ живую кассу
        // (не гейтится радио/датой выше), сама вырезка по [от;до] идёт ниже на уровне кассы.
        // Без него -- прежнее поведение через радио "дней до окончания"/"дата окончания".
        var fn = hasIv
          ? function () { return true; }
          : (daysRadio.checked ? ctx.M.daysThresholdFn(refDate, days) : ctx.M.dateThresholdFn(dateVal ? new Date(dateVal) : refDate));
        caption.textContent = hasIv
          ? "Интервал дней активен (ниже) — контролы «дней до окончания»/«дата окончания» сейчас не используются."
          : (from
            ? "Ретроспективный запрос от " + fmtDate(from) + " — не срез на сегодня (сегодня факт. " + fmtDate(asOf) + ", момент загрузки файла)"
            : "Всегда на сегодня (" + fmtDate(asOf) + ", момент загрузки файла) — не зависит от фильтра периода");

        var raw = ctx.M.clientsAtRisk(model, refDate, fn, { strict: ctx.strict });
        if (pf) raw = raw.filter(function (r) { return (r.partner || "—") === pf; });
        var rows = raw.map(function (r) {
          var kassaDetails = (r.kassaDetails || []).map(function (kd) {
            return { rnm: kd.rnm, tariff: kd.tariff, end: kd.end, days: daysBetween(refDate, kd.end), statusText: riskPillText(daysBetween(refDate, kd.end)) };
          });
          return { key: r.key, org: r.org, partner: r.partner, partnerInn: r.partnerInn, kassasToRenew: r.kassasToRenew, end: r.end, exportDays: daysBetween(refDate, r.end), statusHtml: riskPill(daysBetween(refDate, r.end)), kassaDetails: kassaDetails };
        });
        // интервал дней -- сужает kassaDetails каждого клиента, клиенты без совпавших касс
        // выпадают. КРИТИЧНО: дата/статус/сортировка строки клиента ДО этого места ссылались
        // на его ближайший дедлайн ВООБЩЕ (часто "критично · 0 дн." от совсем другой кассы,
        // не имеющей отношения к интервалу) -- Дима поймал именно это ("фильтр 15-30, а
        // первыми в списке критично 0 дней"). После сужения пересчитываем end/статус/сортировку
        // от БЛИЖАЙШЕЙ ИЗ ОТОБРАННЫХ касс -- ровно тех, что реально попали в [от;до].
        if (hasIv) {
          var matchedKassas = 0;
          rows = rows.filter(function (r) {
            r.kassaDetails = r.kassaDetails.filter(function (kd) { return kd.days >= lo && kd.days <= hi; });
            r.kassasToRenew = r.kassaDetails.length;
            matchedKassas += r.kassasToRenew;
            if (r.kassasToRenew > 0) {
              var nearest = r.kassaDetails.reduce(function (a, b) { return b.days < a.days ? b : a; });
              r.end = nearest.end;
              r.exportDays = nearest.days;
              r.statusHtml = riskPill(nearest.days);
            }
            return r.kassasToRenew > 0;
          });
          intervalControls.querySelector(".interval-summary").textContent = "касс в интервале: " + fmtNum(matchedKassas) + " · клиентов: " + fmtNum(rows.length);
        } else {
          intervalControls.querySelector(".interval-summary").textContent = "";
        }
        rows.sort(function (a, b) { return a.end - b.end; });
        renderClientListTable(tableHolder, expandArea, rows, wrap, model);
      }
      controls.addEventListener("input", renderTable);
      controls.addEventListener("change", renderTable);
      intervalControls.addEventListener("input", renderTable);
      renderTable();
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b1-age"] = {
    // Игнорирует "Режим" (strict/legacy) — всегда только действующие по новой формуле
    // оттока (не по kassaLapsedAt). Клиент/касса выпадает из когорты ровно на 31-й день
    // после окончания. Тумблер Клиенты (ИНН) / Кассы (РНМ) — п.12, 2026-08-06.
    title: "Возрастная структура базы", type: "график", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeActiveSnapshot(model, ctx.asOf);
      var wrap = el('<div></div>');
      var avId = "ageview-" + Math.random().toString(36).slice(2, 7);
      var toggle = el(
        '<div class="threshold-row" style="margin-bottom:8px">' +
        '<label><input type="radio" name="' + avId + '" value="clients" checked> Клиенты (ИНН)</label>' +
        '<label><input type="radio" name="' + avId + '" value="kassas"> Кассы (РНМ)</label>' +
        '</div>'
      );
      var chartHolder = el('<div></div>');
      wrap.appendChild(toggle);
      wrap.appendChild(chartHolder);
      function render() {
        var byKassas = toggle.querySelector('input[value="kassas"]').checked;
        var b = byKassas ? s.kassaAgeBuckets : s.ageBuckets;
        var total = byKassas ? s.activeKassas : s.activeClients;
        chartHolder.innerHTML = "";
        chartHolder.appendChild(el(barList([
          { label: "младше 1 года", value: b["0-1y"], color: "#3987e5" },
          { label: "1–2 года", value: b["1-2y"], color: "#256abf" },
          { label: "2–3 года", value: b["2-3y"], color: "#184f95" },
          { label: "старше 3 лет", value: b["3y+"], color: "#104281" },
        ], { caption: "когорты не пересекаются · действующих (" + (byKassas ? "касс" : "клиентов") + ") — " + fmtNum(total) })));
      }
      toggle.addEventListener("change", render);
      render();
      return wrap;
    },
  };

  WIDGETS["b1-churned"] = {
    // Замена (2026-08-06): было только 30+ дней подтверждённого оттока, стало окно
    // 0-90 дней (ещё в грейсе + уже подтверждённый недавний отток) — та самая "замена
    // текущему борду", о которой просил Дима. Всегда от даты ЗАГРУЗКИ ФАЙЛА (loadAsOf),
    // не от фильтра периода. Фильтр по каждому полю (п.14), полная выгрузка.
    title: "Просроченные клиенты", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var asOf = ctx.loadAsOf || ctx.asOf;
      var wrap = el('<div></div>');
      var partnerOptions = Array.from(new Set(Array.from(model.clients.values()).filter(function (c) { return !c.phys; }).map(function (c) { return c.partner || "—"; }))).sort();
      // Грейс 0-30 дней (Дима, 2026-08-25) -- отдельный, ни от чего не зависящий счётчик,
      // тот же, что и на "Клиенты под риском" (clientsOverdue(asOf,0,30) -- всегда от даты
      // загрузки файла, не от фильтров ниже).
      var graceStat = el('<div class="stat-label" style="margin-bottom:6px"></div>');
      var grace = ctx.M.clientsOverdue(model, asOf, 0, 30);
      var graceKassas = grace.reduce(function (sum, r) { return sum + r.kassasToRenew; }, 0);
      graceStat.textContent = "В грейсе 0-30 дней (уже не продлились, отток ещё не подтверждён): " + fmtNum(grace.length) + " клиентов · " + fmtNum(graceKassas) + " касс";
      var controls = el(
        '<div class="threshold-row">' +
        '<label title="Если заполнено -- и клиент, и счётчик «касс к продлению» считаются ТОЛЬКО по кассам с датой окончания в этом диапазоне (старые кассы вне диапазона не попадают в счёт). Пусто -- как раньше, окно 0-90 дней от сегодня.">от <input type="date" class="from-input"> до <input type="date" class="to-input"></label>' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '<label>ИНН клиента <input type="text" class="f-inn" placeholder="поиск" style="width:110px"></label>' +
        '<label>Наименование клиента <input type="text" class="f-org" placeholder="поиск" style="width:140px"></label>' +
        '<label>ИНН партнёра <input type="text" class="f-pinn" placeholder="поиск" style="width:110px"></label>' +
        '</div>'
      );
      // Интервал дней просрочки (Дима, 2026-08-25, фикс 2026-08-25) -- ДОБАВЛЕН рядом с
      // "от-до по дате" выше, не заменяет его. Как только заполнен хоть один край -- ГЛАВНЫЙ
      // отбор (окно 0-90 по умолчанию и "от-до по дате" выше игнорируются ПОЛНОСТЬЮ), иначе
      // интервал упирался в потолок дефолтного окна и выглядел как "не применяется", если
      // границы выходили за него (найдено Димой на боевом сайте).
      var intervalControls = el(
        '<div class="threshold-row" style="margin-top:6px">' +
        '<label title="Как только заполнено хоть одно поле -- этот интервал становится ГЛАВНЫМ отбором, «от-до по дате» выше игнорируется. Показывает все кассы, у которых «дней просрочки» попадает в этот диапазон. Оба поля пустые — работает «от-до по дате» / окно 0-90, как раньше.">интервал дней просрочки: от <input type="number" class="interval-from" style="width:70px"> до <input type="number" class="interval-to" style="width:70px"></label>' +
        '<span class="interval-summary stat-label"></span>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
      var caption = el('<div class="stat-label" style="margin-bottom:6px"></div>');
      wrap.appendChild(graceStat);
      wrap.appendChild(caption);
      wrap.appendChild(controls);
      wrap.appendChild(intervalControls);
      wrap.appendChild(tableHolder);
      wrap.appendChild(expandArea);

      function renderTable() {
        var pf = controls.querySelector(".f-partner").value;
        var innf = controls.querySelector(".f-inn").value.trim().toLowerCase();
        var orgf = controls.querySelector(".f-org").value.trim().toLowerCase();
        var pinnf = controls.querySelector(".f-pinn").value.trim().toLowerCase();
        var fromVal = controls.querySelector(".from-input").value;
        var toVal = controls.querySelector(".to-input").value;
        var from = fromVal ? new Date(fromVal + "T00:00:00") : null;
        var to = toVal ? new Date(toVal + "T23:59:59") : null;

        var ivFrom = parseFloat(intervalControls.querySelector(".interval-from").value);
        var ivTo = parseFloat(intervalControls.querySelector(".interval-to").value);
        var hasIv = !isNaN(ivFrom) || !isNaN(ivTo);
        var lo = isNaN(ivFrom) ? -Infinity : ivFrom, hi = isNaN(ivTo) ? Infinity : ivTo;

        var raw;
        if (hasIv) {
          // Интервал -- ГЛАВНЫЙ отбор: берём ВСЕХ просроченных без верхней границы (окно
          // 0-90 и "от-до по дате" сейчас не действуют), вырезка по [от;до] -- на уровне кассы ниже.
          raw = ctx.M.clientsOverdue(model, asOf, 0, Infinity);
          caption.textContent = "Интервал дней просрочки активен (ниже) — «от-до по дате» и окно 0-90 сейчас не используются.";
        } else if (from && to) {
          raw = ctx.M.clientsOverdueInRange(model, asOf, from, to);
          caption.textContent = "Диапазон " + fmtDate(from) + " — " + fmtDate(to) + ": и клиент, и «касс к продлению» считаются только по кассам с окончанием в этом окне (сегодня факт. " + fmtDate(asOf) + ", момент загрузки файла).";
        } else {
          raw = ctx.M.clientsOverdue(model, asOf, 0, 90);
          caption.textContent = "Всегда на сегодня (" + fmtDate(asOf) + ", момент загрузки файла) — не зависит от фильтра периода. Окно 0-90 дней: недавно просроченные + ещё не подтверждённый (≤30 дней) отток.";
        }
        raw = raw.filter(function (r) {
          if (pf && (r.partner || "—") !== pf) return false;
          if (innf && !r.key.toLowerCase().includes(innf)) return false;
          if (orgf && !(r.org || "").toLowerCase().includes(orgf)) return false;
          if (pinnf && !(r.partnerInn || "").toLowerCase().includes(pinnf)) return false;
          return true;
        });
        var rows = raw.map(function (r) {
          var kassaDetails = (r.kassaDetails || []).map(function (kd) {
            return { rnm: kd.rnm, tariff: kd.tariff, end: kd.end, days: daysBetween(kd.end, asOf), statusText: overduePillText(daysBetween(kd.end, asOf)) };
          });
          return { key: r.key, org: r.org, partner: r.partner, partnerInn: r.partnerInn, kassasToRenew: r.kassasToRenew, end: r.end, exportDays: r.daysOverdue, statusHtml: overduePill(r.daysOverdue), kassaDetails: kassaDetails };
        });
        // интервал дней просрочки -- сужает kassaDetails каждого клиента, клиенты без совпавших
        // касс выпадают. КРИТИЧНО: дата/статус/сортировка строки клиента ДО этого места
        // ссылались на просрочку САМОЙ СВЕЖЕЙ его кассы (часто 0-5 дней, вне интервала вообще) --
        // Дима поймал именно это ("фильтр 15-30, а показывает тех, кто отвалился вчера").
        // После сужения пересчитываем end/статус/сортировку от НАИМЕНЕЕ просроченной ИЗ
        // ОТОБРАННЫХ касс -- ровно тех, что реально попали в [от;до].
        if (hasIv) {
          var matchedKassas = 0;
          rows = rows.filter(function (r) {
            r.kassaDetails = r.kassaDetails.filter(function (kd) { return kd.days >= lo && kd.days <= hi; });
            r.kassasToRenew = r.kassaDetails.length;
            matchedKassas += r.kassasToRenew;
            if (r.kassasToRenew > 0) {
              var nearest = r.kassaDetails.reduce(function (a, b) { return b.days < a.days ? b : a; });
              r.end = nearest.end;
              r.exportDays = nearest.days;
              r.statusHtml = overduePill(nearest.days);
            }
            return r.kassasToRenew > 0;
          });
          intervalControls.querySelector(".interval-summary").textContent = "касс в интервале: " + fmtNum(matchedKassas) + " · клиентов: " + fmtNum(rows.length);
        } else {
          intervalControls.querySelector(".interval-summary").textContent = "";
        }
        rows.sort(function (a, b) { return a.exportDays - b.exportDays; }); // недавно ушедшие сверху -- самые актуальные для дозвона
        renderClientListTable(tableHolder, expandArea, rows, wrap, model);
      }
      controls.addEventListener("input", renderTable);
      controls.addEventListener("change", renderTable);
      intervalControls.addEventListener("input", renderTable);
      renderTable();
      return wrap;
    },
    exportable: true,
  };

  // ---------- B2 Кассы ----------

  WIDGETS["b2-active"] = {
    title: "Активные кассы сейчас", type: "карточка", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeSnapshot(model, ctx.asOf, { strict: ctx.strict });
      var caption = ctx.strict
        ? "РНМ с действующим (непрерванным) кодом ОФД на as-of · всего в базе " + fmtNum(s.totalKassas)
        : "РНМ с «Общая дата окончания» ≥ as-of · всего в базе " + fmtNum(s.totalKassas);
      return statBlock(fmtNum(s.activeKassas), caption);
    },
  };

  WIDGETS["b2-flow"] = {
    // Счёт перенесён из "Прирост базы (кассы)" один-в-один (п.15, 2026-08-06) — те же
    // computeFlow.kassas, просто карточками вместо графика+таблицы.
    title: "Новые / отток / вернувшиеся касс", type: "карточки", scope: "период", span: true,
    render: function (model, ctx) {
      // per-gap модель (2026-09-10) -- new/churn через computeGapFlow, "reanim" (0-90 дней)
      // информационная, оставлена на старой clientReturnInfo/kassaReturnInfo (см. b1-new).
      var f = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf).kassas;
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, true);
      var totalNew = series.newByMonth.reduce(function (a, b) { return a + b; }, 0);
      var totalChurn = series.churnByMonth.reduce(function (a, b) { return a + b; }, 0);
      return '<div class="stat-row">' +
        '<div>' + statBlock(fmtNum(totalNew), "новые кассы", true) + '</div>' +
        '<div>' + statBlock(fmtNum(totalChurn), "отток касс (30+ дн. без продления)", true) + '</div>' +
        '<div>' + statBlock(fmtNum(f.reanim), "вернувшиеся (31–90 дней)", true) + '</div>' +
        '</div>';
    },
  };

  WIDGETS["b2-netgrowth"] = {
    // Переименован "Нетто-прирост базы (кассы)" -> "Прирост базы (кассы)" (п.3.3). Те же
    // 3 градации + тумблер % (п.3.1/3.2/3.4) и те же вкладки Новые/Отток/Возвращённые
    // (п.3.5), что и в клиентской версии — зеркально, но раскрытие по кассам/РНМ вместо
    // клиентов (2026-08-06).
    title: "Прирост базы (кассы)", type: "график", scope: "период", span: true,
    render: function (model, ctx) {
      // per-gap модель (2026-09-10, зеркало b1-netgrowth) -- см. HISTORY.md.
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, true);
      function monthEndClamped(m) {
        var end = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
        return end < ctx.asOf ? end : ctx.asOf;
      }
      var activeByMonth = series.months.map(function (m) { return ctx.M.computeGapActiveCount(model, monthEndClamped(m), ctx.asOf, true); });
      var boundaryPrev = ctx.M.computeGapActiveCount(model, monthEndClamped(ctx.M.addMonths(series.months[0], -1)), ctx.asOf, true);
      var realDeltaByMonth = series.months.map(function (m, i) { return activeByMonth[i] - (i === 0 ? boundaryPrev : activeByMonth[i - 1]); });
      var returnedSeries = null;
      var returnedActiveByMonth = null;

      var wrap = el("<div></div>");
      var ngId = "ngviewk-" + Math.random().toString(36).slice(2, 7);
      var tabs = el(
        '<div class="threshold-row" style="margin-bottom:10px">' +
        '<label><input type="radio" name="' + ngId + '" value="cum" checked> Накопительно</label>' +
        '<label><input type="radio" name="' + ngId + '" value="new"> Новые кассы</label>' +
        '<label><input type="radio" name="' + ngId + '" value="churn"> Отток касс</label>' +
        '<label><input type="radio" name="' + ngId + '" value="returned"> Возвращённые кассы</label>' +
        '</div>'
      );
      var viewHolder = el('<div></div>');
      wrap.appendChild(tabs);
      wrap.appendChild(viewHolder);

      function renderCumView() {
        var cum = [], net = realDeltaByMonth, acc = 0;
        for (var i = 0; i < series.months.length; i++) { acc += net[i]; cum.push(acc); }
        var tooltips = series.months.map(function (m, i) {
          var sign = net[i] > 0 ? "+" : "";
          return MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear() + ": прирост " + sign + fmtNum(net[i]) + " · накопительно " + fmtNum(cum[i]);
        });
        var chart = lineChart(series.months, [{ label: "Накопительно", values: cum, color: "var(--s1)", tooltips: tooltips }], { area: true });
        var v = el("<div></div>");
        v.appendChild(el('<div>' + chart + '</div>'));
        var tableHolder = el('<div style="margin-top:14px"></div>');
        tableHolder.appendChild(gradientFlowTable(series, activeByMonth, "касс", {
          realDeltaByMonth: realDeltaByMonth,
          graceColumn: true,
          returnedByMonth: series.returnedByMonth,
        }));
        v.appendChild(tableHolder);
        return v;
      }

      var kassaDrillFilters = [
        { label: "РНМ", key: "rnm" },
        { label: "ИНН клиента", key: "clientKey" },
        { label: "Наименование", key: "org" },
        { label: "Партнёр", key: "partner" }
      ];
      var kassaDrillOpts = {
        entityLabel: "касс",
        activeTotalByMonth: activeByMonth,
        columns: [
          { label: "РНМ", key: "rnm" },
          { label: "ИНН клиента", key: "clientKey" },
          { label: "Наименование клиента", key: "org" },
          { label: "ИНН партнёра", key: "partnerInn" },
          { label: "Партнёр", key: "partner" },
          { label: "Тариф", key: "tariff" },
          { label: "Дата прихода", key: "arrivedAt", date: true },
          { label: "Дата ухода", key: "leftAt", date: true }
        ],
        filterFields: kassaDrillFilters
      };
      var kassaChurnOpts = {
        entityLabel: "касс",
        activeTotalByMonth: activeByMonth,
        columns: [
          { label: "РНМ", key: "rnm" },
          { label: "ИНН клиента", key: "clientKey" },
          { label: "Наименование клиента", key: "org" },
          { label: "ИНН партнёра", key: "partnerInn" },
          { label: "Партнёр", key: "partner" },
          { label: "Тариф", key: "tariff" },
          { label: "Дата окончания", key: "end", date: true },
          { label: "Осталось активных касс у клиента", key: "activeKassas", num: true }
        ],
        filterFields: kassaDrillFilters
      };

      function renderView() {
        var v = tabs.querySelector('input:checked').value;
        viewHolder.innerHTML = "";
        if (v === "cum") {
          viewHolder.appendChild(renderCumView());
        } else if (v === "new") {
          viewHolder.appendChild(monthlyCountBoard(series.months, series.newByMonth, "Новых", "var(--s1)", function (m) { return ctx.M.kassasNewInMonth(model, m, ctx.asOf); }, Object.assign({ exportTitle: "Прирост базы (кассы) — новые кассы" }, kassaDrillOpts)));
        } else if (v === "churn") {
          viewHolder.appendChild(monthlyCountBoard(series.months, series.churnByMonth, "Отток", "var(--crit)", function (m) { return ctx.M.kassasChurnedInMonthGap(model, m, ctx.asOf); }, Object.assign({ exportTitle: "Прирост базы (кассы) — отток касс" }, kassaChurnOpts)));
        } else if (v === "returned") {
          if (!returnedSeries) {
            returnedSeries = ctx.M.computeReturnedByMonthKassas(model, ctx.periodStart, ctx.periodEnd);
            returnedActiveByMonth = activeCountsAtMonthEnds(model, returnedSeries.months, ctx, true);
          }
          var returnedOpts = Object.assign({}, kassaDrillOpts, { activeTotalByMonth: returnedActiveByMonth, exportTitle: "Прирост базы (кассы) — возвращённые кассы" });
          viewHolder.appendChild(monthlyCountBoard(returnedSeries.months, returnedSeries.countByMonth, "Возвращённых", "var(--s2)", function (m) { return ctx.M.kassasReturnedInMonth(model, m); }, returnedOpts));
        }
      }
      tabs.addEventListener("change", renderView);
      renderView();
      return wrap;
    },
  };

  // общий каркас "график сверху (снэпшот по ВСЕМ кассам) + кнопка рефреша + таблица с
  // фастфильтрами снизу" -- используется в b2-renewdist и b2-tariff. Без кнопки график и
  // отфильтрованная таблица расходятся в цифрах; рефреш пересчитывает график по текущему
  // фильтру таблицы (не автоматически на каждое изменение фильтра, только по клику).
  function chartPlusFilterableTable(arr, ctx, buildChartRows, chartOpts, tableOpts) {
    var wrap = el('<div></div>');
    var chartHolder = el('<div></div>');
    chartHolder.appendChild(el(barList(buildChartRows(arr), chartOpts)));
    // класс НЕ export-btn (баг: dnd.js вешает CSV-экспорт на первую .export-btn в DOM —
    // если бы у этой кнопки был тот же класс, она бы перехватывала обработчик экспорта у
    // настоящей кнопки в подвале виджета и автоматом скачивала CSV вместо простого рефреша)
    var refreshBtn = el('<button class="refresh-chart-btn" style="margin-top:8px">⟳ обновить график по текущему фильтру</button>');
    wrap.appendChild(chartHolder);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(el('<div style="height:14px"></div>'));
    var kassaOpts = { M: ctx.M, strict: ctx.strict };
    if (tableOpts) Object.assign(kassaOpts, tableOpts);
    var table = kassaDetailTable(arr, ctx.asOf, kassaOpts);
    wrap.appendChild(table);
    refreshBtn.addEventListener("click", function () {
      var filtered = table._getFilteredKassas ? table._getFilteredKassas() : arr;
      chartHolder.innerHTML = "";
      chartHolder.appendChild(el(barList(buildChartRows(filtered), chartOpts)));
    });
    wrap._getExportRows = function () { return table._getExportRows(); };
    return wrap;
  }

  WIDGETS["b2-renewdist"] = {
    // Название уточнено 2026-08-20 (Дима: "переименовать, чтобы не путаться" с новым
    // клиентским бордом ниже) — id виджета "b2-renewdist" НЕ трогаем, чтобы не сломать
    // уже сохранённые Димой раскладки (localStorage хранит именно этот id).
    title: "Распределение продлений по кассам", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var arr = Array.from(model.kassas.values());
      function buildRows(kassas) {
        var b = { "0": 0, "1-2": 0, "3-5": 0, "6+": 0 };
        kassas.forEach(function (k) {
          var r = k.renewals;
          var rb = r === 0 ? "0" : r <= 2 ? "1-2" : r <= 5 ? "3-5" : "6+";
          b[rb]++;
        });
        return [
          { label: "0 продлений", value: b["0"], color: "#3987e5" },
          { label: "1–2", value: b["1-2"], color: "#256abf" },
          { label: "3–5", value: b["3-5"], color: "#184f95" },
          { label: "6+", value: b["6+"], color: "#104281" },
        ];
      }
      return chartPlusFilterableTable(arr, ctx, buildRows, { caption: "число касс в каждой корзине" }, {});
    },
    exportable: true,
  };

  WIDGETS["b2-renewdist-clients"] = {
    // Копия b2-renewdist (2026-08-20), но во главе КЛИЕНТ (ИНН), не касса. Цель (Дима):
    // понять сколько клиентов и сколько раз они продлились В ЦЕЛОМ, не по отдельной кассе.
    title: "Распределение продлений по клиентам", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      // Продлений клиента = сумма продлений по ВСЕМ его кассам (не среднее, не макс --
      // "сколько раз они продлились" суммарно). Резервных физлиц (c.phys, legacy strict:false)
      // не считаем -- у них по определению 0 касс, только шумели бы бакет "0 продлений".
      var clientArr = Array.from(model.clients.values()).filter(function (c) { return !c.phys; }).map(function (c) {
        var totalRenewals = c.kassas.reduce(function (sum, k) { return sum + k.renewals; }, 0);
        var lastKassa = c.kassas.reduce(function (last, k) { return (!last || k.appearance > last.appearance) ? k : last; }, null);
        // active -- та же "действующий сейчас" формула, что у "Распределение по числу
        // касс"/"Возрастная структура базы" (clientLapsedAt, не завязана на strict/legacy).
        return { key: c.key, org: c.org, partner: c.partner, kassaCount: c.kassas.length, renewals: totalRenewals, tariff: lastKassa ? lastKassa.tariff : null, active: !ctx.M.clientLapsedAt(c, ctx.asOf) };
      });

      function buildRows(clients) {
        var b = { "0": 0, "1-2": 0, "3-5": 0, "6+": 0 };
        clients.forEach(function (c) {
          var r = c.renewals;
          var rb = r === 0 ? "0" : r <= 2 ? "1-2" : r <= 5 ? "3-5" : "6+";
          b[rb]++;
        });
        return [
          { label: "0 продлений", value: b["0"], color: "#3987e5" },
          { label: "1–2", value: b["1-2"], color: "#256abf" },
          { label: "3–5", value: b["3-5"], color: "#184f95" },
          { label: "6+", value: b["6+"], color: "#104281" },
        ];
      }

      var wrap = el('<div></div>');
      wrap.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">Считаем клиентов (ИНН), не кассы. «Продлений» — сумма продлений по ВСЕМ кассам клиента за всё время (сколько раз он в целом продлевался), «Касс» — сколько касс у него сейчас. Тариф — последней по дате активации кассы клиента (может быть несколько касс на разных тарифах). По умолчанию — только действующие клиенты (фильтр «Статус» ниже) — иначе давно отвалившиеся клиенты с историческими продлениями раздувают цифры.</div>'));
      var chartHolder = el('<div></div>');
      // График по умолчанию тоже только по активным -- совпадает с дефолтом фильтра таблицы
      // ниже (2026-08-20, Дима: "значения выглядят сильно завышенно, нужно приземлить").
      chartHolder.appendChild(el(barList(buildRows(clientArr.filter(function (c) { return c.active; })), { caption: "число клиентов в каждой корзине · только действующие" })));
      var refreshBtn = el('<button class="refresh-chart-btn" style="margin-top:8px">⟳ обновить график по текущему фильтру</button>');
      wrap.appendChild(chartHolder);
      wrap.appendChild(refreshBtn);
      wrap.appendChild(el('<div style="height:14px"></div>'));
      var table = clientRenewalDetailTable(clientArr);
      wrap.appendChild(table);
      refreshBtn.addEventListener("click", function () {
        var filtered = table._getFilteredClients ? table._getFilteredClients() : clientArr;
        chartHolder.innerHTML = "";
        chartHolder.appendChild(el(barList(buildRows(filtered), { caption: "число клиентов в каждой корзине" })));
      });
      wrap._getExportRows = function () { return table._getExportRows(); };
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b2-tariff"] = {
    title: "Распределение касс по сроку тарифа", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var arr = Array.from(model.kassas.values());
      function buildRows(kassas) {
        var buckets = {};
        kassas.forEach(function (k) { var t = k.tariff || "—"; buckets[t] = (buckets[t] || 0) + 1; });
        var rows = Object.keys(buckets).map(function (k) { return { label: k, value: buckets[k] }; });
        rows.sort(function (a, b) { return b.value - a.value; });
        return rows;
      }
      return chartPlusFilterableTable(arr, ctx, buildRows, { color: "var(--brand)", caption: "число касс на каждом тарифе" });
    },
    exportable: true,
  };

  WIDGETS["b2-summary"] = {
    title: "Сводка клиенты vs кассы", type: "карточки", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeSnapshot(model, ctx.asOf, { strict: ctx.strict });
      var b = s.kassaCountBuckets;
      var totalReal = b["1"] + b["2-3"] + b["4-9"] + b["10+"];
      var multi = b["2-3"] + b["4-9"] + b["10+"];
      var pct = totalReal ? multi / totalReal : 0;
      var totalKassas = b["1"] * 1 + b["2-3"] * 2.5 + b["4-9"] * 6.5 + b["10+"] * 12; // приблизительно, для среднего
      var avg = totalReal ? (totalKassas / totalReal).toFixed(1) : "—";
      return '<div class="stat-row">' +
        '<div>' + statBlock(fmtPct(pct), "клиентов с более чем 1 кассой", true) + '</div>' +
        '<div>' + statBlock(avg, "касс в среднем на клиента", true) + '</div>' +
        '</div>';
    },
  };

  // ---------- B3 Партнёры ----------

  WIDGETS["b3-active"] = {
    title: "Действующие партнёры сейчас", type: "карточка", scope: "as-of",
    render: function (model, ctx) {
      var partners = ctx.M.computePartners(model, ctx.asOf, { strict: ctx.strict });
      var active = partners.filter(function (p) { return p.kassas > 0; }).length;
      return statBlock(fmtNum(active), "внутри с хотя бы 1 активной кассой на as-of");
    },
  };

  WIDGETS["b3-table"] = {
    title: "Таблица по партнёрам", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var partners = ctx.M.computePartners(model, ctx.asOf, { strict: ctx.strict });
      var wrap = el('<div></div>');
      // случайный суффикс -- на холсте виджет может оказаться размещён дважды, статичный
      // name конфликтовал бы между двумя экземплярами (см. ту же причину у pvId/ngId)
      var stateId = "partnerstate-" + Math.random().toString(36).slice(2, 7);
      var controls = el(
        '<div class="threshold-row">' +
        '<label>Партнёр <input type="text" class="f-name" placeholder="поиск по названию" style="width:220px"></label>' +
        '<label><input type="radio" name="' + stateId + '" value="all" checked> все</label>' +
        '<label><input type="radio" name="' + stateId + '" value="clients"> только с активными клиентами</label>' +
        '<label><input type="radio" name="' + stateId + '" value="reserve"> только с резервными кодами</label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      function apply() {
        // БАГ (нашли 2026-08-06): раньше здесь резали до топ-150 по клиентам ДО отрисовки
        // — партнёры с большим резервом, но малым числом клиентов/касс, физически не
        // попадали в DOM, и клик по заголовку "Резерв" не мог их найти (сортировать
        // нечего, они не отрисованы). Теперь рисуем ВСЕХ отфильтрованных без среза —
        // сортировка по клику работает по-настоящему на полном наборе.
        var q = controls.querySelector(".f-name").value.trim().toLowerCase();
        var state = controls.querySelector('input[type="radio"]:checked').value;
        var filtered = q ? partners.filter(function (p) { return p.name.toLowerCase().includes(q); }) : partners.slice();
        // фильтр по состоянию (2026-08-07). После фикса computePartners() (партнёр кассы
        // = партнёр её текущего владельца-клиента, не собственное историческое поле кассы)
        // clients>0 и kassas>0 стали эквивалентны -- касса физически не может остаться за
        // партнёром без клиентов, поэтому простого clients>0 / reserve>0 достаточно.
        if (state === "clients") filtered = filtered.filter(function (p) { return p.clients > 0; });
        else if (state === "reserve") filtered = filtered.filter(function (p) { return p.clients === 0 && p.reserve > 0; });
        var rows = filtered.map(function (p) { return [p.name, p.clients, p.kassas, p.reserve]; });
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(filtered.length) + '</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "Партнёр" }, { label: "Клиентов", num: true }, { label: "Касс", num: true }, { label: "Резерв", num: true }], rows
        ));
        wrap._getExportRows = function () { return filtered.map(function (p) { return { Партнёр: p.name, Клиенты: p.clients, Кассы: p.kassas, Резерв: p.reserve }; }); };
      }
      controls.addEventListener("input", apply);
      controls.addEventListener("change", apply);
      apply();
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-reserve"] = {
    title: "Топ по зависшему резерву", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var reserve = ctx.M.computeReserve(model, ctx.asOf);
      var detail = ctx.M.computeReserveDetail(model);
      var years = Object.keys(reserve.byYear).sort(function (a, b) { return b - a; });
      var wrap = el('<div><div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">всего в резерве ' + fmtNum(reserve.total) + ' · старше года — ' + fmtNum(reserve.olderThanYear) + ' · выгрузка — детально по каждому коду, все поля исходной выгрузки</div></div>');
      // Фильтр по году (Дима, 2026-08-25) -- год берётся по ДАТЕ СОЗДАНИЯ кода (та же
      // разбивка, что уже используется на "Неактивированные коды по годам", computeReserveDetail).
      var controls = el(
        '<div class="threshold-row" style="margin-bottom:8px">' +
        '<label>Год <select class="f-year"><option value="">все</option>' + years.map(function (y) { return "<option>" + y + "</option>"; }).join("") + '</select></label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      function apply() {
        var yf = controls.querySelector(".f-year").value;
        var arr;
        if (yf) {
          var y = parseInt(yf, 10);
          arr = Array.from(detail.entries()).map(function (e) {
            var ym = e[1].years.get(y);
            var count = 0;
            if (ym) ym.forEach(function (c) { count += c; });
            return { name: e[0], count: count };
          }).filter(function (p) { return p.count > 0; });
        } else {
          arr = Array.from(reserve.byPartner.entries()).map(function (e) { return { name: e[0], count: e[1] }; });
        }
        arr.sort(function (a, b) { return b.count - a.count; });
        var top = arr.slice(0, 50);
        tableHolder.innerHTML = "";
        tableHolder.appendChild(makeSortableTable([{ label: "Партнёр" }, { label: "Неактивир. кодов", num: true }], top.map(function (p) { return [p.name, p.count]; })));
        // детальная выгрузка (п.22, 2026-08-06) -- как в оригинальной выгрузке, по каждому
        // коду резерва все поля, а не агрегат "партнёр+count"; выгрузка тоже сужается по году
        wrap._getExportRows = function () {
          return model.reserveRows.filter(function (r) {
            return !yf || (r.created instanceof Date && r.created.getFullYear() === parseInt(yf, 10));
          }).map(function (r) {
            return {
              PIN: r.pin, Статус: r.status, Тариф: r.tariff, ТипАктивации: r.activationType,
              ДатаСоздания: fmtDate(r.created), ДатаАктивации: fmtDate(r.activated),
              ДатаОкончания: fmtDate(r.endDate), ОбщаяДатаОкончания: fmtDate(r.overallEnd), РНМ: r.rnm || "",
              Организация: r.org || "", ИННОрганизации: r.innOrg || "", ИННФизлица: r.innPhys || "",
              Партнёр: r.partner || "", ИННПартнёра: r.partnerInn || "", ЦентрПродаж: r.salesCenter || "", ТипПродажи: r.salesType || "",
            };
          });
        };
      }
      controls.addEventListener("change", apply);
      apply();
      return wrap;
    },
    exportable: true,
  };

  // Ручная привязка партнёра к каналу (Дима, 2026-08-25) -- тот же инструмент, что у
  // калькуляторов B5 (ccOverrides/ccAssignment/ccBroadcastAssignmentChanged, определены
  // ниже по файлу как function-декларации -- hoisted, доступны здесь на момент вызова
  // render(), т.к. вызывается позже, уже после полной загрузки скрипта). График сверху
  // тоже пересчитывается через ccAssignment -- согласован с редактируемой таблицей снизу.
  WIDGETS["b3-channels"] = {
    title: "Разбивка по каналам", type: "таблица + график", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el('<div></div>');
      var chartHolder = el('<div></div>');
      var controls = el(
        '<div class="threshold-row" style="margin-top:12px">' +
        '<label>Канал <select class="f-channel"><option value="">выбери канал, чтобы увидеть и отредактировать партнёров</option>' +
        '<option>Ольга Зибер</option><option>Лариса Пенигина</option><option>Партнёры</option>' +
        '</select></label></div>'
      );
      var tableHolder = el('<div style="margin-top:8px"></div>');
      wrap.appendChild(chartHolder);
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      var selectEl = controls.querySelector(".f-channel");
      var editorState = null;

      function statsMap() {
        return new Map(ctx.M.computePartnersByChannel(model, ctx.asOf, { strict: ctx.strict }).map(function (p) { return [p.name, p]; }));
      }

      function renderChart(asn, stats) {
        var rows = CC_CHANNELS.map(function (chName, i) {
          var names = asn.byChannel[chName] || [];
          var clients = names.reduce(function (sum, n) { var s = stats.get(n); return sum + (s ? s.clients : 0); }, 0);
          var short = chName === "Ольга Зибер" ? "Оля Зибер" : chName === "Лариса Пенигина" ? "Лариса П." : chName;
          return { label: short, value: clients, color: i === 0 ? "var(--s1)" : i === 1 ? "var(--s2)" : "var(--s3)" };
        });
        chartHolder.innerHTML = "";
        chartHolder.appendChild(el(barList(rows, { caption: "число активных клиентов, закреплённых за каналом, на as-of (с учётом ручных правок партнёров ниже)" })));
      }

      function renderPartnerList() {
        var term = editorState.searchInput.value.trim().toLowerCase();
        var mineF = ccSearchFilter(editorState.mine, term);
        var freeF = ccSearchFilter(editorState.free, term);
        var html = "";
        if (freeF.length) html += '<div class="cc-group-label">Свободные (' + freeF.length + ')</div>' + freeF.map(function (n) { return ccPartnerRowHTML(n, false); }).join("");
        if (mineF.length) html += '<div class="cc-group-label">В канале (' + mineF.length + ')</div>' + mineF.map(function (n) { return ccPartnerRowHTML(n, true); }).join("");
        if (!mineF.length && !freeF.length) html = '<div class="cc-empty">Ничего не найдено</div>';
        editorState.listEl.innerHTML = html;
        editorState.listEl.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
          cb.addEventListener("change", function () {
            var name = cb.dataset.partner;
            ccOverrides[name] = cb.checked ? editorState.channel : "";
            ccSaveOverrides(ccOverrides);
            ccBroadcastAssignmentChanged();
          });
        });
      }

      function renderPartnerTable(stats) {
        var sortedMine = editorState.mine.slice().sort(function (a, b) {
          var sa = stats.get(a), sb = stats.get(b);
          return (sb ? sb.clients : 0) - (sa ? sa.clients : 0);
        });
        editorState.summaryEl.textContent = "партнёров в канале «" + editorState.channel + "»: " + fmtNum(sortedMine.length);
        editorState.tableEl.innerHTML = "";
        editorState.tableEl.appendChild(makeSortableTable(
          [{ label: "Партнёр" }, { label: "Клиентов", num: true }, { label: "Касс", num: true }, { label: "Резерв", num: true }],
          sortedMine.map(function (n) { var s = stats.get(n) || { clients: 0, kassas: 0, reserve: 0 }; return [n, s.clients, s.kassas, s.reserve]; })
        ));
        wrap._getExportRows = function () {
          return sortedMine.map(function (n) { var s = stats.get(n) || { clients: 0, kassas: 0, reserve: 0 }; return { Партнёр: n, Канал: editorState.channel, Клиенты: s.clients, Кассы: s.kassas, Резерв: s.reserve }; });
        };
      }

      // Шапку редактора (аккордеон + поиск) пересоздаём только при смене ВЫБРАННОГО канала,
      // не на каждый refresh() -- иначе открытый аккордеон/введённый поиск сбрасывались бы
      // при любой правке чек-бокса в ЛЮБОМ борде каналов на холсте (ccBroadcastAssignmentChanged
      // дёргает refresh() у всех сразу). Тот же паттерн, что и в ccBuildChannelBody.
      function buildEditorShell(channel) {
        tableHolder.innerHTML = "";
        var shell = el(
          '<div>' +
          '<div class="cc-settings">' +
          '<button type="button" class="cc-toggle">▸ Управлять партнёрами канала</button>' +
          '<div class="cc-body hidden">' +
          '<input type="text" class="cc-search" placeholder="поиск партнёра…">' +
          '<div class="cc-list"></div>' +
          '</div>' +
          '</div>' +
          '<div class="cc-summary" style="font-size:11.5px;color:var(--muted);margin:8px 0"></div>' +
          '<div class="cc-table"></div>' +
          '</div>'
        );
        tableHolder.appendChild(shell);
        editorState = {
          channel: channel, mine: [], free: [],
          toggleBtn: shell.querySelector(".cc-toggle"),
          bodyEl: shell.querySelector(".cc-body"),
          searchInput: shell.querySelector(".cc-search"),
          listEl: shell.querySelector(".cc-list"),
          summaryEl: shell.querySelector(".cc-summary"),
          tableEl: shell.querySelector(".cc-table"),
        };
        editorState.toggleBtn.addEventListener("click", function () {
          editorState.bodyEl.classList.toggle("hidden");
          editorState.toggleBtn.textContent = (!editorState.bodyEl.classList.contains("hidden") ? "▾" : "▸") + " Управлять партнёрами канала";
          if (!editorState.bodyEl.classList.contains("hidden")) renderPartnerList();
        });
        editorState.searchInput.addEventListener("input", renderPartnerList);
      }

      function refresh() {
        var asn = ccAssignment(model, ctx);
        var stats = statsMap();
        renderChart(asn, stats);
        var sel = selectEl.value;
        if (!sel) {
          editorState = null;
          tableHolder.innerHTML = "";
          wrap._getExportRows = function () {
            var out = [];
            CC_CHANNELS.forEach(function (chName) {
              (asn.byChannel[chName] || []).forEach(function (n) {
                var s = stats.get(n) || { clients: 0, kassas: 0, reserve: 0 };
                out.push({ Партнёр: n, Канал: chName, Клиенты: s.clients, Кассы: s.kassas, Резерв: s.reserve });
              });
            });
            return out;
          };
          return;
        }
        if (!editorState || editorState.channel !== sel) buildEditorShell(sel);
        editorState.mine = asn.byChannel[sel] || [];
        editorState.free = asn.free;
        if (!editorState.bodyEl.classList.contains("hidden")) renderPartnerList();
        renderPartnerTable(stats);
      }

      ccActiveRefreshers[instanceId] = refresh;
      selectEl.addEventListener("change", refresh);
      refresh();
      return wrap;
    },
    onRemove: function (instanceId) {
      delete ccActiveRefreshers[instanceId];
    },
    exportable: true,
  };

  WIDGETS["b3-churn-top"] = {
    // Формула п.23 (2026-08-06): было "база на начало периода + retention%", стало
    // "новые + отток + база на КОНЕЦ периода" — три голых числа: пришло/ушло/осталось.
    title: "Топ оттока по партнёрам", type: "таблица, раскрывается", scope: "период", span: true,
    render: function (model, ctx) {
      // per-gap модель (2026-09-10) -- см. HISTORY.md, та же ошибка была и в retention:
      // currentEnd-based отток "стирал" клиентов, ушедших и вернувшихся, из статистики
      // того месяца, где они реально ушли.
      var rows = ctx.M.computeGapPartnerFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      rows = rows.filter(function (p) { return p.churnedClients > 0; });
      rows.sort(function (a, b) { return b.churnedClients - a.churnedClients; });
      var top = rows.slice(0, 100);
      var body = top.map(function (p) { return [p.name, p.newClients, p.churnedClients, p.pendingClients, p.baseAtEnd]; });
      var wrap = el('<div></div>');
      wrap.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">Считаем клиентов (ИНН). Отток — не продлились 30+ дней (подтверждён). 0-30 дней — уже не продлились, но ещё в грейс-периоде (не факт оттока, может продлиться позже). Новые/Отток/0-30 дней — за весь выбранный период. Клиентов на конец периода — сколько осталось у партнёра прямо на дату конца периода (пришло + было − ушло). Последние ~30 дней периода обычно занижены, см. помесячную раскладку ниже. Клик по партнёру — кассы его клиентов с окончанием в текущем месяце.</div>'));
      var tableWrap = makeSortableTable(
        [{ label: "Партнёр" }, { label: "Новых клиентов", num: true }, { label: "Клиентов в оттоке", num: true }, { label: "0-30 дней (грейс)", num: true }, { label: "Клиентов на конец периода", num: true }],
        body
      );
      wrap.appendChild(tableWrap);
      var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
      wrap.appendChild(expandArea);
      var now = new Date();
      tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function () {
          // Партнёр из САМОЙ ЯЧЕЙКИ, не из индекса top[i] -- makeSortableTable переставляет
          // строки в DOM по клику на заголовок, индекс после сортировки уже не совпадает.
          var partnerName = tr.children[0].textContent;
          var kassas = ctx.M.computePartnerKassasInMonth(model, partnerName, now.getFullYear(), now.getMonth());
          expandArea.innerHTML = "";
          expandArea.appendChild(el('<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px;margin-bottom:6px"><b>' + esc(partnerName) + '</b> · кассы с окончанием в текущем месяце (' + MONTHS_SHORT[now.getMonth()] + ' ' + now.getFullYear() + ') — ' + kassas.length + '</div>'));
          var drillRows = kassas.map(function (k) { return [k.rnm, k.inn || "—", k.org || "—", k.tariff || "—", fmtDate(k.overallEnd)]; });
          expandArea.appendChild(makeSortableTable([{ label: "РНМ" }, { label: "ИНН" }, { label: "Наименование" }, { label: "Тариф" }, { label: "Дата окончания" }], drillRows));
        });
      });
      // Кнопка "скачать грейс 0-30 по всем партнёрам" (Дима, 2026-08-25) -- отдельная выгрузка,
      // НЕ ограниченная топ-100 (в отличие от основной таблицы выше): один клиент = одна
      // строка, первый столбец -- имя партнёра (повторяется во всех строках этого партнёра).
      // Только скачивание CSV, на экране ничего не показываем.
      var graceBtn = el('<button class="export-grace-btn" style="margin-top:10px">⬇ скачать грейс 0-30 дней — все клиенты по всем партнёрам</button>');
      wrap.appendChild(graceBtn);
      graceBtn.addEventListener("click", function () {
        var pending = ctx.M.computeGapPendingClientsList(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
        pending.sort(function (a, b) { return (a.partner || "").localeCompare(b.partner || "", "ru"); });
        var exportRows = pending.map(function (p) { return { Партнёр: p.partner, ИННКлиента: p.key, НаименованиеКлиента: p.org }; });
        OFDExport.downloadCSV("грейс_0-30_по_партнёрам", exportRows);
      });

      wrap.appendChild(el('<div style="height:16px"></div>'));
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:6px">Помесячно по всей базе (не по партнёрам — контекст, почему итог выше может быть занижен)</div>'));
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, false);
      wrap.appendChild(monthlyFlowTable(series, ctx));
      wrap._getExportRows = function () { return rows.map(function (p) { return { Партнёр: p.name, НовыхКлиентов: p.newClients, КлиентовВОттоке: p.churnedClients, Клиентов0_30Дней: p.pendingClients, КлиентовНаКонецПериода: p.baseAtEnd }; }); };
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-partner-eff"] = {
    title: "Партнёр: новые / отток / % эффективности (кассы)", type: "таблица", scope: "период", span: true,
    render: function (model, ctx) {
      // per-gap модель (2026-09-10) -- см. b3-churn-top выше и HISTORY.md.
      var rows = ctx.M.computeGapPartnerFlowKassas(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      rows.sort(function (a, b) { return (b.retention === null ? -1 : b.retention) - (a.retention === null ? -1 : a.retention); });
      var top = rows.slice(0, 150);
      var body = top.map(function (p) { return [p.name, p.baseAtStart, p.newKassas, p.churnedKassas, p.retention !== null ? fmtPct(p.retention) : "—"]; });
      var wrap = el('<div></div>');
      wrap.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">Считаем кассы (РНМ), не клиентов. Отток — не продлились 30+ дней. Retention = 1 − (отток касс / касс у партнёра на начало периода). Отсортировано по убыванию retention. Числа по всему периоду — последние ~30 дней обычно занижены, см. помесячную раскладку ниже.</div>'));
      wrap.appendChild(makeSortableTable(
        [{ label: "Партнёр" }, { label: "Касс на начало периода", num: true }, { label: "Новых касс", num: true }, { label: "Отток касс", num: true }, { label: "% эффективности (retention)" }],
        body
      ));
      wrap.appendChild(el('<div style="height:16px"></div>'));
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:6px">Помесячно по всей базе касс (не по партнёрам — контекст, почему итог выше может быть занижен)</div>'));
      var series = ctx.M.computeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, true);
      wrap.appendChild(monthlyFlowTable(series, ctx));
      wrap._getExportRows = function () { return rows.map(function (p) { return { Партнёр: p.name, КассНаНачалоПериода: p.baseAtStart, НовыхКасс: p.newKassas, ОтТокКасс: p.churnedKassas, Эффективность: p.retention !== null ? (p.retention * 100).toFixed(1) + "%" : "" }; }); };
      return wrap;
    },
    exportable: true,
  };

  // ---------- B4 Коды ОФД ----------

  WIDGETS["b4-years"] = {
    title: "Неактивированные коды по годам", type: "график, раскрывается", scope: "as-of", span: true,
    render: function (model, ctx) {
      var reserve = ctx.M.computeReserve(model, ctx.asOf);
      var years = Object.keys(reserve.byYear).sort();
      var items = years.map(function (y) {
        var total = 0; Object.keys(reserve.byYear[y]).forEach(function (m) { total += reserve.byYear[y][m]; });
        return { label: y, value: total };
      });
      var wrap = el('<div></div>');
      wrap.appendChild(el(barChartVertical(items, { color: "var(--s1)" })));
      var hint = el('<div class="stat-label" style="margin-top:4px">клик на год → месяцы, клик на месяц → партнёры, генерировавшие коды в этом месяце</div>');
      wrap.appendChild(hint);
      var detail = el('<div style="margin-top:10px"></div>');
      wrap.appendChild(detail);

      // экспорт всегда доступен: без раскрытия — резерв по всем партнёрам за всё время,
      // после клика на месяц — экспорт переключается на партнёров именно этого месяца
      var allTimeByPartner = Array.from(reserve.byPartner.entries()).map(function (e) { return { Партнёр: e[0], НеактивированныеКоды: e[1] }; });
      wrap._getExportRows = function () { return allTimeByPartner; };

      wrap.querySelectorAll(".mark-bar").forEach(function (bar, i) {
        bar.style.cursor = "pointer";
        bar.addEventListener("click", function () {
          var y = years[i];
          var monthData = reserve.byYear[y];
          var monthItems = [];
          for (var m = 0; m < 12; m++) monthItems.push({ label: MONTHS_SHORT[m], value: monthData[m] || 0 });
          detail.innerHTML = '<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">' + y + ' по месяцам</div>';
          var monthChart = el(barChartVertical(monthItems, { color: "var(--s1)" }));
          detail.appendChild(monthChart);
          var partnerArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
          detail.appendChild(partnerArea);

          monthChart.querySelectorAll(".mark-bar").forEach(function (mbar, mi) {
            mbar.style.cursor = "pointer";
            mbar.addEventListener("click", function () {
              var yearNum = parseInt(y, 10);
              var partnerList = ctx.M.computeReservePartnersForMonth(model, yearNum, mi);
              wrap._getExportRows = function () { return partnerList.map(function (p) { return { Партнёр: p.name, НеактивированныеКоды: p.count }; }); };
              partnerArea.innerHTML = '<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">' + MONTHS_SHORT[mi] + " " + y + " · экспорт переключён на этот месяц</div>";
              partnerArea.appendChild(makeSortableTable(
                [{ label: "Партнёр" }, { label: "Неактивир. кодов", num: true }],
                partnerList.map(function (p) { return [p.name, p.count]; })
              ));
            });
          });
        });
      });
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b4-partners"] = {
    title: "Неактивированные коды по партнёрам", type: "таблица, раскрывается", scope: "as-of", span: true,
    render: function (model, ctx) {
      var detail = ctx.M.computeReserveDetail(model);
      var arr = Array.from(detail.entries()).map(function (e) { return { name: e[0], total: e[1].total, years: e[1].years }; });
      arr.sort(function (a, b) { return b.total - a.total; });
      var top = arr.slice(0, 50);
      var wrap = el('<div></div>');
      var tableWrap = makeSortableTable([{ label: "Партнёр" }, { label: "Неактивир. кодов", num: true }], top.map(function (p) { return [p.name, p.total]; }));
      wrap.appendChild(tableWrap);
      var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
      wrap.appendChild(expandArea);
      tableWrap.querySelectorAll("tbody tr").forEach(function (tr, i) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function () {
          var p = top[i];
          var years = Array.from(p.years.keys()).sort(function (a, b) { return b - a; });
          var yearRows = years.map(function (y) {
            var months = p.years.get(y);
            var yearTotal = 0;
            var monthRows = [];
            for (var m = 0; m < 12; m++) {
              var cnt = months.get(m) || 0;
              yearTotal += cnt;
              if (cnt) monthRows.push('<div class="rd-month-row"><span>' + MONTHS_SHORT[m] + '</span><span>' + fmtNum(cnt) + '</span></div>');
            }
            return '<div class="rd-year-block">'
              + '<div class="rd-year-row"><span class="rd-caret">▸</span><span class="rd-year-label">' + y + '</span><span class="rd-year-count">' + fmtNum(yearTotal) + '</span></div>'
              + '<div class="rd-months" hidden>' + (monthRows.join("") || '<div class="rd-month-row"><span>нет данных</span></div>') + '</div>'
              + '</div>';
          });
          expandArea.innerHTML = '<div class="rd-detail">' + (yearRows.join("") || "нет данных по датам") + '</div>';
          expandArea.querySelectorAll(".rd-year-row").forEach(function (row) {
            row.addEventListener("click", function () {
              var block = row.parentElement;
              var months = block.querySelector(".rd-months");
              var caret = row.querySelector(".rd-caret");
              var open = !months.hidden;
              months.hidden = open;
              caret.textContent = open ? "▸" : "▾";
            });
          });
        });
      });
      wrap._getExportRows = function () { return arr.map(function (p) { return { Партнёр: p.name, НеактивированныеКоды: p.total }; }); };
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b4-revoked"] = {
    title: "Отозванные коды", type: "карточка", scope: "период",
    render: function (model, ctx) {
      var n = ctx.M.computeRevokedInPeriod(model, ctx.periodStart, ctx.periodEnd);
      return statBlock(fmtNum(n), "создано и отозвано за период · не участвует нигде больше");
    },
  };

  WIDGETS["b4-funnel"] = {
    title: "Общая воронка", type: "график", scope: "период", span: true,
    render: function (model, ctx) {
      var f = ctx.M.computeFunnel(model, ctx.periodStart, ctx.periodEnd);
      // % конверсии (Дима, 2026-08-25) -- у КАЖДОГО столбца, относительно "Создано" (не
      // относительно соседнего столбца) -- прямо под числом на графике.
      function pctOfCreated(v) { return f.created ? " (" + fmtPct(v / f.created) + ")" : ""; }
      var chart = barChartVertical([
        { label: "Создано", value: f.created, valueLabel: fmtNum(f.created) + pctOfCreated(f.created) },
        { label: "Активировано", value: f.activated, valueLabel: fmtNum(f.activated) + pctOfCreated(f.activated) },
        { label: "Неактивировано", value: f.notActivated, valueLabel: fmtNum(f.notActivated) + pctOfCreated(f.notActivated) },
        { label: "Отозвано", value: f.revoked, valueLabel: fmtNum(f.revoked) + pctOfCreated(f.revoked) },
      ], { color: "var(--brand)" });
      var lag = f.avgLagDays !== null ? f.avgLagDays.toFixed(1) + " дн." : "—";
      var caption = '<div class="stat-label" style="margin-top:6px">Активировано — клиент привязал код к себе (статус «Зарегистрировано»). Неактивировано — до сих пор в резерве партнёра (Новый/Выдан). Столбцы 2-4 честно делят «Создано». % под каждым столбцом — доля от «Создано». Среднее время создание → активация: ' + lag + '</div>';
      return chart + caption;
    },
  };

  WIDGETS["b4-reserve-share"] = {
    title: "Доля кодов «впрок»", type: "карточка", scope: "период",
    render: function (model, ctx) {
      var share = ctx.M.computeReserveShare(model, ctx.periodStart, ctx.periodEnd);
      return statBlock(fmtPct(share), "от всех кодов, созданных за период — без клиента на момент выгрузки");
    },
  };
  // ---------- B5 Расчёты: борды каналов продаж ----------
  //
  // Второй заход (2026-08-19): первая версия была фикс. панелью в сайдбаре — Дима
  // забраковал ("пользоваться неудобно, сделай бордом"). Теперь — обычные виджеты холста,
  // по одному на каждый из 3 фиксированных каналов (те же строки, что возвращает
  // classifyChannel/computePartnersByChannel: "Ольга Зибер" / "Лариса Пенигина" /
  // "Партнёры") — можно перетащить из библиотеки, размножить, убрать как любой борд.
  // scope:"период" -- берёт период НАПРЯМУЮ из шапки (ctx.periodStart/periodEnd), не свой
  // локальный — Дима явно просил "дата с-по должна быть общей" для сравнения каналов.
  var CC_CHANNELS = ["Ольга Зибер", "Лариса Пенигина", "Партнёры"];
  var CC_OVERRIDE_KEY = "ofd-channel-overrides-v1";
  var CC_TARIFF_COLORS = ["#3987e5", "#256abf", "#184f95", "#104281", "#0b7a66", "#0e8f79"];

  function ccLoadOverrides() {
    try { return JSON.parse(localStorage.getItem(CC_OVERRIDE_KEY) || "{}"); } catch (e) { return {}; }
  }
  function ccSaveOverrides(map) {
    try { localStorage.setItem(CC_OVERRIDE_KEY, JSON.stringify(map)); } catch (e) { /* приватный режим и т.п. -- не критично */ }
  }
  var ccOverrides = ccLoadOverrides(); // partnerName -> channelName | "" (явно свободен)

  // Персональное серверное хранение (Дима, 2026-09-04): "почищу куки на сайте — информация
  // слетит" -- localStorage у каждого браузера свой. Кнопка "Сохранить" на борде кладёт
  // снимок ccOverrides в KV по логину (см. worker.js /api/overrides), переживает чистку
  // кук/новый браузер. Явный ответ Димы: "не переусложнять" -- значит НЕ городим merge/diff
  // между локальной и серверной копией, только два однозначных действия: (а) кнопка
  // "Сохранить" -- локальное состояние ПОЛНОСТЬЮ перезаписывает серверное; (б) при старте,
  // ТОЛЬКО если в ЭТОМ браузере ещё вообще нет сохранённого распределения (пустой/новый
  // localStorage), подтягиваем серверную копию -- никогда не перетираем непустой локальный
  // ccOverrides молча, только явная кнопка "Сохранить" может перезаписать чужую копию.
  var CC_API_OVERRIDES_URL = "/api/overrides";

  function ccServerSave(onDone) {
    if (typeof fetch !== "function") { onDone && onDone(false, "недоступно в этом окружении"); return; }
    // Вместе с overrides шлём имена custom-каналов (ccCustomNames определена ниже по файлу --
    // безопасно, обращение происходит только в момент вызова этой функции, не при её
    // объявлении) -- нужны бутстрапу на новом устройстве, чтобы пересоздать сами борды,
    // не только состав партнёров (Дима, 2026-09-04: "борд сохраняется и будет доступен всегда").
    var customChannels = Array.from(new Set(Array.from(ccCustomNames.values()).filter(function (n) { return n; })));
    fetch(CC_API_OVERRIDES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: ccOverrides, customChannels: customChannels }),
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function () {
      if (onDone) onDone(true);
    }).catch(function (e) {
      if (onDone) onDone(false, e.message);
    });
  }

  function ccBootstrapFromServer() {
    if (typeof fetch !== "function") return;
    if (Object.keys(ccOverrides).length > 0) return; // локальные данные уже есть -- не трогаем
    fetch(CC_API_OVERRIDES_URL).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      // Повторная проверка -- пока шёл сетевой запрос, пользователь мог САМ что-то отметить
      // (тогда локальные данные уже не пустые, и мы их не перезатираем).
      if (data && data.overrides && Object.keys(data.overrides).length > 0 && Object.keys(ccOverrides).length === 0) {
        ccOverrides = data.overrides;
        ccSaveOverrides(ccOverrides);
        ccBroadcastAssignmentChanged();
      }
    }).catch(function () { /* нет сети/сервер недоступен -- работаем локально, не критично */ });
  }
  ccBootstrapFromServer();

  // Пересоздаёт custom-борды на холсте по именам, сохранённым на сервере (Дима, 2026-09-04:
  // "борд сохраняется у пользователя и будет доступен всегда") -- в отличие от
  // ccBootstrapFromServer (партнёры, вызывается сразу при загрузке модуля), эту функцию
  // нужно звать ПОСЛЕ восстановления локальной раскладки (app.js, после
  // OFDCanvas.loadSavedLayout()) -- только тогда достоверно известно, есть ли уже на холсте
  // ЭТОГО браузера свои custom-борды (ccCustomNames заполняется через applyPersistState
  // именно во время loadSavedLayout). Сравнение ПОИМЁННОЕ (по Set имён), не булевым флагом
  // "есть хоть один local custom" -- фикс бага от 2026-09-11 (жалоба коллеги "борды не
  // сохраняются"): со старой булевой проверкой НОВЫЙ борд, сохранённый ТОЛЬКО на сервере
  // (кнопка "Сохранить" на самой карточке нажата, а топбар "Сохранить расположение" -- нет,
  // из-за чего борд не попал в LAYOUT_KEY_V2), после reload никогда не подтягивался, если на
  // холсте уже был ДРУГОЙ, ранее сохранённый в layout custom-борд -- функция видела
  // "локальный custom уже есть" и выходила, даже не взглянув на список имён с сервера.
  function ccBootstrapCustomChannelsFromServer() {
    if (typeof fetch !== "function") return;
    if (!root.OFDCanvas || typeof root.OFDCanvas.addWidget !== "function") return;
    fetch(CC_API_OVERRIDES_URL).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      var names = (data && Array.isArray(data.customChannels)) ? data.customChannels : [];
      var uniqueNames = Array.from(new Set(names.filter(function (n) { return n && typeof n === "string"; })));
      if (!uniqueNames.length) return;
      // Локальный набор считаем ЗДЕСЬ, после await сетевого запроса -- та же защита от гонки,
      // что была в старой "повторной проверке" (пока шёл запрос, пользователь мог сам создать
      // борд), только теперь по конкретному имени, а не общим флагом.
      var localNames = new Set(Array.from(ccCustomNames.values()).filter(function (n) { return n; }));
      uniqueNames.forEach(function (name) {
        if (localNames.has(name)) return; // уже есть на холсте -- не дублируем
        root.OFDCanvas.addWidget("b5-revenue-custom", null, null, null, null, name);
      });
    }).catch(function () { /* нет сети/сервер недоступен -- борд просто не появится, не критично */ });
  }

  // Live-sync между бордами каналов на холсте -- их ровно 3 (фиксированный набор, не
  // произвольное N), поэтому реестр по имени канала, не по instanceId. Каждый render()
  // перезаписывает свою запись; после ЛЮБОГО изменения ccOverrides зовём refresh() у ВСЕХ
  // сейчас смонтированных карточек -- Дима держит все 3 борда открытыми одновременно и
  // ожидает, что снятие партнёра в одном СРАЗУ видно в остальных, без ручного "⟳"
  // (2026-08-20: "снял галочку с Ларисы, партнёр не появился у Оли и Партнёров").
  var ccActiveRefreshers = {}; // channelName -> function()
  function ccBroadcastAssignmentChanged() {
    Object.keys(ccActiveRefreshers).forEach(function (key) { ccActiveRefreshers[key](); });
  }

  function ccEffectiveChannel(name, autoMap) {
    if (Object.prototype.hasOwnProperty.call(ccOverrides, name)) return ccOverrides[name];
    var auto = autoMap.get(name);
    return CC_CHANNELS.indexOf(auto) !== -1 ? auto : "Партнёры";
  }

  // Разбивает всех партнёров на {byChannel, free} -- дефолт из авто-классификации,
  // ручные overrides поверх. Пересчитывается заново при каждом render() (в т.ч. каждой
  // карточки отдельно) -- дёшево (проход по партнёрам, не по клиентам/кассам).
  function ccAssignment(model, ctx) {
    var rows = ctx.M.computePartnersByChannel(model, ctx.asOf, { strict: ctx.strict });
    var autoMap = new Map(rows.map(function (r) { return [r.name, r.channel]; }));
    // computePartnersByChannel фильтрует по активности (0 активных клиентов + 0 резерва =
    // партнёра там нет вообще) -- нормально для остальных бордов, но здесь ломает ручное
    // назначение через панель "по ЦП": partnersBySalesCenters НЕ фильтрует по активности
    // (сознательно, см. её комментарий), так что override на давно неактивного партнёра
    // пишется корректно, но сам партнёр не появляется ни в "Партнёры канала", ни (значит) в
    // расчёте выручки -- потому что список имён строился ТОЛЬКО из rows выше (Дима,
    // 2026-09-06: "не отображается в списке 'В канале'"). Добавляем имена с явным override
    // отдельно -- ccEffectiveChannel всё равно проверяет ccOverrides в первую очередь,
    // autoMap для них просто будет пустым (не страшно, override и так сильнее авто-правила).
    var nameSet = new Set(rows.map(function (r) { return r.name; }));
    Object.keys(ccOverrides).forEach(function (name) { nameSet.add(name); });
    var names = Array.from(nameSet).sort();
    var byChannel = {}; CC_CHANNELS.forEach(function (c) { byChannel[c] = []; });
    var free = [];
    names.forEach(function (name) {
      var eff = ccEffectiveChannel(name, autoMap);
      if (eff === "") { free.push(name); return; }
      // Бакет создаём лениво -- eff может быть именем КАСТОМНОГО канала (2026-08-20,
      // борд "Новый канал"), которого нет в CC_CHANNELS. Раньше был фолбэк на "Партнёры",
      // из-за которого партнёр, явно назначенный в кастомный канал, тихо утекал в чужой бакет.
      if (!byChannel[eff]) byChannel[eff] = [];
      byChannel[eff].push(name);
    });
    return { byChannel: byChannel, free: free };
  }

  // Ранжированный поиск партнёра (Дима, 2026-09-02: ищешь "Атол" -- он тонет среди ИП вида
  // "...Анатольевич", потому что "атол" случайно совпадает как подстрока внутри отчества).
  // Плоский substring-match без ранжирования отдаёт совпадения в исходном алфавитном порядке --
  // декои "ИП ... Анатольевич" (буква "И") идут раньше настоящего "ООО "АТОЛ"" (буква "О"),
  // реальный результат оказывается в конце списка. Ранжируем: точное совпадение > начинается с
  // термина > термин как отдельное слово (после пробела/кавычки/скобки) > термин где-то внутри
  // слова (наименее релевантно).
  function ccSearchScore(name, term) {
    var lower = name.toLowerCase();
    var idx = lower.indexOf(term);
    if (idx === -1) return -1;
    if (lower === term) return 0;
    if (idx === 0) return 1;
    var boundary = /[\s"«(]/.test(lower.charAt(idx - 1));
    return boundary ? 2 : 3;
  }

  // Фильтрует и сортирует список имён по релевантности термину (см. ccSearchScore выше) --
  // сортировка стабильна (гарантия ES2019+), внутри одного ранга сохраняется исходный порядок.
  function ccSearchFilter(list, term) {
    if (!term) return list;
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var s = ccSearchScore(list[i], term);
      if (s !== -1) scored.push({ n: list[i], s: s });
    }
    scored.sort(function (a, b) { return a.s - b.s; });
    return scored.map(function (x) { return x.n; });
  }

  // Строгий поиск -- БЕЗ совпадений "термин где-то внутри слова" (ccSearchScore===3).
  // Обычный ccSearchFilter такие совпадения просто ранжирует ниже (нормально для списка на
  // экране под курсором), но этого недостаточно там, где ложное совпадение реально уводит
  // логику в сторону -- единый поиск ЦП/партнёр (Дима, 2026-09-06): "атол" по обычному
  // ccSearchFilter матчит не только "ООО АТОЛ", но и полсотни "ИП ... Анатольевич"
  // (подстрока "атол" внутри отчества), и КАЖДЫЙ такой ложный партнёр тянет за собой СВОЙ
  // ЦП в общий список -- "почему-то все центры продаж, внутри нет похожих значений".
  function ccSearchFilterStrict(list, term) {
    if (!term) return list;
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var s = ccSearchScore(list[i], term);
      if (s !== -1 && s <= 2) scored.push({ n: list[i], s: s });
    }
    scored.sort(function (a, b) { return a.s - b.s; });
    return scored.map(function (x) { return x.n; });
  }

  function ccPartnerRowHTML(name, checked) {
    return '<label class="cc-partner-row"><input type="checkbox" data-partner="' + esc(name) + '"' + (checked ? " checked" : "") + '> ' + esc(name) + '</label>';
  }

  // Общее тело карточки канала (аккордеон партнёров + чек/%оттока/период + метрики
  // кассы->тарифы->деньги->отток) -- переиспользуется и 3 фиксированными бордами
  // (channelName неизменен на всё время жизни виджета), и кастомным "Новый канал"
  // (channelName может смениться при переименовании -- тогда вызывающий код зовёт эту
  // функцию ЗАНОВО с новым именем, а не пытается патчить уже построенный DOM).
  // Регистрирует себя в ccActiveRefreshers[instanceId] -- единая точка live-sync между
  // ВСЕМИ бордами каналов на холсте (2026-08-20), ключ instanceId (не channelName) --
  // так у кастомных бордов с одинаковым/пустым именем нет коллизий в реестре.
  // Массовое назначение канала по Центру продаж (Дима+Оксана, 2026-09-02). Кейс: канал
  // Ларисы = (а) прямые продажи (Партнёр совпадает с её офисом, точный список
  // LARISA_PARTNERS) + (б) "партнёры ОП" -- агенты, у которых ЦП совпадает с её офисом, но
  // Партнёр другой (непрямые продажи). Тыкать вручную десятки чекбоксов в общем списке
  // "Партнёры канала" неудобно -- отдельная панель: отметил один/несколько ЦП -> подтянулись
  // ВСЕ партнёры с этим ЦП чекбоксами -> снял часть -> "Применить" массово пишет ccOverrides.
  // Общая для любого канала (не только Ларисы), работает и на кастомных бордах.
  //
  // Семантика "Применить" (важно, чтобы не сломать live-sync с обычным списком выше):
  // - отмечено -> ccOverrides[name] = channelName (явный override на этот канал);
  // - снято, но партнёр СЕЙЧАС (до применения) эффективно уже в ЭТОМ канале (авто-правило
  //   или прежний override) -> явно выталкиваем в catch-all "Партнёры", иначе авто-правило
  //   тут же вернёт его обратно и снятая галочка ничего не изменит. Если сам channelName и
  //   есть "Партнёры" -- это no-op, пропускаем (некуда выталкивать из catch-all).
  // - снято и партнёр и так был не в этом канале -- не трогаем чужой override.
  function ccBuildCenterFilterPanel(channelName, model, ctx) {
    var allCenters = ctx.M.allSalesCentersSorted(model);
    var allPartnerNames = ctx.M.allPartnerNamesSorted(model);
    var panel = el('<div class="cc-settings" style="margin-top:8px"></div>');
    var toggleBtn = el('<button type="button" class="cc-toggle cc-cp-toggle">▸ Массовое назначение по Центру продаж</button>');
    var body = el('<div class="cc-body cc-cp-body hidden"></div>');
    var centerSearch = el('<input type="text" class="cc-search cc-cp-search" placeholder="поиск ЦП или партнёра…">');
    // Массовое выделение НАЙДЕННЫХ ЦП (Дима, 2026-09-04: "чтобы массово закрепить всех ЦП и
    // партнеров в отдельный канал -- потом скорее всего уберем"). Работает на текущем
    // (уже отфильтрованном поиском) списке centersList, как и cc-select-all/cc-cp-select-all
    // выше для партнёров -- тот же паттерн.
    var centerBulkRow = el(
      '<div class="threshold-row" style="margin:4px 0 6px">' +
      '<button type="button" class="refresh-chart-btn cc-cp-center-select-all">Выделить всех</button>' +
      '<button type="button" class="refresh-chart-btn cc-cp-center-select-none">Убрать всех</button>' +
      '</div>'
    );
    var centersList = el('<div class="cc-list"></div>');
    var previewBtn = el('<button type="button" class="refresh-chart-btn cc-cp-preview-btn" style="margin-top:6px">Показать партнёров</button>');
    var previewHolder = el('<div style="margin-top:8px"></div>');
    body.appendChild(centerSearch);
    body.appendChild(centerBulkRow);
    body.appendChild(centersList);
    body.appendChild(previewBtn);
    body.appendChild(previewHolder);
    panel.appendChild(toggleBtn);
    panel.appendChild(body);

    function renderCentersList(list, checkedBefore) {
      centersList.innerHTML = list.length
        ? list.map(function (c) {
            return '<label class="cc-cp-center-row"><input type="checkbox" class="cc-cp-center" value="' + esc(c) + '"' + (checkedBefore.has(c) ? " checked" : "") + '> ' + esc(c) + '</label>';
          }).join("")
        : '<div class="cc-empty">Ничего не найдено — ни среди Центров продаж, ни среди партнёров.</div>';
    }

    // Единый поиск (Дима, 2026-09-06): вводишь название ЦП ИЛИ имя партнёра в одно поле.
    // Сначала прямые совпадения по названию ЦП, ЗАТЕМ добавляем ЦП тех партнёров, чьё имя
    // тоже совпало с термином (обратная связь через salesCentersForPartnerName) -- список
    // ЦП ниже сужается до объединения обоих источников. Если после этого остался РОВНО один
    // релевантный ЦП -- дальше можно решить однозначно, поэтому автоматически отмечаем его
    // и сразу показываем партнёров (без лишнего клика). Если ЦП несколько -- решить
    // однозначно нельзя, оставляем выбор человеку (отмечает нужный сам, жмёт "Показать").
    function resetPreviewPlaceholder() {
      previewHolder.innerHTML = '<div class="stat-label">Отметь хотя бы один Центр продаж выше.</div>';
    }

    function renderCenters() {
      var term = centerSearch.value.trim().toLowerCase();
      var checkedBefore = new Set(Array.from(centersList.querySelectorAll("input:checked")).map(function (cb) { return cb.value; }));

      if (!term) {
        renderCentersList(allCenters, checkedBefore);
        // Сбрасываем превью -- список ЦП только что целиком пересобран, любое старое превью
        // относится к чекбоксам, которых уже нет в DOM (иначе "зависшее" превью от
        // предыдущего поиска остаётся видно, будто всё ещё актуально -- поймано тестом,
        // 2026-09-06).
        resetPreviewPlaceholder();
        return;
      }

      var directCenters = ccSearchFilter(allCenters, term);
      var matchingPartners = ccSearchFilterStrict(allPartnerNames, term);
      var relevantSet = new Set(directCenters);
      matchingPartners.forEach(function (pn) {
        ctx.M.salesCentersForPartnerName(model, pn).forEach(function (c) { relevantSet.add(c); });
      });
      var relevant = Array.from(relevantSet);
      renderCentersList(relevant, checkedBefore);

      if (relevant.length === 1) {
        var onlyCb = centersList.querySelector(".cc-cp-center");
        if (onlyCb) {
          onlyCb.checked = true;
          // Префилл поиска партнёра внутри превью -- ТОЛЬКО если совпадение реально пришло
          // через имя партнёра (иначе термин -- название ЦП, фильтровать им список имён
          // партнёров бессмысленно, покажет "ничего не найдено" по ошибке).
          renderPreview(matchingPartners.length > 0 ? term : null);
        } else {
          resetPreviewPlaceholder();
        }
      } else {
        // Несколько ЦП (или ноль) -- решить однозначно нельзя, выбор за человеком. Старое
        // превью (если было от предыдущего однозначного поиска) тоже сбрасываем -- тот
        // набор чекбоксов уже не существует в текущем списке.
        resetPreviewPlaceholder();
      }
    }
    renderCenters();
    centerSearch.addEventListener("input", renderCenters);
    centerBulkRow.querySelector(".cc-cp-center-select-all").addEventListener("click", function () {
      centersList.querySelectorAll(".cc-cp-center").forEach(function (cb) { cb.checked = true; });
    });
    centerBulkRow.querySelector(".cc-cp-center-select-none").addEventListener("click", function () {
      centersList.querySelectorAll(".cc-cp-center").forEach(function (cb) { cb.checked = false; });
    });

    function renderPreview(presetPartnerTerm) {
      var selected = Array.from(centersList.querySelectorAll(".cc-cp-center:checked")).map(function (cb) { return cb.value; });
      if (!selected.length) {
        previewHolder.innerHTML = '<div class="stat-label">Отметь хотя бы один Центр продаж выше.</div>';
        return;
      }
      var candidateNames = ctx.M.partnersBySalesCenters(model, new Set(selected));
      var rows = ctx.M.computePartnersByChannel(model, ctx.asOf, { strict: ctx.strict });
      var autoMap = new Map(rows.map(function (r) { return [r.name, r.channel]; }));
      var allCandidates = candidateNames.map(function (name) { return { name: name, eff: ccEffectiveChannel(name, autoMap) }; });

      previewHolder.innerHTML =
        '<div class="stat-label cc-cp-count" style="margin-bottom:6px"></div>' +
        '<input type="text" class="cc-search cc-cp-partner-search" placeholder="поиск партнёра в списке…" style="margin-bottom:6px">' +
        '<label class="cc-partner-row"><input type="checkbox" class="cc-cp-only-free"' + (presetPartnerTerm ? "" : " checked") + '> Показать только свободных (скрыть закреплённых за другими каналами)</label>' +
        '<div class="threshold-row" style="margin:4px 0 6px">' +
        '<button type="button" class="refresh-chart-btn cc-cp-select-all">Выделить всех</button>' +
        '<button type="button" class="refresh-chart-btn cc-cp-select-none">Убрать всех</button>' +
        '</div>' +
        '<div class="cc-list cc-cp-rows"></div>' +
        '<button type="button" class="refresh-chart-btn cc-cp-apply-btn" style="margin-top:8px">Применить к каналу «' + esc(channelName) + '»</button>' +
        '<div class="cc-cp-status stat-label" style="margin-top:6px"></div>';

      var rowsHolder = previewHolder.querySelector(".cc-cp-rows");
      var onlyFreeCb = previewHolder.querySelector(".cc-cp-only-free");
      var partnerSearch = previewHolder.querySelector(".cc-cp-partner-search");
      var countLabel = previewHolder.querySelector(".cc-cp-count");
      var renderedOnce = false;
      // "только свободных" по умолчанию ВЫКЛЮЧЕНА, когда сюда пришли через поиск
      // конкретного партнёра (Дима: "информация, за кем он сейчас закреплён") -- иначе
      // найденный, но уже занятый другим каналом партнёр был бы молча скрыт тем же
      // фильтром, который должен был помочь его найти.
      if (presetPartnerTerm) partnerSearch.value = presetPartnerTerm;

      // "Свободный" (Дима, 2026-09-04) -- партнёр либо уже в ЭТОМ канале, либо в общем
      // catch-all "Партнёры" (никем целенаправленно не занят). Партнёр, закреплённый за
      // ДРУГИМ конкретным каналом (авто-списком или override) -- НЕ свободен, скрыт по
      // умолчанию, чтобы не перетягивать его бездумно массовым применением ЦП.
      function isFree(eff) { return eff === channelName || eff === "Партнёры"; }

      function renderRows() {
        // Сохраняем текущие галочки НЕЗАВИСИМО от их источника (дефолт по eff или ручной
        // клик) -- иначе переключение фильтров сбрасывало бы то, что уже отметил/снял
        // пользователь до этого клика.
        var checkedBefore = new Set(Array.from(rowsHolder.querySelectorAll(".cc-cp-partner:checked")).map(function (cb) { return cb.dataset.partner; }));
        var pTerm = partnerSearch.value.trim().toLowerCase();
        var visible = onlyFreeCb.checked ? allCandidates.filter(function (r) { return isFree(r.eff); }) : allCandidates;
        if (pTerm) {
          var byName = new Map(visible.map(function (r) { return [r.name, r]; }));
          visible = ccSearchFilterStrict(visible.map(function (r) { return r.name; }), pTerm).map(function (name) { return byName.get(name); });
        }
        // Счётчик ДОЛЖЕН явно меняться при переключении фильтра (Дима, 2026-09-04: "нажимаю
        // на 'только свободных' -- ничего не меняется") -- раньше он писался один раз со
        // статичным общим числом, сам список фильтровался, но при небольшой разнице (1-2
        // строки в длинном списке) это было незаметно на глаз. Теперь считает видимые/скрытые
        // явно при каждой перерисовке.
        var hiddenCount = allCandidates.length - visible.length;
        countLabel.textContent = "Партнёров с выбранным ЦП: " + fmtNum(allCandidates.length) +
          (onlyFreeCb.checked ? " · показано свободных: " + fmtNum(visible.length) : " · показаны все, кроме отфильтрованных поиском") +
          (pTerm ? " · сужено поиском «" + pTerm + "»" : "") +
          (hiddenCount ? " · скрыто фильтрами: " + fmtNum(hiddenCount) : "") +
          " — отмеченные закрепятся за каналом «" + channelName + "» по кнопке ниже."; // textContent -- esc() тут не нужен, это не innerHTML
        rowsHolder.innerHTML = visible.length
          ? visible.map(function (r) {
              // Дефолтная галочка (Дима, 2026-09-06: "нажимает применить, ничего не
              // происходит") -- раньше чекалось ТОЛЬКО если партнёр уже в этом канале, но
              // именно ТОГО партнёра, которого специально искали (совпал с presetPartnerTerm
              // при авто-показе через единый поиск), почти всегда хотят добавить, а не
              // просто посмотреть -- он был НЕ отмечен по умолчанию,колега жал "Применить"
              // с пустым выбором и не видел эффекта. Строгое совпадение (score<=2), та же
              // логика, что и у самого поиска -- не хватаем случайных "Анатольевичей".
              var presetMatch = presetPartnerTerm ? ccSearchScore(r.name, presetPartnerTerm) : -1;
              var wasChecked = renderedOnce ? checkedBefore.has(r.name) : (r.eff === channelName || (presetMatch !== -1 && presetMatch <= 2));
              var hint = r.eff === channelName ? "" : ' <span style="color:var(--muted)">— сейчас в «' + esc(r.eff) + '»</span>';
              return '<label class="cc-partner-row"><input type="checkbox" class="cc-cp-partner" data-partner="' + esc(r.name) + '" data-prev-eff="' + esc(r.eff) + '"' + (wasChecked ? " checked" : "") + '> ' + esc(r.name) + hint + '</label>';
            }).join("")
          : '<div class="cc-empty">' + (onlyFreeCb.checked ? "Все партнёры этого ЦП уже закреплены за другими каналами — сними «только свободных», чтобы их увидеть." : "Ничего не найдено.") + '</div>';
        renderedOnce = true;
      }
      renderRows();
      onlyFreeCb.addEventListener("change", renderRows);
      partnerSearch.addEventListener("input", renderRows);

      previewHolder.querySelector(".cc-cp-select-all").addEventListener("click", function () {
        rowsHolder.querySelectorAll(".cc-cp-partner").forEach(function (cb) { cb.checked = true; });
      });
      previewHolder.querySelector(".cc-cp-select-none").addEventListener("click", function () {
        rowsHolder.querySelectorAll(".cc-cp-partner").forEach(function (cb) { cb.checked = false; });
      });

      previewHolder.querySelector(".cc-cp-apply-btn").addEventListener("click", function () {
        var changed = 0;
        rowsHolder.querySelectorAll(".cc-cp-partner").forEach(function (cb) {
          var name = cb.dataset.partner;
          var prevEff = cb.dataset.prevEff;
          if (cb.checked) {
            if (ccOverrides[name] !== channelName) { ccOverrides[name] = channelName; changed++; }
          } else if (prevEff === channelName && channelName !== "Партнёры") {
            if (ccOverrides[name] !== "Партнёры") { ccOverrides[name] = "Партнёры"; changed++; }
          }
        });
        if (changed) { ccSaveOverrides(ccOverrides); ccBroadcastAssignmentChanged(); }
        previewHolder.querySelector(".cc-cp-status").textContent = changed ? ("Применено — изменено партнёров: " + changed + ".") : "Изменений нет.";
        renderPreview();
      });
    }
    previewBtn.addEventListener("click", function () { renderPreview(); });

    toggleBtn.addEventListener("click", function () {
      body.classList.toggle("hidden");
      toggleBtn.textContent = (body.classList.contains("hidden") ? "▸" : "▾") + " Массовое назначение по Центру продаж";
    });

    return panel;
  }

  function ccBuildChannelBody(channelName, model, ctx, instanceId) {
    var asn = ccAssignment(model, ctx);
    var mine = asn.byChannel[channelName] || [];
    var free = asn.free;

    var wrap = el('<div></div>');
    var head = el(
      '<div class="cc-settings">' +
      '<div class="threshold-row" style="margin-bottom:8px">' +
      '<button type="button" class="cc-toggle">▸ Партнёры канала (' + mine.length + ')</button>' +
      '<button type="button" class="refresh-chart-btn cc-server-save" title="Сохранить текущее распределение партнёров по каналам на сервере — переживёт чистку кук/новый браузер">Сохранить</button>' +
      '<span class="cc-server-status stat-label"></span>' +
      '</div>' +
      '<div class="threshold-row" style="margin-top:8px">' +
      '<label title="Смотрим на будущие продления -- касс, у которых дата окончания попадает в это окно">с <input type="date" class="cc-from"></label>' +
      '<label>по <input type="date" class="cc-to"></label>' +
      '</div>' +
      '<div class="threshold-row" style="margin-top:8px">' +
      '<label>чек, ₽ <input type="number" min="0" step="1" class="cc-check"></label>' +
      '<label>% оттока (закладываем) <input type="number" min="0" max="100" step="1" class="cc-churn" placeholder="—"></label>' +
      '</div>' +
      '<div class="cc-body hidden">' +
      '<input type="text" class="cc-search" placeholder="поиск партнёра…">' +
      '<div class="threshold-row" style="margin:6px 0 0">' +
      '<button type="button" class="refresh-chart-btn cc-select-all">Выделить всех</button>' +
      '<button type="button" class="refresh-chart-btn cc-select-none">Убрать всех</button>' +
      '</div>' +
      '<div class="cc-list"></div>' +
      '</div>' +
      '</div>'
    );
    var resultsBox = el('<div class="cc-results"></div>');
    wrap.appendChild(head);
    wrap.appendChild(ccBuildCenterFilterPanel(channelName, model, ctx));
    wrap.appendChild(resultsBox);

    var toggleBtn = head.querySelector(".cc-toggle");
    var bodyEl = head.querySelector(".cc-body");
    var searchInput = head.querySelector(".cc-search");
    var listEl = head.querySelector(".cc-list");
    var fromInput = head.querySelector(".cc-from");
    var toInput = head.querySelector(".cc-to");
    var checkInput = head.querySelector(".cc-check");
    var churnInput = head.querySelector(".cc-churn");
    var serverStatus = head.querySelector(".cc-server-status");

    head.querySelector(".cc-server-save").addEventListener("click", function () {
      serverStatus.textContent = "Сохранение…";
      ccServerSave(function (success, err) {
        serverStatus.textContent = success ? ("Сохранено " + new Date().toLocaleTimeString("ru-RU")) : ("Ошибка сохранения: " + (err || "нет ответа от сервера"));
      });
    });

    function updateToggleLabel() {
      var isOpen = !bodyEl.classList.contains("hidden");
      toggleBtn.textContent = (isOpen ? "▾" : "▸") + " Партнёры канала (" + mine.length + ")";
    }

    // Свободные -- ПЕРВЫМИ (это и есть actionable-список, "кого можно добавить"),
    // "В канале" -- ниже, справочно (Дима, дословно из ТЗ: "чтобы ИХ [свободных]
    // выводило наверх списка, они же [ниже] находились те, что за ней уже закреплены" --
    // раньше был перепутан порядок, свободные оказывались внизу под длинным "В канале").
    function renderList() {
      var term = searchInput.value.trim().toLowerCase();
      var mineF = ccSearchFilter(mine, term);
      var freeF = ccSearchFilter(free, term);
      var html = "";
      if (freeF.length) html += '<div class="cc-group-label">Свободные (' + freeF.length + ')</div>' + freeF.map(function (n) { return ccPartnerRowHTML(n, false); }).join("");
      if (mineF.length) html += '<div class="cc-group-label">В канале (' + mineF.length + ')</div>' + mineF.map(function (n) { return ccPartnerRowHTML(n, true); }).join("");
      if (!mineF.length && !freeF.length) html = '<div class="cc-empty">Ничего не найдено</div>';
      listEl.innerHTML = html;
      listEl.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var name = cb.dataset.partner;
          ccOverrides[name] = cb.checked ? channelName : "";
          ccSaveOverrides(ccOverrides);
          // Пересчитывают и перерисовывают себя ВСЕ смонтированные борды каналов
          // сразу (включая этот) -- см. ccBroadcastAssignmentChanged выше.
          ccBroadcastAssignmentChanged();
        });
      });
    }

    // Полный пересчёт "с нуля" из ccAssignment (не точечная правка mine/free) --
    // вызывается и на свою же карточку, и на остальные борды каналов через
    // ccBroadcastAssignmentChanged, единая точка входа для live-sync.
    function refreshAssignment() {
      var fresh = ccAssignment(model, ctx);
      mine = fresh.byChannel[channelName] || [];
      free = fresh.free;
      updateToggleLabel();
      if (!bodyEl.classList.contains("hidden")) renderList();
      renderResults();
    }
    ccActiveRefreshers[instanceId] = refreshAssignment;

    toggleBtn.addEventListener("click", function () {
      bodyEl.classList.toggle("hidden");
      updateToggleLabel();
      if (!bodyEl.classList.contains("hidden")) renderList();
    });
    searchInput.addEventListener("input", renderList);

    // Выделить/убрать всех (Дима, 2026-09-04: "для ускорения процесса") -- действует ТОЛЬКО
    // на видимый (уже отфильтрованный поиском) список, как select-all в Zendesk/Jira, не на
    // весь список партнёров канала целиком. Батчим: один ccSaveOverrides+broadcast на все
    // изменения разом, не по одному на чекбокс -- иначе на сотнях партнёров это N лишних
    // пересчётов/перерисовок ВСЕХ открытых бордов каналов подряд.
    function bulkSetVisible(checked) {
      var changed = 0;
      listEl.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
        var name = cb.dataset.partner;
        var target = checked ? channelName : "";
        if (ccOverrides[name] !== target) { ccOverrides[name] = target; changed++; }
      });
      if (changed) { ccSaveOverrides(ccOverrides); ccBroadcastAssignmentChanged(); }
    }
    head.querySelector(".cc-select-all").addEventListener("click", function () { bulkSetVisible(true); });
    head.querySelector(".cc-select-none").addEventListener("click", function () { bulkSetVisible(false); });

    function renderResults() {
      var check = parseFloat(checkInput.value) || 0;
      var churnRaw = churnInput.value.trim();
      var hasChurn = churnRaw !== ""; // Дима, 2026-08-19: отток пуст, пока % явно не введён -- 0 и "не задано" разные вещи
      var churn = hasChurn ? (parseFloat(churnRaw) || 0) : 0;
      var fromVal = fromInput.value, toVal = toInput.value;
      var from = fromVal ? new Date(fromVal + "T00:00:00") : null;
      var to = toVal ? new Date(toVal + "T23:59:59") : null;

      if (!mine.length) {
        resultsBox.innerHTML = '<div class="stat-label" style="margin-top:14px">В канале нет партнёров — раскрой список выше и добавь.</div>';
        return;
      }
      if (!from || !to || from > to) {
        resultsBox.innerHTML = '<div class="stat-label" style="margin-top:14px">Укажи период «с — по» (будущие продления), чтобы увидеть прогноз.</div>';
        return;
      }
      var set = new Set(mine);
      var kassas = ctx.M.computeChannelForecastKassas(model, set, from, to);

      var byTariff = new Map();
      kassas.forEach(function (k) {
        var t = k.tariff || "—";
        byTariff.set(t, (byTariff.get(t) || 0) + 1);
      });
      var tariffRows = Array.from(byTariff.entries()).sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e, i) { return { label: e[0], value: e[1], color: CC_TARIFF_COLORS[i % CC_TARIFF_COLORS.length] }; });

      var revenue = kassas.length * check * (1 - churn / 100);
      var clientsToRenew = new Set(kassas.map(function (k) { return k.clientKey; })).size;

      var html = "";
      html += '<div class="cc-metric">' + statBlock(fmtNum(kassas.length), "Касс к продлению") + '</div>';
      html += '<div class="cc-metric">' + statBlock(fmtNum(clientsToRenew), "Клиентов к продлению") + '</div>';
      if (tariffRows.length) {
        html += '<div class="cc-metric">' + barList(tariffRows, { caption: "разбивка по тарифам среди найденных касс" }) + '</div>';
      }
      html += '<div class="cc-metric"><div class="stat-value" style="color:var(--good)">' + fmtNum(Math.round(revenue)) + ' ₽</div><div class="stat-label">Прогноз выручки за период</div></div>';
      // Отток -- прогноз потерь ОТ введённого % (не факт по истории): касс_к_продлению × %.
      // Пусто, пока % не введён -- см. hasChurn выше.
      if (hasChurn) {
        var lostKassas = Math.round(kassas.length * churn / 100);
        var lostMoney = lostKassas * check;
        html += '<div class="cc-metric"><div class="stat-value" style="color:var(--crit)">' + fmtNum(lostKassas) + ' касс</div><div class="stat-label">Отток за период — потеряно ≈ ' + fmtNum(Math.round(lostMoney)) + ' ₽</div></div>';
      } else {
        html += '<div class="cc-metric"><div class="stat-label">Укажи % оттока выше, чтобы увидеть прогноз потерь.</div></div>';
      }
      resultsBox.innerHTML = html;
    }

    fromInput.addEventListener("change", renderResults);
    toInput.addEventListener("change", renderResults);
    checkInput.addEventListener("input", renderResults);
    churnInput.addEventListener("input", renderResults);
    renderResults();
    return wrap;
  }

  function makeChannelRevenueWidget(channelName) {
    return {
      // scope:"as-of" -- у каждого борда СВОЙ период "с-по" (ниже), не общий фильтр шапки:
      // Дима explicitly хочет сравнивать разные будущие окна на разных каналах одновременно.
      title: "Выручка канала: " + channelName, type: "калькулятор", scope: "as-of", span: true,
      render: function (model, ctx, instanceId) {
        return ccBuildChannelBody(channelName, model, ctx, instanceId);
      },
      onRemove: function (instanceId) {
        delete ccActiveRefreshers[instanceId];
      },
    };
  }

  WIDGETS["b5-revenue-olya"] = makeChannelRevenueWidget("Ольга Зибер");
  WIDGETS["b5-revenue-larisa"] = makeChannelRevenueWidget("Лариса Пенигина");
  WIDGETS["b5-revenue-partners"] = makeChannelRevenueWidget("Партнёры");

  // Кастомный канал (2026-08-20) -- "есть вероятность, что каналов будет больше 3".
  // Название редактируется ТЕКСТОВЫМ ПОЛЕМ внутри карточки (не заголовком борда --
  // widgetShell/dnd.js общие на все 30+ виджетов, трогать не стали). Имя + состав
  // партнёров переживают перезагрузку страницы через getPersistState/applyPersistState
  // (см. dnd.js saveLayout/loadSavedLayout) -- партнёры уже персистентны сами по себе
  // (ccOverrides в localStorage по имени партнёра), тут персистится только САМО ИМЯ,
  // привязанное к конкретному instanceId размещения на холсте.
  var ccCustomNames = new Map(); // instanceId -> имя канала ("" = ещё не задано)

  WIDGETS["b5-revenue-custom"] = {
    title: "Новый канал продаж", type: "калькулятор", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el('<div></div>');
      var nameRow = el(
        '<div class="cc-settings">' +
        '<label class="cc-name-label">Название канала</label>' +
        '<input type="text" class="cc-name-input" placeholder="Например, «Маркетплейсы»">' +
        '</div>'
      );
      var bodyHost = el('<div></div>');
      wrap.appendChild(nameRow);
      wrap.appendChild(bodyHost);

      var nameInput = nameRow.querySelector(".cc-name-input");
      nameInput.value = ccCustomNames.get(instanceId) || "";

      function renderBody() {
        var channelName = ccCustomNames.get(instanceId) || "";
        bodyHost.innerHTML = "";
        if (!channelName) {
          bodyHost.appendChild(el('<div class="stat-label" style="margin-top:12px">Введи название канала выше, чтобы начать назначать партнёров.</div>'));
          delete ccActiveRefreshers[instanceId]; // нечего пересчитывать, пока канал не назван
          return;
        }
        bodyHost.appendChild(ccBuildChannelBody(channelName, model, ctx, instanceId));
      }

      nameInput.addEventListener("change", function () {
        var newName = nameInput.value.trim();
        var oldName = ccCustomNames.get(instanceId) || "";
        if (newName === oldName) return;
        // Переименование переносит УЖЕ назначенных партнёров со старого имени на новое --
        // иначе они потерялись бы, оставшись привязаны к имени, которого больше нет ни у
        // одной карточки на холсте.
        if (oldName) {
          Object.keys(ccOverrides).forEach(function (partner) {
            if (ccOverrides[partner] === oldName) ccOverrides[partner] = newName;
          });
          ccSaveOverrides(ccOverrides);
        }
        ccCustomNames.set(instanceId, newName);
        renderBody();
        ccBroadcastAssignmentChanged();
      });

      renderBody();
      return wrap;
    },
    onRemove: function (instanceId) {
      var name = ccCustomNames.get(instanceId);
      if (name) {
        // Партнёров канала не удаляем совсем -- освобождаем (снова видны как "Свободные"
        // на остальных бордах), как и при обычном снятии галочки.
        Object.keys(ccOverrides).forEach(function (partner) {
          if (ccOverrides[partner] === name) ccOverrides[partner] = "";
        });
        ccSaveOverrides(ccOverrides);
      }
      ccCustomNames.delete(instanceId);
      delete ccActiveRefreshers[instanceId];
      ccBroadcastAssignmentChanged();
    },
    getPersistState: function (instanceId) {
      return ccCustomNames.get(instanceId) || "";
    },
    applyPersistState: function (instanceId, saved) {
      if (saved) ccCustomNames.set(instanceId, saved);
    },
  };

  // ---------- B6 Обзвон ----------

  // Список для обзвона (Дима, 2026-08-26): выбираешь месяц (по ДАТЕ ОКОНЧАНИЯ кассы) и один
  // или несколько каналов -- отдаёт готовый контактный список: одна КАССА = одна строка (не
  // клиент -- если у клиента несколько касс, заканчивающихся в этом месяце, будет несколько
  // строк). Канал -- тот же, что в "Разбивка по каналам"/калькуляторах B5 (ccAssignment, с
  // учётом ручных правок партнёров), не сырое поле "Тип продаж" из выгрузки.
  WIDGETS["b6-callsheet"] = {
    title: "Список для обзвона", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      var controls = el(
        '<div class="threshold-row">' +
        '<label>Месяц окончания <input type="month" class="f-month"></label>' +
        '<span style="display:flex;gap:10px;align-items:center;color:var(--muted)">Каналы:' +
        CC_CHANNELS.map(function (ch) { return '<label style="display:flex;gap:3px;align-items:center;color:var(--ink)"><input type="checkbox" class="f-channel" value="' + esc(ch) + '" checked> ' + esc(ch) + '</label>'; }).join("") +
        '</span>' +
        '</div>'
      );
      var tableHolder = el('<div style="margin-top:8px"></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      var limit = 150;

      function apply() {
        var monthVal = controls.querySelector(".f-month").value; // "YYYY-MM" или ""
        var checkedChannels = Array.from(controls.querySelectorAll(".f-channel:checked")).map(function (cb) { return cb.value; });

        if (!monthVal) {
          tableHolder.innerHTML = '<div class="stat-label">Выбери месяц окончания, чтобы увидеть список.</div>';
          wrap._getExportRows = function () { return []; };
          return;
        }
        if (!checkedChannels.length) {
          tableHolder.innerHTML = '<div class="stat-label">Выбери хотя бы один канал.</div>';
          wrap._getExportRows = function () { return []; };
          return;
        }

        var parts = monthVal.split("-");
        var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1;
        var monthStart = new Date(y, m, 1);
        var monthEnd = new Date(y, m + 1, 0, 23, 59, 59);

        var autoMap = new Map(ctx.M.computePartnersByChannel(model, ctx.asOf, { strict: ctx.strict }).map(function (p) { return [p.name, p.channel]; }));
        function channelOf(partnerName) {
          var name = partnerName || "—";
          var eff = Object.prototype.hasOwnProperty.call(ccOverrides, name) ? ccOverrides[name] : autoMap.get(name);
          return CC_CHANNELS.indexOf(eff) !== -1 ? eff : null; // кастомные/неназначенные каналы сюда не попадают
        }

        var matched = [];
        model.kassas.forEach(function (k) {
          if (!k.overallEnd || k.overallEnd < monthStart || k.overallEnd > monthEnd) return;
          var ch = channelOf(k.partner);
          if (!ch || checkedChannels.indexOf(ch) === -1) return;
          matched.push({
            channel: ch, partner: k.partner || "—", partnerInn: k.partnerInn || "",
            org: k.org || "—", clientKey: k.clientKey || "—", phone: k.phone || "",
            email: k.email || "", tariff: k.tariff || "—", end: k.overallEnd,
          });
        });
        matched.sort(function (a, b) { return a.end - b.end; });

        var top = matched.slice(0, limit);
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(matched.length) + (matched.length > top.length ? " · показаны первые " + top.length + ", остальное — через экспорт" : "") + '</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "Канал продаж" }, { label: "Партнёр" }, { label: "ИНН партнёра" }, { label: "Наименование клиента" }, { label: "ИНН клиента" }, { label: "Номер телефона" }, { label: "Почта" }, { label: "Последний тариф" }, { label: "Дата окончания тарифа" }],
          top.map(function (r) { return [r.channel, r.partner, r.partnerInn, r.org, r.clientKey, r.phone, r.email, r.tariff, fmtDate(r.end)]; })
        ));
        wrap._getExportRows = function () {
          return matched.map(function (r) {
            return {
              КаналПродаж: r.channel, Партнёр: r.partner, ИННПартнёра: r.partnerInn,
              НаименованиеКлиента: r.org, ИННКлиента: r.clientKey, НомерТелефона: r.phone,
              Почта: r.email, ПоследнийТариф: r.tariff, ДатаОкончанияТарифа: fmtDate(r.end),
            };
          });
        };
      }
      controls.addEventListener("input", apply);
      controls.addEventListener("change", apply);
      apply();
      return wrap;
    },
    exportable: true,
  };

  // ---------- B7 Продления: «Календарь продлений» + «Переток тарифов» ----------
  // Спека: tmp/plans/2026-08-31-renewal-calendar-tz.md (Дима, 2026-08-31, /process).
  //
  // Юнит РНМ/ИНН -- ОБЩИЙ на оба борда этой секции, но НЕ добавлен в глобальный топбар
  // (не трогаем index.html/app.js/остальные 31 виджет). Module-level переменная плюс
  // window.OFDCanvas.rerenderAll() при смене -- тот же путь, каким период/as-of уже
  // пересчитывают ВСЕ карточки холста, ничего нового в dnd.js не требуется.
  //
  // Диапазон дат ("видимый диапазон") -- НАОБОРОТ, ЛОКАЛЬНЫЙ на инстанс (viewport, не
  // фильтр -- ТЗ §0: "график считается по всему файлу, диапазон только обрезает видимую
  // часть оси"). Persist через instanceId в module-level Map -- тот же приём, что
  // per-instance имя канала в B5 (getPersistState/applyPersistState), иначе сбрасывался бы
  // на каждый rerenderAll (смена периода/as-of/юнита).
  var RC_UNIT = "kassa";
  var RC_CAL_ONLY_ACTIVE = false; // Календарь: все касс/клиенты / только живые сейчас (as-of)
  var RC_VIEWPORT = new Map(); // instanceId -> {from: idx, to: idx}
  var RC_FLOW_VIEWPORT = new Map(); // то же самое, для "по месяцам" на Борде 2
  var RC_SANKEY_ZOOM = new Map(); // instanceId -> множитель (1 / 1.5 / 2 / 3)
  var RC_FLOW_ONLY_ACTIVE = false; // Переток тарифов: все переходы / только у живых сейчас касс
  var RC_ZOOM_LEVELS = [1, 1.5, 2, 3];

  function rcTariffLabel(t) { return t + " мес"; }
  var RC_TYPE_LABEL = { new: "новые", renewed: "продлилось", churn: "отток", pending: "ожидание (грейс)", forecast: "прогноз" };
  // Демо-палитра, ОБЩАЯ для Календаря и Перетока (Дима, 2026-09-01: список тарифов теперь
  // один на оба борда -- цвет тарифа тоже один и тот же, где бы он ни встретился). В проекте
  // закреплено только 3 dataviz-цвета (--s1/--s2/--s3) под ровно 3 роли, а тарифов может
  // быть больше -- открытый вопрос из ТЗ §3.1, финальную палитру для N категорий утвердить
  // отдельно, эта -- рабочая, не финальная.
  var RC_FLOW_PALETTE = ["var(--s1)", "var(--s2)", "var(--s3)", "#8b6fd1", "#c9a227", "#d1587f", "#4a90a4", "#a45c2e", "#6b8e23", "#9370db"];

  function rcSvgEl(tag, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  // Наведение на сегмент -- своя плавающая подсказка вместо нативного SVG <title>
  // (Дима, 2026-08-31: "при наведении не появляются значения" -- у <title> в браузере
  // задержка ~600-1000мс до показа, на узких сегментах/при быстром движении мыши это
  // читается как "ничего не происходит"). Один общий div на всю страницу, лениво создаётся.
  var rcTooltipEl = null;
  function rcTooltip() {
    if (!rcTooltipEl) {
      rcTooltipEl = document.createElement("div");
      rcTooltipEl.className = "rc-tooltip";
      document.body.appendChild(rcTooltipEl);
    }
    return rcTooltipEl;
  }
  function rcAttachTooltip(node, textFn) {
    node.addEventListener("mouseenter", function () {
      var tip = rcTooltip();
      tip.textContent = textFn();
      tip.style.display = "block";
    });
    node.addEventListener("mousemove", function (e) {
      var tip = rcTooltip();
      tip.style.left = e.clientX + "px";
      tip.style.top = e.clientY + "px";
    });
    node.addEventListener("mouseleave", function () { rcTooltip().style.display = "none"; });
  }
  // Несколько горизонтально скроллящихся графиков (4 блока календаря / 3 строки перетока)
  // должны листаться СИНХРОННО -- иначе визуально кажется, что у каждого своя дата начала
  // (Дима, 2026-08-31: "почему тринадцатимесячные идут только от августа 18, пятнадцати- --
  // от 19, тридцать шесть -- только от 21", хотя ось месяцев у всех ОДНА и та же, просто
  // независимые скроллы разъезжались/читались как разные точки отсчёта).
  function rcLinkScroll(containers) {
    containers.forEach(function (c) {
      c.addEventListener("scroll", function () {
        containers.forEach(function (other) { if (other !== c) other.scrollLeft = c.scrollLeft; });
      });
    });
  }
  function rcMonthLabel(d) { return MONTHS_SHORT[d.getMonth()] + " " + String(d.getFullYear()).slice(2); }
  function rcAsOfIndex(months, asOf) {
    for (var i = 0; i < months.length; i++) {
      if (months[i].getFullYear() === asOf.getFullYear() && months[i].getMonth() === asOf.getMonth()) return i;
    }
    for (var j = months.length - 1; j >= 0; j--) { if (months[j] <= asOf) return j; } // подстраховка, не должно случаться
    return months.length - 1;
  }
  function rcColorForTariff(tariffMonths, nodeOrder) {
    var idx = nodeOrder.indexOf(tariffMonths);
    return RC_FLOW_PALETTE[(idx < 0 ? 0 : idx) % RC_FLOW_PALETTE.length];
  }
  // Колонки drill-таблиц -- см. ТЗ §1.3/§2.4. Юнит "клиент": РНМ заменён на "Кол-во
  // активных касс" (у клиента может быть несколько касс, единого РНМ нет).
  var RC_DRILL_COLUMNS_KASSA = [
    { label: "ИНН клиента", key: "inn" }, { label: "Наименование клиента", key: "org" },
    { label: "РНМ", key: "rnm" }, { label: "Тариф", key: "tariff" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "ИНН партнёра", key: "partnerInn" }, { label: "Наименование партнёра", key: "partner" },
  ];
  var RC_DRILL_COLUMNS_CLIENT = [
    { label: "ИНН клиента", key: "inn" }, { label: "Наименование клиента", key: "org" },
    { label: "Кол-во активных касс", key: "activeKassas", num: true }, { label: "Тариф", key: "tariff" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "ИНН партнёра", key: "partnerInn" }, { label: "Наименование партнёра", key: "partner" },
  ];
  // Борд 2 -- ДВЕ тарифные колонки (до/после), таблица описывает переход, не статичную кассу.
  var RC_TRANSITION_COLUMNS_KASSA = [
    { label: "ИНН клиента", key: "inn" }, { label: "Наименование клиента", key: "org" },
    { label: "РНМ", key: "rnm" }, { label: "Тариф до", key: "tariffFrom" }, { label: "Тариф после", key: "tariffTo" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "ИНН партнёра", key: "partnerInn" }, { label: "Наименование партнёра", key: "partner" },
  ];
  function renderDrillList(container, list, columns, caption) {
    container.innerHTML = "";
    container.appendChild(el('<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px;margin-bottom:6px"><b>' + esc(caption) + '</b></div>'));
    if (!list.length) {
      container.appendChild(el('<div class="stat-label">Нет данных по этому сегменту.</div>'));
      return;
    }
    var limit = 200;
    var top = list.slice(0, limit);
    container.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(list.length) + (list.length > top.length ? " · показаны первые " + top.length : "") + '</div>'));
    var headers = columns.map(function (c) { return { label: c.label, num: !!c.num }; });
    var rows = top.map(function (item) {
      return columns.map(function (c) {
        var v = item[c.key];
        if (c.date) return v ? fmtDate(v) : "—";
        return (v == null || v === "") ? "—" : v;
      });
    });
    var scrollWrap = el('<div class="expand-scroll"></div>');
    scrollWrap.appendChild(makeSortableTable(headers, rows));
    container.appendChild(scrollWrap);
  }

  // renewedFirst/renewedRepeat визуально объединены в один сегмент "продлилось" (число
  // впервые/повторно видно в подсказке при наведении) -- клик раскрывает ОБА подтипа разом.
  function rcDrillRenewalCombined(model, ctx, monthDate, tariffMonths, type, unit, onlyActive) {
    if (type === "renewed") {
      return ctx.M.renewalCalendarDrill(model, ctx.asOf, monthDate, tariffMonths, "renewedFirst", unit, onlyActive)
        .concat(ctx.M.renewalCalendarDrill(model, ctx.asOf, monthDate, tariffMonths, "renewedRepeat", unit, onlyActive));
    }
    return ctx.M.renewalCalendarDrill(model, ctx.asOf, monthDate, tariffMonths, type, unit, onlyActive);
  }

  // Один блок борда 1 (Итого / 13 / 15 / 36): главная панель (новые + продлилось, стек;
  // будущее -- пунктирный контур без заливки, без деления, без прогноза оттока -- ТЗ §1.1)
  // + панель оттока/грейса под ней на своей шкале (ТЗ §1.2). onSegmentClick(monthDate, type).
  // Шкалы/геометрия общие для замороженной оси (rcBuildCalendarAxis) и скроллящегося
  // графика (rcBuildCalendarChart) -- считаем один раз, чтобы сетка совпадала пиксель в
  // пиксель (2026-09-02: ось со значениями раньше была ЧАСТЬЮ того же SVG, что и бары, и
  // скроллилась вместе с ними вправо -- "заморозить" значит вынести подписи в отдельный
  // несдвигаемый SVG слева от .hscroll-chart, но числа на сетке обеих панелей обязаны
  // остаться идентичными).
  function rcCalcCalendarScale(series, viewport, asOfIdx, showNew, showRenewed) {
    var from = viewport.from, to = viewport.to;
    var visSeries = series.slice(from, to + 1);
    var mainH = 118, gapH = 10, churnH = 44, axisH = 20;
    var H = mainH + gapH + churnH + axisH;
    var churnTop = mainH + gapH;
    var maxMain = 1, maxChurn = 1;
    visSeries.forEach(function (s, i) {
      var idx = from + i, isFuture = idx > asOfIdx;
      var v = isFuture ? s.forecast : ((showNew ? s.new : 0) + (showRenewed ? (s.renewedFirst + s.renewedRepeat) : 0));
      if (v > maxMain) maxMain = v;
      if (!isFuture) { var ch = s.churn + s.pending; if (ch > maxChurn) maxChurn = ch; }
    });
    return {
      visSeries: visSeries, from: from, mainH: mainH, gapH: gapH, churnH: churnH, axisH: axisH, H: H, churnTop: churnTop,
      mainScale: mainH / (maxMain * 1.12), churnScale: churnH / (maxChurn * 1.25),
    };
  }

  // Несдвигаемая панель слева -- ТОЛЬКО подписи цифр на сетке, без баров и без месяцев.
  // Ставится ВНЕ .hscroll-chart (обычным соседом во flex-строке), поэтому не скроллится
  // вместе с графиком (2026-09-02, Дима: "значения тоже перелистываются, надо заморозить").
  function rcBuildCalendarAxis(sc) {
    var axisW = 54;
    var svg = rcSvgEl("svg", { viewBox: "0 0 " + axisW + " " + sc.H, width: axisW, height: sc.H, class: "chart-svg rc-axis-svg" });
    for (var g = 0; g <= 3; g++) {
      var gy = sc.mainH - (sc.mainH / 3) * g;
      var mainVal = Math.round((sc.mainH - gy) / sc.mainScale);
      var mainLbl = rcSvgEl("text", { x: axisW - 6, y: gy + 3, class: "tick-label", "text-anchor": "end" });
      mainLbl.textContent = fmtNum(mainVal);
      svg.appendChild(mainLbl);
    }
    for (var gc = 0; gc <= 2; gc++) {
      var gyc = sc.churnTop + sc.churnH - (sc.churnH / 2) * gc;
      var churnVal = Math.round((sc.churnTop + sc.churnH - gyc) / sc.churnScale);
      var churnLbl = rcSvgEl("text", { x: axisW - 6, y: gyc + 3, class: "tick-label", "text-anchor": "end" });
      churnLbl.textContent = fmtNum(churnVal);
      svg.appendChild(churnLbl);
    }
    return svg;
  }

  // Скроллящаяся часть -- бары + сетка (без текста, тот теперь в rcBuildCalendarAxis) +
  // подписи месяцев снизу. padL сведён к минимуму (числа больше не печатаются здесь).
  function rcBuildCalendarChart(sc, buckets, tariffKeyOrNull, months, asOfIdx, allTariffs, showNew, showRenewed, onSegmentClick) {
    var isTotal = tariffKeyOrNull == null;
    var color = isTotal ? "var(--ink)" : rcColorForTariff(tariffKeyOrNull, allTariffs);
    var series = isTotal ? buckets.total : buckets[tariffKeyOrNull];
    var visSeries = sc.visSeries, from = sc.from;
    var mainH = sc.mainH, churnH = sc.churnH, churnTop = sc.churnTop, H = sc.H, mainScale = sc.mainScale, churnScale = sc.churnScale;

    var colW = 46, padL = 6, padR = 10;
    var W = visSeries.length * colW + padL + padR;

    var svg = rcSvgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, class: "chart-svg" });
    for (var g = 0; g <= 3; g++) {
      var gy = mainH - (mainH / 3) * g;
      svg.appendChild(rcSvgEl("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, class: "gridline" }));
    }
    for (var gc = 0; gc <= 2; gc++) {
      var gyc = churnTop + churnH - (churnH / 2) * gc;
      svg.appendChild(rcSvgEl("line", { x1: padL, x2: W - padR, y1: gyc, y2: gyc, class: "gridline" }));
    }

    visSeries.forEach(function (s, i) {
      var idx = from + i;
      var cx = padL + i * colW, barW = 30, bx = cx + (colW - barW) / 2;
      var isAsOf = idx === asOfIdx, isFuture = idx > asOfIdx;
      var monthDate = months[idx];

      if (isFuture) {
        var h = s.forecast * mainScale, y = mainH - h;
        // pointer-events:all -- ОБЯЗАТЕЛЕН при fill:none: без него SVG считает "покрашенной"
        // только саму пунктирную обводку, наведение работает лишь на тонкую линию контура,
        // не на весь столбец (Дима, 2026-09-01: "нужно наводиться на тонкую линию").
        var rect = rcSvgEl("rect", { x: bx, y: y, width: barW, height: Math.max(0, h), rx: 2, style: "fill:none;stroke:" + color + ";stroke-width:1.3;stroke-dasharray:3 2;cursor:pointer;pointer-events:all" });
        rcAttachTooltip(rect, function () { return "Ожидается продлений · " + rcMonthLabel(monthDate) + ": " + s.forecast; });
        rect.addEventListener("click", function () { onSegmentClick(monthDate, "forecast"); });
        svg.appendChild(rect);
      } else {
        var cursorY = mainH;
        if (showRenewed && (s.renewedFirst + s.renewedRepeat) > 0) {
          var hR = (s.renewedFirst + s.renewedRepeat) * mainScale;
          var rRenew = rcSvgEl("rect", { x: bx, y: cursorY - hR, width: barW, height: hR, rx: 2, style: "fill:" + color + ";cursor:pointer" });
          rcAttachTooltip(rRenew, function () { return "Продлилось · " + rcMonthLabel(monthDate) + ": " + (s.renewedFirst + s.renewedRepeat) + " (впервые " + s.renewedFirst + ", повторно " + s.renewedRepeat + ")"; });
          rRenew.addEventListener("click", function () { onSegmentClick(monthDate, "renewed"); });
          svg.appendChild(rRenew);
          cursorY -= hR;
        }
        if (showNew && s.new > 0) {
          var hN = s.new * mainScale;
          // "Новые" -- тот же цвет тарифа, что и "Продлилось", но светлее (opacity) --
          // масштабируется на любое число тарифов без отдельной пары цветов на каждый.
          var rNew = rcSvgEl("rect", { x: bx, y: cursorY - hN, width: barW, height: hN, rx: 2, style: "fill:" + color + ";opacity:.45;cursor:pointer" });
          rcAttachTooltip(rNew, function () { return "Новые · " + rcMonthLabel(monthDate) + ": " + s.new; });
          rNew.addEventListener("click", function () { onSegmentClick(monthDate, "new"); });
          svg.appendChild(rNew);
        }
        var cursorC = churnTop;
        if (s.pending > 0) {
          var hP = s.pending * churnScale;
          var rP = rcSvgEl("rect", { x: bx, y: cursorC, width: barW, height: hP, rx: 2, style: "fill:var(--warn);cursor:pointer" });
          rcAttachTooltip(rP, function () { return "Ожидание (грейс) · " + rcMonthLabel(monthDate) + ": " + s.pending; });
          rP.addEventListener("click", function () { onSegmentClick(monthDate, "pending"); });
          svg.appendChild(rP);
          cursorC += hP;
        }
        if (s.churn > 0) {
          var hC = s.churn * churnScale;
          var rC = rcSvgEl("rect", { x: bx, y: cursorC, width: barW, height: hC, rx: 2, style: "fill:var(--crit);cursor:pointer" });
          rcAttachTooltip(rC, function () { return "Отток · " + rcMonthLabel(monthDate) + ": " + s.churn; });
          rC.addEventListener("click", function () { onSegmentClick(monthDate, "churn"); });
          svg.appendChild(rC);
        }
      }
      var lbl = rcSvgEl("text", { x: cx + colW / 2, y: H - 5, class: "tick-label", "text-anchor": "middle", style: isAsOf ? "fill:var(--brand);font-weight:700" : "" });
      lbl.textContent = rcMonthLabel(monthDate);
      svg.appendChild(lbl);
    });
    return svg;
  }

  // <select> вместо <input type="month"> для видимого диапазона -- надёжнее (Дима,
  // 2026-08-31: "после переключения фильтр автоматически не применяется" -- нативный
  // date/month-picker в разных браузерах ведёт себя по-разному, где-то change прилетает
  // только после потери фокуса; select с готовыми опциями всегда даёт валидное значение и
  // всегда стреляет change сразу по выбору).
  function rcMonthSelectHTML(className, months, selectedIdx) {
    var opts = months.map(function (d, i) {
      return '<option value="' + i + '"' + (i === selectedIdx ? " selected" : "") + '>' + esc(rcMonthLabel(d)) + '</option>';
    }).join("");
    return '<select class="' + className + '">' + opts + '</select>';
  }

  WIDGETS["b7-renewal-calendar"] = {
    title: "Календарь продлений", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var asOf = ctx.asOf;
      var tariffs = ctx.M.allTariffsSorted(model);
      var cal = ctx.M.computeRenewalCalendar(model, asOf, { unit: RC_UNIT, tariffs: tariffs, onlyActive: RC_CAL_ONLY_ACTIVE });
      var months = cal.months;
      var asOfIdx = rcAsOfIndex(months, asOf);

      var vp = RC_VIEWPORT.get(instanceId);
      if (!vp) {
        // дефолт -- последние 12 прошедших месяцев + весь прогноз (не все 40+ месяцев
        // истории разом -- ради этого и просили viewport-контрол, не только скролл)
        vp = { from: Math.max(0, asOfIdx - 11), to: months.length - 1 };
        RC_VIEWPORT.set(instanceId, vp);
      }
      vp.from = Math.min(Math.max(vp.from, 0), months.length - 1);
      vp.to = Math.min(Math.max(vp.to, vp.from), months.length - 1);

      var wrap = el("<div></div>");
      var unitRow = el(
        '<div class="threshold-row">' +
        '<span style="color:var(--muted)">Единица</span>' +
        '<label><input type="radio" name="rc-unit-' + instanceId + '" value="kassa"' + (RC_UNIT === "kassa" ? " checked" : "") + '> РНМ (кассы)</label>' +
        '<label><input type="radio" name="rc-unit-' + instanceId + '" value="client"' + (RC_UNIT === "client" ? " checked" : "") + '> ИНН (клиенты)</label>' +
        '<span style="color:var(--muted);margin-left:10px">Кассы/клиенты</span>' +
        '<label><input type="radio" name="rc-active-' + instanceId + '" value="all"' + (RC_CAL_ONLY_ACTIVE ? "" : " checked") + '> все</label>' +
        '<label><input type="radio" name="rc-active-' + instanceId + '" value="active"' + (RC_CAL_ONLY_ACTIVE ? " checked" : "") + '> только действующие</label>' +
        '<span style="color:var(--muted);margin-left:10px">вид</span>' +
        '<label><input type="radio" name="rc-view-' + instanceId + '" value="chart" checked> график</label>' +
        '<label><input type="radio" name="rc-view-' + instanceId + '" value="table"> таблица</label>' +
        '</div>'
      );
      var rangeRow = el(
        '<div class="threshold-row" style="margin-top:-4px">' +
        '<span style="color:var(--muted)">видимый диапазон</span>' +
        rcMonthSelectHTML("rc-from", months, vp.from) + ' <span>—</span> ' + rcMonthSelectHTML("rc-to", months, vp.to) +
        '<button type="button" class="refresh-chart-btn rc-full-range">весь период</button>' +
        '</div>'
      );
      var legendRow = el(
        '<div class="threshold-row" style="margin-top:-4px">' +
        '<label><input type="checkbox" class="rc-show-new" checked> Новые (светлее)</label>' +
        '<label><input type="checkbox" class="rc-show-renewed" checked> Продлилось (темнее)</label>' +
        '<span style="color:var(--muted)">Отток/грейс — своя панель под графиком · пунктир — прогноз · наведи на столбец — точное число</span>' +
        '</div>'
      );
      var blocksHolder = el("<div></div>");
      var tableHolder = el('<div style="display:none"></div>');
      var drillHolder = el('<div style="margin-top:10px"></div>');
      wrap.appendChild(unitRow);
      wrap.appendChild(rangeRow);
      wrap.appendChild(legendRow);
      wrap.appendChild(blocksHolder);
      wrap.appendChild(tableHolder);
      wrap.appendChild(drillHolder);

      function tariffLabelOrTotal(key) { return key == null ? "Итого" : rcTariffLabel(key); }

      function buildBlock(label, tariffKeyOrNull) {
        var block = el('<div class="rc-block"></div>');
        block.appendChild(el('<div class="rc-block-title"><b>' + esc(label) + '</b></div>'));
        var showNew = legendRow.querySelector(".rc-show-new").checked;
        var showRenewed = legendRow.querySelector(".rc-show-renewed").checked;
        var series = tariffKeyOrNull == null ? cal.buckets.total : cal.buckets[tariffKeyOrNull];
        var sc = rcCalcCalendarScale(series, vp, asOfIdx, showNew, showRenewed);
        // Ось слева -- ВНЕ .hscroll-chart, не скроллится вместе с графиком (заморожена).
        var chartRow = el('<div style="display:flex;align-items:flex-start"></div>');
        chartRow.appendChild(rcBuildCalendarAxis(sc));
        var chartWrap = el('<div class="hscroll-chart"></div>');
        chartWrap.appendChild(rcBuildCalendarChart(sc, cal.buckets, tariffKeyOrNull, months, asOfIdx, tariffs, showNew, showRenewed, function (monthDate, type) {
          if (tariffKeyOrNull == null) {
            drillHolder.innerHTML = '<div class="stat-label" style="margin-top:8px">На «Итого» клик не раскрывается (тарифы суммированы) — выбери конкретный тариф ниже.</div>';
            return;
          }
          var list = rcDrillRenewalCombined(model, ctx, monthDate, tariffKeyOrNull, type, RC_UNIT, RC_CAL_ONLY_ACTIVE);
          var columns = RC_UNIT === "client" ? RC_DRILL_COLUMNS_CLIENT : RC_DRILL_COLUMNS_KASSA;
          renderDrillList(drillHolder, list, columns, tariffLabelOrTotal(tariffKeyOrNull) + " · " + rcMonthLabel(monthDate) + " · " + RC_TYPE_LABEL[type]);
        }));
        chartRow.appendChild(chartWrap);
        block.appendChild(chartRow);
        return block;
      }
      function renderBlocks() {
        blocksHolder.innerHTML = "";
        blocksHolder.appendChild(buildBlock("Итого", null));
        tariffs.forEach(function (t) { blocksHolder.appendChild(buildBlock(rcTariffLabel(t), t)); });
        // синхронный скролл -- все блоки листаются вместе, иначе кажется, что у каждого
        // своя точка отсчёта на оси месяцев (Дима, 2026-08-31)
        rcLinkScroll(Array.from(blocksHolder.querySelectorAll(".hscroll-chart")));
      }

      // Единая таблица на весь виджет (Дима, 2026-09-01) -- Месяц×Тариф, только прошлое+as-of
      // (у прогноза нет разбивки новые/продлилось/отток/грейс, только сырое ожидаемое число --
      // нечего сводить в эти колонки). % у каждого значения -- доля от (Новые+Продлившиеся+
      // Отток+Грейс) этой же строки. Конверсия = Продлившиеся/(Продлившиеся+Отток).
      function renderTable() {
        tableHolder.innerHTML = "";
        var toIdx = Math.min(vp.to, asOfIdx);
        if (vp.from > toIdx) {
          tableHolder.appendChild(el('<div class="stat-label">В видимом диапазоне только будущие месяцы — у прогноза нет этой разбивки, сдвинь диапазон.</div>'));
          return;
        }
        var groups = [null].concat(tariffs);
        var rows = [];
        for (var idx = vp.from; idx <= toIdx; idx++) {
          groups.forEach(function (g) {
            var s = g == null ? cal.buckets.total[idx] : cal.buckets[g][idx];
            var renewed = s.renewedFirst + s.renewedRepeat;
            var base = s.new + renewed + s.churn + s.pending;
            function cell(v) { return base ? fmtNum(v) + " (" + (v / base * 100).toFixed(1) + "%)" : fmtNum(v); }
            var convBase = renewed + s.churn;
            var conv = convBase ? (renewed / convBase * 100).toFixed(1) + "%" : "—";
            rows.push([rcMonthLabel(months[idx]), tariffLabelOrTotal(g), cell(s.new), cell(renewed), cell(s.churn), cell(s.pending), conv]);
          });
        }
        var headers = [
          { label: "Месяц" }, { label: "Тариф" }, { label: "Новые" }, { label: "Продлившиеся" },
          { label: "Отток" }, { label: "Грейс" }, { label: "Конверсия", num: true },
        ];
        var scrollWrap = el('<div class="table-scroll"></div>');
        scrollWrap.appendChild(makeSortableTable(headers, rows));
        tableHolder.appendChild(scrollWrap);
        tableHolder.appendChild(el('<div class="stat-label" style="margin-top:6px">% — доля от (Новые+Продлившиеся+Отток+Грейс) в этой строке. Конверсия = Продлившиеся / (Продлившиеся+Отток).</div>'));
      }

      renderBlocks();

      function syncRangeSelects() {
        rangeRow.querySelector(".rc-from").value = String(vp.from);
        rangeRow.querySelector(".rc-to").value = String(vp.to);
      }
      function refreshVisible() {
        var view = unitRow.querySelector('input[name="rc-view-' + instanceId + '"]:checked').value;
        blocksHolder.style.display = view === "chart" ? "" : "none";
        tableHolder.style.display = view === "table" ? "" : "none";
        if (view === "chart") renderBlocks(); else renderTable();
      }

      unitRow.querySelectorAll('input[name="rc-unit-' + instanceId + '"]').forEach(function (r) {
        r.addEventListener("change", function () { RC_UNIT = r.value; root.OFDCanvas && root.OFDCanvas.rerenderAll(); });
      });
      unitRow.querySelectorAll('input[name="rc-active-' + instanceId + '"]').forEach(function (r) {
        r.addEventListener("change", function () {
          RC_CAL_ONLY_ACTIVE = unitRow.querySelector('input[name="rc-active-' + instanceId + '"]:checked').value === "active";
          root.OFDCanvas && root.OFDCanvas.rerenderAll();
        });
      });
      unitRow.querySelectorAll('input[name="rc-view-' + instanceId + '"]').forEach(function (r) {
        r.addEventListener("change", refreshVisible);
      });
      rangeRow.querySelector(".rc-from").addEventListener("change", function (e) {
        vp.from = parseInt(e.target.value, 10);
        if (vp.to < vp.from) vp.to = vp.from;
        syncRangeSelects(); refreshVisible();
      });
      rangeRow.querySelector(".rc-to").addEventListener("change", function (e) {
        vp.to = parseInt(e.target.value, 10);
        if (vp.from > vp.to) vp.from = vp.to;
        syncRangeSelects(); refreshVisible();
      });
      rangeRow.querySelector(".rc-full-range").addEventListener("click", function () {
        vp.from = 0; vp.to = months.length - 1;
        syncRangeSelects(); refreshVisible();
      });
      legendRow.querySelectorAll(".rc-show-new, .rc-show-renewed").forEach(function (cb) { cb.addEventListener("change", renderBlocks); });

      return wrap;
    },
  };

  // Sankey (alluvial) -- узлы слева "тариф ДО"/справа "тариф ПОСЛЕ" (nodeOrder общий для
  // обеих сторон), self-flow (X->X) рисуется как почти горизонтальная полоса. Раскладка --
  // накопительный offset по узлам (та же техника, что и в мокапе, согласованном с Димой).
  function rcBuildSankey(rows, nodeOrder, tariffLabelFn, onFlowClick, zoom) {
    zoom = zoom || 1;
    var W = 680, H = Math.max(260, nodeOrder.length * 52), x1 = 92, x2 = W - 92, gap = 8;
    var leftTotal = {}, rightTotal = {};
    nodeOrder.forEach(function (n) { leftTotal[n] = 0; rightTotal[n] = 0; });
    rows.forEach(function (r) {
      if (nodeOrder.indexOf(r.from) === -1 || nodeOrder.indexOf(r.to) === -1) return;
      leftTotal[r.from] += r.count; rightTotal[r.to] += r.count;
    });
    var totalL = nodeOrder.reduce(function (s, n) { return s + leftTotal[n]; }, 0) || 1;
    var totalR = nodeOrder.reduce(function (s, n) { return s + rightTotal[n]; }, 0) || 1;
    var plotH = H - 24;
    var usableH = Math.max(1, plotH - gap * (nodeOrder.length - 1));
    var scaleL = usableH / totalL, scaleR = usableH / totalR;
    var yL = {}, cursorL = 0, yR = {}, cursorR = 0;
    nodeOrder.forEach(function (n) { yL[n] = cursorL; cursorL += leftTotal[n] * scaleL + gap; });
    nodeOrder.forEach(function (n) { yR[n] = cursorR; cursorR += rightTotal[n] * scaleR + gap; });
    // Список реальных потоков (count>0), нужен для двух НЕЗАВИСИМЫХ сортировок ниже.
    var flows = [];
    nodeOrder.forEach(function (from) {
      nodeOrder.forEach(function (to) {
        var r = rows.filter(function (x) { return x.from === from && x.to === to; })[0];
        if (r && r.count) flows.push(r);
      });
    });

    // Сортировка ВНУТРИ узла по убыванию (Дима, 2026-09-01: "в рамках одного тарифа тоже
    // от большего к меньшему") -- НЕЗАВИСИМО для левой стороны (исходящие потоки узла) и
    // правой (входящие потоки узла): порядок потоков внутри "13 мес" слева определяется их
    // размером КАК ИСТОЧНИКА, а порядок внутри "13 мес" справа -- их размером КАК
    // НАЗНАЧЕНИЯ, это разные числа для одного и того же (from,to). Два прохода вместо
    // мутирующего офсета, чтобы каждая сторона сортировалась сама по себе.
    var posL = {}, posR = {}; // "from|to" -> {top, bot}
    nodeOrder.forEach(function (from) {
      var outgoing = flows.filter(function (r) { return r.from === from; }).sort(function (a, b) { return b.count - a.count; });
      var cursor = yL[from];
      outgoing.forEach(function (r) {
        // минимум 2px толщины -- иначе мелкие переходы (Дима: "не видно мелкие линии")
        // тонут в линейном масштабе рядом с self-flow X->X (обычно на порядки больше)
        var h = Math.max(2, r.count * scaleL);
        posL[r.from + "|" + r.to] = { top: cursor, bot: cursor + h };
        cursor += h;
      });
    });
    nodeOrder.forEach(function (to) {
      var incoming = flows.filter(function (r) { return r.to === to; }).sort(function (a, b) { return b.count - a.count; });
      var cursor = yR[to];
      incoming.forEach(function (r) {
        var h = Math.max(2, r.count * scaleR);
        posR[r.from + "|" + r.to] = { top: cursor, bot: cursor + h };
        cursor += h;
      });
    });

    // width/height масштабируются zoom'ом, viewBox -- нет: это и есть "увеличить график"
    // (Дима, 2026-09-01), не просто больше пикселей той же плотности.
    var svg = rcSvgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W * zoom, height: H * zoom, class: "chart-svg" });
    flows.forEach(function (r) {
      var key = r.from + "|" + r.to;
      var p1 = posL[key], p2 = posR[key];
      var xm = (x1 + x2) / 2;
      var d = "M " + x1 + " " + p1.top +
        " C " + xm + " " + p1.top + " " + xm + " " + p2.top + " " + x2 + " " + p2.top +
        " L " + x2 + " " + p2.bot +
        " C " + xm + " " + p2.bot + " " + xm + " " + p1.bot + " " + x1 + " " + p1.bot + " Z";
      var path = rcSvgEl("path", { d: d, style: "fill:" + rcColorForTariff(r.from, nodeOrder) + ";opacity:.35;cursor:pointer" });
      rcAttachTooltip(path, function () { return tariffLabelFn(r.from) + " → " + tariffLabelFn(r.to) + ": " + r.count; });
      path.addEventListener("mouseenter", function () { path.style.opacity = ".7"; });
      path.addEventListener("mouseleave", function () { path.style.opacity = ".35"; });
      path.addEventListener("click", function () { onFlowClick(r.from, r.to); });
      svg.appendChild(path);
    });
    nodeOrder.forEach(function (n) {
      var hL = Math.max(1, leftTotal[n] * scaleL), hR = Math.max(1, rightTotal[n] * scaleR);
      var color = rcColorForTariff(n, nodeOrder);
      svg.appendChild(rcSvgEl("rect", { x: x1 - 7, y: yL[n], width: 7, height: hL, style: "fill:" + color }));
      svg.appendChild(rcSvgEl("rect", { x: x2, y: yR[n], width: 7, height: hR, style: "fill:" + color }));
      var lblL = rcSvgEl("text", { x: x1 - 12, y: yL[n] + hL / 2 + 4, "text-anchor": "end", class: "tick-label" });
      lblL.textContent = tariffLabelFn(n); svg.appendChild(lblL);
      var lblR = rcSvgEl("text", { x: x2 + 12, y: yR[n] + hR / 2 + 4, class: "tick-label" });
      lblR.textContent = tariffLabelFn(n); svg.appendChild(lblR);
    });
    return svg;
  }

  // onColumnClick(monthDate) -- клик ЛЮБОЙ точки столбца (не отдельного сегмента).
  // Раньше клик был привязан к конкретному цветному прямоугольнику -- у мелких переходов
  // (Дима, 2026-09-02: "36 месяцев, маленькие значения, невозможно навестись, не видны под
  // основным цветом") высота сегмента могла быть меньше пикселя, физически некликабельна.
  // Теперь весь столбец кликабелен единообразно (невидимый rect на всю высоту plotH, ниже
  // сегментов по z-order -- сегменты рисуются поверх и по-прежнему сами ловят hover-tooltip,
  // но клик по НИМ тоже ведёт на тот же onColumnClick, не на прямой drill сегмента) --
  // вызывающая сторона показывает табличную разбивку по тарифам за месяц, из неё уже клик по
  // строке открывает список клиентов/касс. Min-height 2px на сегменте -- та же техника, что в
  // rcBuildSankey, чтобы мелкие переходы были хоть как-то видны на графике.
  function rcBuildMonthlyFlow(bySourceForTariff, months, nodeOrder, tariffLabelFn, onColumnClick) {
    var colW = 46, padL = 30, padR = 10;
    var W = months.length * colW + padL + padR, H = 96, axisH = 18, plotH = H - axisH;
    var svg = rcSvgEl("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, class: "chart-svg" });
    var maxTotal = 1;
    months.forEach(function (m, i) {
      var sum = 0, b = bySourceForTariff[i];
      Object.keys(b).forEach(function (k) { sum += b[k]; });
      if (sum > maxTotal) maxTotal = sum;
    });
    var yScale = plotH / (maxTotal * 1.1);
    months.forEach(function (m, i) {
      var cx = padL + i * colW, barW = 30, bx = cx + (colW - barW) / 2;
      var hit = rcSvgEl("rect", { x: bx, y: 0, width: barW, height: plotH, style: "fill:transparent;cursor:pointer;pointer-events:all" });
      hit.addEventListener("click", function () { onColumnClick(m); });
      svg.appendChild(hit);
      var cursor = plotH, b = bySourceForTariff[i];
      nodeOrder.forEach(function (destT) {
        var v = b[destT]; if (!v) return;
        var h = Math.max(2, v * yScale);
        var rect = rcSvgEl("rect", { x: bx, y: cursor - h, width: barW, height: h, style: "fill:" + rcColorForTariff(destT, nodeOrder) + ";cursor:pointer" });
        rcAttachTooltip(rect, function () { return tariffLabelFn(destT) + " · " + rcMonthLabel(m) + ": " + v; });
        rect.addEventListener("click", function () { onColumnClick(m); });
        svg.appendChild(rect);
        cursor -= h;
      });
      var lbl = rcSvgEl("text", { x: cx + colW / 2, y: H - 4, class: "tick-label", "text-anchor": "middle" });
      lbl.textContent = rcMonthLabel(m);
      svg.appendChild(lbl);
    });
    return svg;
  }

  WIDGETS["b7-tariff-flow"] = {
    title: "Переток тарифов", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var asOf = ctx.asOf;
      // Только кассы -- юнит-тумблер убран по просьбе Димы (2026-09-01): переход всегда
      // физически привязан к конкретной кассе (цепочка её кодов), клиентский разрез — лишний
      // слой дедупа поверх, не нужен на этом борде (в отличие от Борда 1, где юнит важен).
      var unit = "kassa";
      var tariffs = ctx.M.allTariffsSorted(model); // общий список с Календарём (Дима, 2026-09-01)
      var rows = ctx.M.computeTariffTransitions(model, unit, asOf, RC_FLOW_ONLY_ACTIVE);
      var monthly = ctx.M.computeTariffTransitionsMonthly(model, asOf, unit, RC_FLOW_ONLY_ACTIVE, tariffs);

      var volume = {};
      rows.forEach(function (r) { volume[r.from] = (volume[r.from] || 0) + r.count; volume[r.to] = (volume[r.to] || 0) + r.count; });
      var nodeOrder = Object.keys(volume).map(Number).sort(function (a, b) { return volume[b] - volume[a]; });
      if (!nodeOrder.length) nodeOrder = tariffs.slice();
      function tariffLabelFn(m) { return m + " мес"; }

      // viewport "по месяцам" -- дефолт ВЕСЬ диапазон (Дима, 2026-08-31: "почему не с самого
      // начала" -- в отличие от Борда 1, тут по умолчанию ничего не обрезаем, "от" и "до"
      // только чтобы при желании сузить). Общая ось с Бордом 1 (тот же calendarMonthRange).
      var flowVp = RC_FLOW_VIEWPORT.get(instanceId);
      if (!flowVp) { flowVp = { from: 0, to: monthly.months.length - 1 }; RC_FLOW_VIEWPORT.set(instanceId, flowVp); }
      flowVp.from = Math.min(Math.max(flowVp.from, 0), monthly.months.length - 1);
      flowVp.to = Math.min(Math.max(flowVp.to, flowVp.from), monthly.months.length - 1);

      var wrap = el("<div></div>");
      var activeToggleId = "tf-active-" + instanceId;
      var unitRow = el(
        '<div class="threshold-row">' +
        '<span style="color:var(--muted)">Кассы</span>' +
        '<label><input type="radio" name="' + activeToggleId + '" value="all"' + (RC_FLOW_ONLY_ACTIVE ? "" : " checked") + '> все за всё время</label>' +
        '<label><input type="radio" name="' + activeToggleId + '" value="active"' + (RC_FLOW_ONLY_ACTIVE ? " checked" : "") + '> только действующие сейчас</label>' +
        '<span style="color:var(--muted);margin-left:10px">видимый диапазон ("по месяцам")</span>' +
        rcMonthSelectHTML("tf-from", monthly.months, flowVp.from) + ' <span>—</span> ' + rcMonthSelectHTML("tf-to", monthly.months, flowVp.to) +
        '<button type="button" class="refresh-chart-btn tf-full-range">весь период</button>' +
        '</div>'
      );
      unitRow.querySelectorAll('input[name="' + activeToggleId + '"]').forEach(function (r) {
        r.addEventListener("change", function () {
          RC_FLOW_ONLY_ACTIVE = unitRow.querySelector("input:checked").value === "active";
          root.OFDCanvas && root.OFDCanvas.rerenderAll();
        });
      });
      var zoom = RC_SANKEY_ZOOM.get(instanceId) || 1;
      var sankeyBlock = el('<div class="rc-block"></div>');
      sankeyBlock.appendChild(el('<div class="rc-block-title"><b>Общая картина (весь период)</b></div>'));

      // График/Таблица -- переключение вида (Дима, 2026-09-01): таблица даёт точные числа
      // построчно (Тариф до / Тариф после / Сумма), график — общую картину потоков.
      var viewToggleId = "tf-view-" + instanceId;
      var viewToggle = el(
        '<div class="threshold-row" style="margin-top:-4px">' +
        '<label><input type="radio" name="' + viewToggleId + '" value="chart" checked> График</label>' +
        '<label><input type="radio" name="' + viewToggleId + '" value="table"> Таблица</label>' +
        '</div>'
      );
      sankeyBlock.appendChild(viewToggle);

      var chartArea = el("<div></div>");
      var zoomRow = el(
        '<div class="threshold-row" style="margin-top:-4px">' +
        '<span style="color:var(--muted)">Масштаб</span>' +
        RC_ZOOM_LEVELS.map(function (z) { return '<button type="button" class="refresh-chart-btn rc-zoom-btn" data-zoom="' + z + '">' + Math.round(z * 100) + '%</button>'; }).join(" ") +
        '</div>'
      );
      chartArea.appendChild(zoomRow);
      var sankeyWrap = el('<div class="hscroll-chart rc-zoomable"></div>');
      chartArea.appendChild(sankeyWrap);
      chartArea.appendChild(el('<div class="stat-label">Клик по полосе — список клиентов/касс этого перехода за весь период · наведи — точное число</div>'));
      sankeyBlock.appendChild(chartArea);

      var tableArea = el('<div style="display:none"></div>');
      sankeyBlock.appendChild(tableArea);
      // Фастфильтры (Дима, 2026-09-01: "когда переключаем на табличный вид у нас всё летит
      // вразнобой") -- построены ОДИН раз, отдельно от результатов таблицы, иначе выбор
      // фильтра сбрасывался бы при каждой перерисовке.
      var tableFilters = el(
        '<div class="threshold-row">' +
        '<label>Тариф до <select class="tf-filter-from"><option value="">все</option>' +
        tariffs.map(function (t) { return '<option value="' + t + '">' + esc(tariffLabelFn(t)) + '</option>'; }).join("") +
        '</select></label>' +
        '<label>Тариф после <select class="tf-filter-to"><option value="">все</option>' +
        tariffs.map(function (t) { return '<option value="' + t + '">' + esc(tariffLabelFn(t)) + '</option>'; }).join("") +
        '</select></label>' +
        '</div>'
      );
      tableArea.appendChild(tableFilters);
      var tableResultsHolder = el("<div></div>");
      tableArea.appendChild(tableResultsHolder);

      function markActiveZoomBtn() {
        zoomRow.querySelectorAll(".rc-zoom-btn").forEach(function (b) {
          var active = parseFloat(b.dataset.zoom) === zoom;
          b.style.borderColor = active ? "var(--brand)" : "";
          b.style.color = active ? "var(--brand)" : "";
        });
      }
      markActiveZoomBtn();

      var monthlyBlock = el('<div class="rc-block"></div>');
      monthlyBlock.appendChild(el('<div class="rc-block-title"><b>По месяцам — из каждого тарифа Борда 1</b></div>'));
      var monthlyLegend = el('<div class="chart-legend"></div>');
      monthlyLegend.innerHTML = nodeOrder.map(function (t) {
        return '<span class="lg-item"><span class="lg-swatch" style="background:' + rcColorForTariff(t, nodeOrder) + '"></span>' + tariffLabelFn(t) + '</span>';
      }).join("");
      monthlyBlock.appendChild(monthlyLegend);
      var monthlyBlocksHolder = el("<div></div>");
      monthlyBlock.appendChild(monthlyBlocksHolder);
      monthlyBlock.appendChild(el('<div class="stat-label" style="margin-top:6px">Клик по столбцу месяца — разбивка по тарифам ниже (включая мелкие переходы, которые на графике почти не видны) · клик по строке разбивки — список клиентов/касс.</div>'));

      var drillHolder = el('<div style="margin-top:10px"></div>');
      wrap.appendChild(unitRow);
      wrap.appendChild(sankeyBlock);
      wrap.appendChild(monthlyBlock);
      wrap.appendChild(drillHolder);

      function showDrill(fromT, toT, monthDate, caption) {
        var list = ctx.M.tariffTransitionDrill(model, asOf, unit, fromT, toT, monthDate || null, RC_FLOW_ONLY_ACTIVE);
        renderDrillList(drillHolder, list, RC_TRANSITION_COLUMNS_KASSA, caption);
      }

      // Клик по столбцу месяца на "по месяцам" (2026-09-02, Дима) -- вместо клика по
      // конкретному цветному сегменту (мелкие переходы физически некликабельны) сперва
      // показываем ТЕКСТОВУЮ разбивку по всем тарифам-назначениям этого месяца, дальше клик
      // по строке разбивки открывает полный список клиентов/касс (showDrill выше).
      function showMonthlyBreakdown(srcT, monthDate) {
        var idx = rcAsOfIndex(monthly.months, monthDate);
        var b = monthly.bySource[srcT][idx] || {};
        var breakdown = nodeOrder.map(function (destT) { return { destT: destT, v: b[destT] || 0 }; })
          .filter(function (r) { return r.v > 0; })
          .sort(function (a, b) { return b.v - a.v; });
        drillHolder.innerHTML = "";
        drillHolder.appendChild(el('<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px;margin-bottom:6px"><b>Из ' + esc(tariffLabelFn(srcT)) + ' · ' + rcMonthLabel(monthDate) + '</b></div>'));
        if (!breakdown.length) {
          drillHolder.appendChild(el('<div class="stat-label">Нет переходов в этом месяце.</div>'));
          return;
        }
        var body = breakdown.map(function (r) { return [tariffLabelFn(r.destT), r.v]; });
        var table = makeSortableTable([{ label: "Тариф после", num: true }, { label: "Сумма", num: true }], body);
        drillHolder.appendChild(table);
        drillHolder.appendChild(el('<div class="stat-label" style="margin-top:6px">клик по строке — список клиентов/касс этого перехода</div>'));
        // parseInt из текста ячейки, не индекс массива -- makeSortableTable переставляет
        // строки в DOM по клику на заголовок, индекс после ресорта уже не совпадёт с breakdown[i]
        // (та же техника, что и в renderTable() выше).
        table.querySelectorAll("tbody tr").forEach(function (tr) {
          tr.style.cursor = "pointer";
          tr.addEventListener("click", function () {
            var destT = parseInt(tr.children[0].textContent, 10);
            showDrill(srcT, destT, monthDate, tariffLabelFn(srcT) + " → " + tariffLabelFn(destT) + " · " + rcMonthLabel(monthDate));
          });
        });
      }

      function renderSankey() {
        sankeyWrap.innerHTML = "";
        if (!rows.length) {
          sankeyWrap.appendChild(el('<div class="placeholder-body">Пока нет ни одного перехода тарифов в данных.</div>'));
          return;
        }
        sankeyWrap.appendChild(rcBuildSankey(rows, nodeOrder, tariffLabelFn, function (fromT, toT) {
          showDrill(fromT, toT, null, tariffLabelFn(fromT) + " → " + tariffLabelFn(toT) + " · весь период");
        }, zoom));
      }
      renderSankey();
      zoomRow.querySelectorAll(".rc-zoom-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          zoom = parseFloat(btn.dataset.zoom);
          RC_SANKEY_ZOOM.set(instanceId, zoom);
          markActiveZoomBtn();
          renderSankey();
        });
      });

      // Таблица -- плоский список "Тариф до / Тариф после / Сумма" (Дима, 2026-09-01: "36 на
      // 36 - сумма, 36 на 1 - сумма"), не матрица -- проще читать построчно. Клик по строке =
      // тот же drill, что и клик по полосе Sankey.
      function renderTable() {
        tableResultsHolder.innerHTML = "";
        var fFrom = tableFilters.querySelector(".tf-filter-from").value;
        var fTo = tableFilters.querySelector(".tf-filter-to").value;
        var filtered = rows.filter(function (r) {
          if (fFrom && r.from !== parseInt(fFrom, 10)) return false;
          if (fTo && r.to !== parseInt(fTo, 10)) return false;
          return true;
        });
        if (!filtered.length) {
          tableResultsHolder.appendChild(el('<div class="placeholder-body">Нет переходов по этому фильтру.</div>'));
          return;
        }
        var sorted = filtered.slice().sort(function (a, b) { return b.count - a.count; });
        var body = sorted.map(function (r) { return [tariffLabelFn(r.from), tariffLabelFn(r.to), r.count]; });
        // num:true на тарифных колонках -- ОБЯЗАТЕЛЬНО: иначе клик по заголовку сортирует
        // как ТЕКСТ ("1 мес" раньше "36 мес" алфавитно) -- ровно то, что Дима назвал
        // "летит вразнобой" (2026-09-01). parseFloat("36 мес") корректно даёт 36.
        var tableWrap = makeSortableTable(
          [{ label: "Тариф до", num: true }, { label: "Тариф после", num: true }, { label: "Сумма", num: true }],
          body
        );
        tableResultsHolder.appendChild(tableWrap);
        tableResultsHolder.appendChild(el('<div class="stat-label" style="margin-top:6px">найдено ' + fmtNum(filtered.length) + ' · клик по строке — список клиентов/касс этого перехода за весь период</div>'));
        tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
          tr.style.cursor = "pointer";
          tr.addEventListener("click", function () {
            var fromT = parseInt(tr.children[0].textContent, 10);
            var toT = parseInt(tr.children[1].textContent, 10);
            showDrill(fromT, toT, null, tariffLabelFn(fromT) + " → " + tariffLabelFn(toT) + " · весь период");
          });
        });
      }
      tableFilters.addEventListener("change", renderTable);
      tableFilters.addEventListener("input", renderTable);
      viewToggle.querySelectorAll('input[name="' + viewToggleId + '"]').forEach(function (r) {
        r.addEventListener("change", function () {
          var checkedVal = viewToggle.querySelector("input:checked").value;
          chartArea.style.display = checkedVal === "chart" ? "" : "none";
          tableArea.style.display = checkedVal === "table" ? "" : "none";
          if (checkedVal === "table") renderTable();
        });
      });

      function renderMonthlyBlocks() {
        monthlyBlocksHolder.innerHTML = "";
        var visMonths = monthly.months.slice(flowVp.from, flowVp.to + 1);
        tariffs.forEach(function (srcT) {
          var block = el('<div class="rc-block"></div>');
          block.appendChild(el('<div class="rc-block-title">Из ' + esc(tariffLabelFn(srcT)) + '</div>'));
          var chartWrap = el('<div class="hscroll-chart"></div>');
          var visBucket = monthly.bySource[srcT].slice(flowVp.from, flowVp.to + 1);
          chartWrap.appendChild(rcBuildMonthlyFlow(visBucket, visMonths, nodeOrder, tariffLabelFn, function (monthDate) {
            showMonthlyBreakdown(srcT, monthDate);
          }));
          block.appendChild(chartWrap);
          monthlyBlocksHolder.appendChild(block);
        });
        // синхронный скролл -- 3 строки "по месяцам" листаются вместе (та же причина, что
        // на Борде 1: иначе кажется, что у каждого тарифа своя точка отсчёта)
        rcLinkScroll(Array.from(monthlyBlocksHolder.querySelectorAll(".hscroll-chart")));
      }
      renderMonthlyBlocks();

      function syncFlowRangeSelects() {
        unitRow.querySelector(".tf-from").value = String(flowVp.from);
        unitRow.querySelector(".tf-to").value = String(flowVp.to);
      }

      unitRow.querySelector(".tf-from").addEventListener("change", function (e) {
        flowVp.from = parseInt(e.target.value, 10);
        if (flowVp.to < flowVp.from) flowVp.to = flowVp.from;
        syncFlowRangeSelects(); renderMonthlyBlocks();
      });
      unitRow.querySelector(".tf-to").addEventListener("change", function (e) {
        flowVp.to = parseInt(e.target.value, 10);
        if (flowVp.from > flowVp.to) flowVp.from = flowVp.to;
        syncFlowRangeSelects(); renderMonthlyBlocks();
      });
      unitRow.querySelector(".tf-full-range").addEventListener("click", function () {
        flowVp.from = 0; flowVp.to = monthly.months.length - 1;
        syncFlowRangeSelects(); renderMonthlyBlocks();
      });

      return wrap;
    },
  };

  // ---------- B8 "Обмен с 1С" (Дима, 2026-09-04) -- видно только учётной записи u5yhjzlpy,
  // раздел скрыт в index.html/app.js (класс hidden-1c, открывается по /api/whoami).
  //
  // Реальный формат файла (Дима прислал "Сверка_А_Систем_январь_сентябрь_2026.xlsx",
  // 2026-09-05) -- один лист на месяц (имя листа "YYYY-MM"), ОДНА И ТА ЖЕ строка заголовков
  // на каждом: Ключ доступа / ИНН покупателя / Заводской номер ККТ / Начало действия тарифа /
  // Окончание действия тарифа / Количество месяцев / Итоговая сумма / Сумма роялти. Даты --
  // ТЕКСТОВЫЕ строки "YYYY-MM-DD HH:MM:SS" (не Excel date-serial), cellDates их не трогает,
  // парсим вручную (ofd1cParseDate).
  //
  // КЛЮЧЕВОЕ ОГРАНИЧЕНИЕ (проверено на реальных данных обоих файлов, не предположение):
  // "Заводской номер ККТ" в этом файле -- НЕ то же самое, что "РНМ ККТ" в основной выгрузке
  // ОФД. Заводской номер -- номер от завода-изготовителя, РНМ -- регистрационный номер от
  // ФНС при постановке на учёт, это ДВЕ РАЗНЫЕ системы нумерации, в основной выгрузке ОФД
  // заводского номера нет ВООБЩЕ ни в одной колонке. Сопоставить кассу-в-кассу нельзя.
  // Матчим ТОЛЬКО по ИНН клиента (общее поле в обеих системах) -- см. ofd1cMatchClients.
  var OFD1C_STATE = { records: null, fileName: null, sheetsCount: null, headerMismatch: false };
  var OFD1C_REFRESHERS = {}; // instanceId -> function() -- живой пересчёт остальных B8-бордов после загрузки файла (тот же приём, что ccActiveRefreshers у B5)
  function ofd1cBroadcast() { Object.keys(OFD1C_REFRESHERS).forEach(function (k) { OFD1C_REFRESHERS[k](); }); }

  // Результат офлайн-обогащения DaData (scripts/dadata-enrich.js) -- отдельный upload,
  // ТА ЖЕ схема, что "Обмен с 1С": грузится вручную как файл (не автоматически, инструмент
  // zero-backend). records -- Map<ИНН, {org,okved,region,status,director,enrichedAt}>,
  // Map не {} -- 185к+ ключей, Map быстрее на точечных lookup при скоринге по каждому
  // кандидату. Только часть базы обогащена на любой момент времени (обогащение идёт
  // партиями по 9500/день) -- отсутствие записи для ИНН means "ещё не обогащён", не ошибка.
  var OFD1C_DADATA_STATE = { records: null, fileName: null };
  function ofd1cDadataInfo(inn) { return OFD1C_DADATA_STATE.records ? OFD1C_DADATA_STATE.records.get(inn) || null : null; }

  // Чтение+разбор dadata-cache.json + запись в OFD1C_DADATA_STATE + broadcast -- ОБЩАЯ
  // логика (2026-09-17, кнопка "DaData" переехала в топбар, борд b8-1c-dadata-upload
  // больше не грузит файл сам, только показывает). Promise с итоговой сводкой для
  // статус-строки вызывающей стороны (топбар).
  function ofd1cHandleDadataFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var parsed = JSON.parse(e.target.result);
          var map = new Map();
          var withDirector = 0;
          Object.keys(parsed).forEach(function (inn) {
            map.set(inn, parsed[inn]);
            if (parsed[inn] && parsed[inn].director) withDirector++;
          });
          OFD1C_DADATA_STATE = { records: map, fileName: file.name };
          ofd1cBroadcast();
          resolve({ fileName: file.name, count: map.size, withDirector: withDirector });
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error("Не удалось прочитать файл «" + file.name + "»")); };
      reader.readAsText(file);
    });
  }

  function ofd1cEnsureXLSX() {
    if (root.XLSX) return Promise.resolve();
    if (ofd1cEnsureXLSX._p) return ofd1cEnsureXLSX._p;
    ofd1cEnsureXLSX._p = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "js/vendor/xlsx.full.min.js";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Не удалось загрузить библиотеку разбора XLSX")); };
      document.head.appendChild(s);
    });
    return ofd1cEnsureXLSX._p;
  }

  var OFD1C_EXPECTED_HEADER = ["Ключ доступа", "ИНН покупателя", "Заводской номер ККТ", "Начало действия тарифа", "Окончание действия тарифа", "Количество месяцев", "Итоговая сумма", "Сумма роялти"];

  function ofd1cParseDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(String(v).trim().replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }

  // Колонки читаем ПО ПОЗИЦИИ (тот же принцип, что в parser.js для основной выгрузки) --
  // надёжнее к мелким опечаткам в заголовке, чем сопоставление по названию.
  function ofd1cParseWorkbook(wb) {
    var records = [];
    var headerMismatch = false;
    wb.SheetNames.forEach(function (sheetName) {
      var sheet = wb.Sheets[sheetName];
      var arr = root.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
      if (!arr.length) return;
      var header = (arr[0] || []).map(function (h) { return h == null ? "" : String(h).trim(); });
      if (!OFD1C_EXPECTED_HEADER.every(function (h, i) { return header[i] === h; })) headerMismatch = true;
      for (var i = 1; i < arr.length; i++) {
        var r = arr[i];
        if (!r || r.every(function (c) { return c == null || c === ""; })) continue;
        var inn = root.OFDParser.cleanInn(r[1]);
        if (!inn) continue;
        records.push({
          accessKey: r[0] != null ? String(r[0]) : null,
          inn: inn,
          kktSerial: r[2] != null ? String(r[2]).trim() : null,
          tariffStart: ofd1cParseDate(r[3]),
          tariffEnd: ofd1cParseDate(r[4]),
          months: typeof r[5] === "number" ? r[5] : null,
          totalSum: typeof r[6] === "number" ? r[6] : null,
          royaltySum: typeof r[7] === "number" ? r[7] : null,
          sheetName: sheetName,
        });
      }
    });
    return { records: records, headerMismatch: headerMismatch };
  }

  // Группирует записи "Обмен с 1С" по ИНН и подтягивает клиента основной базы (или null,
  // если ИНН не нашёлся -- давно ушедший/несуществующий клиент, опечатка, или основной файл
  // ОФД просто ещё не загружен).
  function ofd1cMatchClients(model) {
    var byInn = new Map();
    OFD1C_STATE.records.forEach(function (rec) {
      var bucket = byInn.get(rec.inn);
      if (!bucket) { bucket = { inn: rec.inn, client: model.clients.get(rec.inn) || null, records: [] }; byInn.set(rec.inn, bucket); }
      bucket.records.push(rec);
    });
    return Array.from(byInn.values());
  }

  function ofd1cReadFileAsWorkbook(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try { resolve(root.XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true })); }
        catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error("Не удалось прочитать файл «" + file.name + "»")); };
      reader.readAsArrayBuffer(file);
    });
  }

  // Разбор + дедуп + запись в OFD1C_STATE + broadcast -- ОБЩАЯ логика, раньше жила только
  // внутри WIDGETS["b8-1c-upload"].render (2026-09-17: кнопка загрузки перенесена в
  // топбар, виджет убран из библиотеки, но функция здесь используется и топбаром, и
  // оставленной ради обратной совместимости регистрацией WIDGETS["b8-1c-upload"] -- один
  // код, не два разных парсера, которые могут разъехаться со временем). Возвращает Promise
  // с итоговой сводкой для статус-строки вызывающей стороны.
  function ofd1cHandleFiles(files) {
    return ofd1cEnsureXLSX().then(function () {
      return Promise.all(files.map(ofd1cReadFileAsWorkbook));
    }).then(function (workbooks) {
      // Дедуп составным ключом ИНН+заводской номер+начало тарифа -- см. HISTORY.md
      // 2026-09-05, "Ключ доступа" для этого не годится (повторяется на разных записях).
      var allRecords = [], headerMismatch = false, sheetsCount = 0;
      var seenKeys = new Set();
      workbooks.forEach(function (wb) {
        var parsed = ofd1cParseWorkbook(wb);
        if (parsed.headerMismatch) headerMismatch = true;
        sheetsCount += wb.SheetNames.length;
        parsed.records.forEach(function (r) {
          var dedupKey = r.inn + "|" + r.kktSerial + "|" + (r.tariffStart ? r.tariffStart.getTime() : "");
          if (seenKeys.has(dedupKey)) return;
          seenKeys.add(dedupKey);
          allRecords.push(r);
        });
      });
      OFD1C_STATE = { records: allRecords, fileName: files.map(function (f) { return f.name; }).join(", "), sheetsCount: sheetsCount, headerMismatch: headerMismatch };
      ofd1cBroadcast();
      return { recordsCount: allRecords.length, sheetsCount: sheetsCount, headerMismatch: headerMismatch, fileNames: OFD1C_STATE.fileName };
    });
  }

  var OFD1C_DADATA_COLUMNS = [
    { label: "ИНН", key: "key" }, { label: "Организация (DaData)", key: "org" },
    { label: "ОКВЭД", key: "okved" }, { label: "Регион", key: "region" }, { label: "Статус", key: "status" },
    { label: "Директор", key: "director" }, { label: "Обогащён", key: "enrichedAtLabel" },
    { label: "Есть в базе ОФД", key: "ofdMatch" },
  ];
  var OFD1C_DADATA_FILTERS = [
    { label: "ИНН", key: "key" }, { label: "Организация", key: "org" },
    { label: "ОКВЭД", key: "okved" }, { label: "Регион", key: "region" },
  ];

  WIDGETS["b8-1c-dadata-upload"] = {
    // Название без "загрузка" -- сама загрузка переехала в кнопку "DaData" в топбаре
    // (2026-09-17), борд теперь ТОЛЬКО показывает данные. ID виджета НЕ трогаем (см. SKILL.md
    // -- смена id ломает чьи-то уже сохранённые раскладки), меняем только заголовок.
    title: "Обогащение DaData — данные", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el('<div></div>');
      function renderBody() {
        wrap.innerHTML = "";
        wrap.appendChild(el('<div class="stat-label" style="margin-bottom:10px">Загрузка — кнопка «DaData» в шапке (генерируется офлайн-скриптом <code>scripts/dadata-enrich.js</code>, обогащение идёт партиями по 9500 ИНН/день — файл на диске обновляется каждый день, загрузи заново кнопкой сверху, чтобы подтянуть свежие данные). Отрасль (борд «Купившие vs контроль») и скоринг для продавцов используют эти данные, если они загружены — без загрузки работают как раньше, просто без отраслевого сигнала.</div>'));
        if (!OFD1C_DADATA_STATE.records || !OFD1C_DADATA_STATE.records.size) {
          wrap.appendChild(el('<div class="placeholder-body">Файл не загружен — нажми «DaData» в шапке.</div>'));
          return;
        }
        var withDirector = 0;
        OFD1C_DADATA_STATE.records.forEach(function (r) { if (r.director) withDirector++; });
        wrap.appendChild(el('<div class="stat-label" style="margin-bottom:8px">' + esc(OFD1C_DADATA_STATE.fileName) + ' — обогащено ИНН: ' + fmtNum(OFD1C_DADATA_STATE.records.size) + ' (с ФИО руководителя: ' + fmtNum(withDirector) + ')</div>'));

        // Строки для таблицы -- ВСЯ информация, которую удалось получить от DaData на
        // каждый ИНН (Дима, 2026-09-17: "табличный массив, вся информация... в полном
        // разрезе"), не только счётчик. "Есть в базе ОФД" -- бонус-сопоставление с
        // основной базой по ИНН (тот же клиент/партнёр, что видит остальной инструмент).
        var rows = [];
        OFD1C_DADATA_STATE.records.forEach(function (r, inn) {
          var client = model.clients.get(inn);
          rows.push({
            key: inn, org: r.org || "—", okved: r.okved || "—", region: r.region || "—",
            status: r.status || "—", director: r.director || "—",
            enrichedAtLabel: r.enrichedAt ? String(r.enrichedAt).slice(0, 10) : "—",
            ofdMatch: client ? (client.org || "да") : "—",
          });
        });
        var tableHolder = el('<div></div>');
        wrap.appendChild(tableHolder);
        renderDrillTable(tableHolder, rows, OFD1C_DADATA_COLUMNS, OFD1C_DADATA_FILTERS, "записей", "Обогащённые ИНН", 300);
        var downloadBtn = el('<button class="refresh-chart-btn" style="margin-top:8px">Скачать весь массив (' + fmtNum(rows.length) + ')</button>');
        downloadBtn.addEventListener("click", function () {
          var exportRows = rows.map(function (item) {
            var out = {};
            OFD1C_DADATA_COLUMNS.forEach(function (c) { out[c.label.replace(/\s+/g, "")] = item[c.key]; });
            return out;
          });
          if (root.OFDExport) root.OFDExport.downloadCSV("Обогащение DaData", exportRows);
        });
        wrap.appendChild(downloadBtn);
      }
      renderBody();
      OFD1C_REFRESHERS[instanceId] = renderBody; // подписка на ofd1cBroadcast -- загрузка теперь СНАРУЖИ (топбар), борд сам не источник события
      return wrap;
    },
    onRemove: function (instanceId) { delete OFD1C_REFRESHERS[instanceId]; },
  };

  WIDGETS["b8-1c-upload"] = {
    title: "Обмен с 1С — загрузка файла", type: "загрузка", scope: "as-of", span: true,
    render: function (model) {
      var wrap = el('<div></div>');
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:10px">Загрузи файл(ы) сверки «Обмен с 1С» (можно сразу несколько — например, за разные периоды; один лист на месяц, колонки: Ключ доступа / ИНН покупателя / Заводской номер ККТ / Начало действия тарифа / Окончание действия тарифа / Количество месяцев / Итоговая сумма / Сумма роялти). Сопоставление с основной базой ОФД — ТОЛЬКО по ИНН: заводского номера ККТ в выгрузке ОФД нет вообще, там своя нумерация (РНМ ККТ, от ФНС) — кассу-в-кассу сопоставить нельзя.</div>'));
      var input = el('<input type="file" accept=".xlsx,.xls" multiple>');
      var status = el('<div class="stat-label" style="margin-top:8px"></div>');
      var preview = el('<div style="margin-top:10px"></div>');
      wrap.appendChild(input);
      wrap.appendChild(status);
      wrap.appendChild(preview);

      function renderPreview() {
        var recs = OFD1C_STATE.records;
        var matched = ofd1cMatchClients(model);
        var matchedCount = matched.filter(function (m) { return m.client; }).length;
        var lines = [];
        lines.push(OFD1C_STATE.fileName + " — листов: " + OFD1C_STATE.sheetsCount + ", записей: " + fmtNum(recs.length) + ", уникальных ИНН: " + fmtNum(matched.length));
        lines.push("Сопоставлено с клиентами ОФД по ИНН: " + fmtNum(matchedCount) + " из " + fmtNum(matched.length) + " (" + (matched.length ? (matchedCount / matched.length * 100).toFixed(1) : "0") + "%)");
        if (OFD1C_STATE.headerMismatch) lines.push("⚠ на части листов заголовки отличаются от ожидаемых — данные всё равно прочитаны по позиции колонок, проверь глазами ниже.");
        status.innerHTML = lines.map(function (l) { return esc(l); }).join("<br>");

        var headers = [
          { label: "ИНН" }, { label: "Заводской номер ККТ" }, { label: "Начало тарифа" },
          { label: "Окончание тарифа" }, { label: "Мес.", num: true }, { label: "Сумма", num: true }, { label: "Найден в ОФД" },
        ];
        var bodyRows = recs.slice(0, 30).map(function (r) {
          var client = model.clients.get(r.inn);
          return [r.inn, r.kktSerial || "—", fmtDate(r.tariffStart), fmtDate(r.tariffEnd), r.months || "—", fmtNum(r.totalSum || 0), client ? (client.org || "да") : "—"];
        });
        preview.innerHTML = "";
        preview.appendChild(el('<div class="stat-label" style="margin:8px 0 4px">Первые ' + bodyRows.length + ' из ' + fmtNum(recs.length) + ' записей:</div>'));
        var scrollWrap = el('<div class="table-scroll"></div>');
        scrollWrap.appendChild(makeSortableTable(headers, bodyRows));
        preview.appendChild(scrollWrap);
      }
      if (OFD1C_STATE.records) renderPreview();

      input.addEventListener("change", function () {
        var files = Array.from(input.files || []);
        if (!files.length) return;
        status.textContent = "Загрузка библиотеки разбора…";
        ofd1cHandleFiles(files).then(function () {
          renderPreview();
        }).catch(function (err) {
          status.textContent = "Ошибка разбора: " + err.message;
        });
      });

      return wrap;
    },
  };

  // ---------- "Прирост базы (Обмен с 1С)" -- та же формула оттока/возврата, что в
  // основном ОФД (Дима, 2026-09-05: "логика должна быть той же, что и по кодам ОФД"), но
  // строится не по кодам ОФД, а по тарифным интервалам обмена с 1С (tariffStart..tariffEnd
  // каждой записи). Сознательно ПАРАЛЛЕЛЬНАЯ копия churnStatusFromEnd/findReturn из
  // metrics.js, не импорт -- те функции завязаны на kassa.intervals/client.kassas, здесь
  // домен другой (интервалы 1С-тарифов клиента целиком, не касс по отдельности); проще
  // отдельная копия с теми же порогами (30/31 день, 90 дней/3 года), чем городить общий
  // интерфейс поверх двух разных моделей данных.
  var OFD1C_CHURN_GRACE_DAYS = 30;
  var OFD1C_REANIM_WINDOW_START_DAYS = 31;
  var OFD1C_RETURN_TAG_MAX_DAYS = 1095;

  // matched (из ofd1cMatchClients, только с client != null) -> добавляет appearance
  // (самое раннее начало тарифа), currentEnd (самое позднее окончание) и intervals
  // (tariffStart/tariffEnd каждой записи, без невалидных).
  function ofd1cClientRecord(m) {
    var intervals = m.records.map(function (r) { return { start: r.tariffStart, end: r.tariffEnd }; }).filter(function (iv) { return iv.start; });
    var starts = intervals.map(function (iv) { return iv.start; });
    var ends = intervals.filter(function (iv) { return iv.end; }).map(function (iv) { return iv.end; });
    return {
      inn: m.inn, client: m.client, records: m.records, intervals: intervals,
      appearance: starts.length ? new Date(Math.min.apply(null, starts.map(function (d) { return d.getTime(); }))) : null,
      currentEnd: ends.length ? new Date(Math.max.apply(null, ends.map(function (d) { return d.getTime(); }))) : null,
    };
  }
  function ofd1cMatchedEntries(model) {
    return ofd1cMatchClients(model).filter(function (m) { return m.client; }).map(ofd1cClientRecord);
  }

  // "Портрет покупателя 1С" (Дима, 2026-09-17) -- две метрики для борда сравнения купивших
  // vs контроль и карточки клиента. Касс на момент покупки 1С -- COUNT касс ОФД клиента с
  // appearance <= первая покупка 1С (client.kassas -- та же коллекция, что уже использует
  // b8-1c-summary для c.kassas.length "сейчас"). Продлений 1С -- COUNT тарифных интервалов
  // в цепочке минус 1 (симметрично формуле "продлений кассы" в основной модели, SKILL.md) --
  // берётся напрямую по m.records (все записи 1С клиента), НЕ по entry.intervals
  // (ofd1cClientRecord отбрасывает записи без start -- здесь специально считаем ВСЕ строки
  // выгрузки, включая с валидным ИНН, но битой датой, иначе продления недосчитываются).
  function ofd1cKassasAtPurchase(client, firstPurchaseDate) {
    if (!firstPurchaseDate) return null;
    return client.kassas.filter(function (k) { return k.appearance && k.appearance <= firstPurchaseDate; }).length;
  }
  function ofd1cRenewalCount(records) {
    return Math.max(0, records.length - 1);
  }

  // ---------- Борд A "Купившие 1С vs контроль" (2026-09-17, фаза 2, часть 1 — данные без
  // UI). Контрольная группа -- СЛУЧАЙНАЯ выборка не-купивших ТОГО ЖЕ РАЗМЕРА, что и
  // купившие, НЕ того же распределения по кассам (см. tmp/plans/2026-09-17 -- если
  // подгонять распределение, график "касс на дату сравнения" обнулится по построению,
  // сама разница в распределении и есть искомый сигнал).
  //
  // Выборка -- Fisher-Yates shuffle на seeded PRNG (mulberry32), НЕ систематическая
  // сортировка по ИНН + шаг (первая версия, снята 2026-09-17 по требованию Димы -- первые
  // цифры ИНН юрлица кодируют регион налоговой, номер выдаётся последовательно, поэтому
  // "каждый N-й по возрастанию ИНН" рискует систематическим перекосом по региону/дате
  // регистрации, не той случайностью, которая нужна для честного сравнения). Seeded, не
  // Math.random() -- тот же seed даёт ту же выборку при повторном прогоне (тест/повторная
  // загрузка того же файла воспроизводимы), просто без всякой связи с порядком ИНН.
  var OFD1C_CONTROL_SEED = 1758066000; // фиксированная дата решения (2026-09-17), не меняем -- смена seed меняет ВСЮ контрольную группу задним числом
  function ofd1cMulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) | 0;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function ofd1cControlGroup(model, buyerInns) {
    var buyerSet = new Set(buyerInns);
    var pool = Array.from(model.clients.keys()).filter(function (inn) { return !buyerSet.has(inn); });
    var targetSize = Math.min(buyerInns.length, pool.length);
    if (targetSize <= 0) return [];
    var rand = ofd1cMulberry32(OFD1C_CONTROL_SEED);
    // Fisher-Yates, частичный -- перемешиваем только столько элементов, сколько нужно взять
    // (targetSize свопов с хвоста), не весь pool целиком -- эквивалентно полному shuffle по
    // распределению, но O(targetSize), не O(pool.length) на больших базах.
    for (var i = 0; i < targetSize; i++) {
      var j = i + Math.floor(rand() * (pool.length - i));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool.slice(0, targetSize).map(function (inn) { return model.clients.get(inn); });
  }

  // Бакеты числа касс -- те же границы, что в макете борда A (1 / 2-3 / 4-10 / 10+).
  // Границы -- ТЕ ЖЕ, что уже использует основной инструмент (computeActiveSnapshot,
  // b1-kassdist: "1"/"2-3"/"4-9"/"10+") -- унифицировано 2026-09-17 по просьбе Димы, чтобы
  // "Число касс на дату сравнения" можно было напрямую сверять с готовой разбивкой
  // b1-kassdist, не пересчитывать вручную с другими границами.
  var OFD1C_KASSA_BUCKETS = [
    { label: "1", test: function (n) { return n === 1; } },
    { label: "2–3", test: function (n) { return n >= 2 && n <= 3; } },
    { label: "4–9", test: function (n) { return n >= 4 && n <= 9; } },
    { label: "10+", test: function (n) { return n > 9; } },
  ];
  function ofd1cKassaBucketLabel(count) {
    for (var i = 0; i < OFD1C_KASSA_BUCKETS.length; i++) if (OFD1C_KASSA_BUCKETS[i].test(count)) return OFD1C_KASSA_BUCKETS[i].label;
    return "0";
  }
  // clients -- массив объектов клиента основной модели (c.kassas.length = "сейчас", та же
  // цифра, что уже показывает b8-1c-summary в колонке "Касс на ОФД" -- НЕ own as-of фильтр,
  // единообразно с существующим виджетом). Возвращает { buckets: [{label,count,clients}],
  // total }.
  function ofd1cKassaDistribution(clients) {
    var byLabel = new Map(OFD1C_KASSA_BUCKETS.map(function (b) { return [b.label, []]; }));
    clients.forEach(function (c) {
      var label = ofd1cKassaBucketLabel(c.kassas.length);
      if (!byLabel.has(label)) byLabel.set(label, []); // "0" -- клиент без касс, крайний случай
      byLabel.get(label).push(c);
    });
    var buckets = OFD1C_KASSA_BUCKETS.map(function (b) { return { label: b.label, clients: byLabel.get(b.label), count: byLabel.get(b.label).length }; });
    return { buckets: buckets, total: clients.length };
  }

  // Вся ДЕЙСТВУЮЩАЯ база ОФД (не выборка) -- Дима, 2026-09-17: "для контрольной группы
  // подхватить непосредственно данные из другого инструмента", вместо случайной выборки
  // того же размера. Тот же критерий "действующий", что уже использует b1-kassdist
  // (computeActiveSnapshot): не физлицо-резерв (c.phys), не в оттоке (M.clientLapsedAt) --
  // НЕ через саму computeActiveSnapshot (та отдаёт только counts, не объекты клиентов,
  // а здесь нужны объекты для drilldown-таблицы по клику).
  function ofd1cActiveOfdClients(model, ctx) {
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      if (ctx.M.clientLapsedAt(c, ctx.asOf)) return;
      out.push(c);
    });
    return out;
  }

  function ofd1cMedian(numbers) {
    var arr = numbers.filter(function (n) { return n != null && !isNaN(n); }).slice().sort(function (a, b) { return a - b; });
    if (!arr.length) return null;
    var mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  // Срок в ОФД до покупки 1С, в месяцах (дробное число). entry -- из ofd1cMatchedEntries
  // (entry.client.appearance = приход в ОФД, entry.appearance = первая покупка 1С).
  function ofd1cTenureMonths(entry) {
    if (!entry.client || !entry.client.appearance || !entry.appearance) return null;
    return (entry.appearance.getTime() - entry.client.appearance.getTime()) / (30.4368 * 86400000);
  }
  var OFD1C_TENURE_BUCKETS = [
    { label: "0–3м", test: function (m) { return m >= 0 && m < 3; } },
    { label: "3–6м", test: function (m) { return m >= 3 && m < 6; } },
    { label: "6–12м", test: function (m) { return m >= 6 && m < 12; } },
    { label: "12м+", test: function (m) { return m >= 12; } },
  ];
  function ofd1cTenureBucketLabel(months) {
    for (var i = 0; i < OFD1C_TENURE_BUCKETS.length; i++) if (OFD1C_TENURE_BUCKETS[i].test(months)) return OFD1C_TENURE_BUCKETS[i].label;
    return null; // отрицательный срок (покупка 1С раньше появления в ОФД -- данные врут) не бакетируется
  }
  function ofd1cTenureDistribution(entries) {
    var byLabel = new Map(OFD1C_TENURE_BUCKETS.map(function (b) { return [b.label, []]; }));
    var excluded = [];
    entries.forEach(function (entry) {
      var months = ofd1cTenureMonths(entry);
      var label = months === null ? null : ofd1cTenureBucketLabel(months);
      if (label === null) { excluded.push(entry); return; }
      byLabel.get(label).push(entry);
    });
    var buckets = OFD1C_TENURE_BUCKETS.map(function (b) { return { label: b.label, entries: byLabel.get(b.label), count: byLabel.get(b.label).length }; });
    return { buckets: buckets, excluded: excluded, total: entries.length - excluded.length };
  }

  // Конверсия в 1С по партнёру -- среди купивших (buyerEntries), группировка по c.partner
  // (партнёр КЛИЕНТА-владельца, та же семантика, что везде в инструменте -- см. SKILL.md
  // "партнёр привязан к кассе ТОЛЬКО через клиента"), знаменатель -- ВСЕ клиенты этого
  // партнёра в основной базе (model.clients), не только сопоставленные с 1С.
  function ofd1cPartnerConversion(model, buyerEntries) {
    var totalByPartner = new Map();
    model.clients.forEach(function (c) {
      var p = c.partner || "—";
      totalByPartner.set(p, (totalByPartner.get(p) || 0) + 1);
    });
    var buyersByPartner = new Map();
    buyerEntries.forEach(function (entry) {
      var p = (entry.client && entry.client.partner) || "—";
      if (!buyersByPartner.has(p)) buyersByPartner.set(p, []);
      buyersByPartner.get(p).push(entry);
    });
    // Проходим по ВСЕМ партнёрам из totalByPartner (не только тем, у кого buyers>0) -- иначе
    // партнёры без единого купившего 1С выпадают из результата целиком, что искажает TVD
    // (2026-09-17, формула эмпирических весов ниже): TVD партнёра как признака требует ПОЛНОЕ
    // распределение по всем партнёрам с обеих сторон, не только "ненулевую" часть. UI (топ-15
    // по buyers) это не ломает -- нулевые естественно уходят в хвост после сортировки.
    var rows = Array.from(totalByPartner.keys()).map(function (p) {
      var entries = buyersByPartner.get(p) || [];
      var total = totalByPartner.get(p);
      return { partner: p, buyers: entries.length, total: total, rate: total > 0 ? entries.length / total : 0, entries: entries };
    });
    // Сортировка по КОЛИЧЕСТВУ купивших клиентов, не по доле (Дима, 2026-09-17) -- доля
    // легко фаворизирует крошечных партнёров (1 из 1 клиента = 100%), количество честнее
    // отражает "кто из партнёров реально продаёт 1С больше всех".
    rows.sort(function (a, b) { return b.buyers - a.buyers; });
    return rows;
  }

  // ---------- Борд C "Скоринг для продавцов" -- формула v3 (2026-09-28, grilling с Димой,
  // план tmp/plans/2026-09-28-okved-board-and-scoring-v3.md). ЗАМЕНЯЕТ v2 (TVD-веса +
  // "совпал с модальной категорией купивших"). Что было не так в v2 (найдено на реальных
  // данных, 1262 покупателя 2025-2026): (1) "самая частая категория у купивших" != "склонная
  // к покупке" -- ОКВЭД 47 (розница) модален у купивших просто потому, что его больше всего
  // в базе, а конверсия у него ×0,78 к средней, при этом медицина 86 (×3,1) и общепит 56
  // (×2,85) баллов не получали; (2) веса по сырому TVD -- у признаков с большим числом
  // категорий половина TVD шум (партнёр: 0,52, из них 0,30 шум); (3) касс у купивших
  // считались "сейчас", после покупки.
  //
  // Как считает v3 (Дима одобрил пошагово, простое объяснение -- в чате 2026-09-28):
  //  1. Купившие = действующие сегодня клиенты из файла сверки 1С; база = вся действующая
  //     база (ofd1cActiveOfdClients). Гибрид дат: признаки "бизнеса" (касс, ОКВЭД, ОПФ,
  //     регион, тариф, динамика касс) -- на сегодня; признаки "момента" (срок в ОФД, рост
  //     касс за 12 мес до покупки, продления) -- на дату ПЕРВОЙ покупки 1С (на сегодня
  //     купивший физически не может быть "новым" -- срок 0-3 мес переворачивался ×6,2 → ×0,35).
  //  2. Индекс категории С ПОПРАВКОЙ НА ПАРТНЁРА (Дима: "отвязаться от партнёра, смотреть
  //     на общие черты клиентов"): ожидаемо = Σ по клиентам категории конверсии их
  //     партнёра, индекс = купили / ожидаемо. Партнёры с базой < 300 -- общий пул "прочие".
  //     Сам партнёр в score НЕ входит (только фильтр "кого можно передать на прозвон").
  //  3. Категории с базой < 300 -- нейтральные (fit 0): там одна случайная покупка
  //     переворачивает индекс.
  //  4. Сила признака = средневзвешенное |индекс − 1| по категориям. Из неё вычитается
  //     медиана "силы" на случайных выборках базы того же размера, что купившие (шум);
  //     сила ≤ p95 шума -- признак выключается. Вес = чистая сила / сумма (все признаки
  //     наравне, без потолков и пометок -- решение Димы).
  //  5. fit кандидата = clamp((индекс его категории − 1) / (макс. индекс признака − 1), 0, 1),
  //     score = round(100 × Σ вес × fit).
  var OFD1C_MIN_CATEGORY_BASE = 300; // категория/партнёр меньше -- "мало данных" (Дима, 2026-09-28)
  var OFD1C_NOISE_ITERATIONS = 200;
  var OFD1C_NOISE_SEED = 1759017600; // 2026-09-28 -- фиксирован, иначе веса "плавают" между рендерами
  var OFD1C_PARTNER_POOL_OTHER = "прочие";
  var DAY_MS = 86400000;
  var MONTH_MS = 30.4368 * DAY_MS;

  // when: "today" -- на asOf у обеих групп; "purchase" -- у купивших на дату первой покупки.
  var OFD1C_SCORE_FEATURES = [
    { key: "kassa", when: "today", reason: "касс", label: "Число касс", desc: "сколько касс у клиента" },
    { key: "growthBefore", when: "purchase", reason: "новых касс за год", label: "Рост касс за 12 мес до покупки", desc: "сколько новых касс клиент открыл за год (у купивших — за год до покупки 1С)" },
    { key: "industry", when: "today", label: "Отрасль (ОКВЭД)", desc: "раздел ОКВЭД из DaData" },
    { key: "tenure", when: "purchase", reason: "срок в ОФД", label: "Срок в ОФД", desc: "сколько клиент с нами (у купивших — на момент покупки 1С)" },
    { key: "opf", when: "today", reason: "юр. форма", label: "Юр. форма", desc: "ООО / ИП / … из DaData" },
    { key: "region", when: "today", reason: "регион", label: "Регион", desc: "регион регистрации из DaData" },
    { key: "renewals", when: "purchase", reason: "продлений", label: "Продления", desc: "сколько раз продлевалась самая «старая» касса (у купивших — на момент покупки)" },
    { key: "dynamics", when: "today", reason: "динамика касс за год", label: "Динамика касс за 12 мес", desc: "действующих касс сегодня минус год назад" },
    { key: "tariff", when: "today", reason: "тариф ОФД", label: "Тариф ОФД", desc: "срок последнего кода ОФД, мес" },
  ];
  var OFD1C_SCORE_FEATURE_KEYS = OFD1C_SCORE_FEATURES.map(function (f) { return f.key; });

  // Раздел ОКВЭД -- первые 2 цифры кода ("47.25.1" -> "47"), полный код слишком гранулярен.
  function ofd1cIndustryBucketLabel(okved) {
    if (!okved) return null;
    var m = String(okved).match(/^(\d{1,2})/);
    return m ? m[1] : null;
  }
  function ofd1cKassaAliveAt(k, d) {
    return k.intervals.some(function (iv) { return iv.start && iv.start <= d && (!iv.end || iv.end >= d); });
  }

  // Все 9 признаков клиента на дату ref (категории-строки, null = нет данных). Кассы --
  // появившиеся до ref (та же единица, что c.kassas.length "сейчас" по всему инструменту).
  function ofd1cClientFeaturesAt(c, ref, dadataInfo) {
    var ks = c.kassas.filter(function (k) { return k.appearance && k.appearance <= ref; });
    if (!ks.length) return null;
    var yearAgo = new Date(ref.getTime() - 365 * DAY_MS);
    var appearance = null, lastCode = null, renewMax = 0, grow = 0, aliveNow = 0, aliveYearAgo = 0;
    ks.forEach(function (k) {
      if (!appearance || k.appearance < appearance) appearance = k.appearance;
      var codes = k.codes.filter(function (r) { return r.activated && r.activated <= ref; });
      renewMax = Math.max(renewMax, codes.length - 1);
      codes.forEach(function (r) { if (!lastCode || r.activated > lastCode.activated) lastCode = r; });
      if (k.appearance > yearAgo) grow++;
      if (ofd1cKassaAliveAt(k, ref)) aliveNow++;
      if (ofd1cKassaAliveAt(k, yearAgo)) aliveYearAgo++;
    });
    var tenureMonths = (ref.getTime() - appearance.getTime()) / MONTH_MS;
    var tariffMonths = lastCode ? (/(\d+)/.exec(lastCode.tariff || "") || [])[1] : null;
    var dyn = aliveNow - aliveYearAgo;
    var info = dadataInfo && !dadataInfo.notFound ? dadataInfo : null;
    return {
      kassa: ofd1cKassaBucketLabel(ks.length),
      growthBefore: grow === 0 ? "0" : grow === 1 ? "1" : "2+",
      industry: info ? ofd1cIndustryBucketLabel(info.okved) : null,
      tenure: ofd1cTenureBucketLabel(tenureMonths),
      opf: info && info.opf ? info.opf : null,
      region: info && info.region ? info.region : null,
      renewals: renewMax >= 3 ? "3+" : String(renewMax),
      dynamics: !aliveYearAgo ? "не было касс год назад" : dyn < 0 ? "сократилось" : dyn === 0 ? "без изменений" : dyn === 1 ? "+1" : "+2 и больше",
      tariff: tariffMonths ? tariffMonths + " мес" : null,
    };
  }

  // Индексы категорий с поправкой на партнёра. rows -- [{pool, f}] вся база; isBuyer(i) --
  // является ли rows[i] купившим. Возвращает {featureKey: {cats: Map(label -> {n, bought,
  // expected, index}), strength, maxIndex}}. Вынесено отдельно -- та же функция считает и
  // настоящую силу, и шум на случайных выборках (через buyerRowIdx).
  function ofd1cPartnerAdjustedIndexes(rows, buyerRowIdx, featureKeys) {
    var poolBase = new Map(), poolBought = new Map();
    rows.forEach(function (r) { poolBase.set(r.pool, (poolBase.get(r.pool) || 0) + 1); });
    buyerRowIdx.forEach(function (i) { var p = rows[i].pool; poolBought.set(p, (poolBought.get(p) || 0) + 1); });
    var poolConv = new Map();
    poolBase.forEach(function (n, p) { poolConv.set(p, (poolBought.get(p) || 0) / n); });
    var out = {};
    featureKeys.forEach(function (key) {
      var cats = new Map();
      rows.forEach(function (r) {
        var v = r.f[key];
        if (v == null) return;
        var c = cats.get(v);
        if (!c) { c = { n: 0, bought: 0, expected: 0, index: null }; cats.set(v, c); }
        c.n++;
        c.expected += poolConv.get(r.pool);
      });
      buyerRowIdx.forEach(function (i) { var v = rows[i].f[key]; if (v != null && cats.has(v)) cats.get(v).bought++; });
      var weighted = 0, total = 0, maxIndex = 0;
      cats.forEach(function (c) {
        if (c.n < OFD1C_MIN_CATEGORY_BASE || c.expected <= 0) return;
        c.index = c.bought / c.expected;
        weighted += c.n * Math.abs(c.index - 1);
        total += c.n;
        if (c.index > maxIndex) maxIndex = c.index;
      });
      out[key] = { cats: cats, strength: total ? weighted / total : 0, maxIndex: maxIndex };
    });
    return out;
  }

  function ofd1cQuantile(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  // Шум: OFD1C_NOISE_ITERATIONS раз берём случайных клиентов базы (столько же, сколько
  // купивших), делаем вид, что это "купившие", и считаем ту же силу. Для скорости индексы
  // считаются через заранее собранные таблицы "категория × пул партнёра" (не проход по
  // всей базе на каждую итерацию).
  function ofd1cNoiseStrengths(rows, sampleSize, featureKeys) {
    var pools = Array.from(new Set(rows.map(function (r) { return r.pool; })));
    var poolIdx = new Map(pools.map(function (p, i) { return [p, i]; }));
    var poolBase = new Array(pools.length).fill(0);
    rows.forEach(function (r) { poolBase[poolIdx.get(r.pool)]++; });
    var tables = {};
    featureKeys.forEach(function (key) {
      var catIdx = new Map(), cross = []; // cross[cat][pool] = n
      rows.forEach(function (r) {
        var v = r.f[key];
        if (v == null) return;
        if (!catIdx.has(v)) { catIdx.set(v, cross.length); cross.push(new Array(pools.length).fill(0)); }
        cross[catIdx.get(v)][poolIdx.get(r.pool)]++;
      });
      var catN = cross.map(function (row) { return row.reduce(function (s, x) { return s + x; }, 0); });
      tables[key] = { catIdx: catIdx, cross: cross, catN: catN };
    });
    var rand = ofd1cMulberry32(OFD1C_NOISE_SEED);
    var samples = {};
    featureKeys.forEach(function (k) { samples[k] = []; });
    for (var it = 0; it < OFD1C_NOISE_ITERATIONS; it++) {
      var poolBought = new Array(pools.length).fill(0);
      var picks = new Array(sampleSize);
      for (var j = 0; j < sampleSize; j++) {
        var r = rows[Math.floor(rand() * rows.length)];
        picks[j] = r;
        poolBought[poolIdx.get(r.pool)]++;
      }
      var poolConv = poolBase.map(function (n, i) { return poolBought[i] / n; });
      featureKeys.forEach(function (key) {
        var t = tables[key];
        var bought = new Array(t.cross.length).fill(0);
        picks.forEach(function (r) { var v = r.f[key]; if (v != null) bought[t.catIdx.get(v)]++; });
        var weighted = 0, total = 0;
        t.cross.forEach(function (row, ci) {
          if (t.catN[ci] < OFD1C_MIN_CATEGORY_BASE) return;
          var expected = 0;
          for (var pi = 0; pi < row.length; pi++) expected += row[pi] * poolConv[pi];
          if (expected <= 0) return;
          weighted += t.catN[ci] * Math.abs(bought[ci] / expected - 1);
          total += t.catN[ci];
        });
        samples[key].push(total ? weighted / total : 0);
      });
    }
    var out = {};
    featureKeys.forEach(function (k) {
      var s = samples[k].slice().sort(function (a, b) { return a - b; });
      out[k] = { median: ofd1cQuantile(s, 0.5), p95: ofd1cQuantile(s, 0.95) };
    });
    return out;
  }

  // Перенормировка весов на подмножество ключей (сумма присутствующих = 1). Используется и
  // для кандидата без значения признака (нет ОКВЭД в DaData и т.п.), и для ручных весов
  // (сохранены до того, как признак включился/выключился).
  function ofd1cNormalizeWeights(weights, keys) {
    var sum = 0;
    keys.forEach(function (k) { sum += weights[k] || 0; });
    var out = {};
    if (sum > 0) { keys.forEach(function (k) { out[k] = (weights[k] || 0) / sum; }); }
    else if (keys.length) { var eq = 1 / keys.length; keys.forEach(function (k) { out[k] = eq; }); }
    return out;
  }

  function ofd1cFitFromIndex(stat, label) {
    if (label == null || !stat) return 0;
    var c = stat.cats.get(label);
    if (!c || c.index == null || stat.maxIndex <= 1) return 0;
    return Math.max(0, Math.min(1, (c.index - 1) / (stat.maxIndex - 1)));
  }

  // Тяжёлая часть (признаки 88к клиентов + шум) -- не зависит от выбранных партнёров и
  // ручных весов, кэшируется на (модель, asOf, файл 1С, файл DaData). Без кэша каждый клик
  // по чекбоксу партнёра пересчитывал бы всю базу.
  var ofd1cScoringCache = null;
  function ofd1cScoringModel(model, ctx) {
    var c0 = ofd1cScoringCache;
    if (c0 && c0.model === model && c0.asOf === ctx.asOf.getTime() && c0.records === OFD1C_STATE.records && c0.dadata === OFD1C_DADATA_STATE.records) return c0.result;

    var entries = ofd1cMatchedEntries(model);
    var purchaseByInn = new Map(entries.filter(function (e) { return e.appearance; }).map(function (e) { return [e.inn, e.appearance]; }));
    var wholeBase = ofd1cActiveOfdClients(model, ctx);
    var partnerOf = function (c) { return c.partner || "—"; };
    var partnerBase = new Map();
    wholeBase.forEach(function (c) { partnerBase.set(partnerOf(c), (partnerBase.get(partnerOf(c)) || 0) + 1); });

    var rows = [], buyerRowIdx = [];
    wholeBase.forEach(function (c) {
      var info = ofd1cDadataInfo(c.key);
      var fToday = ofd1cClientFeaturesAt(c, ctx.asOf, info);
      if (!fToday) return;
      var f = fToday;
      var purchase = purchaseByInn.get(c.key);
      if (purchase) {
        var fPurchase = ofd1cClientFeaturesAt(c, purchase, info);
        if (!fPurchase) return; // покупка раньше первой кассы -- данные врут, не участвует ни как купивший, ни как база
        f = {};
        OFD1C_SCORE_FEATURES.forEach(function (d) { f[d.key] = d.when === "purchase" ? fPurchase[d.key] : fToday[d.key]; });
        buyerRowIdx.push(rows.length);
      }
      var p = partnerOf(c);
      rows.push({ client: c, f: f, fToday: fToday, pool: partnerBase.get(p) >= OFD1C_MIN_CATEGORY_BASE ? p : OFD1C_PARTNER_POOL_OTHER });
    });

    var stats = ofd1cPartnerAdjustedIndexes(rows, buyerRowIdx, OFD1C_SCORE_FEATURE_KEYS);
    var noise = buyerRowIdx.length ? ofd1cNoiseStrengths(rows, buyerRowIdx.length, OFD1C_SCORE_FEATURE_KEYS) : null;
    var featureStats = {}, enabledFeatures = [], netSum = 0;
    OFD1C_SCORE_FEATURE_KEYS.forEach(function (k) {
      var s = stats[k], nz = noise ? noise[k] : { median: 0, p95: 0 };
      var net = Math.max(0, s.strength - nz.median);
      var enabled = buyerRowIdx.length > 0 && s.strength > nz.p95 && net > 0;
      featureStats[k] = { strength: s.strength, noiseMedian: nz.median, noiseP95: nz.p95, net: net, enabled: enabled, cats: s.cats, maxIndex: s.maxIndex };
      if (enabled) { enabledFeatures.push(k); netSum += net; }
    });
    var autoWeights = {};
    OFD1C_SCORE_FEATURE_KEYS.forEach(function (k) { autoWeights[k] = featureStats[k].enabled && netSum > 0 ? featureStats[k].net / netSum : 0; });

    // Потенциальная выручка -- НЕ часть score, отдельная колонка (как в v2): медиана
    // реальной выручки на кассу у купивших (суммы из сверки 1С) × касс кандидата.
    var revenuePerKassaSamples = [];
    entries.forEach(function (e) {
      var sum = e.records.reduce(function (s, r) { return s + (r.totalSum || 0); }, 0);
      var atPurchase = ofd1cKassasAtPurchase(e.client, e.appearance);
      if (sum > 0 && atPurchase) revenuePerKassaSamples.push(sum / atPurchase);
    });

    // Точки соприкосновения -- общий директор с уже купившим (как в v2, отдельная пометка,
    // не вес; ФИО физлица, 152-ФЗ -- см. пометку юриста в HISTORY.md 2026-09-17).
    var buyerDirectorMap = new Map();
    entries.forEach(function (e) {
      var info = ofd1cDadataInfo(e.inn);
      if (info && info.director) {
        if (!buyerDirectorMap.has(info.director)) buyerDirectorMap.set(info.director, new Set());
        buyerDirectorMap.get(info.director).add(e.inn);
      }
    });

    // Гейт по оттоку -- клиенты под риском в ближайшие 30 дней не скорятся (тот же
    // clientsAtRisk, что b1-risk; clientChurnStatus для этого НЕ подходит, см. HISTORY.md).
    var riskyInns = new Set(ctx.M.clientsAtRisk(model, ctx.asOf, ctx.M.daysThresholdFn(ctx.asOf, 30)).map(function (r) { return r.key; }));

    var result = {
      rows: rows, buyerRowIdx: buyerRowIdx, buyerInns: new Set(entries.map(function (e) { return e.inn; })),
      featureStats: featureStats, enabledFeatures: enabledFeatures, autoWeights: autoWeights,
      buyersCount: buyerRowIdx.length, baseCount: rows.length,
      medianRevenuePerKassa: ofd1cMedian(revenuePerKassaSamples),
      buyerDirectorMap: buyerDirectorMap, riskyInns: riskyInns,
    };
    ofd1cScoringCache = { model: model, asOf: ctx.asOf.getTime(), records: OFD1C_STATE.records, dadata: OFD1C_DADATA_STATE.records, result: result };
    return result;
  }

  function ofd1cReasonText(key, label, index) {
    var x = "×" + index.toFixed(2).replace(".", ",");
    var name = key === "industry" ? "отрасль " + label + (OFD1C_OKVED_LABELS[label] ? " (" + OFD1C_OKVED_LABELS[label] + ")" : "") : ofd1cFeatureDef(key).reason + " «" + label + "»";
    return name + " — " + x + " к средней";
  }
  function ofd1cFeatureDef(key) {
    for (var i = 0; i < OFD1C_SCORE_FEATURES.length; i++) if (OFD1C_SCORE_FEATURES[i].key === key) return OFD1C_SCORE_FEATURES[i];
    return { key: key, label: key, reason: key };
  }
  function ofd1cFeatureLabel(key) { return ofd1cFeatureDef(key).label; }

  // buyerInns -- оставлен в сигнатуре для совместимости (купившие берутся из файла сверки
  // внутри ofd1cScoringModel). allowedPartners -- Set имён (null = все, пустой = никого).
  // manualWeights -- ручные веса панели в долях по ключам OFD1C_SCORE_FEATURES, null -- авто.
  function ofd1cScoringCandidates(model, buyerInns, ctx, allowedPartners, manualWeights) {
    var sm = ofd1cScoringModel(model, ctx);
    var activeWeights = sm.autoWeights;
    if (manualWeights) {
      // Ручной ввод не обходит автоотключение признака (сила не выше шума) -- иначе можно
      // накрутить вес статистически пустому признаку.
      var manualSubset = {};
      sm.enabledFeatures.forEach(function (k) { manualSubset[k] = manualWeights[k] || 0; });
      activeWeights = ofd1cNormalizeWeights(manualSubset, sm.enabledFeatures);
    }
    var excluded = new Set(buyerInns);
    var out = [];
    sm.rows.forEach(function (row) {
      var c = row.client, inn = c.key;
      if (sm.buyerInns.has(inn) || excluded.has(inn)) return;
      var partner = c.partner || "—";
      if (allowedPartners && !allowedPartners.has(partner)) return;
      if (sm.riskyInns.has(inn)) return;
      // Без реального совпадения DaData кандидат не рассматривается (Дима, 2026-09-18).
      var info = ofd1cDadataInfo(inn);
      if (!info || info.notFound) return;

      var f = row.fToday; // кандидат -- всё на сегодня (для него "сегодня" и есть момент решения)
      var presentKeys = sm.enabledFeatures.filter(function (k) { return f[k] != null; });
      var w = ofd1cNormalizeWeights(activeWeights, presentKeys);
      var total = 0, contributions = [];
      presentKeys.forEach(function (k) {
        var st = sm.featureStats[k];
        var fit = ofd1cFitFromIndex(st, f[k]);
        total += w[k] * fit;
        if (fit > 0) contributions.push({ key: k, part: w[k] * fit, label: f[k], index: st.cats.get(f[k]).index });
      });
      var score = Math.round(100 * total);
      contributions.sort(function (a, b) { return b.part - a.part; });
      var reasons = contributions.slice(0, 3).map(function (x) { return ofd1cReasonText(x.key, x.label, x.index); });

      var affiliated = null;
      if (info.director && sm.buyerDirectorMap.has(info.director)) {
        var withThisDirector = sm.buyerDirectorMap.get(info.director);
        if (!(withThisDirector.size === 1 && withThisDirector.has(inn))) {
          affiliated = Array.from(withThisDirector).join(", ");
          reasons.unshift("⚡ тот же директор (" + info.director + "), что у уже купившего 1С: " + affiliated);
        }
      }
      var tenureNowMonths = c.appearance ? (ctx.asOf.getTime() - c.appearance.getTime()) / MONTH_MS : null;
      out.push({
        key: inn, org: c.org, partner: partner, activeKassas: c.kassas.length, tariff: f.tariff || "—", // c.tariff в модели нет -- тариф последнего кода из признаков (до 2026-09-28 колонка всегда была «—»)
        tenureNowMonths: tenureNowMonths == null ? null : Math.round(tenureNowMonths * 10) / 10,
        score: score, scoreHtml: ofd1cScorePill(score),
        revenuePotential: sm.medianRevenuePerKassa != null ? Math.round(c.kassas.length * sm.medianRevenuePerKassa) : null,
        affiliated: affiliated,
        hasContact: !!(c.kassas.some(function (k) { return k.phone || k.email; })),
        dynamics: f.dynamics,
        reason: reasons.length ? reasons.join("; ") : "черты клиента на уровне средней базы",
      });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return { list: out, autoWeights: sm.autoWeights, enabledFeatures: sm.enabledFeatures, featureStats: sm.featureStats, buyersCount: sm.buyersCount, baseCount: sm.baseCount };
  }

  function ofd1cLapsedAt(entry, atDate) {
    if (!entry.appearance || atDate < entry.appearance) return false;
    for (var i = 0; i < entry.intervals.length; i++) {
      var iv = entry.intervals[i];
      if (iv.start <= atDate && (!iv.end || atDate <= iv.end)) return false;
    }
    return true;
  }
  function ofd1cChurnStatus(entry, asOf) {
    if (!entry.currentEnd) return null;
    var graceDeadline = new Date(entry.currentEnd.getTime() + OFD1C_CHURN_GRACE_DAYS * 86400000);
    var resolveAt = new Date(entry.currentEnd.getTime() + OFD1C_REANIM_WINDOW_START_DAYS * 86400000);
    if (asOf < resolveAt) return "pending";
    return ofd1cLapsedAt(entry, graceDeadline) ? "churned" : "safe";
  }
  function ofd1cFindReturn(intervals) {
    if (intervals.length < 2) return null;
    var sorted = intervals.slice().sort(function (a, b) { return a.start - b.start; });
    var last = sorted[sorted.length - 1];
    var priorMaxEnd = null;
    for (var i = 0; i < sorted.length - 1; i++) {
      var e = sorted[i].end;
      if (e && (priorMaxEnd === null || e > priorMaxEnd)) priorMaxEnd = e;
    }
    if (!priorMaxEnd || last.start <= priorMaxEnd) return null;
    var days = Math.round((last.start - priorMaxEnd) / 86400000);
    if (days > OFD1C_RETURN_TAG_MAX_DAYS) return null;
    return { returnDate: last.start, gapEnd: priorMaxEnd, days: days, tag: days <= 90 ? "вернувшийся" : "возвращённый" };
  }
  function ofd1cBuildMonthRange(periodStart, periodEnd) {
    var months = [];
    var cursor = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    var end = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    while (cursor <= end) { months.push(new Date(cursor)); cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); }
    return months;
  }
  function ofd1cMonthIndexOf(months, date) {
    for (var i = 0; i < months.length; i++) { if (date.getFullYear() === months[i].getFullYear() && date.getMonth() === months[i].getMonth()) return i; }
    return -1;
  }
  function ofd1cInRange(date, start, end) { return date && date >= start && date <= end; }

  function ofd1cComputeChurnGradient(model, periodStart, periodEnd, asOf) {
    var months = ofd1cBuildMonthRange(periodStart, periodEnd);
    var newByMonth = months.map(function () { return 0; });
    var churnByMonth = months.map(function () { return 0; });
    var graceByMonth = months.map(function () { return 0; });
    var forecastByMonth = months.map(function () { return 0; });
    ofd1cMatchedEntries(model).forEach(function (e) {
      if (ofd1cInRange(e.appearance, periodStart, periodEnd)) {
        var ni = ofd1cMonthIndexOf(months, e.appearance);
        if (ni >= 0) newByMonth[ni]++;
      }
      if (!e.currentEnd || !ofd1cInRange(e.currentEnd, periodStart, periodEnd)) return;
      var mi = ofd1cMonthIndexOf(months, e.currentEnd);
      if (mi < 0) return;
      var daysSinceEnd = (asOf - e.currentEnd) / 86400000;
      if (daysSinceEnd < 0) { forecastByMonth[mi]++; }
      else if (daysSinceEnd <= OFD1C_CHURN_GRACE_DAYS) { if (ofd1cLapsedAt(e, asOf)) graceByMonth[mi]++; }
      else { if (ofd1cChurnStatus(e, asOf) === "churned") churnByMonth[mi]++; }
    });
    return { months: months, newByMonth: newByMonth, churnByMonth: churnByMonth, graceByMonth: graceByMonth, forecastByMonth: forecastByMonth };
  }
  function ofd1cComputeReturnedByMonth(model, periodStart, periodEnd) {
    var months = ofd1cBuildMonthRange(periodStart, periodEnd);
    var countByMonth = months.map(function () { return 0; });
    ofd1cMatchedEntries(model).forEach(function (e) {
      var ri = ofd1cFindReturn(e.intervals);
      if (!ri || ri.tag !== "возвращённый" || !ofd1cInRange(ri.returnDate, periodStart, periodEnd)) return;
      var i = ofd1cMonthIndexOf(months, ri.returnDate);
      if (i >= 0) countByMonth[i]++;
    });
    return { months: months, countByMonth: countByMonth };
  }
  // per-gap модель (2026-09-10) -- та же архитектура, что в metrics.js computeGapFlow/
  // computeGapActiveCount (см. HISTORY.md), применена к домену "Обмен с 1С" (единица --
  // ИНН клиента, объединённые интервалы ВСЕХ его записей 1С, аналогично объединению касс
  // клиента в основной модели). Заменяет ofd1cComputeChurnGradient/ofd1cActiveCountsAtMonthEnds
  // ниже (currentEnd-based, ОСТАВЛЕНЫ нетронутыми для отката, просто больше не вызываются
  // из виджета) -- та же ошибка классификации была и тут: entry.currentEnd = максимум по
  // ВСЕМ записям клиента, стирал прошлые разрывы будущими продлениями. Дима предполагал,
  // что тут "ничего сильно не поменяется" -- неверно: код структурно идентичен старой
  // (уже исправленной) основной модели, содержит ТУ ЖЕ уязвимость. Пороги грейса/реанимации
  // (OFD1C_CHURN_GRACE_DAYS=30/OFD1C_REANIM_WINDOW_START_DAYS=31) совпадают с основной
  // моделью -- coverageGaps/isAliveAtWithGrace/mergeIntervals из metrics.js переиспользуются
  // напрямую через root.OFDMetrics, не дублируются.
  function ofd1cCoverage(e) {
    return root.OFDMetrics.mergeIntervals(e.intervals);
  }
  function ofd1cComputeGapFlow(model, periodStart, periodEnd, asOf) {
    var months = ofd1cBuildMonthRange(periodStart, periodEnd);
    var newByMonth = months.map(function () { return 0; });
    var churnByMonth = months.map(function () { return 0; });
    var graceByMonth = months.map(function () { return 0; });
    var returnedByMonth = months.map(function () { return 0; });
    ofd1cMatchedEntries(model).forEach(function (e) {
      var coverage = ofd1cCoverage(e);
      if (!coverage.length || coverage[0].start > asOf) return;
      var ni = ofd1cMonthIndexOf(months, coverage[0].start);
      if (ni >= 0) newByMonth[ni]++;
      var gaps = root.OFDMetrics.coverageGaps(coverage, asOf);
      gaps.forEach(function (g) {
        if (g.status === "churned") {
          var ei = ofd1cMonthIndexOf(months, g.E);
          if (ei >= 0) churnByMonth[ei]++;
          if (g.S) { var si = ofd1cMonthIndexOf(months, g.S); if (si >= 0) returnedByMonth[si]++; }
        } else if (g.status === "pending") {
          var pi = ofd1cMonthIndexOf(months, g.E);
          if (pi >= 0) graceByMonth[pi]++;
        }
      });
    });
    return { months: months, newByMonth: newByMonth, churnByMonth: churnByMonth, graceByMonth: graceByMonth, returnedByMonth: returnedByMonth };
  }
  function ofd1cComputeGapActiveCount(model, atDate, asOf) {
    var n = 0;
    ofd1cMatchedEntries(model).forEach(function (e) {
      var coverage = ofd1cCoverage(e);
      if (!coverage.length) return;
      var gaps = root.OFDMetrics.coverageGaps(coverage, asOf);
      if (root.OFDMetrics.isAliveAtWithGrace(coverage, gaps, atDate)) n++;
    });
    return n;
  }

  function ofd1cActiveCountsAtMonthEnds(model, months, ctx) {
    var entries = ofd1cMatchedEntries(model);
    return months.map(function (m) {
      var monthEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
      var end = monthEnd < ctx.asOf ? monthEnd : ctx.asOf;
      var count = 0;
      entries.forEach(function (e) { if (!ofd1cLapsedAt(e, end)) count++; });
      return count;
    });
  }
  // Раскрытия для вкладок -- ТЕ ЖЕ поля/ключи, что и DEFAULT_DRILL_COLUMNS/CLIENT_CHURN_COLUMNS
  // основного "Прирост базы" (Дима: "все поля должны быть такими же"), плюс отдельная
  // колонка "последний тариф 1С" (Дима, 2026-09-07) -- срок в месяцах САМОЙ ПОЗДНЕЙ по дате
  // начала записи обмена с 1С у этого клиента. Колонки — ниже, OFD1C_DRILL_COLUMNS/
  // OFD1C_CHURN_COLUMNS, отдельные от общих (те используются и главным бордом ОФД).
  function ofd1cLastTariffLabel(entry) {
    var starts = entry.records.filter(function (r) { return r.tariffStart; });
    if (!starts.length) return null;
    var last = starts.reduce(function (a, b) { return b.tariffStart > a.tariffStart ? b : a; });
    return last.months != null ? last.months + " мес" : null;
  }
  function ofd1cClientsNewInMonth(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    ofd1cMatchedEntries(model).forEach(function (e) {
      if (!e.appearance || e.appearance.getFullYear() !== y || e.appearance.getMonth() !== m) return;
      if (asOf && e.appearance > asOf) return; // симметрично clientsNewInMonth в metrics.js
      var c = e.client;
      out.push({ key: e.inn, org: c.org, partner: c.partner, partnerInn: c.partnerInn, activeKassas: c.kassas.length, arrivedAt: e.appearance, leftAt: null, lastTariff: ofd1cLastTariffLabel(e) });
    });
    return out;
  }
  function ofd1cClientsChurnedInMonth(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    ofd1cMatchedEntries(model).forEach(function (e) {
      var end = e.currentEnd;
      if (!end || end.getFullYear() !== y || end.getMonth() !== m) return;
      var daysSinceEnd = (asOf - end) / 86400000;
      if (daysSinceEnd <= OFD1C_CHURN_GRACE_DAYS) return;
      if (ofd1cChurnStatus(e, asOf) !== "churned") return;
      var c = e.client;
      out.push({ key: e.inn, org: c.org, partner: c.partner, partnerInn: c.partnerInn, end: end, activeKassas: c.kassas.length, lastTariff: ofd1cLastTariffLabel(e) });
    });
    return out;
  }
  function ofd1cClientsReturnedInMonth(model, monthDate) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    ofd1cMatchedEntries(model).forEach(function (e) {
      var ri = ofd1cFindReturn(e.intervals);
      if (!ri || ri.tag !== "возвращённый" || ri.returnDate.getFullYear() !== y || ri.returnDate.getMonth() !== m) return;
      var c = e.client;
      out.push({ key: e.inn, org: c.org, partner: c.partner, partnerInn: c.partnerInn, activeKassas: c.kassas.length, arrivedAt: ri.returnDate, leftAt: ri.gapEnd, lastTariff: ofd1cLastTariffLabel(e) });
    });
    return out;
  }
  // per-gap версия для drill-down (2026-09-10) -- см. clientsChurnedInMonthGap в metrics.js,
  // тот же принцип: список ОБЯЗАН соответствовать computeGapFlow.churnByMonth того же месяца.
  function ofd1cClientsChurnedInMonthGap(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    ofd1cMatchedEntries(model).forEach(function (e) {
      var coverage = ofd1cCoverage(e);
      if (!coverage.length) return;
      var gaps = root.OFDMetrics.coverageGaps(coverage, asOf);
      var hit = gaps.find(function (g) { return g.status === "churned" && g.E.getFullYear() === y && g.E.getMonth() === m; });
      if (!hit) return;
      var c = e.client;
      out.push({ key: e.inn, org: c.org, partner: c.partner, partnerInn: c.partnerInn, end: hit.E, activeKassas: c.kassas.length, lastTariff: ofd1cLastTariffLabel(e) });
    });
    return out;
  }
  var OFD1C_DRILL_COLUMNS = DEFAULT_DRILL_COLUMNS.concat([{ label: "Последний тариф 1С", key: "lastTariff" }]);
  var OFD1C_CHURN_COLUMNS = CLIENT_CHURN_COLUMNS.concat([{ label: "Последний тариф 1С", key: "lastTariff" }]);

  // Клик по ИНН в раскрытой таблице вкладок Новые/Отток/Возвращённые (Дима, 2026-09-07) --
  // переиспользуем ту же карточку клиента, что уже есть в "Портрет клиента" (см.
  // ofd1cRenderClientCard ниже и её вызов из WIDGETS["b8-1c-summary"]).
  function ofd1cShowClientCard(model, ctx, inn, container) {
    var bucket = ofd1cMatchClients(model).filter(function (x) { return x.inn === inn; })[0];
    if (!bucket || !bucket.client) { container.innerHTML = ""; return; }
    ofd1cRenderClientCard(container, bucket, ctx);
  }

  // Карточка клиента: таблица касс ОФД (РНМ) + таблица записей обмена с 1С (заводской
  // номер) -- вынесена из "Портрет клиента" (2026-09-07), переиспользуется также по клику
  // на ИНН в "Прирост базы (Обмен с 1С)" (см. ofd1cShowClientCard выше). m = элемент
  // ofd1cMatchClients() с m.client != null (ИНН сопоставлен с основной базой ОФД).
  function ofd1cRenderClientCard(container, m, ctx) {
    var c = m.client;
    container.innerHTML = "";
    container.appendChild(el('<div style="font-size:13px;border-top:2px solid var(--ink);padding-top:10px;margin-top:4px"><b>' + esc(c.org || m.inn) + '</b> · ИНН ' + esc(m.inn) + (c.partner ? ' · партнёр ' + esc(c.partner) : '') + '</div>'));

    // "Портрет покупателя 1С" (2026-09-17, фаза 3) -- 3 поля из борда A/ofd1cKassasAtPurchase/
    // ofd1cRenewalCount. entry -- та же обёртка (ofd1cClientRecord), что использует борд A,
    // считаем здесь заново (дёшево, m -- сырой matched-объект без .appearance).
    var entry = ofd1cClientRecord(m);
    var kassasAtPurchase = ofd1cKassasAtPurchase(c, entry.appearance);
    var renewals = ofd1cRenewalCount(m.records);
    var tenureMonths = ofd1cTenureMonths(entry);
    container.appendChild(el(
      '<div class="kv-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 18px;margin:10px 0 4px;font-size:12.5px">' +
      '<div><div style="color:var(--muted);font-size:11px">Касс на момент покупки 1С</div><div style="font-family:var(--mono)">' + (kassasAtPurchase == null ? "—" : fmtNum(kassasAtPurchase)) + '</div></div>' +
      '<div><div style="color:var(--muted);font-size:11px">Продлений 1С</div><div style="font-family:var(--mono)">' + fmtNum(renewals) + '</div></div>' +
      '<div><div style="color:var(--muted);font-size:11px">Срок до покупки</div><div style="font-family:var(--mono)">' + (tenureMonths == null ? "—" : tenureMonths.toFixed(1) + " мес") + '</div></div>' +
      '</div>'
    ));

    var kassaHeaders = [{ label: "РНМ" }, { label: "Тариф ОФД" }, { label: "Окончание кода ОФД" }, { label: "Статус" }];
    var kassaRows = c.kassas.map(function (k) {
      var alive = ctx.M.isKassaAlive(k, ctx.asOf, ctx.strict);
      var deadline = ctx.M.kassaDeadline(k, ctx.asOf, ctx.strict);
      return [k.rnm, k.tariff || "—", fmtDate(deadline), alive ? "действует" : "истёк"];
    });
    container.appendChild(el('<div class="stat-label" style="margin:8px 0 4px">Кассы на ОФД (' + fmtNum(c.kassas.length) + '):</div>'));
    var kassaScroll = el('<div class="table-scroll"></div>');
    kassaScroll.appendChild(makeSortableTable(kassaHeaders, kassaRows));
    container.appendChild(kassaScroll);

    var ofd1cHeaders = [{ label: "Заводской номер ККТ" }, { label: "Начало обмена 1С" }, { label: "Окончание обмена 1С" }, { label: "Мес.", num: true }];
    var ofd1cRows = m.records.map(function (r) { return [r.kktSerial || "—", fmtDate(r.tariffStart), fmtDate(r.tariffEnd), r.months || "—"]; });
    container.appendChild(el('<div class="stat-label" style="margin:12px 0 4px">Обмен с 1С (' + fmtNum(m.records.length) + ' записей):</div>'));
    var ofd1cScroll = el('<div class="table-scroll"></div>');
    ofd1cScroll.appendChild(makeSortableTable(ofd1cHeaders, ofd1cRows));
    container.appendChild(ofd1cScroll);

    container.appendChild(el('<div class="stat-label" style="margin-top:8px">⚠ Прямого соответствия «эта касса ↔ этот заводской номер» нет — в файле обмена с 1С нет РНМ, а в выгрузке ОФД нет заводского номера, общего идентификатора между системами не существует. Обе таблицы — про одного и того же клиента, но НЕ построчно связаны друг с другом.</div>'));
  }

  WIDGETS["b8-1c-growth"] = {
    title: "Прирост базы (Обмен с 1С)", type: "график", scope: "период", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el('<div></div>');
      function renderBody() {
        wrap.innerHTML = "";
        if (!OFD1C_STATE.records) {
          wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится помесячный прирост клиентов, подключивших обмен с 1С: накопительный эффект, новые/отток/возвращённые, по той же логике, что «Прирост базы» на кодах ОФД.</div>'));
          return;
        }
        // per-gap модель (2026-09-10) -- см. HISTORY.md.
        var series = ofd1cComputeGapFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
        function monthEndClamped(m) {
          var end = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
          return end < ctx.asOf ? end : ctx.asOf;
        }
        var activeByMonth = series.months.map(function (m) { return ofd1cComputeGapActiveCount(model, monthEndClamped(m), ctx.asOf); });
        var boundaryPrev = ofd1cComputeGapActiveCount(model, monthEndClamped(root.OFDMetrics.addMonths(series.months[0], -1)), ctx.asOf);
        var realDeltaByMonth = series.months.map(function (m, i) { return activeByMonth[i] - (i === 0 ? boundaryPrev : activeByMonth[i - 1]); });
        var returnedSeries = null, returnedActiveByMonth = null;

        var ngId = "ofd1cngview-" + Math.random().toString(36).slice(2, 7);
        var tabs = el(
          '<div class="threshold-row" style="margin-bottom:10px">' +
          '<label><input type="radio" name="' + ngId + '" value="cum" checked> Накопительно</label>' +
          '<label><input type="radio" name="' + ngId + '" value="new"> Новые клиенты</label>' +
          '<label><input type="radio" name="' + ngId + '" value="churn"> Отток клиентов</label>' +
          '<label><input type="radio" name="' + ngId + '" value="returned"> Возвращённые клиенты</label>' +
          '</div>'
        );
        var viewHolder = el('<div></div>');
        wrap.appendChild(tabs);
        wrap.appendChild(viewHolder);

        function renderCumView() {
          var cum = [], net = realDeltaByMonth, acc = 0;
          for (var i = 0; i < series.months.length; i++) { acc += net[i]; cum.push(acc); }
          var tooltips = series.months.map(function (m, i) {
            var sign = net[i] > 0 ? "+" : "";
            return MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear() + ": прирост " + sign + fmtNum(net[i]) + " · накопительно " + fmtNum(cum[i]);
          });
          var chart = lineChart(series.months, [{ label: "Накопительно", values: cum, color: "var(--s1)", tooltips: tooltips }], { area: true });
          var v = el("<div></div>");
          v.appendChild(el('<div>' + chart + '</div>'));
          var tableHolder = el('<div style="margin-top:14px"></div>');
          tableHolder.appendChild(gradientFlowTable(series, activeByMonth, "клиентов с обменом 1С", {
            realDeltaByMonth: realDeltaByMonth,
            graceColumn: true,
            returnedByMonth: series.returnedByMonth,
          }));
          v.appendChild(tableHolder);
          return v;
        }

        // onRowClick -- клик по ИНН в раскрытой таблице открывает карточку клиента (та же,
        // что в "Портрет клиента"): кассы ОФД + записи 1С (Дима, 2026-09-07). Одинаково на
        // всех трёх вкладках.
        function onInnClick(inn, cardHolder) { ofd1cShowClientCard(model, ctx, inn, cardHolder); }

        function renderView() {
          var v = tabs.querySelector('input:checked').value;
          viewHolder.innerHTML = "";
          if (v === "cum") {
            viewHolder.appendChild(renderCumView());
          } else if (v === "new") {
            viewHolder.appendChild(monthlyCountBoard(series.months, series.newByMonth, "Новых", "var(--s1)", function (m) { return ofd1cClientsNewInMonth(model, m, ctx.asOf); }, { columns: OFD1C_DRILL_COLUMNS, activeTotalByMonth: activeByMonth, exportTitle: "Прирост базы (Обмен с 1С) — новые клиенты", onRowClick: onInnClick }));
          } else if (v === "churn") {
            viewHolder.appendChild(monthlyCountBoard(series.months, series.churnByMonth, "Отток", "var(--crit)", function (m) { return ofd1cClientsChurnedInMonthGap(model, m, ctx.asOf); }, { columns: OFD1C_CHURN_COLUMNS, activeTotalByMonth: activeByMonth, exportTitle: "Прирост базы (Обмен с 1С) — отток клиентов", onRowClick: onInnClick }));
          } else if (v === "returned") {
            if (!returnedSeries) {
              returnedSeries = ofd1cComputeReturnedByMonth(model, ctx.periodStart, ctx.periodEnd);
              returnedActiveByMonth = ofd1cActiveCountsAtMonthEnds(model, returnedSeries.months, ctx);
            }
            viewHolder.appendChild(monthlyCountBoard(returnedSeries.months, returnedSeries.countByMonth, "Возвращённых", "var(--s2)", function (m) { return ofd1cClientsReturnedInMonth(model, m); }, { columns: OFD1C_DRILL_COLUMNS, activeTotalByMonth: returnedActiveByMonth, exportTitle: "Прирост базы (Обмен с 1С) — возвращённые клиенты", onRowClick: onInnClick }));
          }
        }
        tabs.addEventListener("change", renderView);
        renderView();
      }
      renderBody();
      OFD1C_REFRESHERS[instanceId] = renderBody;
      return wrap;
    },
    onRemove: function (instanceId) { delete OFD1C_REFRESHERS[instanceId]; },
  };

  // ---------- Борд A "Купившие 1С vs контроль" (2026-09-17, фаза 2 часть 2 — UI).
  // Колонки/маппинг строк — та же плоская форма {key,org,partner,partnerInn,activeKassas,...},
  // что везде в 1С-drilldown (см. OFD1C_DRILL_COLUMNS выше, ofd1cClientsNewInMonth и
  // соседи) — переиспользуем renderDrillTable/makeSortableTable НАПРЯМУЮ, не пишем свою
  // таблицу. НЕ клик по самому SVG-бару (barList не даёт хука на конкретный rect без
  // переписывания barList) — по СТРОКЕ списка бакетов под графиком, тот же UX, что уже
  // проверен на "Прирост базы" (monthlyCountBoard: "Клик по строке — список ... за этот
  // месяц"), только по бакету, не по месяцу.
  var OFD1C_PORTRAIT_COLUMNS = [
    { label: "ИНН", key: "key" }, { label: "Наименование", key: "org" },
    { label: "Партнёр", key: "partner" }, { label: "Касс сейчас", key: "activeKassas", num: true },
  ];
  var OFD1C_PORTRAIT_TENURE_COLUMNS = OFD1C_PORTRAIT_COLUMNS.concat([
    { label: "Срок до покупки, мес", key: "tenureMonths", num: true },
    { label: "Первая покупка 1С", key: "firstPurchase", date: true },
  ]);
  var OFD1C_PORTRAIT_FILTERS = [{ label: "ИНН", key: "key" }, { label: "Наименование", key: "org" }, { label: "Партнёр", key: "partner" }];

  function ofd1cClientRow(client) {
    return { key: client.key, org: client.org, partner: client.partner, partnerInn: client.partnerInn, activeKassas: client.kassas.length };
  }
  function ofd1cEntryRow(entry) {
    var row = ofd1cClientRow(entry.client);
    row.key = entry.inn;
    var months = ofd1cTenureMonths(entry);
    row.tenureMonths = months == null ? null : Math.round(months * 10) / 10;
    row.firstPurchase = entry.appearance;
    return row;
  }

  // Общий компонент для всех 4 графиков борда A: столбчатый график сверху + список
  // бакетов (label/count), клик по строке бакета раскрывает под ним таблицу (renderDrillTable)
  // + появляется кнопка "Скачать" именно под ЭТОЙ таблицей (Дима, 2026-09-17: "при нажатии
  // на графики... должен открываться список с этими клиентами... и кнопка Скачать").
  // buckets: [{label, count, rows}], rows — уже готовые плоские объекты (ofd1cClientRow/
  // ofd1cEntryRow), не сырые client/entry — иначе renderDrillTable/makeSortableTable не
  // найдут нужных плоских ключей (см. DEFAULT_DRILL_COLUMNS -- та же плоская форма всюду).
  function ofd1cBucketDrillBoard(buckets, opts) {
    opts = opts || {};
    var columns = opts.columns || OFD1C_PORTRAIT_COLUMNS;
    var entityLabel = opts.entityLabel || "клиентов";
    var exportName = opts.exportName || "Портрет 1С";
    var wrap = el("<div></div>");
    var chartHolder = el("<div></div>");
    var chartRows = buckets.map(function (b) { return { label: b.label, value: b.count }; });
    chartHolder.appendChild(el(barList(chartRows, { color: opts.color, caption: opts.caption })));
    wrap.appendChild(chartHolder);

    var listWrap = el('<div style="margin-top:8px"></div>');
    var expandArea = el('<div style="margin-top:10px"></div>');
    // cardHolder -- ТОЛЬКО когда задан opts.onRowClick (та же схема, что у monthlyCountBoard/
    // "Прирост базы Обмен с 1С" -- см. комментарий там): отдельная область ПОД раскрытой
    // таблицей для карточки конкретного клиента по клику на ИНН, universal-панель, не
    // отдельный борд (см. tmp/plans/2026-09-17, решение по борду B).
    var cardHolder = opts.onRowClick ? el('<div style="margin-top:10px"></div>') : null;
    var downloadBtn = el('<button class="refresh-chart-btn" style="margin-top:8px" disabled>Скачать (выбери строку ниже)</button>');
    var selected = null;

    buckets.forEach(function (b) {
      // b.title (необязательно) -- полная детализация в hover-тултипе, когда b.label
      // сознательно короткий (не переполняет SVG-график/строку, см. 2026-09-17: длинный
      // составной label "партнёр — N клиентов (X% из Y)" ломал вёрстку barList/списка).
      var row = el(
        '<div class="drill-row"' + (b.title ? ' title="' + esc(b.title) + '"' : '') + ' style="cursor:pointer;padding:7px 2px;border-bottom:1px solid var(--line);' +
        'display:flex;justify-content:space-between;gap:10px;font-size:13px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(b.label) + '</span>' +
        '<span style="font-family:var(--mono);flex-shrink:0">' + fmtNum(b.count) + '</span></div>'
      );
      row.addEventListener("click", function () {
        selected = b;
        if (cardHolder) cardHolder.innerHTML = "";
        renderDrillTable(expandArea, b.rows, columns, OFD1C_PORTRAIT_FILTERS, entityLabel, b.label, 300, opts.onRowClick ? function (inn) { opts.onRowClick(inn, cardHolder); } : undefined);
        downloadBtn.disabled = !b.rows.length;
        downloadBtn.textContent = "Скачать «" + b.label + "» (" + fmtNum(b.rows.length) + ")";
      });
      listWrap.appendChild(row);
    });
    wrap.appendChild(listWrap);
    wrap.appendChild(expandArea);
    if (cardHolder) wrap.appendChild(cardHolder);
    downloadBtn.addEventListener("click", function () {
      if (!selected) return;
      var exportRows = selected.rows.map(function (item) {
        var out = {};
        columns.forEach(function (c) {
          var v = item[c.key];
          out[c.label.replace(/\s+/g, "")] = c.date ? (v ? fmtDate(v) : "") : (v == null ? "" : v);
        });
        return out;
      });
      if (root.OFDExport) root.OFDExport.downloadCSV(exportName + " — " + selected.label, exportRows);
    });
    wrap.appendChild(downloadBtn);
    return wrap;
  }

  WIDGETS["b8-1c-portrait-compare"] = {
    title: "Обмен с 1С — купившие vs контроль", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      if (!OFD1C_STATE.records) {
        wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится сравнение купивших 1С с контрольной группой не-купивших.</div>'));
        return wrap;
      }
      var entries = ofd1cMatchedEntries(model);
      if (!entries.length) {
        wrap.appendChild(el('<div class="placeholder-body">Ни один клиент из файла обмена 1С не сопоставился с базой ОФД по ИНН — сравнивать не с чем.</div>'));
        return wrap;
      }
      var buyerInns = entries.map(function (e) { return e.inn; });

      // Клик по ИНН в любой drilldown-таблице ниже -- universal-карточка клиента
      // (ofd1cRenderClientCard), не отдельный борд (решение из беседы 2026-09-17, см.
      // tmp/plans). У купивших есть реальная запись 1С (m.records непустой); у клиента из
      // остальной базы ОФД обмена 1С нет вообще -- карточка всё равно открывается (честно
      // показывает "Обмен с 1С (0 записей)"), просто m синтетический, не из ofd1cMatchClients.
      function openCard(inn, cardHolder) {
        if (!cardHolder) return;
        var client = model.clients.get(inn);
        if (!client) return;
        var matched = ofd1cMatchClients(model).find(function (x) { return x.inn === inn; });
        var m = matched || { inn: inn, client: client, records: [] };
        ofd1cRenderClientCard(cardHolder, m, ctx);
      }

      var buyerClients = entries.map(function (e) { return e.client; });
      var tenureDist = ofd1cTenureDistribution(entries);
      var medianTenure = ofd1cMedian(tenureDist.buckets.reduce(function (acc, b) { return acc.concat(b.entries.map(ofd1cTenureMonths)); }, []));
      var medianRenewals = ofd1cMedian(entries.map(function (e) { return ofd1cRenewalCount(e.records); }));

      // Сводные плитки (были в утверждённом макете, выпали при первой реализации -- Дима,
      // 2026-09-17, вернул как обязательные).
      wrap.appendChild(el(
        '<div class="stat-row" style="margin-bottom:16px">' +
        '<div>' + statBlock(fmtNum(entries.length), "купивших 1С", true) + '</div>' +
        '<div>' + statBlock(medianTenure == null ? "—" : medianTenure.toFixed(1) + " мес", "медианный срок до покупки", true) + '</div>' +
        '<div>' + statBlock(medianRenewals == null ? "—" : fmtNum(medianRenewals), "медиана продлений 1С", true) + '</div>' +
        '</div>'
      ));

      // Общая база для сравнения -- ВСЯ действующая база ОФД (не случайная выборка,
      // 2026-09-17 -- Дима: "подхватить непосредственно данные из другого инструмента"),
      // тот же критерий "действующий", что у b1-kassdist.
      function twoSeriesSection(title, buyerDist, baseDist, baseLabel) {
        var section = el('<div class="chart-card" style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:16px"></div>');
        section.appendChild(el('<div class="stat-label" style="margin-bottom:8px"><b>' + esc(title) + '</b></div>'));
        var cols = el('<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px"></div>');
        var buyerCol = el('<div></div>');
        buyerCol.appendChild(el('<div class="stat-label" style="margin-bottom:4px">Купившие 1С</div>'));
        buyerCol.appendChild(ofd1cBucketDrillBoard(buyerDist.buckets.map(function (b) {
          return { label: b.label + " (" + fmtPct(buyerDist.total ? b.count / buyerDist.total : 0) + ")", count: b.count, rows: b.clients ? b.clients.map(ofd1cClientRow) : b.entries.map(ofd1cEntryRow) };
        }), { color: "var(--s1)", exportName: title + " — купившие 1С", onRowClick: openCard, columns: buyerDist.buckets[0] && buyerDist.buckets[0].entries ? OFD1C_PORTRAIT_TENURE_COLUMNS : OFD1C_PORTRAIT_COLUMNS }));
        var baseCol = el('<div></div>');
        baseCol.appendChild(el('<div class="stat-label" style="margin-bottom:4px">' + esc(baseLabel) + '</div>'));
        baseCol.appendChild(ofd1cBucketDrillBoard(baseDist.buckets.map(function (b) {
          return { label: b.label + " (" + fmtPct(baseDist.total ? b.count / baseDist.total : 0) + ")", count: b.count, rows: b.clients.map(ofd1cClientRow) };
        }), { color: "var(--s2)", exportName: title + " — " + baseLabel, onRowClick: openCard, columns: OFD1C_PORTRAIT_COLUMNS }));
        cols.appendChild(buyerCol);
        cols.appendChild(baseCol);
        section.appendChild(cols);
        return section;
      }

      // График 1 — распределение по кассам, купившие vs вся действующая база ОФД.
      var wholeBase = ofd1cActiveOfdClients(model, ctx);
      wrap.appendChild(twoSeriesSection(
        "Число касс на дату сравнения",
        ofd1cKassaDistribution(buyerClients),
        ofd1cKassaDistribution(wholeBase),
        "Вся действующая база ОФД (" + fmtNum(wholeBase.length) + ")"
      ));

      // График 2 — срок в ОФД до покупки 1С. У остальной базы нет даты покупки 1С (её не
      // существует) -- эта секция ТОЛЬКО у купивших, одна колонка, не двухколоночная форма.
      // tenureDist уже посчитан выше для медианы в сводных плитках, не пересчитываем.
      var tenureSection = el('<div class="chart-card" style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:16px"></div>');
      tenureSection.appendChild(el('<div class="stat-label" style="margin-bottom:8px"><b>Срок в ОФД до покупки 1С</b></div>'));
      if (tenureDist.excluded.length) {
        tenureSection.appendChild(el('<div class="stat-label" style="margin-bottom:6px;color:var(--muted)">' + fmtNum(tenureDist.excluded.length) + ' клиент(ов) исключены из графика — покупка 1С датирована раньше прихода в ОФД (аномалия в данных, не бакетируется).</div>'));
      }
      tenureSection.appendChild(ofd1cBucketDrillBoard(tenureDist.buckets.map(function (b) {
        return { label: b.label, count: b.count, rows: b.entries.map(ofd1cEntryRow) };
      }), { color: "var(--s1)", exportName: "Срок до покупки 1С", onRowClick: openCard, columns: OFD1C_PORTRAIT_TENURE_COLUMNS }));
      wrap.appendChild(tenureSection);

      // График 3 — купившие 1С по партнёру (топ-15 по КОЛИЧЕСТВУ клиентов, не по доле --
      // Дима, 2026-09-17: "на первом месте ИП Остапенко и далее" -- полный список без
      // обрезки доступен через "Скачать"; топ-15 в самом графике -- та же причина, что и
      // с плоским списком партнёров в B5, HISTORY.md 2026-08-19: "плохо, максимально плохо").
      var partnerRows = ofd1cPartnerConversion(model, entries).filter(function (r) { return r.total > 0; }).slice(0, 15);
      var partnerSection = el('<div class="chart-card" style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:16px"></div>');
      partnerSection.appendChild(el('<div class="stat-label" style="margin-bottom:8px"><b>Купившие 1С по партнёру (топ-15 по количеству клиентов)</b></div>'));
      // label -- короткий (только имя партнёра), иначе длинная составная строка ломала
      // вёрстку SVG-графика (текст выходил за пределы viewBox barList, "уезжал" -- Дима,
      // 2026-09-17). Полная детализация (доля/знаменатель) -- в title (hover), не в самом
      // тексте; точные числа всегда доступны в раскрытой таблице по клику и в "Скачать".
      partnerSection.appendChild(ofd1cBucketDrillBoard(partnerRows.map(function (r) {
        return {
          label: r.partner, count: r.buyers, rows: r.entries.map(ofd1cEntryRow),
          title: r.partner + ": " + fmtNum(r.buyers) + " клиент(ов) с 1С из " + fmtNum(r.total) + " всей базы партнёра (" + fmtPct(r.rate) + ")",
        };
      }), { color: "var(--brand)", exportName: "Купившие 1С по партнёру", onRowClick: openCard, columns: OFD1C_PORTRAIT_TENURE_COLUMNS }));
      wrap.appendChild(partnerSection);

      return wrap;
    },
  };

  // Словарь расшифровок ОКВЭД -- двузначный код класса -> краткое название (Дима,
  // 2026-09-18: "под каждым ОКВЭД краткое наименование, за что данный ОКВЭД отвечает").
  // Источник: официальный текст ОК 029-2014 (КДЕС Ред.2), приказ Росстандарта от
  // 31.01.2014 №14-ст (consultant.ru/document/cons_doc_LAW_163320/), сверено кросс-
  // источниками (research-агент, 2026-09-18) -- для UI-подсказки, не юридический
  // документ; отсутствующие в диапазоне 01-99 числа (04,34,40,44,48,54,57,67,76,83,89) --
  // официальные пропуски классификатора, не баг словаря.
  var OFD1C_OKVED_LABELS = {
    "01": "Растениеводство и животноводство, охота", "02": "Лесоводство и лесозаготовки",
    "03": "Рыболовство и рыбоводство", "05": "Добыча угля",
    "06": "Добыча сырой нефти и природного газа", "07": "Добыча металлических руд",
    "08": "Добыча прочих полезных ископаемых", "09": "Услуги в области добычи полезных ископаемых",
    "10": "Производство пищевых продуктов", "11": "Производство напитков",
    "12": "Производство табачных изделий", "13": "Производство текстильных изделий",
    "14": "Производство одежды", "15": "Производство кожи и изделий из кожи",
    "16": "Обработка древесины, изделия из дерева", "17": "Производство бумаги и бумажных изделий",
    "18": "Полиграфическая деятельность, копирование носителей", "19": "Производство кокса и нефтепродуктов",
    "20": "Производство химических веществ и продуктов", "21": "Производство лекарственных средств и материалов",
    "22": "Производство резиновых и пластмассовых изделий", "23": "Производство прочей неметаллической минеральной продукции",
    "24": "Металлургическое производство", "25": "Производство готовых металлических изделий",
    "26": "Производство компьютеров, электроники, оптики", "27": "Производство электрического оборудования",
    "28": "Производство машин и оборудования", "29": "Производство автотранспортных средств, прицепов",
    "30": "Производство прочих транспортных средств", "31": "Производство мебели",
    "32": "Производство прочих готовых изделий", "33": "Ремонт и монтаж машин и оборудования",
    "35": "Электро-, газо-, пароснабжение, кондиционирование воздуха", "36": "Забор, очистка и распределение воды",
    "37": "Сбор и обработка сточных вод", "38": "Сбор, обработка и утилизация отходов",
    "39": "Ликвидация загрязнений, удаление отходов", "41": "Строительство зданий",
    "42": "Строительство инженерных сооружений", "43": "Специализированные строительные работы",
    "45": "Торговля и ремонт автотранспорта, мотоциклов", "46": "Оптовая торговля (кроме автотранспорта)",
    "47": "Розничная торговля (кроме автотранспорта)", "49": "Сухопутный и трубопроводный транспорт",
    "50": "Деятельность водного транспорта", "51": "Деятельность воздушного и космического транспорта",
    "52": "Складское хозяйство, вспомогательная транспортная деятельность", "53": "Почтовая связь и курьерская деятельность",
    "55": "Услуги по временному проживанию (гостиницы)", "56": "Деятельность ресторанов и предприятий питания",
    "58": "Издательская деятельность", "59": "Производство кино-, видеофильмов, звукозапись",
    "60": "Телевизионное и радиовещание", "61": "Деятельность в сфере телекоммуникаций",
    "62": "Разработка ПО, IT-консультации", "63": "Деятельность в области информационных технологий",
    "64": "Финансовые услуги (кроме страхования)", "65": "Страхование и пенсионное обеспечение",
    "66": "Вспомогательная деятельность в финансах и страховании", "68": "Операции с недвижимым имуществом",
    "69": "Деятельность в области права и бухучёта", "70": "Головные офисы, управленческий консалтинг",
    "71": "Архитектура, инженерное проектирование, испытания", "72": "Научные исследования и разработки",
    "73": "Реклама и исследование конъюнктуры рынка", "74": "Прочая профессиональная научно-техническая деятельность",
    "75": "Ветеринарная деятельность", "77": "Аренда и лизинг",
    "78": "Трудоустройство и подбор персонала", "79": "Деятельность туристических агентств",
    "80": "Услуги безопасности и расследований", "81": "Обслуживание зданий и территорий",
    "82": "Административно-хозяйственные услуги для бизнеса", "84": "Госуправление, военная безопасность, соцобеспечение",
    "85": "Образование", "86": "Деятельность в области здравоохранения",
    "87": "Уход с обеспечением проживания", "88": "Социальные услуги без обеспечения проживания",
    "90": "Творческая деятельность, искусство, развлечения", "91": "Деятельность библиотек, архивов, музеев",
    "92": "Организация азартных игр, заключение пари", "93": "Деятельность в области спорта, отдыха",
    "94": "Деятельность общественных организаций", "95": "Ремонт компьютеров и предметов личного пользования",
    "96": "Прочие персональные услуги", "97": "Деятельность домашних хозяйств с наёмными работниками",
    "98": "Недифференцированная деятельность частных домохозяйств", "99": "Деятельность экстерриториальных организаций и органов",
  };

  // ---------- Борд "Отрасль (ОКВЭД)" v3 (Дима, 2026-09-28: "очень неудачное отображение,
  // неудобно сопоставлять купивших и общую базу -- принципиально изменить формат"). Вопрос
  // борда -- "в каких отраслях клиенты покупают 1С чаще среднего". v2 (два барчарта "штук"
  // бок о бок + таблица + drilldown) показывала розницу 47 первой просто потому, что её
  // больше всего в базе, при конверсии ×0,78 к средней. v3 -- ОДНА таблица-рейтинг:
  // база / купили / конверсия / индекс к средней (полоска вокруг ×1) / индекс без влияния
  // партнёра (тот, что использует скоринг). Отрасли с базой < 300 -- свёрнутая группа "мало
  // данных" (одна случайная покупка переворачивает индекс). Данные -- из того же
  // ofd1cScoringModel (кэш), что скоринг: купившие = действующие сегодня, база = вся
  // действующая база, только клиенты с ОКВЭД из DaData.
  var OFD1C_INDUSTRY_BAR_MAX = 4; // правый край полоски = ×4, выше -- упирается в край
  var OFD1C_INDUSTRY_TABLE_MAX_HEIGHT = "620px";

  function ofd1cIndexBar(index) {
    var left = 30, right = 70; // % ширины: слева 0..×1, справа ×1..×MAX
    var fill, color, offset;
    if (index >= 1) {
      fill = Math.min(1, (index - 1) / (OFD1C_INDUSTRY_BAR_MAX - 1)) * right;
      offset = left; color = "var(--good)";
    } else {
      fill = (1 - Math.max(0, index)) * left;
      offset = left - fill; color = "var(--muted)";
    }
    return '<div style="position:relative;min-width:150px;height:12px;background:color-mix(in oklab, var(--line) 55%, transparent);border-radius:6px">' +
      '<div style="position:absolute;left:' + offset.toFixed(1) + '%;width:' + fill.toFixed(1) + '%;top:0;bottom:0;background:' + color + ';border-radius:6px"></div>' +
      '<div style="position:absolute;left:' + left + '%;top:-2px;bottom:-2px;width:2px;background:var(--ink)" title="×1 — средняя"></div>' +
      '<span style="display:none">' + index.toFixed(4) + '</span></div>';
  }
  function ofd1cFmtIndex(x) { return x == null ? "—" : "×" + x.toFixed(2).replace(".", ","); }

  WIDGETS["b8-1c-industry"] = {
    title: "Обмен с 1С — отрасль (ОКВЭД)", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      if (!OFD1C_STATE.records) {
        wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится рейтинг отраслей по конверсии в 1С.</div>'));
        return wrap;
      }
      if (!OFD1C_DADATA_STATE.records) {
        wrap.appendChild(el('<div class="placeholder-body">Загрузи <code>dadata-cache.json</code> (кнопка «DaData» в шапке) — отрасль клиента берётся оттуда.</div>'));
        return wrap;
      }
      var sm = ofd1cScoringModel(model, ctx);
      var stat = sm.featureStats.industry;
      var rowsWithInd = sm.rows.filter(function (r) { return r.fToday.industry != null; });
      var buyerIdxSet = new Set(sm.buyerRowIdx);
      var buyersWithInd = sm.buyerRowIdx.filter(function (i) { return sm.rows[i].fToday.industry != null; }).length;
      if (!buyersWithInd || !rowsWithInd.length) {
        wrap.appendChild(el('<div class="placeholder-body">Нет купивших 1С с отраслью из DaData — сравнивать не с чем.</div>'));
        return wrap;
      }
      var avgConv = buyersWithInd / rowsWithInd.length;
      var byCode = new Map();
      sm.rows.forEach(function (r, i) {
        var code = r.fToday.industry;
        if (code == null) return;
        var g = byCode.get(code);
        if (!g) { g = { code: code, label: OFD1C_OKVED_LABELS[code] || null, base: [], buyers: [] }; byCode.set(code, g); }
        g.base.push(r.client);
        if (buyerIdxSet.has(i)) g.buyers.push(r.client);
      });
      var items = Array.from(byCode.values()).map(function (g) {
        var conv = g.buyers.length / g.base.length;
        var c = stat.cats.get(g.code);
        return { code: g.code, label: g.label, base: g.base, buyers: g.buyers, conv: conv, index: conv / avgConv, adjIndex: c ? c.index : null };
      });
      var reliable = items.filter(function (x) { return x.base.length >= OFD1C_MIN_CATEGORY_BASE; }).sort(function (a, b) { return b.index - a.index; });
      var small = items.filter(function (x) { return x.base.length < OFD1C_MIN_CATEGORY_BASE; }).sort(function (a, b) { return b.base.length - a.base.length; });

      wrap.appendChild(el(
        '<div style="display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;margin-bottom:10px">' +
        '<div><span class="stat-label">Средняя конверсия в 1С</span> <b style="font-size:20px">' + fmtPct(avgConv) + '</b></div>' +
        '<div class="stat-label" style="color:var(--muted)">купили ' + fmtNum(buyersWithInd) + ' из ' + fmtNum(rowsWithInd.length) + ' действующих клиентов с отраслью из DaData</div>' +
        '</div>'
      ));
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:8px;color:var(--muted)">Индекс к средней: ×1 — покупают как все, ×2 — вдвое чаще. «Без влияния партнёра» — тот же индекс, очищенный от того, что отрасль чаще приходит через сильных в 1С партнёров; его использует скоринг. Клик по строке — список клиентов ниже.</div>'));

      var drillHolder = el('<div style="margin-top:12px"></div>');
      var cardHolder = el('<div style="margin-top:10px"></div>');
      function openCard(inn) {
        var client = model.clients.get(inn);
        if (!client) return;
        var matched = ofd1cMatchClients(model).find(function (x) { return x.inn === inn; });
        ofd1cRenderClientCard(cardHolder, matched || { inn: inn, client: client, records: [] }, ctx);
      }
      function renderDrilldown(item) {
        drillHolder.innerHTML = "";
        cardHolder.innerHTML = "";
        drillHolder.appendChild(el('<div class="stat-label" style="margin-bottom:8px"><b>ОКВЭД ' + esc(item.code) + (item.label ? ' — ' + esc(item.label) : '') + '</b> · база ' + fmtNum(item.base.length) + ', купили ' + fmtNum(item.buyers.length) + ', конверсия ' + fmtPct(item.conv) + '</div>'));
        var cols = el('<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px"></div>');
        var buyerSet = new Set(item.buyers);
        [["Купившие 1С", item.buyers], ["Не купившие", item.base.filter(function (c) { return !buyerSet.has(c); })]].forEach(function (pair) {
          var col = el('<div></div>'); // заголовок и счётчик рисует сам renderDrillTable
          var area = el('<div></div>');
          col.appendChild(area);
          renderDrillTable(area, pair[1].map(ofd1cClientRow), OFD1C_PORTRAIT_COLUMNS, OFD1C_PORTRAIT_FILTERS, "клиентов", pair[0], 300, openCard);
          cols.appendChild(col);
        });
        drillHolder.appendChild(cols);
        drillHolder.appendChild(cardHolder);
      }

      var headers = [
        { label: "ОКВЭД / отрасль" }, { label: "База", num: true }, { label: "Купили", num: true },
        { label: "Конверсия", num: true }, { label: "Индекс к средней", num: true },
        { label: "", html: true }, { label: "Без влияния партнёра", num: true },
      ];
      function tableFor(list) {
        var t = makeSortableTable(headers, list.map(function (x) {
          return [x.code + (x.label ? " " + x.label : ""), x.base.length, x.buyers.length, fmtPct(x.conv), ofd1cFmtIndex(x.index), ofd1cIndexBar(x.index), ofd1cFmtIndex(x.adjIndex)];
        }));
        t.querySelectorAll("tbody tr").forEach(function (tr, i) {
          tr.style.cursor = "pointer";
          tr.dataset.code = list[i].code;
          tr.addEventListener("click", function () { renderDrilldown(list[i]); });
        });
        return t;
      }
      // Рейтинг -- главное содержимое борда: общий кап .table-scroll (260px ≈ 5 строк)
      // прятал 24 из 29 отраслей. ~15 строк на экране, остальное -- прокрутка внутри.
      var mainTable = tableFor(reliable);
      mainTable.style.maxHeight = OFD1C_INDUSTRY_TABLE_MAX_HEIGHT;
      mainTable.querySelectorAll("th").forEach(function (th) { th.style.position = "sticky"; th.style.top = "0"; th.style.background = "var(--card-bg)"; th.style.zIndex = "1"; });
      wrap.appendChild(mainTable);
      if (small.length) {
        var details = el('<details class="ofd1c-small-industries" style="margin-top:10px"><summary style="cursor:pointer;color:var(--muted);font-size:12.5px">Мелкие отрасли (база меньше ' + OFD1C_MIN_CATEGORY_BASE + '): ' + fmtNum(small.length) + ' шт. — мало данных, индекс ненадёжен, в скоринге не учитываются</summary></details>');
        var smallTable = tableFor(small);
        smallTable.style.opacity = ".6";
        details.appendChild(smallTable);
        wrap.appendChild(details);
      }
      wrap.appendChild(drillHolder);
      return wrap;
    },
  };

  // ---------- Борд C "Скоринг для продавцов" (2026-09-17, фаза 4). Партнёр-пикер --
  // поиск+чекбоксы (НЕ плоский список ~тысяч партнёров -- тот же урок B5, HISTORY.md
  // 2026-08-19: "плохо, максимально плохо"). Opt-in по умолчанию (пусто -- ни один партнёр
  // не выбран, список кандидатов пуст, пока Дима явно не отметит партнёров) -- Дима,
  // 2026-09-17: "не от всех партнёров можем передавать на прозвон". Persist в localStorage
  // ПО ИМЕНИ партнёра (тот же приём, что CC_OVERRIDE_KEY выше -- переживает новую загрузку
  // файла, пока имя партнёра не меняется).
  var OFD1C_SCORING_PARTNERS_KEY = "ofd1c-scoring-allowed-partners-v1";
  function ofd1cLoadAllowedPartners() {
    try { return new Set(JSON.parse(localStorage.getItem(OFD1C_SCORING_PARTNERS_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function ofd1cSaveAllowedPartners(set) {
    try { localStorage.setItem(OFD1C_SCORING_PARTNERS_KEY, JSON.stringify(Array.from(set))); } catch (e) { /* приватный режим и т.п. -- не критично */ }
  }
  // Score -- цветная пилюля (макет утверждён Димой как визуальный эталон, 2026-09-17:
  // "цифра скора занесена в отдельную форму"), переиспользуем УЖЕ существующий
  // .status-pill (good/warn/crit) -- тот же компонент, что overduePill() выше, не новый
  // самодельный стиль. Сортировка по-прежнему работает: makeSortableTable сортирует по
  // textContent ячейки, у пилюли это просто число.
  function ofd1cScorePill(score) {
    var cls = score >= 70 ? "good" : score >= 40 ? "warn" : "crit";
    return '<span class="status-pill ' + cls + '" style="font-weight:700">' + score + '</span>';
  }
  var OFD1C_SCORING_COLUMNS = [
    { label: "ИНН", key: "key" }, { label: "Клиент", key: "org" }, { label: "Партнёр", key: "partner" },
    { label: "Касс", key: "activeKassas", num: true }, { label: "Тариф ОФД", key: "tariff" },
    { label: "Срок в ОФД, мес", key: "tenureNowMonths", num: true },
    { label: "Score", key: "scoreHtml", num: true, html: true, exportKey: "score" },
    // Потенциальная выручка -- НЕ часть score (формула v2, 2026-09-17), отдельная колонка
    // для сортировки продавцом по ценности, не только по похожести профиля.
    { label: "Потенц. выручка", key: "revenuePotential", num: true },
    { label: "Динамика касс 12 мес", key: "dynamics" },
    { label: "Причина", key: "reason" },
  ];
  var OFD1C_SCORING_FILTERS = [{ label: "ИНН", key: "key" }, { label: "Клиент", key: "org" }, { label: "Партнёр", key: "partner" }];

  // Панель развесовки скоринга (Дима, 2026-09-18): переключатель Авто/Ручной ("Авто" =
  // сброс к TVD-расчёту), список весов с кратким пояснением + цветная рамка по отклонению
  // от TVD-обоснованного значения (стиль — те же токены, что status-pill/score-пилюля).
  // Персистентность -- localStorage, тот же приём, что уже хранит выбор партнёров на этом
  // борде (переживает reload/новую загрузку файла).
  var OFD1C_WEIGHT_MODE_KEY = "ofd1c-scoring-weight-mode-v1"; // "auto" | "manual"
  var OFD1C_MANUAL_WEIGHTS_KEY = "ofd1c-scoring-manual-weights-v2"; // {ключ признака v3: %} -- v2 ключа: набор признаков сменился 2026-09-28, старые ручные веса (с партнёром) не переносим
  // Контроль дрейфа весов (Дима, 2026-09-28: "как часто уточнять правильность весов") --
  // снимок последних принятых авто-весов; сдвиг любого > OFD1C_WEIGHT_DRIFT_PP -- плашка.
  var OFD1C_WEIGHT_SNAPSHOT_KEY = "ofd1c-scoring-weight-snapshot-v1"; // {weights:{k:%}, buyers, asOf}
  var OFD1C_WEIGHT_DRIFT_PP = 5;
  var OFD1C_WEIGHT_DEVIATION_WARN = 5; // п.п. -- порог жёлтого (Дима, 2026-09-18)
  var OFD1C_WEIGHT_DEVIATION_CRIT = 15; // п.п. -- порог красного
  function ofd1cLoadWeightSnapshot() {
    try { var v = JSON.parse(localStorage.getItem(OFD1C_WEIGHT_SNAPSHOT_KEY) || "null"); return v && v.weights ? v : null; } catch (e) { return null; }
  }
  function ofd1cSaveWeightSnapshot(snap) {
    try { localStorage.setItem(OFD1C_WEIGHT_SNAPSHOT_KEY, JSON.stringify(snap)); } catch (e) { /* не критично */ }
  }
  // Доли -> целые проценты с суммой ровно 100 (метод наибольших остатков). Простое
  // Math.round на 9 признаках даёт 99/101 -- и кнопка "Применить" в ручном режиме
  // оказывалась заблокированной сразу после переключения с "Авто".
  function ofd1cRoundPct(weights, keys) {
    var out = {}, rest = [], sum = 0;
    keys.forEach(function (k) { var v = (weights[k] || 0) * 100; out[k] = Math.floor(v); sum += out[k]; rest.push({ k: k, r: v - out[k] }); });
    if (!keys.some(function (k) { return weights[k] > 0; })) return out;
    rest.sort(function (a, b) { return b.r - a.r; });
    for (var i = 0; i < 100 - sum && i < rest.length; i++) out[rest[i].k]++;
    return out;
  }
  // Признаки, чей авто-вес сдвинулся больше порога относительно снимка. Признак, которого
  // нет в снимке, считается как 0 (новый признак с весом > порога тоже заметный сдвиг).
  function ofd1cWeightDrift(autoPct, snapshot) {
    if (!snapshot) return [];
    return OFD1C_SCORE_FEATURE_KEYS.filter(function (k) {
      return Math.abs((autoPct[k] || 0) - (snapshot.weights[k] || 0)) > OFD1C_WEIGHT_DRIFT_PP;
    });
  }
  function ofd1cLoadWeightMode() {
    try { return localStorage.getItem(OFD1C_WEIGHT_MODE_KEY) === "manual" ? "manual" : "auto"; } catch (e) { return "auto"; }
  }
  function ofd1cSaveWeightMode(mode) {
    try { localStorage.setItem(OFD1C_WEIGHT_MODE_KEY, mode); } catch (e) { /* приватный режим и т.п. -- не критично */ }
  }
  function ofd1cLoadManualWeights() {
    try { var v = JSON.parse(localStorage.getItem(OFD1C_MANUAL_WEIGHTS_KEY) || "null"); return v && typeof v === "object" ? v : null; } catch (e) { return null; }
  }
  function ofd1cSaveManualWeights(weightsPct) {
    try { localStorage.setItem(OFD1C_MANUAL_WEIGHTS_KEY, JSON.stringify(weightsPct)); } catch (e) { /* не критично */ }
  }
  function ofd1cWeightDeviationClass(manualPct, autoPct) {
    var diff = Math.abs(manualPct - autoPct);
    if (diff <= OFD1C_WEIGHT_DEVIATION_WARN) return "good";
    if (diff <= OFD1C_WEIGHT_DEVIATION_CRIT) return "warn";
    return "crit";
  }

  // Выгрузка для отдела продаж (Дима, 2026-09-28) -- XLSX с выпадающим списком статуса
  // звонка (CSV выпадающие списки не умеет). Первые 4 статуса -- от Димы, остальные --
  // частые исходы B2B-прозвона, добавлены по его просьбе "накидай сам".
  var OFD1C_CALL_STATUSES = [
    "Не дозвонились", "Купил", "Отказ", "Уже использует др. решение",
    "Перезвонить позже", "Неверный номер", "Не ЛПР — передали контакт",
    "Отправили КП / думает", "Не использует 1С", "Закрывается / прекратил деятельность",
  ];
  // Все телефоны и e-mail клиента -- со ВСЕХ кодов всех касс (Дима: "бери всё, что
  // найдёшь"), без повторов, в порядке от свежих кодов к старым (свежий -- вероятнее живой).
  function ofd1cClientContacts(client) {
    var codes = [];
    client.kassas.forEach(function (k) { k.codes.forEach(function (r) { codes.push(r); }); });
    codes.sort(function (a, b) { return (b.activated || b.created || 0) - (a.activated || a.created || 0); });
    var phones = [], emails = [];
    codes.forEach(function (r) {
      if (r.phone && phones.indexOf(r.phone) === -1) phones.push(r.phone);
      if (r.email && emails.indexOf(r.email.toLowerCase()) === -1) emails.push(r.email.toLowerCase());
    });
    return { phones: phones, emails: emails };
  }
  function ofd1cSalesExportSpec(candidates, model, asOf) {
    return {
      sheetName: "Прозвон 1С",
      headers: ["ИНН", "Наименование клиента", "Касс (действующих)", "Телефон", "E-mail", "Статус звонка"],
      colWidths: [14, 44, 10, 34, 34, 34],
      textCols: [0],
      rows: candidates.map(function (item) {
        var c = model.clients.get(item.key);
        var contacts = ofd1cClientContacts(c);
        var alive = c.kassas.filter(function (k) { return ofd1cKassaAliveAt(k, asOf); }).length;
        return [item.key, item.org || "", alive, contacts.phones.join(", "), contacts.emails.join(", "), ""];
      }),
      listColumn: { index: 5, options: OFD1C_CALL_STATUSES, sheetName: "Статусы" },
    };
  }

  WIDGETS["b8-1c-scoring"] = {
    title: "Обмен с 1С — скоринг для продавцов", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      if (!OFD1C_STATE.records) {
        wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится список НЕ-купивших клиентов, похожих по профилю на тех, кто уже купил.</div>'));
        return wrap;
      }
      var entries = ofd1cMatchedEntries(model);
      if (!entries.length) {
        wrap.appendChild(el('<div class="placeholder-body">Ни один клиент не сопоставлен с обменом 1С — не с кем сравнивать профиль.</div>'));
        return wrap;
      }
      var buyerInns = entries.map(function (e) { return e.inn; });
      var allPartners = Array.from(new Set(Array.from(model.clients.values()).map(function (c) { return c.partner || "—"; }))).sort();
      var allowed = ofd1cLoadAllowedPartners();

      // Индикатор прогресса обогащения (Дима, 2026-09-18) -- кандидаты теперь ТОЛЬКО из
      // обогащённой DaData части базы (фильтр в ofd1cScoringCandidates), список растёт по
      // мере обогащения -- явно не финальный список.
      var enrichedCount = OFD1C_DADATA_STATE.records ? OFD1C_DADATA_STATE.records.size : 0;
      var totalClientsCount = model.clients.size;
      wrap.appendChild(el(
        '<div class="stat-label" style="margin-bottom:10px;color:var(--muted)">Обогащено DaData: ' + fmtNum(enrichedCount) + ' из ' + fmtNum(totalClientsCount) + ' (' + fmtPct(totalClientsCount ? enrichedCount / totalClientsCount : 0) + ') — список кандидатов пополняется ежедневно, без полного совпадения DaData клиент в список не попадает.</div>'
      ));

      var pickerBox = el('<div style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px"></div>');
      pickerBox.appendChild(el('<div class="stat-label" style="margin-bottom:6px"><b>Партнёры, чьих клиентов можно передавать на прозвон</b> — по умолчанию не выбран ни один, список кандидатов ниже пуст, пока не отметишь партнёров.</div>'));
      var searchInput = el('<input type="text" placeholder="поиск партнёра" style="width:220px;padding:5px 8px;border:1px solid var(--line);border-radius:7px;margin-bottom:8px">');
      pickerBox.appendChild(searchInput);
      var bulkRow = el('<div style="margin:4px 0 8px"><button class="refresh-chart-btn" id="ofd1cScoringSelectAll">Отметить все видимые</button> <button class="refresh-chart-btn" id="ofd1cScoringClearAll">Снять все видимые</button></div>');
      pickerBox.appendChild(bulkRow);
      var partnerListHolder = el('<div style="max-height:180px;overflow-y:auto;border-top:1px solid var(--line);padding-top:6px"></div>');
      pickerBox.appendChild(partnerListHolder);
      wrap.appendChild(pickerBox);

      // ---- Панель развесовки ----
      var weightBox = el('<div style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px"></div>');
      weightBox.appendChild(el('<div class="stat-label" style="margin-bottom:4px"><b>Развесовка признаков скоринга</b></div>'));
      var weightInfoRow = el('<div class="stat-label" style="margin-bottom:8px;color:var(--muted)"></div>');
      weightBox.appendChild(weightInfoRow);
      var driftHolder = el('<div></div>');
      weightBox.appendChild(driftHolder);
      var modeRow = el('<div style="margin-bottom:10px;display:flex;gap:8px"></div>');
      var autoBtn = el('<button class="refresh-chart-btn" id="ofd1cWeightModeAuto">Авто</button>');
      var manualBtn = el('<button class="refresh-chart-btn" id="ofd1cWeightModeManual">Ручной</button>');
      modeRow.appendChild(autoBtn);
      modeRow.appendChild(manualBtn);
      weightBox.appendChild(modeRow);
      var weightRowsHolder = el('<div></div>');
      weightBox.appendChild(weightRowsHolder);
      var weightSumRow = el('<div class="stat-label" style="margin-top:8px"></div>');
      weightBox.appendChild(weightSumRow);
      var applyWeightsBtn = el('<button class="refresh-chart-btn" style="margin-top:8px">Применить</button>');
      weightBox.appendChild(applyWeightsBtn);
      wrap.appendChild(weightBox);

      // Score от-до -- доп. фильтр поверх обычных текстовых (Дима, 2026-09-17). Отдельно
      // от .drill-f/renderDrillTable (тот умеет только текстовый substring-фильтр) --
      // фильтруем candidates ЗАРАНЕЕ, до передачи в таблицу, не трогая общий компонент.
      var scoreFromInput = el('<input type="number" placeholder="Score от" min="0" max="100" style="width:100px;padding:5px 8px;border:1px solid var(--line);border-radius:7px">');
      var scoreToInput = el('<input type="number" placeholder="Score до" min="0" max="100" style="width:100px;padding:5px 8px;border:1px solid var(--line);border-radius:7px">');
      var scoreFilterRow = el('<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--muted)">Score диапазон:</span></div>');
      scoreFilterRow.appendChild(scoreFromInput);
      scoreFilterRow.appendChild(scoreToInput);
      // Контакт -- НЕ вес (поле берётся с последнего кода и у купивших могло появиться
      // после покупки -- утечка), только фильтр "можно дозвониться" (план 2026-09-28).
      var contactLabel = el('<label style="display:flex;align-items:center;gap:5px;margin-left:10px;cursor:pointer"><input type="checkbox" class="ofd1c-contact-only"> только с телефоном или e-mail</label>');
      var contactOnlyInput = contactLabel.querySelector("input");
      scoreFilterRow.appendChild(contactLabel);
      wrap.appendChild(scoreFilterRow);

      var candidatesHolder = el('<div></div>');
      wrap.appendChild(candidatesHolder);

      var lastAutoWeights = {};
      var lastEnabledFeatures = [];
      var lastFeatureStats = {};
      var lastBuyersCount = 0;

      // Панель хранит проценты (0-100, то, что видит Дима); ofd1cScoringCandidates ждёт
      // доли (сумма=1) -- конвертация только в этой точке.
      function currentManualWeightsFraction() {
        var saved = ofd1cLoadManualWeights();
        if (!saved) return null;
        var out = {};
        Object.keys(saved).forEach(function (k) { out[k] = (saved[k] || 0) / 100; });
        return out;
      }

      function renderCandidates() {
        candidatesHolder.innerHTML = "";
        var manualActive = ofd1cLoadWeightMode() === "manual" ? currentManualWeightsFraction() : null;
        var result = ofd1cScoringCandidates(model, buyerInns, ctx, allowed, manualActive);
        lastAutoWeights = result.autoWeights;
        lastEnabledFeatures = result.enabledFeatures;
        lastFeatureStats = result.featureStats;
        lastBuyersCount = result.buyersCount;
        var all = result.list;
        var from = scoreFromInput.value === "" ? null : parseFloat(scoreFromInput.value);
        var to = scoreToInput.value === "" ? null : parseFloat(scoreToInput.value);
        var candidates = all.filter(function (c) {
          return (from == null || c.score >= from) && (to == null || c.score <= to) && (!contactOnlyInput.checked || c.hasContact);
        });
        candidatesHolder.appendChild(el('<div class="stat-label" style="margin-bottom:8px">Кандидатов: ' + fmtNum(candidates.length) + (candidates.length !== all.length ? " из " + fmtNum(all.length) + " (сужено фильтрами)" : "") + (allowed.size ? ' · партнёров выбрано: ' + fmtNum(allowed.size) : ' · партнёры не выбраны — список пуст') + '</div>'));
        if (!candidates.length) return;
        var tableArea = el('<div></div>');
        candidatesHolder.appendChild(tableArea);
        renderDrillTable(tableArea, candidates, OFD1C_SCORING_COLUMNS, OFD1C_SCORING_FILTERS, "клиентов", "Кандидаты на допродажу 1С", 500);
        var downloadBtn = el('<button class="refresh-chart-btn" style="margin-top:8px">Скачать список (' + fmtNum(candidates.length) + ')</button>');
        downloadBtn.addEventListener("click", function () {
          var exportRows = candidates.map(function (item) {
            var out = {};
            OFD1C_SCORING_COLUMNS.forEach(function (c) {
              // scoreHtml -- готовая разметка пилюли, в CSV нужно сырое число (c.exportKey).
              var v = c.exportKey ? item[c.exportKey] : item[c.key];
              out[c.label.replace(/\s+/g, "")] = v == null ? "" : v;
            });
            return out;
          });
          if (root.OFDExport) root.OFDExport.downloadCSV("Скоринг для продавцов — Обмен с 1С", exportRows);
        });
        candidatesHolder.appendChild(downloadBtn);
        var salesBtn = el('<button class="refresh-chart-btn ofd1c-sales-export" style="margin-top:8px;margin-left:6px;font-weight:700">Выгрузка для отдела продаж (Excel, ' + fmtNum(candidates.length) + ')</button>');
        salesBtn.addEventListener("click", function () {
          if (!root.OFDExport || !root.OFDExport.downloadXlsx) return;
          root.OFDExport.downloadXlsx("Прозвон 1С " + fmtDate(ctx.asOf), ofd1cSalesExportSpec(candidates, model, ctx.asOf));
        });
        candidatesHolder.appendChild(salesBtn);
      }

      // В "Авто" поля readonly, значения = текущие TVD-веса (%, округлено). В "Ручной" --
      // редактируемые, изначально = сохранённые ручные значения, а при первом заходе (нет
      // сохранённых) = текущие авто-веса, чтобы стартовать от осмысленной точки.
      function renderWeightRows() {
        var mode = ofd1cLoadWeightMode();
        autoBtn.style.cssText = mode === "auto" ? "font-weight:700;border-color:var(--brand)" : "";
        manualBtn.style.cssText = mode === "manual" ? "font-weight:700;border-color:var(--brand)" : "";
        weightRowsHolder.innerHTML = "";
        var autoPct = ofd1cRoundPct(lastAutoWeights, lastEnabledFeatures);
        renderWeightInfo(autoPct);
        var manualSaved = ofd1cLoadManualWeights();
        var inputs = {};
        OFD1C_SCORE_FEATURES.forEach(function (def) {
          var k = def.key, st = lastFeatureStats[k];
          var enabled = lastEnabledFeatures.indexOf(k) !== -1;
          var statLine = st ? "сила " + st.strength.toFixed(3).replace(".", ",") + " · случайный шум " + st.noiseMedian.toFixed(3).replace(".", ",") : "";
          if (!enabled) {
            weightRowsHolder.appendChild(el(
              '<div style="display:flex;align-items:center;gap:10px;padding:5px 0;font-size:12.5px;opacity:.55">' +
              '<div style="flex:1"><b>' + esc(def.label) + '</b><div style="color:var(--muted)">' + esc(def.desc) + ' · выключен: не отличается от случайности' + (statLine ? ' (' + statLine + ')' : '') + '</div></div>' +
              '<span style="width:70px;text-align:center">0</span><span>%</span></div>'
            ));
            return;
          }
          var startVal = mode === "manual" && manualSaved && manualSaved[k] != null ? manualSaved[k] : autoPct[k];
          var row = el(
            '<div style="display:flex;align-items:center;gap:10px;padding:5px 0;font-size:12.5px">' +
            '<div style="flex:1"><b>' + esc(def.label) + '</b><div style="color:var(--muted)">' + esc(def.desc) + (statLine ? ' · ' + statLine : '') + '</div></div>' +
            '<input type="number" min="0" max="100" step="1" style="width:70px;padding:5px 6px;border-radius:8px;font-weight:700;text-align:center" value="' + startVal + '"' + (mode === "auto" ? " disabled" : "") + '>' +
            '<span>%</span></div>'
          );
          var input = row.querySelector("input");
          inputs[k] = input;
          function paintDeviation() {
            if (mode !== "manual") { input.style.border = "1px solid var(--line)"; input.style.background = ""; return; }
            var v = parseFloat(input.value) || 0;
            var cls = ofd1cWeightDeviationClass(v, autoPct[k]);
            var color = cls === "good" ? "var(--good)" : cls === "warn" ? "var(--warn)" : "var(--crit)";
            input.style.border = "2px solid " + color;
            input.style.background = "color-mix(in oklab, " + color + " 14%, transparent)";
          }
          paintDeviation();
          input.addEventListener("input", function () { paintDeviation(); updateSumRow(); });
          weightRowsHolder.appendChild(row);
        });
        weightRowsHolder._inputs = inputs;
        updateSumRow();
      }

      // "Посчитано на N купивших" + плашка дрейфа. Первый расчёт (снимка нет) -- снимок
      // сохраняется молча: сравнивать не с чем.
      function renderWeightInfo(autoPct) {
        var asOfLabel = fmtDate(ctx.asOf);
        weightInfoRow.textContent = "Авто-веса посчитаны на " + fmtNum(lastBuyersCount) + " действующих купивших 1С, дата " + asOfLabel + ". Партнёр в балл не входит — индексы очищены от его влияния.";
        driftHolder.innerHTML = "";
        var snap = ofd1cLoadWeightSnapshot();
        if (!snap) { ofd1cSaveWeightSnapshot({ weights: autoPct, buyers: lastBuyersCount, asOf: asOfLabel }); return; }
        var drifted = ofd1cWeightDrift(autoPct, snap);
        if (!drifted.length) return;
        var list = drifted.map(function (k) { return ofd1cFeatureLabel(k) + ": " + (snap.weights[k] || 0) + "% → " + (autoPct[k] || 0) + "%"; }).join("; ");
        var banner = el('<div class="ofd1c-weight-drift" style="border:1px solid var(--warn);background:color-mix(in oklab, var(--warn) 14%, transparent);border-radius:10px;padding:8px 10px;margin-bottom:10px;font-size:12.5px">' +
          '<b>Веса заметно изменились</b> (больше ' + OFD1C_WEIGHT_DRIFT_PP + ' п.п. с прошлого раза: ' + esc(snap.buyers + " купивших, " + snap.asOf) + '): ' + esc(list) + '. Проверь, не сломались ли данные. ' +
          '<button class="refresh-chart-btn ofd1c-accept-weights" style="margin-left:6px">Принять новые веса</button></div>');
        banner.querySelector(".ofd1c-accept-weights").addEventListener("click", function () {
          ofd1cSaveWeightSnapshot({ weights: autoPct, buyers: lastBuyersCount, asOf: asOfLabel });
          driftHolder.innerHTML = "";
        });
        driftHolder.appendChild(banner);
      }

      function updateSumRow() {
        var mode = ofd1cLoadWeightMode();
        if (mode !== "manual") {
          weightSumRow.innerHTML = "";
          applyWeightsBtn.style.display = "none";
          return;
        }
        applyWeightsBtn.style.display = "";
        var inputs = weightRowsHolder._inputs || {};
        var sum = 0;
        lastEnabledFeatures.forEach(function (k) { sum += parseFloat(inputs[k] && inputs[k].value) || 0; });
        var valid = Math.round(sum) === 100;
        weightSumRow.innerHTML = "";
        weightSumRow.appendChild(el('<span style="font-weight:700;color:' + (valid ? "var(--good)" : "var(--crit)") + '">Сумма: ' + sum.toFixed(0) + '%' + (valid ? "" : " — должно быть 100%") + '</span>'));
        applyWeightsBtn.disabled = !valid;
      }

      autoBtn.addEventListener("click", function () {
        ofd1cSaveWeightMode("auto"); // "Авто" = сброс ручных изменений к TVD-расчёту (Дима, 2026-09-18)
        renderWeightRows();
        renderCandidates();
      });
      manualBtn.addEventListener("click", function () {
        ofd1cSaveWeightMode("manual");
        renderWeightRows();
        renderCandidates();
      });
      applyWeightsBtn.addEventListener("click", function () {
        var inputs = weightRowsHolder._inputs || {};
        var weightsPct = {};
        lastEnabledFeatures.forEach(function (k) { weightsPct[k] = parseFloat(inputs[k] && inputs[k].value) || 0; });
        ofd1cSaveManualWeights(weightsPct);
        renderCandidates();
        renderWeightRows();
      });

      function renderPartnerList() {
        var term = searchInput.value.trim().toLowerCase();
        var visible = term ? allPartners.filter(function (p) { return p.toLowerCase().indexOf(term) !== -1; }) : allPartners;
        partnerListHolder.innerHTML = "";
        visible.forEach(function (p) {
          var row = el(
            '<label style="display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:12.5px;cursor:pointer">' +
            '<input type="checkbox" class="ofd1c-partner-cb"' + (allowed.has(p) ? " checked" : "") + '><span>' + esc(p) + '</span></label>'
          );
          row.querySelector("input").addEventListener("change", function (e) {
            if (e.target.checked) allowed.add(p); else allowed.delete(p);
            ofd1cSaveAllowedPartners(allowed);
            renderCandidates();
          });
          partnerListHolder.appendChild(row);
        });
        bulkRow.querySelector("#ofd1cScoringSelectAll").onclick = function () {
          visible.forEach(function (p) { allowed.add(p); });
          ofd1cSaveAllowedPartners(allowed);
          renderPartnerList();
          renderCandidates();
        };
        bulkRow.querySelector("#ofd1cScoringClearAll").onclick = function () {
          visible.forEach(function (p) { allowed.delete(p); });
          ofd1cSaveAllowedPartners(allowed);
          renderPartnerList();
          renderCandidates();
        };
      }
      searchInput.addEventListener("input", renderPartnerList);
      scoreFromInput.addEventListener("input", renderCandidates);
      scoreToInput.addEventListener("input", renderCandidates);
      contactOnlyInput.addEventListener("change", renderCandidates);

      renderPartnerList();
      renderCandidates(); // сначала -- заполняет lastAutoWeights/lastEnabledFeatures для панели весов
      renderWeightRows();
      return wrap;
    },
  };

  WIDGETS["b8-1c-summary"] = {
    title: "Обмен с 1С — портрет клиента", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el('<div></div>');
      var drillHolder = el('<div style="margin-top:14px"></div>');
      function renderBody() {
        wrap.innerHTML = "";
        drillHolder.innerHTML = "";
        if (!OFD1C_STATE.records) {
          wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится портрет каждого клиента с обменом 1С.</div>'));
          return;
        }
        var matched = ofd1cMatchClients(model);
        var matchedOk = matched.filter(function (m) { return m.client; });
        var unmatchedCount = matched.length - matchedOk.length;
        wrap.appendChild(el('<div class="stat-label" style="margin-bottom:8px">Клиентов с обменом 1С: ' + fmtNum(matched.length) + ' · сопоставлено с ОФД по ИНН: ' + fmtNum(matchedOk.length) +
          (unmatchedCount ? ' · не найдено в ОФД: ' + fmtNum(unmatchedCount) + ' (нет такого ИНН среди загруженных клиентов, либо основной файл ОФД ещё не загружен)' : '') + '</div>'));

        var headers = [
          { label: "ИНН" }, { label: "Клиент" }, { label: "Партнёр" },
          { label: "Первый приход в ОФД" }, { label: "Касс на ОФД", num: true },
          { label: "Заводских номеров 1С", num: true }, { label: "Первая покупка 1С" }, { label: "Действует до" },
        ];
        var bodyRows = matchedOk.map(function (m) {
          var c = m.client;
          var serials = new Set(m.records.map(function (r) { return r.kktSerial; }).filter(Boolean));
          var starts = m.records.map(function (r) { return r.tariffStart; }).filter(Boolean);
          var ends = m.records.map(function (r) { return r.tariffEnd; }).filter(Boolean);
          var firstStart = starts.length ? new Date(Math.min.apply(null, starts.map(function (d) { return d.getTime(); }))) : null;
          var lastEnd = ends.length ? new Date(Math.max.apply(null, ends.map(function (d) { return d.getTime(); }))) : null;
          return [m.inn, c.org || "—", c.partner || "—", fmtDate(c.appearance), c.kassas.length, serials.size, fmtDate(firstStart), fmtDate(lastEnd)];
        });
        var scrollWrap = el('<div class="table-scroll"></div>');
        var tableWrap = makeSortableTable(headers, bodyRows);
        scrollWrap.appendChild(tableWrap);
        wrap.appendChild(scrollWrap);
        wrap.appendChild(el('<div class="stat-label" style="margin-top:8px">Клик по строке — полная карточка клиента (кассы ОФД + записи обмена 1С) ниже. «Заводских номеров 1С» — не привязано к конкретной кассе ОФД, общего идентификатора между системами нет.</div>'));
        wrap.appendChild(drillHolder);

        tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
          tr.style.cursor = "pointer";
          tr.addEventListener("click", function () {
            var inn = tr.children[0].textContent;
            var m = matchedOk.find(function (x) { return x.inn === inn; });
            if (m) renderDrill(m);
          });
        });
      }

      function renderDrill(m) { ofd1cRenderClientCard(drillHolder, m, ctx); }

      renderBody();
      OFD1C_REFRESHERS[instanceId] = renderBody;
      return wrap;
    },
    onRemove: function (instanceId) { delete OFD1C_REFRESHERS[instanceId]; },
  };

  // ---------- "Календарь продлений (Обмен с 1С)" + "Переток тарифов (Обмен с 1С)"
  // (Дима, 2026-09-07) -- копии функциональности b7-renewal-calendar/b7-tariff-flow на
  // данных обмена с 1С вместо основной модели ОФД. Единица "касса" здесь = (ИНН + заводской
  // номер ККТ), подтверждено Димой -- заводские номера сами по себе не гарантированно
  // уникальны между разными клиентами, поэтому клиент -- часть идентичности. Список тарифов
  // -- автоматически из встречающихся значений "Количество месяцев" (как allTariffsSorted в
  // Б7), НЕ жёстко 1/6/12. Пороги оттока/грейса/возврата -- ТЕ ЖЕ, что уже в "Прирост базы
  // (Обмен с 1С)" выше (OFD1C_CHURN_GRACE_DAYS/OFD1C_REANIM_WINDOW_START_DAYS). Как и
  // остальной код раздела -- сознательно ПАРАЛЛЕЛЬНЫЕ копии функций из metrics.js
  // (collectKassaEvents/computeRenewalCalendar/computeTariffTransitions и т.д.), не импорт --
  // те работают на model.kassas (коды ОФД), здесь домен другой (цепочки записей 1С по
  // заводскому номеру). Рендер переиспользует ОБЩИЕ (не завязанные на конкретную модель
  // данных) rc*-хелперы, объявленные перед b7-renewal-calendar (rcBuildCalendarChart,
  // rcCalcCalendarScale, rcBuildSankey, rcBuildMonthlyFlow и т.д.).
  var OFD1C_CALENDAR_FORECAST_MONTHS = 36;
  var OFD1C_RC_UNIT = "kassa";
  var OFD1C_RC_CAL_ONLY_ACTIVE = false;
  var OFD1C_RC_VIEWPORT = new Map();
  var OFD1C_RC_FLOW_VIEWPORT = new Map();
  var OFD1C_RC_FLOW_ONLY_ACTIVE = false;
  var OFD1C_RC_SANKEY_ZOOM = new Map();

  // Группировка записей 1С в цепочки "одна касса" = (ИНН + заводской номер), записи внутри
  // отсортированы по дате начала тарифа. Только сопоставленные с ОФД по ИНН (client != null)
  // -- та же граница, что и везде в разделе (несопоставленные показаны отдельно как "не
  // найдено" в "Портрет клиента", в расчётах не участвуют).
  function ofd1cGroupBySerial(model) {
    var byKey = new Map();
    OFD1C_STATE.records.forEach(function (r) {
      if (!r.tariffStart) return;
      var key = r.inn + "|" + (r.kktSerial || "");
      var g = byKey.get(key);
      if (!g) { g = { inn: r.inn, kktSerial: r.kktSerial, client: model.clients.get(r.inn) || null, records: [] }; byKey.set(key, g); }
      g.records.push(r);
    });
    var chains = [];
    byKey.forEach(function (g) {
      if (!g.client) return;
      g.records.sort(function (a, b) { return a.tariffStart - b.tariffStart; });
      var ends = g.records.filter(function (r) { return r.tariffEnd; }).map(function (r) { return r.tariffEnd; });
      g.appearance = g.records[0].tariffStart;
      g.currentEnd = ends.length ? new Date(Math.max.apply(null, ends.map(function (d) { return d.getTime(); }))) : null;
      chains.push(g);
    });
    return chains;
  }
  function ofd1cChainsByClient(chains) {
    var byInn = new Map();
    chains.forEach(function (chain) {
      var arr = byInn.get(chain.inn);
      if (!arr) { arr = []; byInn.set(chain.inn, arr); }
      arr.push(chain);
    });
    return byInn;
  }
  // "Жива" ли КОНКРЕТНАЯ цепочка (заводской номер) на дату -- покрыта ли она хоть одной
  // своей записью. Аналог kassaLapsedAt/ofd1cLapsedAt, но на уровне одной кассы 1С, не всех
  // записей клиента разом.
  function ofd1cSerialLapsedAt(chain, atDate) {
    if (!chain.appearance || atDate < chain.appearance) return false;
    for (var i = 0; i < chain.records.length; i++) {
      var r = chain.records[i];
      if (r.tariffStart <= atDate && (!r.tariffEnd || atDate <= r.tariffEnd)) return false;
    }
    return true;
  }
  function ofd1cClientLapsedAt1C(chainsForClient, atDate) {
    return chainsForClient.every(function (chain) { return ofd1cSerialLapsedAt(chain, atDate); });
  }
  function ofd1cSerialChurnStatus(chain, asOf) {
    if (!chain.currentEnd) return null;
    var graceDeadline = new Date(chain.currentEnd.getTime() + OFD1C_CHURN_GRACE_DAYS * 86400000);
    var resolveAt = new Date(chain.currentEnd.getTime() + OFD1C_REANIM_WINDOW_START_DAYS * 86400000);
    if (asOf < resolveAt) return "pending";
    return ofd1cSerialLapsedAt(chain, graceDeadline) ? "churned" : "safe";
  }
  function ofd1cAllTariffsSorted(chains) {
    var set = new Set();
    chains.forEach(function (chain) { chain.records.forEach(function (r) { if (r.months != null) set.add(r.months); }); });
    var arr = Array.from(set);
    arr.sort(function (a, b) { return b - a; });
    return arr;
  }
  // Один код 1С -> до 3 событий, зеркально collectKassaEvents из metrics.js (см. HISTORY.md
  // Б7): "new" у первой записи цепочки, "renewedFirst"/"renewedRepeat" у каждой НЕ последней
  // (следующая запись есть -- значит продление), у последней -- forecast/churn/pending по
  // currentEnd (максимум окончания по всей цепочке, не обязательно "хронологически
  // последняя по началу" запись -- та же логика, что overallEnd в основной модели).
  function ofd1cCollectSerialEvents(chain, asOf) {
    var events = [];
    var recs = chain.records;
    if (!recs.length) return events;
    events.push({ type: "new", tariff: recs[0].months, tariffLabel: recs[0].months + " мес", date: recs[0].tariffStart });
    for (var i = 0; i < recs.length - 1; i++) {
      var end = recs[i].tariffEnd;
      if (!end) continue;
      events.push({ type: i === 0 ? "renewedFirst" : "renewedRepeat", tariff: recs[i].months, tariffLabel: recs[i].months + " мес", date: end });
    }
    if (chain.currentEnd) {
      var endRec = recs.filter(function (r) { return r.tariffEnd && r.tariffEnd.getTime() === chain.currentEnd.getTime(); })[0];
      var lastTariff = endRec ? endRec.months : recs[recs.length - 1].months;
      if (chain.currentEnd > asOf) {
        events.push({ type: "forecast", tariff: lastTariff, tariffLabel: lastTariff + " мес", date: chain.currentEnd });
      } else {
        var status = ofd1cSerialChurnStatus(chain, asOf);
        var type = status === "churned" ? "churn" : status === "pending" ? "pending" : "renewedRepeat";
        events.push({ type: type, tariff: lastTariff, tariffLabel: lastTariff + " мес", date: chain.currentEnd });
      }
    }
    return events;
  }
  // "Общая дата окончания" клиента -- максимум currentEnd по ВСЕМ его кассам (заводским
  // номерам), плюс запись, которая её дала (для тарифа события отток/прогноз клиента).
  function ofd1cClientEndInfo(chainsForClient) {
    var ends = chainsForClient.filter(function (c) { return c.currentEnd; }).map(function (c) { return c.currentEnd; });
    if (!ends.length) return null;
    var end = new Date(Math.max.apply(null, ends.map(function (d) { return d.getTime(); })));
    var endChain = chainsForClient.filter(function (c) { return c.currentEnd && c.currentEnd.getTime() === end.getTime(); })[0];
    var endRec = endChain ? endChain.records.filter(function (r) { return r.tariffEnd && r.tariffEnd.getTime() === end.getTime(); })[0] : null;
    return { end: end, endChain: endChain, tariff: endRec ? endRec.months : null };
  }
  // Клиентский юнит -- события со ВСЕХ касс (заводских номеров) клиента, дедуп продлений по
  // (тип,тариф,месяц), отток/прогноз на уровне ВСЕГО клиента -- зеркально collectClientEvents
  // из metrics.js. Грейса у клиента нет (той же причине, что в основной модели: "может быть
  // несколько касс, по одной грейс, по другим всё хорошо").
  function ofd1cCollectClient1CEvents(chainsForClient, asOf) {
    var events = [];
    var earliest = chainsForClient.reduce(function (a, b) { return b.appearance < a.appearance ? b : a; });
    events.push({ type: "new", tariff: earliest.records[0].months, tariffLabel: earliest.records[0].months + " мес", date: earliest.appearance });

    var seen = new Set();
    chainsForClient.forEach(function (chain) {
      ofd1cCollectSerialEvents(chain, asOf).forEach(function (ev) {
        if (ev.type !== "renewedFirst" && ev.type !== "renewedRepeat") return;
        var key = ev.type + "|" + ev.tariff + "|" + (ev.date ? ev.date.getFullYear() + "-" + ev.date.getMonth() : "no-date");
        if (seen.has(key)) return;
        seen.add(key);
        events.push(ev);
      });
    });

    var endInfo = ofd1cClientEndInfo(chainsForClient);
    if (endInfo && endInfo.tariff != null) {
      if (endInfo.end > asOf) {
        events.push({ type: "forecast", tariff: endInfo.tariff, tariffLabel: endInfo.tariff + " мес", date: endInfo.end });
      } else {
        var graceDeadline = new Date(endInfo.end.getTime() + OFD1C_CHURN_GRACE_DAYS * 86400000);
        var resolveAt = new Date(endInfo.end.getTime() + OFD1C_REANIM_WINDOW_START_DAYS * 86400000);
        var status = asOf < resolveAt ? "pending" : (ofd1cClientLapsedAt1C(chainsForClient, graceDeadline) ? "churned" : "safe");
        if (status === "churned") events.push({ type: "churn", tariff: endInfo.tariff, tariffLabel: endInfo.tariff + " мес", date: endInfo.end });
        // status === "pending" -- грейса у клиента нет, событие не создаём
      }
    }
    return events;
  }
  function ofd1cCalendarMonthRange(chains, asOf, forecastMonths) {
    var minDate = null;
    chains.forEach(function (chain) { if (!minDate || chain.appearance < minDate) minDate = chain.appearance; });
    if (!minDate) minDate = asOf;
    var start = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    var end = new Date(asOf.getFullYear(), asOf.getMonth() + (forecastMonths || 0), 1);
    return ofd1cBuildMonthRange(start, end);
  }
  function ofd1cEmptyCalendarCounts() { return { new: 0, renewedFirst: 0, renewedRepeat: 0, churn: 0, pending: 0, forecast: 0 }; }
  function ofd1cMakeCalendarBuckets(months, tariffs) {
    var b = {};
    tariffs.concat(["total"]).forEach(function (t) { b[t] = months.map(function () { return ofd1cEmptyCalendarCounts(); }); });
    return b;
  }
  function ofd1cAddEventToBuckets(buckets, months, ev) {
    if (!buckets[ev.tariff]) return;
    var idx = ofd1cMonthIndexOf(months, ev.date);
    if (idx < 0) return;
    buckets[ev.tariff][idx][ev.type] += 1;
    buckets.total[idx][ev.type] += 1;
  }
  // opts: { unit: "kassa"|"client", tariffs, onlyActive } -- зеркально computeRenewalCalendar.
  function ofd1cComputeRenewalCalendar(model, asOf, opts) {
    opts = opts || {};
    var forecastMonths = opts.forecastMonths || OFD1C_CALENDAR_FORECAST_MONTHS;
    var unit = opts.unit === "client" ? "client" : "kassa";
    var chains = ofd1cGroupBySerial(model);
    var tariffs = opts.tariffs || ofd1cAllTariffsSorted(chains);
    var onlyActive = !!opts.onlyActive;
    var months = ofd1cCalendarMonthRange(chains, asOf, forecastMonths);
    var buckets = ofd1cMakeCalendarBuckets(months, tariffs);
    function isSurvivalGated(type) { return type === "new" || type === "renewedFirst" || type === "renewedRepeat"; }

    if (unit === "kassa") {
      chains.forEach(function (chain) {
        var alive = !ofd1cSerialLapsedAt(chain, asOf);
        ofd1cCollectSerialEvents(chain, asOf).forEach(function (ev) {
          if (onlyActive && !alive && isSurvivalGated(ev.type)) return;
          ofd1cAddEventToBuckets(buckets, months, ev);
        });
      });
    } else {
      ofd1cChainsByClient(chains).forEach(function (chainsForClient) {
        var alive = !ofd1cClientLapsedAt1C(chainsForClient, asOf);
        ofd1cCollectClient1CEvents(chainsForClient, asOf).forEach(function (ev) {
          if (onlyActive && !alive && isSurvivalGated(ev.type)) return;
          ofd1cAddEventToBuckets(buckets, months, ev);
        });
      });
    }
    return { months: months, buckets: buckets, unit: unit, tariffs: tariffs, chains: chains };
  }
  // Раскрытие по клику на сегмент Календаря -- зеркально renewalCalendarDrill.
  function ofd1cRenewalCalendarDrill(chains, asOf, monthDate, tariffMonths, type, unit, onlyActive) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    var byClientMap = ofd1cChainsByClient(chains);

    if (unit === "client" && (type === "churn" || type === "forecast")) {
      byClientMap.forEach(function (chainsForClient, inn) {
        var endInfo = ofd1cClientEndInfo(chainsForClient);
        if (!endInfo || endInfo.tariff == null) return;
        if (endInfo.end.getFullYear() !== y || endInfo.end.getMonth() !== m) return;
        var isForecast = endInfo.end > asOf;
        if (type === "forecast" && !isForecast) return;
        if (type === "churn") {
          if (isForecast) return;
          var graceDeadline = new Date(endInfo.end.getTime() + OFD1C_CHURN_GRACE_DAYS * 86400000);
          if (!ofd1cClientLapsedAt1C(chainsForClient, graceDeadline)) return;
        }
        if (endInfo.tariff !== tariffMonths) return;
        var client = chainsForClient[0].client;
        out.push({
          inn: inn, org: client.org,
          activeKassas: chainsForClient.filter(function (c) { return !ofd1cSerialLapsedAt(c, asOf); }).length,
          tariff: tariffMonths + " мес", end: endInfo.end, partnerInn: client.partnerInn, partner: client.partner,
        });
      });
      return out;
    }
    if (unit === "client" && type === "pending") return out; // грейса у клиента нет

    var survivalGated = onlyActive && (type === "new" || type === "renewedFirst" || type === "renewedRepeat");
    var seenClients = new Set();
    chains.forEach(function (chain) {
      if (survivalGated && unit !== "client" && ofd1cSerialLapsedAt(chain, asOf)) return;
      var events = ofd1cCollectSerialEvents(chain, asOf);
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.tariff !== tariffMonths || ev.type !== type) continue;
        if (!ev.date || ev.date.getFullYear() !== y || ev.date.getMonth() !== m) continue;
        if (unit === "client") {
          if (seenClients.has(chain.inn)) break;
          var chainsForClient = byClientMap.get(chain.inn);
          if (survivalGated && ofd1cClientLapsedAt1C(chainsForClient, asOf)) break;
          seenClients.add(chain.inn);
          out.push({
            inn: chain.inn, org: chain.client.org,
            activeKassas: chainsForClient.filter(function (c) { return !ofd1cSerialLapsedAt(c, asOf); }).length,
            tariff: ev.tariffLabel, end: ev.date, partnerInn: chain.client.partnerInn, partner: chain.client.partner,
          });
        } else {
          out.push({
            inn: chain.inn, org: chain.client.org, rnm: chain.kktSerial,
            tariff: ev.tariffLabel, end: ev.date, partnerInn: chain.client.partnerInn, partner: chain.client.partner,
          });
        }
        break;
      }
    });
    return out;
  }
  function ofd1cDrillRenewalCombined(chains, asOf, monthDate, tariffMonths, type, unit, onlyActive) {
    if (type === "renewed") {
      return ofd1cRenewalCalendarDrill(chains, asOf, monthDate, tariffMonths, "renewedFirst", unit, onlyActive)
        .concat(ofd1cRenewalCalendarDrill(chains, asOf, monthDate, tariffMonths, "renewedRepeat", unit, onlyActive));
    }
    return ofd1cRenewalCalendarDrill(chains, asOf, monthDate, tariffMonths, type, unit, onlyActive);
  }
  // Колонки drill-таблиц -- зеркально RC_DRILL_COLUMNS_KASSA/CLIENT, но "РНМ" заменён на
  // "Заводской номер ККТ" (единственный ID кассы в данных 1С).
  var OFD1C_RC_DRILL_COLUMNS_KASSA = [
    { label: "ИНН клиента", key: "inn" }, { label: "Наименование клиента", key: "org" },
    { label: "Заводской номер ККТ", key: "rnm" }, { label: "Тариф", key: "tariff" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "ИНН партнёра", key: "partnerInn" }, { label: "Наименование партнёра", key: "partner" },
  ];
  var OFD1C_RC_DRILL_COLUMNS_CLIENT = [
    { label: "ИНН клиента", key: "inn" }, { label: "Наименование клиента", key: "org" },
    { label: "Кол-во активных касс (1С)", key: "activeKassas", num: true }, { label: "Тариф", key: "tariff" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "ИНН партнёра", key: "partnerInn" }, { label: "Наименование партнёра", key: "partner" },
  ];

  // ================= B9: Каналы продаж (Дима, 2026-10-01) ===========================
  // Собрано строго по утверждённому драфту (артефакт «Борды на обсуждение», задача 1) и
  // комментариям к нему. Один борд из трёх частей, в библиотеке — три пункта:
  //   1. Каналы и закреплённые партнёры  (b9-channels-setup)
  //   2. Динамика канала: 2026 против 2025 (b9-channels-dynamics)
  //   3. Прирост базы по каналам          (b9-channels-growth)
  // Пять каналов: Корп, Ольга Зибер, Пенигина — прямые, Пенигина — ОП, Партнёры.
  // Правило разнесения — в metrics.classifyChannel (пара «Партнёр» + «Центр продаж»),
  // поверх него ручные перезакрепления: правило даёт старт, рука важнее.
  var CH_OVERRIDE_KEY = "ofd.channelOverrides.v1";
  var CH_REFRESHERS = {};
  var CH_NOCHANNEL = "Без канала";
  function chLoadOverrides() {
    try { return JSON.parse(localStorage.getItem(CH_OVERRIDE_KEY) || "{}"); } catch (e) { return {}; }
  }
  var chOverrides = chLoadOverrides();
  function chSaveOverrides() {
    try { localStorage.setItem(CH_OVERRIDE_KEY, JSON.stringify(chOverrides)); } catch (e) { /* приватный режим */ }
  }
  function chBroadcast() { Object.keys(CH_REFRESHERS).forEach(function (k) { CH_REFRESHERS[k](); }); }
  function chEditCount() { return Object.keys(chOverrides).filter(function (k) { return chOverrides[k]; }).length; }
  function chAllChannels() { return root.OFDMetrics.CHANNELS.concat([CH_NOCHANNEL]); }
  // Канал клиента — по самой свежей кассе (Дима: 11,2% клиентов имеют кассы в разных
  // каналах, однозначного ответа из данных нет), поверх — ручной override партнёра.
  function chClientChannel(c) {
    if (!c.kassas || !c.kassas.length) return "Партнёры";
    var last = c.kassas[c.kassas.length - 1];
    return chOverrides[last.partner || "—"] || last.channel || "Партнёры";
  }
  function chPartnerOf(c) {
    return c.kassas && c.kassas.length ? (c.kassas[c.kassas.length - 1].partner || "—") : "—";
  }
  function chPartnerRows(model, asOf) {
    var byPartner = new Map();
    model.clients.forEach(function (c) {
      if (c.phys || !c.kassas.length) return;
      var last = c.kassas[c.kassas.length - 1], name = last.partner || "—";
      var row = byPartner.get(name);
      if (!row) { row = { name: name, home: last.channel || "Партнёры", clients: 0, alive: 0 }; byPartner.set(name, row); }
      row.clients++;
      if (!root.OFDMetrics.clientLapsedAt(c, asOf)) row.alive++;
    });
    var out = [];
    byPartner.forEach(function (r) { r.channel = chOverrides[r.name] || r.home; out.push(r); });
    out.sort(function (a, b) { return b.alive - a.alive; });
    return out;
  }

  // ---------- часть 1: каналы и закреплённые партнёры ----------
  var CH_SETUP_SEL = new Map();
  WIDGETS["b9-channels-setup"] = {
    title: "Каналы продаж — состав", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el("<div></div>");
      function draw() {
        wrap.innerHTML = "";
        var rows = chPartnerRows(model, ctx.asOf);
        var sel = CH_SETUP_SEL.get(instanceId) || "Ольга Зибер";
        var counts = {};
        chAllChannels().forEach(function (ch) { counts[ch] = { p: 0, c: 0 }; });
        rows.forEach(function (r) {
          if (!counts[r.channel]) counts[r.channel] = { p: 0, c: 0 };
          counts[r.channel].p++; counts[r.channel].c += r.alive;
        });
        var head = el('<div class="threshold-row" style="justify-content:space-between">' +
          '<span class="muted">Правило даёт стартовую раскладку, ручные правки важнее. ' +
          '<span class="ch-edits">Ручных правок: ' + chEditCount() + "</span></span>" +
          '<button type="button" class="refresh-chart-btn ch-reset">Сбросить к правилу</button></div>');
        wrap.appendChild(head);
        head.querySelector(".ch-reset").addEventListener("click", function () {
          chOverrides = {}; chSaveOverrides(); chBroadcast();
        });
        var pane = el('<div class="ch-pane"></div>');
        var left = el('<div class="ch-col"></div>'), right = el('<div class="ch-col"></div>');
        left.appendChild(el('<div class="ch-colhead">Канал</div>'));
        chAllChannels().forEach(function (ch) {
          var n = counts[ch] || { p: 0, c: 0 };
          if (ch === CH_NOCHANNEL && !n.p) return;
          var b = el('<button type="button" class="ch-row' + (ch === sel ? " on" : "") +
            (ch === CH_NOCHANNEL ? " warn" : "") + '">' + esc(ch) +
            ' <span class="cnt">' + fmtNum(n.c) + " кл · " + n.p + " п</span></button>");
          b.addEventListener("click", function () { CH_SETUP_SEL.set(instanceId, ch); draw(); });
          left.appendChild(b);
        });
        right.appendChild(el('<div class="ch-colhead">Партнёры канала «' + esc(sel) + "»</div>"));
        var search = el('<input type="text" class="ch-search" placeholder="поиск партнёра…">');
        right.appendChild(search);
        var list = el('<div class="ch-prlist"></div>');
        right.appendChild(list);
        var note = el('<div class="muted" style="margin-top:6px"></div>');
        right.appendChild(note);
        function drawList() {
          var q = search.value.trim().toLowerCase();
          var inCh = rows.filter(function (r) {
            return r.channel === sel && (!q || r.name.toLowerCase().indexOf(q) >= 0);
          });
          list.innerHTML = "";
          inCh.slice(0, 200).forEach(function (r) {
            var row = el('<div class="ch-pr"><span class="nm" title="' + esc(r.name) + '">' + esc(r.name) + "</span>" +
              (chOverrides[r.name] ? ' <span class="ch-moved">вручную</span>' : "") +
              '<span class="cnt">' + fmtNum(r.alive) + "</span></div>");
            if (sel !== CH_NOCHANNEL) {
              var unpin = el('<button type="button" class="refresh-chart-btn ch-unpin">Открепить</button>');
              unpin.addEventListener("click", function () {
                chOverrides[r.name] = CH_NOCHANNEL; chSaveOverrides(); chBroadcast();
              });
              row.appendChild(unpin);
            }
            var sl = el('<select class="ch-move"><option value="">Перенести в…</option>' +
              chAllChannels().filter(function (x) { return x !== r.channel && x !== CH_NOCHANNEL; })
                .map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join("") + "</select>");
            sl.addEventListener("change", function () {
              if (!sl.value) return;
              chOverrides[r.name] = sl.value; chSaveOverrides(); chBroadcast();
            });
            row.appendChild(sl);
            list.appendChild(row);
          });
          if (!inCh.length) list.appendChild(el('<div class="muted">Никого не найдено.</div>'));
          note.textContent = inCh.length > 200 ? "Показаны первые 200 из " + fmtNum(inCh.length) + " — остальных через поиск."
            : (sel === CH_NOCHANNEL ? "Откреплённые партнёры не попадают ни в один канал, пока их не закрепят." : "");
        }
        search.addEventListener("input", drawList);
        drawList();
        pane.appendChild(left); pane.appendChild(right);
        wrap.appendChild(pane);
        // Правило разнесения — под спойлером: это стартовая раскладка, дальше работают правки.
        var rule = el('<details class="ch-rule"><summary>Как партнёры разнесены изначально — правило по полю «Центр продаж»</summary></details>');
        rule.appendChild(makeSortableTable(
          [{ label: "#", num: true }, { label: "Условие" }, { label: "Канал" }],
          [["1", "«Партнер» в справочнике «Корп»", "Корп"],
           ["2", "«Партнер» в справочнике Зибер", "Ольга Зибер"],
           ["3", "«Центр продаж» — представительство и «Партнер» — тот же офис", "Пенигина — прямые"],
           ["4", "«Центр продаж» — представительство, «Партнер» — другой", "Пенигина — ОП"],
           ["5", "Всё остальное", "Партнёры"]]
        ));
        rule.appendChild(el('<div class="muted" style="padding:6px 2px">Проверяется сверху вниз, первое совпадение. ' +
          "Правила 1–2 стоят выше «Центра продаж» намеренно: «ЛК ОФД» и АТОЛ сидят в общем ЦП и иначе ушли бы в «Партнёры».</div>"));
        wrap.appendChild(rule);
      }
      draw();
      CH_REFRESHERS[instanceId] = draw;
      return wrap;
    },
    onRemove: function (instanceId) { delete CH_REFRESHERS[instanceId]; CH_SETUP_SEL.delete(instanceId); },
  };

  // ---------- общий расчёт по каналу за год ----------
  var CH_MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  var CH_MONF = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  function chSeries(model, ctx, year, filterFn) {
    return root.OFDMetrics.computeChannelMonthly(model, year, ctx.asOf, ctx.opts, filterFn);
  }
  function chGraceEnd(year, m) {
    var d = new Date(year, m + 1, 0);
    return new Date(d.getTime() + 31 * 86400000).toLocaleDateString("ru-RU");
  }

  // ---------- часть 2: динамика канала, 2026 против 2025 одним графиком ----------
  var CH_DYN = new Map();
  WIDGETS["b9-channels-dynamics"] = {
    title: "Каналы продаж — динамика год к году", type: "график", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el("<div></div>");
      function draw() {
        wrap.innerHTML = "";
        var M = root.OFDMetrics;
        var st = CH_DYN.get(instanceId) || { ch: "Ольга Зибер", metric: "C" };
        CH_DYN.set(instanceId, st);
        var yNow = ctx.asOf.getFullYear();
        var tabs = el('<div class="ch-tabs"></div>');
        M.CHANNELS.forEach(function (ch) {
          var b = el('<button type="button" class="ch-tab' + (ch === st.ch ? " on" : "") + '">' + esc(ch) + "</button>");
          b.addEventListener("click", function () { st.ch = ch; draw(); });
          tabs.appendChild(b);
        });
        wrap.appendChild(tabs);
        var f = function (c) { return chClientChannel(c) === st.ch; };
        var cur = chSeries(model, ctx, yNow, f), prev = chSeries(model, ctx, yNow - 1, f);
        var MN = { N: "Новые клиенты", C: "Отток клиентов", S: "Разница (новые − отток)" };
        var legend = el('<div class="ch-legend">' +
          '<span><i class="ch-sw" style="background:var(--s2)"></i>' + yNow + "</span>" +
          '<span><i class="ch-sw" style="background:var(--s1)"></i>' + (yNow - 1) + "</span>" +
          '<span class="ch-seg">' +
          ["N", "C", "S"].map(function (k) {
            return '<span class="ch-segopt' + (k === st.metric ? " on" : "") + '" data-k="' + k +
              '">' + (k === "N" ? "новые" : k === "C" ? "отток" : "разница") + "</span>";
          }).join("") + "</span></div>");
        legend.querySelectorAll(".ch-segopt").forEach(function (o) {
          o.addEventListener("click", function () { st.metric = o.dataset.k; draw(); });
        });
        wrap.appendChild(legend);
        function vals(s, k) {
          return s.map(function (m) { return k === "N" ? m.newClients : k === "C" ? m.churned : m.newClients - m.churned; });
        }
        var a26 = vals(cur, st.metric), a25 = vals(prev, st.metric);
        // Грейс: по незрелым месяцам подтверждённый отток занижен — пунктир ведёт к худшему
        // случаю (все pending уйдут в отток), сплошная линия обрывается на последнем зрелом.
        var worst = cur.map(function (m, i) {
          var add = m.ripe ? 0 : m.pending;
          return st.metric === "N" ? a26[i] : st.metric === "C" ? a26[i] + add : a26[i] - add;
        });
        var lastRipe = 0;
        cur.forEach(function (m, i) { if (m.ripe && (m.newClients || m.churned)) lastRipe = i; });
        var hasFuture = cur.map(function (m, i) { return i <= ctx.asOf.getMonth(); });
        wrap.appendChild(el('<div class="ch-chart">' +
          chDrawChart(a26, a25, worst, lastRipe, ctx.asOf.getMonth(), yNow, MN[st.metric], cur, prev, st.metric) + "</div>"));
        // Вердикт за январь–as-of
        var upto = ctx.asOf.getMonth() + 1;
        function sum(arr, key) { var t = 0; for (var i = 0; i < upto; i++) t += arr[i][key]; return t; }
        var n26 = sum(cur, "newClients"), n25 = sum(prev, "newClients");
        var c26 = sum(cur, "churned"), c25 = sum(prev, "churned");
        var b26 = cur[0].baseAtStart, b25 = prev[0].baseAtStart;
        function pc(a, b) {
          if (!b) return "—";
          var v = (a / b - 1) * 100;
          return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1).replace(".", ",") + "%";
        }
        var net26 = n26 - c26, net25 = n25 - c25, good = net26 >= net25;
        var per = "янв–" + CH_MON[ctx.asOf.getMonth()];
        wrap.appendChild(el('<div class="ch-verdict">' +
          chVCell("Привели, " + per, fmtNum(n26), pc(n26, n25), n26 >= n25, (yNow - 1) + ": " + fmtNum(n25)) +
          chVCell("Потеряли, " + per, fmtNum(c26), pc(c26, c25), c26 <= c25, (yNow - 1) + ": " + fmtNum(c25)) +
          chVCell("Отток от базы на 1 января", b26 ? (100 * c26 / b26).toFixed(1).replace(".", ",") + "%" : "—", "", true,
            (yNow - 1) + ": " + (b25 ? (100 * c25 / b25).toFixed(1).replace(".", ",") + "%" : "—")) +
          '<div><div class="ch-vlabel">Итог год к году</div><div class="ch-vbig" style="color:var(' +
          (good ? "--good" : "--crit") + ')">' + (good ? "▲ положительная" : "▼ отрицательная") +
          '</div><div class="ch-vsub">чистый прирост ' + fmtNum(net26) + " против " + fmtNum(net25) + "</div></div>" +
          "</div>"));
        var grace = cur.filter(function (m, i) { return !m.ripe && i <= ctx.asOf.getMonth() && m.pending; });
        if (grace.length) {
          wrap.appendChild(el('<div class="muted" style="margin-top:8px">Пунктир ведёт к худшему случаю: ' +
            fmtNum(grace.reduce(function (t, m) { return t + m.pending; }, 0)) +
            " клиентов ещё в грейс-периоде, полая точка — уже подтверждённый отток.</div>"));
        }
      }
      draw();
      CH_REFRESHERS[instanceId] = draw;
      return wrap;
    },
    onRemove: function (instanceId) { delete CH_REFRESHERS[instanceId]; CH_DYN.delete(instanceId); },
  };

  function chVCell(label, big, delta, good, sub) {
    return '<div><div class="ch-vlabel">' + esc(label) + '</div><div class="ch-vbig">' + big +
      (delta ? ' <span class="ch-delta ' + (good ? "up" : "down") + '">' + delta + "</span>" : "") +
      '</div><div class="ch-vsub">' + esc(sub) + "</div></div>";
  }
  // Один SVG: 2026 оранжевым, 2025 синим, 12 месяцев. Возвращает СТРОКУ (как lineChart).
  function chDrawChart(a26, a25, worst, lastRipe, asOfMonth, yNow, title, cur, prev, metric) {
    var W = 1100, H = 280, L = 56, R = 52, T = 18, Bm = 30;
    var shown26 = a26.slice(0, asOfMonth + 1), shownW = worst.slice(0, asOfMonth + 1);
    var all = shown26.concat(a25, shownW);
    var lo = Math.min.apply(null, all.concat([0])), hi = Math.max.apply(null, all.concat([1]));
    var pad = (hi - lo) * 0.15 || 10;
    var y0 = Math.min(0, lo - pad), y1 = hi + pad;
    var x = function (i) { return L + (i + 0.5) * (W - L - R) / 12; };
    var y = function (v) { return T + (H - T - Bm) * (1 - (v - y0) / (y1 - y0)); };
    var g = "";
    for (var i = 0; i < 12; i++) {
      g += '<rect class="hl" data-m="' + i + '" x="' + (x(i) - (W - L - R) / 24) + '" y="' + T +
        '" width="' + ((W - L - R) / 12) + '" height="' + (H - T - Bm) + '" fill="var(--brand)" opacity="0"/>';
    }
    var step = (y1 - y0) / 4;
    for (var t = 0; t <= 4; t++) {
      var tv = y0 + step * t;
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(tv) + '" y2="' + y(tv) +
        '" stroke="' + (Math.abs(tv) < 0.5 ? "var(--muted)" : "var(--viz-grid)") + '" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(tv) + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' +
        Math.round(tv).toLocaleString("ru-RU") + "</text>";
    }
    for (i = 0; i < 12; i++) {
      g += '<text class="ml" data-m="' + i + '" x="' + x(i) + '" y="' + (H - 9) +
        '" text-anchor="middle" font-size="11.5" fill="var(--muted)">' + CH_MON[i] + "</text>";
    }
    function path(arr, n, col) {
      return arr.slice(0, n).map(function (v, i2) { return (i2 ? "L" : "M") + x(i2).toFixed(1) + " " + y(v).toFixed(1); }).join(" ");
    }
    g += '<path d="' + path(a25, 12) + '" fill="none" stroke="var(--s1)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    g += a25.map(function (v, i2) { return '<circle class="pt" data-m="' + i2 + '" cx="' + x(i2) + '" cy="' + y(v) + '" r="3" fill="var(--s1)" stroke="var(--card-bg)" stroke-width="2"/>'; }).join("");
    g += '<text x="' + (x(11) + 9) + '" y="' + (y(a25[11]) + 4) + '" font-size="11" font-weight="600" fill="var(--ink)">' + (yNow - 1) + "</text>";
    var solidTo = Math.min(lastRipe, asOfMonth) + 1;
    g += '<path d="' + path(a26, solidTo) + '" fill="none" stroke="var(--s2)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    // Хвост от последнего зрелого месяца к худшему случаю — пунктиром.
    if (solidTo <= asOfMonth) {
      var seg = [];
      for (var k = solidTo - 1; k <= asOfMonth; k++) if (k >= 0) seg.push((seg.length ? "L" : "M") + x(k).toFixed(1) + " " + y(worst[k]).toFixed(1));
      g += '<path d="' + seg.join(" ") + '" fill="none" stroke="var(--s2)" stroke-width="2.5" stroke-dasharray="5 4" stroke-linecap="round"/>';
      g += '<text x="' + x(asOfMonth) + '" y="' + (y(worst[asOfMonth]) - 12) + '" text-anchor="middle" font-size="10" fill="var(--muted)">грейс</text>';
      g += '<line x1="' + x(asOfMonth) + '" x2="' + x(asOfMonth) + '" y1="' + y(worst[asOfMonth]) + '" y2="' + y(a26[asOfMonth]) +
        '" stroke="var(--s2)" stroke-width="1.5" stroke-dasharray="2 3"/>';
      g += '<circle cx="' + x(asOfMonth) + '" cy="' + y(a26[asOfMonth]) + '" r="4.5" fill="var(--card-bg)" stroke="var(--s2)" stroke-width="2"/>';
      g += '<text x="' + (x(asOfMonth) - 9) + '" y="' + (y(a26[asOfMonth]) + 4) + '" text-anchor="end" font-size="10" fill="var(--muted)">подтверждено</text>';
    }
    g += a26.slice(0, solidTo).map(function (v, i2) { return '<circle class="pt" data-m="' + i2 + '" cx="' + x(i2) + '" cy="' + y(v) + '" r="3" fill="var(--s2)" stroke="var(--card-bg)" stroke-width="2"/>'; }).join("");
    g += '<text x="' + (x(asOfMonth) + 9) + '" y="' + (y(a26[asOfMonth]) - 10) + '" font-size="11" font-weight="600" fill="var(--ink)">' + yNow + "</text>";
    return '<h4 class="ch-ctitle">' + esc(title) + ' по месяцам</h4><svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' +
      esc(title) + ": " + yNow + " против " + (yNow - 1) + '">' + g + "</svg>";
  }

  // ---------- часть 3: прирост базы по каналам ----------
  var CH_GROWTH = new Map();
  function chAgg(series, from, to) {
    var o = { base: series[from].baseAtStart, n: 0, c: 0, g: 0, r: 0, k: to - from + 1 };
    for (var m = from; m <= to; m++) {
      o.n += series[m].newClients;
      o.c += series[m].churned;
      o.g += series[m].ripe ? 0 : series[m].pending;
      o.r += series[m].returned;
    }
    return o;
  }
  function chAddAgg(a, b) { a.base += b.base; a.n += b.n; a.c += b.c; a.g += b.g; a.r += b.r; a.k = b.k; return a; }
  function chZero() { return { base: 0, n: 0, c: 0, g: 0, r: 0, k: 1 }; }
  function chPct(a, b) {
    if (!b) return "—";
    var v = (a / b - 1) * 100;
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1).replace(".", ",") + "%";
  }
  function chPP(a, b) {
    var v = a - b;
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2).replace(".", ",") + " п.п.";
  }
  function chP2(v) { return v.toFixed(2).replace(".", ",") + "%"; }
  function chDelta(txt, good) { return '<span class="ch-delta ' + (good ? "up" : "down") + '">' + txt + "</span>"; }
  // Проценты — в СРЕДНЕМ ЗА МЕСЯЦ (делим на число месяцев): иначе квартал даёт втрое
  // больший процент, чем месяц, и читается как обвал. Так месяц и период сравнимы напрямую.
  function chCells(a, b) {
    var co = a.base ? a.c / a.base / a.k * 100 : 0, co5 = b.base ? b.c / b.base / b.k * 100 : 0;
    var ci = a.base ? a.n / a.base / a.k * 100 : 0, ci5 = b.base ? b.n / b.base / b.k * 100 : 0;
    return [
      fmtNum(a.base),
      fmtNum(a.n), chDelta(chPct(a.n, b.n), a.n >= b.n),
      fmtNum(a.c) + (a.g ? '<span class="ch-grace-sub">+' + fmtNum(a.g) + " в грейсе</span>" : ""),
      chDelta(chPct(a.c, b.c), a.c <= b.c),
      fmtNum(a.r), chDelta(chPct(a.r, b.r), a.r >= b.r),
      chP2(co), chDelta(chPP(co, co5), co <= co5),
      chP2(ci), chDelta(chPP(ci, ci5), ci >= ci5),
    ];
  }
  function chVerdict(a, b) {
    if (!a.base || !b.base) return "";
    var d = ((a.c / a.base - b.c / b.base) - (a.n / a.base - b.n / b.base)) / a.k * 100;
    if (d >= 0.35) return '<span class="ch-pill crit">провал</span>';
    if (d <= 0) return '<span class="ch-pill good">лучше ' + "прошлого года" + "</span>";
    return '<span class="ch-pill warn">хуже прошлого года</span>';
  }

  WIDGETS["b9-channels-growth"] = {
    title: "Каналы продаж — прирост базы", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el("<div></div>");
      function draw() {
        wrap.innerHTML = "";
        var M = root.OFDMetrics;
        var yNow = ctx.asOf.getFullYear(), curMonth = ctx.asOf.getMonth();
        var st = CH_GROWTH.get(instanceId);
        if (!st) { st = { mode: "one", from: curMonth, to: curMonth, pending: false, open: {} }; CH_GROWTH.set(instanceId, st); }
        // --- строка выбора периода ---
        var bar = el('<div class="ch-monthbar"></div>');
        var seg = el('<span class="ch-seg"><span class="ch-segopt' + (st.mode === "one" ? " on" : "") + '" data-m="one">Месяц</span>' +
          '<span class="ch-segopt' + (st.mode === "range" ? " on" : "") + '" data-m="range">Период</span></span>');
        seg.querySelectorAll(".ch-segopt").forEach(function (o) {
          o.addEventListener("click", function () {
            st.mode = o.dataset.m; st.pending = false;
            if (st.mode === "one") st.from = st.to;
            draw();
          });
        });
        bar.appendChild(seg);
        var months = el('<div class="ch-months"></div>');
        var series = {}, prevSeries = {};
        for (var mi = 0; mi < 12; mi++) {
          (function (i) {
            var future = i > curMonth;
            var ripe = ctx.asOf >= new Date(new Date(yNow, i + 1, 0, 23, 59, 59).getTime() + 31 * 86400000);
            var cls = "ch-mo" + (i >= st.from && i <= st.to ? (i === st.from || i === st.to ? " edge" : " in") : "") + (!future && !ripe ? " grace" : "");
            var b = el('<button type="button" class="' + cls + '"' + (future ? " disabled" : "") + ' title="' +
              (future ? "месяц ещё не наступил" : !ripe ? "грейс-период до " + chGraceEnd(yNow, i) + ": отток предварительный" : "") +
              '">' + CH_MON[i] + (!future && !ripe ? '<span class="ch-gdot">⏳</span>' : "") + "</button>");
            if (!future) {
              b.addEventListener("click", function () {
                if (st.mode === "one") { st.from = st.to = i; }
                else if (!st.pending) { st.from = st.to = i; st.pending = true; }
                else { st.from = Math.min(st.from, i); st.to = Math.max(st.to, i); st.pending = false; }
                draw();
              });
            }
            months.appendChild(b);
          })(mi);
        }
        bar.appendChild(months);
        if (st.mode === "range") {
          var presets = el('<span class="ch-presets">' +
            '<button type="button" class="refresh-chart-btn" data-p="q">Последние 3 мес.</button>' +
            '<button type="button" class="refresh-chart-btn" data-p="ytd">С начала года</button></span>');
          presets.querySelectorAll("[data-p]").forEach(function (b) {
            b.addEventListener("click", function () {
              if (b.dataset.p === "q") { st.from = Math.max(0, curMonth - 2); st.to = curMonth; }
              else { st.from = 0; st.to = curMonth; }
              st.pending = false; draw();
            });
          });
          bar.appendChild(presets);
          bar.appendChild(el('<span class="muted">' +
            (st.pending ? "теперь последний месяц периода" : "клик — первый месяц, второй клик — последний") + "</span>"));
        }
        var one = st.from === st.to;
        bar.appendChild(el('<span class="chip-inline">' +
          (one ? CH_MONF[st.from] + " " + yNow : CH_MON[st.from] + "–" + CH_MON[st.to] + " " + yNow + " · " + (st.to - st.from + 1) + " мес.") +
          "</span>"));
        wrap.appendChild(bar);
        // --- плашка грейса ---
        var graceMonths = [];
        for (var gm = st.from; gm <= st.to; gm++) {
          if (ctx.asOf < new Date(new Date(yNow, gm + 1, 0, 23, 59, 59).getTime() + 31 * 86400000)) graceMonths.push(gm);
        }
        if (graceMonths.length) {
          var g0 = graceMonths[0];
          wrap.appendChild(el('<div class="ch-gracebar"><span class="ch-gico">⏳</span><span><strong>' +
            CH_MONF[g0].charAt(0).toUpperCase() + CH_MONF[g0].slice(1) + " в грейс-периоде до " + chGraceEnd(yNow, g0) + ".</strong> " +
            "Клиенты, у которых подписка закончилась в этом месяце, ещё могут продлиться в течение 30 дней. " +
            "В отток они пока не входят — показаны отдельно строкой «в грейсе» под цифрой оттока. " +
            "Окончательный отток за " + CH_MONF[g0] + " будет после " + chGraceEnd(yNow, g0) + ".</span></div>"));
        }
        // --- таблица ---
        var pctSub = one ? "знач." : "в мес.";
        var mm = ("0" + (st.from + 1)).slice(-2);
        var thead = '<tr><th rowspan="2">Канал</th>' +
          '<th class="grp" rowspan="2">Количество клиентов<br><span class="ch-sub">на 01.' + mm + "</span></th>" +
          '<th class="grp" colspan="2">Новые</th>' +
          '<th class="grp" colspan="2">Отток' + (graceMonths.length ? ' <span class="ch-gtag">⏳ предв.</span>' : "") + "</th>" +
          '<th class="grp" colspan="2">Вернувшиеся</th>' +
          '<th class="grp" colspan="2">% оттока</th>' +
          '<th class="grp" colspan="2">% притока</th>' +
          '<th class="grp" rowspan="2">Динамика</th></tr>' +
          '<tr><th class="num gstart ch-sub">клиенты</th><th class="num ch-sub">к ' + (yNow - 1) + "</th>" +
          '<th class="num gstart ch-sub">клиенты</th><th class="num ch-sub">к ' + (yNow - 1) + "</th>" +
          '<th class="num gstart ch-sub">клиенты</th><th class="num ch-sub">к ' + (yNow - 1) + "</th>" +
          '<th class="num gstart ch-sub">' + pctSub + '</th><th class="num ch-sub">к ' + (yNow - 1) + "</th>" +
          '<th class="num gstart ch-sub">' + pctSub + '</th><th class="num ch-sub">к ' + (yNow - 1) + "</th></tr>";
        var body = "", T26 = chZero(), T25 = chZero();
        var partnerRows = chPartnerRows(model, ctx.asOf);
        M.CHANNELS.forEach(function (ch) {
          var f = function (c) { return chClientChannel(c) === ch; };
          var a = chAgg(chSeries(model, ctx, yNow, f), st.from, st.to);
          var b = chAgg(chSeries(model, ctx, yNow - 1, f), st.from, st.to);
          chAddAgg(T26, a); chAddAgg(T25, b);
          var open = !!st.open[ch];
          var inCh = partnerRows.filter(function (p) { return p.channel === ch; });
          body += '<tr class="ch-line' + (open ? " open" : "") + '" data-ch="' + esc(ch) + '">' +
            '<td><span class="ch-caret">' + (open ? "▾" : "▸") + "</span>" + esc(ch) +
            ' <span class="cnt">' + inCh.length + "</span></td>" +
            chCells(a, b).map(function (v, i2) { return '<td class="num' + (i2 === 0 || i2 === 1 || i2 === 3 || i2 === 5 || i2 === 7 || i2 === 9 ? " gstart" : "") + '">' + v + "</td>"; }).join("") +
            '<td class="gstart">' + chVerdict(a, b) + "</td></tr>";
          if (open) {
            var sub = inCh.slice(0, 25).map(function (p) {
              var pf = function (c) { return chClientChannel(c) === ch && chPartnerOf(c) === p.name; };
              return { p: p, a: chAgg(chSeries(model, ctx, yNow, pf), st.from, st.to), b: chAgg(chSeries(model, ctx, yNow - 1, pf), st.from, st.to) };
            });
            // Худшие по динамике сверху — «кто провалился» видно сразу, как просил Дима.
            sub.sort(function (x, z) {
              function d(o) { return o.a.base && o.b.base ? ((o.a.c / o.a.base - o.b.c / o.b.base) - (o.a.n / o.a.base - o.b.n / o.b.base)) : -1e9; }
              return d(z) - d(x);
            });
            sub.forEach(function (s) {
              body += '<tr class="ch-subline"><td title="' + esc(s.p.name) + '">' + esc(s.p.name) +
                (chOverrides[s.p.name] ? ' <span class="ch-moved">вручную</span>' : "") + "</td>" +
                chCells(s.a, s.b).map(function (v, i2) { return '<td class="num' + (i2 === 0 || i2 === 1 || i2 === 3 || i2 === 5 || i2 === 7 || i2 === 9 ? " gstart" : "") + '">' + v + "</td>"; }).join("") +
                '<td class="gstart">' + chVerdict(s.a, s.b) + "</td></tr>";
            });
            if (inCh.length > 25) {
              body += '<tr class="ch-subline"><td colspan="13" class="muted">…и ещё ' + fmtNum(inCh.length - 25) +
                " партнёров в этом канале</td></tr>";
            }
          }
        });
        body += '<tr class="ch-total"><td><strong>Итого</strong></td>' +
          chCells(T26, T25).map(function (v, i2) { return '<td class="num' + (i2 === 0 || i2 === 1 || i2 === 3 || i2 === 5 || i2 === 7 || i2 === 9 ? " gstart" : "") + '">' + v + "</td>"; }).join("") +
          '<td class="gstart">' + chVerdict(T26, T25) + "</td></tr>";
        var tblWrap = el('<div class="table-scroll"><table class="wtable ch-table"><thead>' + thead + "</thead><tbody>" + body + "</tbody></table></div>");
        tblWrap.querySelectorAll(".ch-line").forEach(function (tr) {
          tr.addEventListener("click", function () {
            var ch = tr.dataset.ch;
            st.open[ch] = !st.open[ch];
            draw();
          });
        });
        wrap.appendChild(tblWrap);
        wrap.appendChild(el('<div class="muted" style="margin-top:6px">База — на начало первого месяца; новые, отток и вернувшиеся — сумма за период; ' +
          "% оттока и % притока — в среднем за месяц, поэтому месяц и квартал сравнимы напрямую. " +
          "Клик по каналу раскрывает его партнёров, сверху — у кого год к году хуже всего.</div>"));
      }
      draw();
      CH_REFRESHERS[instanceId] = draw;
      return wrap;
    },
    onRemove: function (instanceId) { delete CH_REFRESHERS[instanceId]; CH_GROWTH.delete(instanceId); },
  };


  // ---- Выгрузка для прозвона по обмену с 1С (Дима, 2026-10-01) ----------------------
  // Строка = КАССА (цепочка тарифов по заводскому номеру), НЕ клиент: у одного клиента
  // может истечь несколько кодов 1С, и менеджеру нужна строка на каждую кассу отдельно —
  // схлопывать в одну строку Дима явно не захотел. Строки одного клиента идут подряд.
  // Колонка «Касс» — сколько касс ЭТОГО клиента попало в ЭТУ таблицу (просроченных или
  // заканчивающихся), НЕ общее число касс клиента.
  // Окно скользит от as-of: верхняя таблица — месяц as-of минус 1, нижняя — месяц as-of.
  var OFD1C_CALLOUT_LIMIT = 300; // на экране; в Excel уходит всё

  function ofd1cMonthBounds(d, offset) {
    return {
      start: new Date(d.getFullYear(), d.getMonth() + offset, 1),
      end: new Date(d.getFullYear(), d.getMonth() + offset + 1, 0, 23, 59, 59),
    };
  }
  // currentEnd — максимум по всей цепочке, поэтому «конец в прошлом месяце» само по себе
  // означает «не продлили»: было бы продление — максимум сдвинулся бы вперёд.
  function ofd1cCalloutRows(model, asOf, monthOffset) {
    if (!OFD1C_STATE.records) return [];
    var b = ofd1cMonthBounds(asOf, monthOffset);
    var hits = ofd1cGroupBySerial(model).filter(function (ch) {
      return ch.currentEnd && ch.currentEnd >= b.start && ch.currentEnd <= b.end;
    });
    var perClient = new Map();
    hits.forEach(function (ch) { perClient.set(ch.inn, (perClient.get(ch.inn) || 0) + 1); });
    hits.forEach(function (ch) {
      ch._inWindow = perClient.get(ch.inn);
      ch._org = (ch.client && ch.client.org) || "";
      ch._days = Math.round((ch.currentEnd - asOf) / 86400000);
    });
    hits.sort(function (a, c) {
      if (a._org !== c._org) return a._org.localeCompare(c._org, "ru");
      return a.currentEnd - c.currentEnd;
    });
    return hits;
  }
  function ofd1cCalloutCells(ch, model, overdue) {
    var contacts = ch.client ? ofd1cClientContacts(ch.client) : { phones: [], emails: [] };
    return [
      ch.inn, ch._org, ch._inWindow, ch.kktSerial || "—", fmtDate(ch.currentEnd),
      overdue ? Math.abs(ch._days) : ch._days,
      contacts.phones.join(", "), contacts.emails.join(", "),
      (ch.client && ch.client.partner) || "—",
    ];
  }
  var OFD1C_CALLOUT_HEADERS = [
    { label: "ИНН" }, { label: "Наименование" }, { label: "Касс", num: true },
    { label: "Заводской № ККТ" }, { label: "Конец тарифа" }, { label: "Дней", num: true },
    { label: "Телефоны" }, { label: "Email" }, { label: "Партнёр" },
  ];
  function ofd1cCalloutExportSpec(rows, model, overdue, label) {
    return {
      sheetName: overdue ? "Просрочены" : "Заканчиваются",
      headers: OFD1C_CALLOUT_HEADERS.map(function (h) { return h.label; })
        .map(function (l, i) { return i === 5 ? (overdue ? "Дней просрочки" : "Дней осталось") : l; })
        .concat(["Статус звонка"]),
      colWidths: [14, 44, 7, 20, 14, 9, 34, 34, 34, 30],
      textCols: [0, 3],
      rows: rows.map(function (ch) { return ofd1cCalloutCells(ch, model, overdue).concat([""]); }),
      listColumn: { index: 9, options: OFD1C_CALL_STATUSES, sheetName: "Статусы" },
    };
  }
  function ofd1cCalloutBlock(model, asOf, monthOffset, overdue) {
    var box = el('<div style="margin-bottom:18px"></div>');
    var b = ofd1cMonthBounds(asOf, monthOffset);
    var monthLabel = b.start.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    var rows = ofd1cCalloutRows(model, asOf, monthOffset);
    var clients = new Set(rows.map(function (ch) { return ch.inn; })).size;
    var head = el(
      '<div class="threshold-row" style="justify-content:space-between;align-items:baseline">' +
      "<div><strong>" + (overdue ? "Просрочены — закончились и не продлились" : "Заканчиваются — предстоящие") +
      '</strong> <span class="muted">' + esc(monthLabel) + " · " + rows.length + " касс у " + clients + " клиентов</span></div>" +
      '<button type="button" class="refresh-chart-btn callout-dl">Скачать Excel</button>' +
      "</div>"
    );
    box.appendChild(head);
    if (!rows.length) {
      box.appendChild(el('<div class="placeholder-body">За этот месяц ничего нет.</div>'));
      return box;
    }
    var hdr = OFD1C_CALLOUT_HEADERS.map(function (h, i) {
      return i === 5 ? { label: overdue ? "Дней просрочки" : "Дней осталось", num: true } : h;
    });
    box.appendChild(makeSortableTable(hdr, rows.slice(0, OFD1C_CALLOUT_LIMIT).map(function (ch) {
      return ofd1cCalloutCells(ch, model, overdue);
    })));
    if (rows.length > OFD1C_CALLOUT_LIMIT) {
      box.appendChild(el('<div class="muted" style="margin-top:6px">Показаны первые ' +
        OFD1C_CALLOUT_LIMIT + " из " + rows.length + " — в Excel уходят все.</div>"));
    }
    head.querySelector(".callout-dl").addEventListener("click", function () {
      if (!root.OFDExport || !root.OFDExport.downloadXlsx) return;
      root.OFDExport.downloadXlsx(
        (overdue ? "Просрочены 1С " : "Заканчиваются 1С ") + monthLabel,
        ofd1cCalloutExportSpec(rows, model, overdue, monthLabel)
      );
    });
    return box;
  }

  WIDGETS["b7-1c-callout"] = {
    title: "Выгрузка для прозвона (Обмен с 1С)", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el("<div></div>");
      function renderBody() {
        wrap.innerHTML = "";
        if (!OFD1C_STATE.records) {
          wrap.appendChild(el('<div class="placeholder-body">Загрузи файл «Обмен с 1С» кнопкой в шапке — здесь появятся две таблицы для продажников: просроченные за прошлый месяц и заканчивающиеся в текущем.</div>'));
          return;
        }
        wrap.appendChild(ofd1cCalloutBlock(model, ctx.asOf, -1, true));
        wrap.appendChild(ofd1cCalloutBlock(model, ctx.asOf, 0, false));
      }
      renderBody();
      OFD1C_REFRESHERS[instanceId] = renderBody;
      return wrap;
    },
    onRemove: function (instanceId) { delete OFD1C_REFRESHERS[instanceId]; },
  };

  WIDGETS["b8-1c-renewal-calendar"] = {
    title: "Календарь продлений (Обмен с 1С)", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el("<div></div>");
      function renderBody() {
        wrap.innerHTML = "";
        if (!OFD1C_STATE.records) {
          wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится календарь продлений по тарифам обмена с 1С, аналогично основному «Календарю продлений».</div>'));
          return;
        }
        var asOf = ctx.asOf;
        var chains = ofd1cGroupBySerial(model);
        var tariffs = ofd1cAllTariffsSorted(chains);
        var cal = ofd1cComputeRenewalCalendar(model, asOf, { unit: OFD1C_RC_UNIT, tariffs: tariffs, onlyActive: OFD1C_RC_CAL_ONLY_ACTIVE });
        var months = cal.months;
        var asOfIdx = rcAsOfIndex(months, asOf);

        var vp = OFD1C_RC_VIEWPORT.get(instanceId);
        if (!vp) {
          vp = { from: Math.max(0, asOfIdx - 11), to: months.length - 1 };
          OFD1C_RC_VIEWPORT.set(instanceId, vp);
        }
        vp.from = Math.min(Math.max(vp.from, 0), months.length - 1);
        vp.to = Math.min(Math.max(vp.to, vp.from), months.length - 1);

        var unitRow = el(
          '<div class="threshold-row">' +
          '<span style="color:var(--muted)">Единица</span>' +
          '<label><input type="radio" name="o1crc-unit-' + instanceId + '" value="kassa"' + (OFD1C_RC_UNIT === "kassa" ? " checked" : "") + '> Заводской номер (кассы)</label>' +
          '<label><input type="radio" name="o1crc-unit-' + instanceId + '" value="client"' + (OFD1C_RC_UNIT === "client" ? " checked" : "") + '> ИНН (клиенты)</label>' +
          '<span style="color:var(--muted);margin-left:10px">Кассы/клиенты</span>' +
          '<label><input type="radio" name="o1crc-active-' + instanceId + '" value="all"' + (OFD1C_RC_CAL_ONLY_ACTIVE ? "" : " checked") + '> все</label>' +
          '<label><input type="radio" name="o1crc-active-' + instanceId + '" value="active"' + (OFD1C_RC_CAL_ONLY_ACTIVE ? " checked" : "") + '> только действующие</label>' +
          '<span style="color:var(--muted);margin-left:10px">вид</span>' +
          '<label><input type="radio" name="o1crc-view-' + instanceId + '" value="chart" checked> график</label>' +
          '<label><input type="radio" name="o1crc-view-' + instanceId + '" value="table"> таблица</label>' +
          '</div>'
        );
        var rangeRow = el(
          '<div class="threshold-row" style="margin-top:-4px">' +
          '<span style="color:var(--muted)">видимый диапазон</span>' +
          rcMonthSelectHTML("o1crc-from", months, vp.from) + ' <span>—</span> ' + rcMonthSelectHTML("o1crc-to", months, vp.to) +
          '<button type="button" class="refresh-chart-btn o1crc-full-range">весь период</button>' +
          '</div>'
        );
        var legendRow = el(
          '<div class="threshold-row" style="margin-top:-4px">' +
          '<label><input type="checkbox" class="o1crc-show-new" checked> Новые (светлее)</label>' +
          '<label><input type="checkbox" class="o1crc-show-renewed" checked> Продлилось (темнее)</label>' +
          '<span style="color:var(--muted)">Отток/грейс — своя панель под графиком · пунктир — прогноз · наведи на столбец — точное число</span>' +
          '</div>'
        );
        var blocksHolder = el("<div></div>");
        var tableHolder = el('<div style="display:none"></div>');
        var drillHolder = el('<div style="margin-top:10px"></div>');
        wrap.appendChild(unitRow);
        wrap.appendChild(rangeRow);
        wrap.appendChild(legendRow);
        wrap.appendChild(blocksHolder);
        wrap.appendChild(tableHolder);
        wrap.appendChild(drillHolder);

        function tariffLabelOrTotal(key) { return key == null ? "Итого" : rcTariffLabel(key); }

        function buildBlock(label, tariffKeyOrNull) {
          var block = el('<div class="rc-block"></div>');
          block.appendChild(el('<div class="rc-block-title"><b>' + esc(label) + '</b></div>'));
          var showNew = legendRow.querySelector(".o1crc-show-new").checked;
          var showRenewed = legendRow.querySelector(".o1crc-show-renewed").checked;
          var series = tariffKeyOrNull == null ? cal.buckets.total : cal.buckets[tariffKeyOrNull];
          var sc = rcCalcCalendarScale(series, vp, asOfIdx, showNew, showRenewed);
          var chartRow = el('<div style="display:flex;align-items:flex-start"></div>');
          chartRow.appendChild(rcBuildCalendarAxis(sc));
          var chartWrap = el('<div class="hscroll-chart"></div>');
          chartWrap.appendChild(rcBuildCalendarChart(sc, cal.buckets, tariffKeyOrNull, months, asOfIdx, tariffs, showNew, showRenewed, function (monthDate, type) {
            if (tariffKeyOrNull == null) {
              drillHolder.innerHTML = '<div class="stat-label" style="margin-top:8px">На «Итого» клик не раскрывается (тарифы суммированы) — выбери конкретный тариф ниже.</div>';
              return;
            }
            var list = ofd1cDrillRenewalCombined(cal.chains, asOf, monthDate, tariffKeyOrNull, type, OFD1C_RC_UNIT, OFD1C_RC_CAL_ONLY_ACTIVE);
            var columns = OFD1C_RC_UNIT === "client" ? OFD1C_RC_DRILL_COLUMNS_CLIENT : OFD1C_RC_DRILL_COLUMNS_KASSA;
            renderDrillList(drillHolder, list, columns, tariffLabelOrTotal(tariffKeyOrNull) + " · " + rcMonthLabel(monthDate) + " · " + RC_TYPE_LABEL[type]);
          }));
          chartRow.appendChild(chartWrap);
          block.appendChild(chartRow);
          return block;
        }
        function renderBlocks() {
          blocksHolder.innerHTML = "";
          blocksHolder.appendChild(buildBlock("Итого", null));
          tariffs.forEach(function (t) { blocksHolder.appendChild(buildBlock(rcTariffLabel(t), t)); });
          rcLinkScroll(Array.from(blocksHolder.querySelectorAll(".hscroll-chart")));
        }

        function renderTable() {
          tableHolder.innerHTML = "";
          var toIdx = Math.min(vp.to, asOfIdx);
          if (vp.from > toIdx) {
            tableHolder.appendChild(el('<div class="stat-label">В видимом диапазоне только будущие месяцы — у прогноза нет этой разбивки, сдвинь диапазон.</div>'));
            return;
          }
          var groups = [null].concat(tariffs);
          var rows = [];
          for (var idx = vp.from; idx <= toIdx; idx++) {
            groups.forEach(function (g) {
              var s = g == null ? cal.buckets.total[idx] : cal.buckets[g][idx];
              var renewed = s.renewedFirst + s.renewedRepeat;
              var base = s.new + renewed + s.churn + s.pending;
              function cell(v) { return base ? fmtNum(v) + " (" + (v / base * 100).toFixed(1) + "%)" : fmtNum(v); }
              var convBase = renewed + s.churn;
              var conv = convBase ? (renewed / convBase * 100).toFixed(1) + "%" : "—";
              rows.push([rcMonthLabel(months[idx]), tariffLabelOrTotal(g), cell(s.new), cell(renewed), cell(s.churn), cell(s.pending), conv]);
            });
          }
          var headers = [
            { label: "Месяц" }, { label: "Тариф" }, { label: "Новые" }, { label: "Продлившиеся" },
            { label: "Отток" }, { label: "Грейс" }, { label: "Конверсия", num: true },
          ];
          var scrollWrap = el('<div class="table-scroll"></div>');
          scrollWrap.appendChild(makeSortableTable(headers, rows));
          tableHolder.appendChild(scrollWrap);
          tableHolder.appendChild(el('<div class="stat-label" style="margin-top:6px">% — доля от (Новые+Продлившиеся+Отток+Грейс) в этой строке. Конверсия = Продлившиеся / (Продлившиеся+Отток).</div>'));
        }

        renderBlocks();

        function syncRangeSelects() {
          rangeRow.querySelector(".o1crc-from").value = String(vp.from);
          rangeRow.querySelector(".o1crc-to").value = String(vp.to);
        }
        function refreshVisible() {
          var view = unitRow.querySelector('input[name="o1crc-view-' + instanceId + '"]:checked').value;
          blocksHolder.style.display = view === "chart" ? "" : "none";
          tableHolder.style.display = view === "table" ? "" : "none";
          if (view === "chart") renderBlocks(); else renderTable();
        }

        unitRow.querySelectorAll('input[name="o1crc-unit-' + instanceId + '"]').forEach(function (r) {
          r.addEventListener("change", function () { OFD1C_RC_UNIT = r.value; root.OFDCanvas && root.OFDCanvas.rerenderAll(); });
        });
        unitRow.querySelectorAll('input[name="o1crc-active-' + instanceId + '"]').forEach(function (r) {
          r.addEventListener("change", function () {
            OFD1C_RC_CAL_ONLY_ACTIVE = unitRow.querySelector('input[name="o1crc-active-' + instanceId + '"]:checked').value === "active";
            root.OFDCanvas && root.OFDCanvas.rerenderAll();
          });
        });
        unitRow.querySelectorAll('input[name="o1crc-view-' + instanceId + '"]').forEach(function (r) {
          r.addEventListener("change", refreshVisible);
        });
        rangeRow.querySelector(".o1crc-from").addEventListener("change", function (e) {
          vp.from = parseInt(e.target.value, 10);
          if (vp.to < vp.from) vp.to = vp.from;
          syncRangeSelects(); refreshVisible();
        });
        rangeRow.querySelector(".o1crc-to").addEventListener("change", function (e) {
          vp.to = parseInt(e.target.value, 10);
          if (vp.from > vp.to) vp.from = vp.to;
          syncRangeSelects(); refreshVisible();
        });
        rangeRow.querySelector(".o1crc-full-range").addEventListener("click", function () {
          vp.from = 0; vp.to = months.length - 1;
          syncRangeSelects(); refreshVisible();
        });
        legendRow.querySelectorAll(".o1crc-show-new, .o1crc-show-renewed").forEach(function (cb) { cb.addEventListener("change", renderBlocks); });
      }
      renderBody();
      OFD1C_REFRESHERS[instanceId] = renderBody;
      return wrap;
    },
    onRemove: function (instanceId) { delete OFD1C_REFRESHERS[instanceId]; OFD1C_RC_VIEWPORT.delete(instanceId); },
  };

  // ---------- "Переток тарифов (Обмен с 1С)" -- зеркально b7-tariff-flow. БЕЗ тумблера
  // юнита (только заводской номер), тот же принцип, что уже применён в b7-tariff-flow к
  // основной модели: переход всегда привязан к конкретной кассе, клиентский разрез был бы
  // лишним слоем дедупа поверх, не нужным на этом борде.
  function ofd1cSerialTransitionEvents(chain) {
    var events = [];
    var recs = chain.records;
    for (var i = 0; i < recs.length - 1; i++) {
      var fromT = recs[i].months, toT = recs[i + 1].months;
      if (fromT == null || toT == null) continue;
      events.push({ from: fromT, to: toT, fromLabel: fromT + " мес", toLabel: toT + " мес", end: recs[i].tariffEnd });
    }
    return events;
  }
  function ofd1cComputeTariffTransitions(chains, onlyActive, asOf) {
    var agg = new Map();
    function bump(fromT, toT) { var key = fromT + "|" + toT; agg.set(key, (agg.get(key) || 0) + 1); }
    chains.forEach(function (chain) {
      if (onlyActive && ofd1cSerialLapsedAt(chain, asOf)) return;
      ofd1cSerialTransitionEvents(chain).forEach(function (ev) { bump(ev.from, ev.to); });
    });
    var rows = [];
    agg.forEach(function (count, key) {
      var parts = key.split("|");
      rows.push({ from: parseInt(parts[0], 10), to: parseInt(parts[1], 10), count: count });
    });
    return rows;
  }
  function ofd1cComputeTariffTransitionsMonthly(chains, asOf, onlyActive, tariffs) {
    var months = ofd1cCalendarMonthRange(chains, asOf, OFD1C_CALENDAR_FORECAST_MONTHS);
    var bySource = {};
    tariffs.forEach(function (t) { bySource[t] = months.map(function () { return {}; }); });
    function bump(fromT, toT, idx) {
      if (!bySource[fromT] || idx < 0) return;
      var bucket = bySource[fromT][idx];
      bucket[toT] = (bucket[toT] || 0) + 1;
    }
    chains.forEach(function (chain) {
      if (onlyActive && ofd1cSerialLapsedAt(chain, asOf)) return;
      ofd1cSerialTransitionEvents(chain).forEach(function (ev) { bump(ev.from, ev.to, ofd1cMonthIndexOf(months, ev.end)); });
    });
    return { months: months, bySource: bySource };
  }
  function ofd1cTariffTransitionDrill(chains, asOf, fromT, toT, monthDate, onlyActive) {
    var out = [];
    function matches(ev) {
      if (ev.from !== fromT || ev.to !== toT) return false;
      if (!monthDate) return true;
      return ev.end && ev.end.getFullYear() === monthDate.getFullYear() && ev.end.getMonth() === monthDate.getMonth();
    }
    chains.forEach(function (chain) {
      if (onlyActive && ofd1cSerialLapsedAt(chain, asOf)) return;
      var evs = ofd1cSerialTransitionEvents(chain);
      var hit = null;
      for (var i = 0; i < evs.length; i++) { if (matches(evs[i])) { hit = evs[i]; break; } }
      if (!hit) return;
      out.push({
        inn: chain.inn, org: chain.client.org, rnm: chain.kktSerial,
        tariffFrom: hit.fromLabel, tariffTo: hit.toLabel, end: hit.end,
        partnerInn: chain.client.partnerInn, partner: chain.client.partner,
      });
    });
    return out;
  }
  var OFD1C_RC_TRANSITION_COLUMNS = [
    { label: "ИНН клиента", key: "inn" }, { label: "Наименование клиента", key: "org" },
    { label: "Заводской номер ККТ", key: "rnm" }, { label: "Тариф до", key: "tariffFrom" }, { label: "Тариф после", key: "tariffTo" },
    { label: "Дата окончания", key: "end", date: true },
    { label: "ИНН партнёра", key: "partnerInn" }, { label: "Наименование партнёра", key: "partner" },
  ];

  WIDGETS["b8-1c-tariff-flow"] = {
    title: "Переток тарифов (Обмен с 1С)", type: "график + таблица", scope: "as-of", span: true,
    render: function (model, ctx, instanceId) {
      var wrap = el("<div></div>");
      function renderBody() {
        wrap.innerHTML = "";
        if (!OFD1C_STATE.records) {
          wrap.appendChild(el('<div class="placeholder-body">Загрузи файл в борде «Обмен с 1С — загрузка файла» — здесь появится переток тарифов обмена с 1С, аналогично основному «Перетоку тарифов».</div>'));
          return;
        }
        var asOf = ctx.asOf;
        var chains = ofd1cGroupBySerial(model);
        var tariffs = ofd1cAllTariffsSorted(chains);
        var rows = ofd1cComputeTariffTransitions(chains, OFD1C_RC_FLOW_ONLY_ACTIVE, asOf);
        var monthly = ofd1cComputeTariffTransitionsMonthly(chains, asOf, OFD1C_RC_FLOW_ONLY_ACTIVE, tariffs);

        var volume = {};
        rows.forEach(function (r) { volume[r.from] = (volume[r.from] || 0) + r.count; volume[r.to] = (volume[r.to] || 0) + r.count; });
        var nodeOrder = Object.keys(volume).map(Number).sort(function (a, b) { return volume[b] - volume[a]; });
        if (!nodeOrder.length) nodeOrder = tariffs.slice();
        function tariffLabelFn(m) { return m + " мес"; }

        var flowVp = OFD1C_RC_FLOW_VIEWPORT.get(instanceId);
        if (!flowVp) { flowVp = { from: 0, to: monthly.months.length - 1 }; OFD1C_RC_FLOW_VIEWPORT.set(instanceId, flowVp); }
        flowVp.from = Math.min(Math.max(flowVp.from, 0), monthly.months.length - 1);
        flowVp.to = Math.min(Math.max(flowVp.to, flowVp.from), monthly.months.length - 1);

        var activeToggleId = "o1ctf-active-" + instanceId;
        var unitRow = el(
          '<div class="threshold-row">' +
          '<span style="color:var(--muted)">Кассы (заводские номера)</span>' +
          '<label><input type="radio" name="' + activeToggleId + '" value="all"' + (OFD1C_RC_FLOW_ONLY_ACTIVE ? "" : " checked") + '> все за всё время</label>' +
          '<label><input type="radio" name="' + activeToggleId + '" value="active"' + (OFD1C_RC_FLOW_ONLY_ACTIVE ? " checked" : "") + '> только действующие сейчас</label>' +
          '<span style="color:var(--muted);margin-left:10px">видимый диапазон ("по месяцам")</span>' +
          rcMonthSelectHTML("o1ctf-from", monthly.months, flowVp.from) + ' <span>—</span> ' + rcMonthSelectHTML("o1ctf-to", monthly.months, flowVp.to) +
          '<button type="button" class="refresh-chart-btn o1ctf-full-range">весь период</button>' +
          '</div>'
        );
        unitRow.querySelectorAll('input[name="' + activeToggleId + '"]').forEach(function (r) {
          r.addEventListener("change", function () {
            OFD1C_RC_FLOW_ONLY_ACTIVE = unitRow.querySelector("input:checked").value === "active";
            root.OFDCanvas && root.OFDCanvas.rerenderAll();
          });
        });
        var zoom = OFD1C_RC_SANKEY_ZOOM.get(instanceId) || 1;
        var sankeyBlock = el('<div class="rc-block"></div>');
        sankeyBlock.appendChild(el('<div class="rc-block-title"><b>Общая картина (весь период)</b></div>'));

        var viewToggleId = "o1ctf-view-" + instanceId;
        var viewToggle = el(
          '<div class="threshold-row" style="margin-top:-4px">' +
          '<label><input type="radio" name="' + viewToggleId + '" value="chart" checked> График</label>' +
          '<label><input type="radio" name="' + viewToggleId + '" value="table"> Таблица</label>' +
          '</div>'
        );
        sankeyBlock.appendChild(viewToggle);

        var chartArea = el("<div></div>");
        var zoomRow = el(
          '<div class="threshold-row" style="margin-top:-4px">' +
          '<span style="color:var(--muted)">Масштаб</span>' +
          RC_ZOOM_LEVELS.map(function (z) { return '<button type="button" class="refresh-chart-btn rc-zoom-btn" data-zoom="' + z + '">' + Math.round(z * 100) + '%</button>'; }).join(" ") +
          '</div>'
        );
        chartArea.appendChild(zoomRow);
        var sankeyWrap = el('<div class="hscroll-chart rc-zoomable"></div>');
        chartArea.appendChild(sankeyWrap);
        chartArea.appendChild(el('<div class="stat-label">Клик по полосе — список клиентов/касс этого перехода за весь период · наведи — точное число</div>'));
        sankeyBlock.appendChild(chartArea);

        var tableArea = el('<div style="display:none"></div>');
        sankeyBlock.appendChild(tableArea);
        var tableFilters = el(
          '<div class="threshold-row">' +
          '<label>Тариф до <select class="o1ctf-filter-from"><option value="">все</option>' +
          tariffs.map(function (t) { return '<option value="' + t + '">' + esc(tariffLabelFn(t)) + '</option>'; }).join("") +
          '</select></label>' +
          '<label>Тариф после <select class="o1ctf-filter-to"><option value="">все</option>' +
          tariffs.map(function (t) { return '<option value="' + t + '">' + esc(tariffLabelFn(t)) + '</option>'; }).join("") +
          '</select></label>' +
          '</div>'
        );
        tableArea.appendChild(tableFilters);
        var tableResultsHolder = el("<div></div>");
        tableArea.appendChild(tableResultsHolder);

        function markActiveZoomBtn() {
          zoomRow.querySelectorAll(".rc-zoom-btn").forEach(function (b) {
            var active = parseFloat(b.dataset.zoom) === zoom;
            b.style.borderColor = active ? "var(--brand)" : "";
            b.style.color = active ? "var(--brand)" : "";
          });
        }
        markActiveZoomBtn();

        var monthlyBlock = el('<div class="rc-block"></div>');
        monthlyBlock.appendChild(el('<div class="rc-block-title"><b>По месяцам — из каждого тарифа</b></div>'));
        var monthlyLegend = el('<div class="chart-legend"></div>');
        monthlyLegend.innerHTML = nodeOrder.map(function (t) {
          return '<span class="lg-item"><span class="lg-swatch" style="background:' + rcColorForTariff(t, nodeOrder) + '"></span>' + tariffLabelFn(t) + '</span>';
        }).join("");
        monthlyBlock.appendChild(monthlyLegend);
        var monthlyBlocksHolder = el("<div></div>");
        monthlyBlock.appendChild(monthlyBlocksHolder);
        monthlyBlock.appendChild(el('<div class="stat-label" style="margin-top:6px">Клик по столбцу месяца — разбивка по тарифам ниже · клик по строке разбивки — список клиентов/касс.</div>'));

        var drillHolder = el('<div style="margin-top:10px"></div>');
        wrap.appendChild(unitRow);
        wrap.appendChild(sankeyBlock);
        wrap.appendChild(monthlyBlock);
        wrap.appendChild(drillHolder);

        function showDrill(fromT, toT, monthDate, caption) {
          var list = ofd1cTariffTransitionDrill(chains, asOf, fromT, toT, monthDate || null, OFD1C_RC_FLOW_ONLY_ACTIVE);
          renderDrillList(drillHolder, list, OFD1C_RC_TRANSITION_COLUMNS, caption);
        }

        function showMonthlyBreakdown(srcT, monthDate) {
          var idx = rcAsOfIndex(monthly.months, monthDate);
          var b = monthly.bySource[srcT][idx] || {};
          var breakdown = nodeOrder.map(function (destT) { return { destT: destT, v: b[destT] || 0 }; })
            .filter(function (r) { return r.v > 0; })
            .sort(function (a, b) { return b.v - a.v; });
          drillHolder.innerHTML = "";
          drillHolder.appendChild(el('<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px;margin-bottom:6px"><b>Из ' + esc(tariffLabelFn(srcT)) + ' · ' + rcMonthLabel(monthDate) + '</b></div>'));
          if (!breakdown.length) {
            drillHolder.appendChild(el('<div class="stat-label">Нет переходов в этом месяце.</div>'));
            return;
          }
          var body = breakdown.map(function (r) { return [tariffLabelFn(r.destT), r.v]; });
          var table = makeSortableTable([{ label: "Тариф после", num: true }, { label: "Сумма", num: true }], body);
          drillHolder.appendChild(table);
          drillHolder.appendChild(el('<div class="stat-label" style="margin-top:6px">клик по строке — список клиентов/касс этого перехода</div>'));
          table.querySelectorAll("tbody tr").forEach(function (tr) {
            tr.style.cursor = "pointer";
            tr.addEventListener("click", function () {
              var destT = parseInt(tr.children[0].textContent, 10);
              showDrill(srcT, destT, monthDate, tariffLabelFn(srcT) + " → " + tariffLabelFn(destT) + " · " + rcMonthLabel(monthDate));
            });
          });
        }

        function renderSankey() {
          sankeyWrap.innerHTML = "";
          if (!rows.length) {
            sankeyWrap.appendChild(el('<div class="placeholder-body">Пока нет ни одного перехода тарифов в данных обмена с 1С.</div>'));
            return;
          }
          sankeyWrap.appendChild(rcBuildSankey(rows, nodeOrder, tariffLabelFn, function (fromT, toT) {
            showDrill(fromT, toT, null, tariffLabelFn(fromT) + " → " + tariffLabelFn(toT) + " · весь период");
          }, zoom));
        }
        renderSankey();
        zoomRow.querySelectorAll(".rc-zoom-btn").forEach(function (btn) {
          btn.addEventListener("click", function () {
            zoom = parseFloat(btn.dataset.zoom);
            OFD1C_RC_SANKEY_ZOOM.set(instanceId, zoom);
            markActiveZoomBtn();
            renderSankey();
          });
        });

        function renderTable() {
          tableResultsHolder.innerHTML = "";
          var fFrom = tableFilters.querySelector(".o1ctf-filter-from").value;
          var fTo = tableFilters.querySelector(".o1ctf-filter-to").value;
          var filtered = rows.filter(function (r) {
            if (fFrom && r.from !== parseInt(fFrom, 10)) return false;
            if (fTo && r.to !== parseInt(fTo, 10)) return false;
            return true;
          });
          if (!filtered.length) {
            tableResultsHolder.appendChild(el('<div class="placeholder-body">Нет переходов по этому фильтру.</div>'));
            return;
          }
          var sorted = filtered.slice().sort(function (a, b) { return b.count - a.count; });
          var body = sorted.map(function (r) { return [tariffLabelFn(r.from), tariffLabelFn(r.to), r.count]; });
          var tableWrap = makeSortableTable(
            [{ label: "Тариф до", num: true }, { label: "Тариф после", num: true }, { label: "Сумма", num: true }],
            body
          );
          tableResultsHolder.appendChild(tableWrap);
          tableResultsHolder.appendChild(el('<div class="stat-label" style="margin-top:6px">найдено ' + fmtNum(filtered.length) + ' · клик по строке — список клиентов/касс этого перехода за весь период</div>'));
          tableWrap.querySelectorAll("tbody tr").forEach(function (tr) {
            tr.style.cursor = "pointer";
            tr.addEventListener("click", function () {
              var fromT = parseInt(tr.children[0].textContent, 10);
              var toT = parseInt(tr.children[1].textContent, 10);
              showDrill(fromT, toT, null, tariffLabelFn(fromT) + " → " + tariffLabelFn(toT) + " · весь период");
            });
          });
        }
        tableFilters.addEventListener("change", renderTable);
        tableFilters.addEventListener("input", renderTable);
        viewToggle.querySelectorAll('input[name="' + viewToggleId + '"]').forEach(function (r) {
          r.addEventListener("change", function () {
            var checkedVal = viewToggle.querySelector("input:checked").value;
            chartArea.style.display = checkedVal === "chart" ? "" : "none";
            tableArea.style.display = checkedVal === "table" ? "" : "none";
            if (checkedVal === "table") renderTable();
          });
        });

        function renderMonthlyBlocks() {
          monthlyBlocksHolder.innerHTML = "";
          var visMonths = monthly.months.slice(flowVp.from, flowVp.to + 1);
          tariffs.forEach(function (srcT) {
            var block = el('<div class="rc-block"></div>');
            block.appendChild(el('<div class="rc-block-title">Из ' + esc(tariffLabelFn(srcT)) + '</div>'));
            var chartWrap = el('<div class="hscroll-chart"></div>');
            var visBucket = monthly.bySource[srcT].slice(flowVp.from, flowVp.to + 1);
            chartWrap.appendChild(rcBuildMonthlyFlow(visBucket, visMonths, nodeOrder, tariffLabelFn, function (monthDate) {
              showMonthlyBreakdown(srcT, monthDate);
            }));
            block.appendChild(chartWrap);
            monthlyBlocksHolder.appendChild(block);
          });
          rcLinkScroll(Array.from(monthlyBlocksHolder.querySelectorAll(".hscroll-chart")));
        }
        renderMonthlyBlocks();

        function syncFlowRangeSelects() {
          unitRow.querySelector(".o1ctf-from").value = String(flowVp.from);
          unitRow.querySelector(".o1ctf-to").value = String(flowVp.to);
        }
        unitRow.querySelector(".o1ctf-from").addEventListener("change", function (e) {
          flowVp.from = parseInt(e.target.value, 10);
          if (flowVp.to < flowVp.from) flowVp.to = flowVp.from;
          syncFlowRangeSelects(); renderMonthlyBlocks();
        });
        unitRow.querySelector(".o1ctf-to").addEventListener("change", function (e) {
          flowVp.to = parseInt(e.target.value, 10);
          if (flowVp.from > flowVp.to) flowVp.from = flowVp.to;
          syncFlowRangeSelects(); renderMonthlyBlocks();
        });
        unitRow.querySelector(".o1ctf-full-range").addEventListener("click", function () {
          flowVp.from = 0; flowVp.to = monthly.months.length - 1;
          syncFlowRangeSelects(); renderMonthlyBlocks();
        });
      }
      renderBody();
      OFD1C_REFRESHERS[instanceId] = renderBody;
      return wrap;
    },
    onRemove: function (instanceId) { delete OFD1C_REFRESHERS[instanceId]; OFD1C_RC_FLOW_VIEWPORT.delete(instanceId); OFD1C_RC_SANKEY_ZOOM.delete(instanceId); },
  };

  var api = {
    WIDGETS: WIDGETS, widgetShell: widgetShell, fmtNum: fmtNum, fmtDate: fmtDate,
    // Только для теста (test/browser-smoke.js) -- прогнать реальный файл "Обмен с 1С" через
    // тот же парсер/матчинг, что использует b8-1c-upload, без похода через <input type=file>.
    ofd1cParseWorkbook: ofd1cParseWorkbook,
    ofd1cHandleFiles: ofd1cHandleFiles,
    ofd1cMatchClients: ofd1cMatchClients,
    ofd1cSetState: function (s) { OFD1C_STATE = s; },
    ofd1cDadataSetState: function (s) { OFD1C_DADATA_STATE = s; },
    ofd1cDadataGetState: function () { return OFD1C_DADATA_STATE; },
    ofd1cDadataInfo: ofd1cDadataInfo,
    ofd1cHandleDadataFile: ofd1cHandleDadataFile,
    ofd1cGetState: function () { return OFD1C_STATE; },
    ofd1cMatchedEntries: ofd1cMatchedEntries,
    ofd1cComputeChurnGradient: ofd1cComputeChurnGradient,
    ofd1cComputeReturnedByMonth: ofd1cComputeReturnedByMonth,
    ofd1cClientsNewInMonth: ofd1cClientsNewInMonth,
    ofd1cClientsChurnedInMonth: ofd1cClientsChurnedInMonth,
    ofd1cClientsReturnedInMonth: ofd1cClientsReturnedInMonth,
    ofd1cComputeGapFlow: ofd1cComputeGapFlow,
    ofd1cComputeGapActiveCount: ofd1cComputeGapActiveCount,
    ofd1cClientsChurnedInMonthGap: ofd1cClientsChurnedInMonthGap,
    ofd1cKassasAtPurchase: ofd1cKassasAtPurchase,
    ofd1cRenewalCount: ofd1cRenewalCount,
    ofd1cControlGroup: ofd1cControlGroup,
    ofd1cKassaDistribution: ofd1cKassaDistribution,
    ofd1cTenureDistribution: ofd1cTenureDistribution,
    ofd1cPartnerConversion: ofd1cPartnerConversion,
    ofd1cScoringCandidates: ofd1cScoringCandidates,
    ofd1cClientFeaturesAt: ofd1cClientFeaturesAt,
    ofd1cPartnerAdjustedIndexes: ofd1cPartnerAdjustedIndexes,
    ofd1cFitFromIndex: ofd1cFitFromIndex,
    ofd1cScoringModel: ofd1cScoringModel,
    ofd1cClientContacts: ofd1cClientContacts,
    ofd1cSalesExportSpec: ofd1cSalesExportSpec,
    OFD1C_CALL_STATUSES: OFD1C_CALL_STATUSES,
    OFD1C_SCORE_FEATURES: OFD1C_SCORE_FEATURES,
    ofd1cIndustryBucketLabel: ofd1cIndustryBucketLabel,
    ofd1cActiveOfdClients: ofd1cActiveOfdClients,
    ofd1cMedian: ofd1cMedian,
    ccBootstrapCustomChannelsFromServer: ccBootstrapCustomChannelsFromServer,
    // Только для теста (test/browser-smoke.js) -- честное состояние custom-каналов на холсте
    // (то же, что видит hasLocalCustom внутри ccBootstrapCustomChannelsFromServer), без
    // хождения через DOM: GridStack (animate:true) не убирает узел удалённого виджета из DOM
    // синхронно с кликом на "✕" -- querySelectorAll сразу после клика может ещё видеть
    // "зомби"-узел, хотя module-level состояние уже корректно очищено.
    ccCustomChannelNames: function () { return Array.from(ccCustomNames.values()).filter(function (n) { return n; }); },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDWidgets = api;
})(typeof window !== "undefined" ? window : globalThis);
