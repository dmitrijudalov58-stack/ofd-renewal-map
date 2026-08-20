/*
 * Рендер виджетов: DOM-слой поверх js/metrics.js.
 * Каждый виджет — запись в WIDGETS: { title, type, scope, span, render(model, ctx) -> HTMLElement }.
 * ctx = { M, periodStart, periodEnd, asOf } — M это window.OFDMetrics.
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
      '<label>Статус <select class="f-status"><option value="">все</option><option value="alive">активна</option><option value="lapsed">в оттоке</option></select></label>' +
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
        var status = deadline ? riskPill(daysBetween(asOf, deadline)) : '<span class="status-pill crit"><span class="dot"></span>в оттоке</span>';
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
          row.Статус = alive ? "активна" : "в оттоке";
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
    var n = months.length;
    var x = function (i) { return n <= 1 ? padL : padL + (i / (n - 1)) * (w - padL - padR); };
    var y = function (v) { return padT + (1 - v / maxV) * (h - padT - padB); };

    function pathFor(values) {
      return values.map(function (v, i) { return (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(v).toFixed(1); }).join(" ");
    }

    var svgParts = [];
    svgParts.push('<line class="gridline" x1="' + padL + '" y1="' + (padT) + '" x2="' + (w - padR) + '" y2="' + (padT) + '"></line>');
    svgParts.push('<line class="gridline" x1="' + padL + '" y1="' + (padT + (h - padT - padB) / 2) + '" x2="' + (w - padR) + '" y2="' + (padT + (h - padT - padB) / 2) + '"></line>');
    svgParts.push('<line class="baseline" x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padR) + '" y2="' + (h - padB) + '"></line>');

    series.forEach(function (s) {
      var d = pathFor(s.values);
      if (opts.area) {
        var areaD = d + " L" + x(n - 1).toFixed(1) + "," + (h - padB) + " L" + x(0).toFixed(1) + "," + (h - padB) + " Z";
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
      svgParts.push('<text class="value-label" x="' + (x(lastI) + 6).toFixed(1) + '" y="' + (y(s.values[lastI]) - 6).toFixed(1) + '">' + fmtNum(s.values[lastI]) + '</text>');
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
      parts.push('<text class="value-label" x="' + cx.toFixed(1) + '" y="' + (y(d.value) - 5).toFixed(1) + '" text-anchor="middle">' + fmtNum(d.value) + '</text>');
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
  function renderDrillTable(container, list, columns, filterFields, entityLabel, monthLabel, limit) {
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
      tableHolder.appendChild(scrollWrap);
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
            renderDrillTable(expandArea, list, columns, filterFields, entityLabel, label, limit);
          });
        });
      }
    }
    if (toggle) toggle.addEventListener("change", renderTable);
    renderTable();

    wrap.appendChild(tableHolder);
    wrap.appendChild(expandArea);
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
  function gradientFlowTable(series, activeByMonth, unitLabel) {
    var wrap = el("<div></div>");
    var tableHolder = el('<div></div>');
    wrap.appendChild(tableHolder);

    function pct(n, denom) {
      return denom > 0 ? fmtPct(n / denom) : "—";
    }

    function render() {
      var rows = series.months.map(function (m, i) {
        var denom = activeByMonth[i];
        var net = series.newByMonth[i] - series.churnByMonth[i];
        var sign = net > 0 ? "+" : "";
        var churnText = '<span style="color:var(--crit)">' + fmtNum(series.churnByMonth[i]) + '</span>';
        if (series.graceByMonth[i] > 0) {
          churnText += ' <span style="color:var(--warn)">(' + fmtNum(series.graceByMonth[i]) + ' не продлились)</span>';
        }
        return [
          MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear(),
          fmtNum(series.newByMonth[i]),
          churnText,
          sign + fmtNum(Math.abs(net)),
          fmtNum(denom),
          pct(series.churnByMonth[i], denom),
          pct(series.newByMonth[i], denom),
        ];
      });
      tableHolder.innerHTML = "";
      tableHolder.appendChild(makeSortableTable(
        [{ label: "Месяц" }, { label: "Новые" }, { label: "Факт. отток (не продлились)", html: true }, { label: "Дельта изменения" },
         { label: "Кол-во " + unitLabel, num: true }, { label: "% оттока", num: true }, { label: "% притока", num: true }],
        rows
      ));
    }
    render();
    wrap.appendChild(el('<div class="stat-label" style="margin-top:6px">Красным — подтверждённый отток (30+ дней). Оранжевым в скобках — ещё не продлились (0-30 дней), может стать оттоком позже. «Кол-во ' + unitLabel + '» — действующих на КОНЕЦ соответствующего месяца (не сейчас) — от этого числа считаются % оттока/притока в той же строке.</div>'));
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
      var flow = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      var series = ctx.M.computeMonthlySeries(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      var head = '<div class="stat-row">' +
        '<div>' + statBlock(fmtNum(flow.clients.new), "новые (раньше не было)", true) + '</div>' +
        '<div>' + statBlock(fmtNum(flow.clients.reanim), "вернувшиеся (31–90 дней после ухода)", true) + '</div>' +
        '</div>';
      var chart = lineChart(series.months, [{ label: "Новые", values: series.newByMonth, color: "var(--s1)" }], { area: true });
      return '<div>' + head + '<div style="margin-top:10px">' + chart + '</div></div>';
    },
  };

  WIDGETS["b1-churn"] = {
    title: "Отток клиентов за период", type: "карточка + график", scope: "период", span: true,
    render: function (model, ctx) {
      var flow = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      var series = ctx.M.computeMonthlySeries(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      var head = statBlock(fmtNum(flow.clients.churn), "клиентов не продлились 30+ дней (не считая тех, кто ещё вернулся)", true);
      var chart = lineChart(series.months, [{ label: "Отток", values: series.churnByMonth, color: "var(--s2)" }], { area: true });
      var note = '<div class="stat-label" style="margin-top:6px">Ретроспективно: месяц окончания кода, статус известен только когда с даты окончания прошло 31+ дней от as-of — последние месяцы периода могут быть занижены.</div>';
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

  WIDGETS["b1-netgrowth"] = {
    // Переименован "Нетто-прирост базы" -> "Прирост базы" (п.3.3). 3 градации оттока +
    // тумблер % (п.3.1/3.2/3.4). Накопительная кривая — по подтверждённому оттоку (не
    // трогает не продлившихся/прогноз, те ещё не факт). Вкладки Новые/Отток/Возвращённые
    // (п.3.5, 2026-08-06) — существующий накопительный график НЕ тронут, стал одной из
    // вкладок (первой, по умолчанию). Только клиенты (ИНН) — не кассы, п.3.5 про них.
    title: "Прирост базы", type: "график", scope: "период", span: true,
    render: function (model, ctx) {
      var series = ctx.M.computeChurnGradient(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, false);
      var activeByMonth = activeCountsAtMonthEnds(model, series.months, ctx, false);
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
        var cum = [], net = [], acc = 0;
        for (var i = 0; i < series.months.length; i++) {
          var n = series.newByMonth[i] - series.churnByMonth[i];
          net.push(n); acc += n; cum.push(acc);
        }
        var tooltips = series.months.map(function (m, i) {
          var sign = net[i] > 0 ? "+" : "";
          return MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear() + ": прирост " + sign + fmtNum(net[i]) + " · накопительно " + fmtNum(cum[i]);
        });
        var chart = lineChart(series.months, [{ label: "Накопительно", values: cum, color: "var(--s1)", tooltips: tooltips }], { area: true });
        var v = el("<div></div>");
        v.appendChild(el('<div>' + chart + '</div>'));
        var tableHolder = el('<div style="margin-top:14px"></div>');
        tableHolder.appendChild(gradientFlowTable(series, activeByMonth, "клиентов"));
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
          viewHolder.appendChild(monthlyCountBoard(series.months, series.churnByMonth, "Отток", "var(--crit)", function (m) { return ctx.M.clientsChurnedInMonth(model, m, ctx.asOf); }, { columns: CLIENT_CHURN_COLUMNS, activeTotalByMonth: activeByMonth, exportTitle: "Прирост базы — отток клиентов" }));
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
      var controls = el(
        '<div class="threshold-row">' +
        '<label title="Точка отсчёта для ретроспективного запроса — например «кто заканчивается в августе», даже если сегодня уже середина месяца. Жив/дедлайн кассы считается НА ЭТУ дату, не на сегодня. Пусто — как раньше, всё считается от сегодня (as-of).">с даты <input type="date" class="from-input"></label>' +
        '<label><input type="radio" name="' + controlsId + '" checked> дней до окончания <input type="number" value="30" min="1" class="days-input"></label>' +
        '<label><input type="radio" name="' + controlsId + '"> дата окончания <input type="date" class="date-input"></label>' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
      var caption = el('<div class="stat-label" style="margin-bottom:6px"></div>');
      wrap.appendChild(caption);
      wrap.appendChild(controls);
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
        caption.textContent = from
          ? "Ретроспективный запрос от " + fmtDate(from) + " — не срез на сегодня (сегодня факт. " + fmtDate(asOf) + ", момент загрузки файла)"
          : "Всегда на сегодня (" + fmtDate(asOf) + ", момент загрузки файла) — не зависит от фильтра периода";
        var pf = controls.querySelector(".f-partner").value;
        var fn = daysRadio.checked ? ctx.M.daysThresholdFn(refDate, days) : ctx.M.dateThresholdFn(dateVal ? new Date(dateVal) : refDate);
        var raw = ctx.M.clientsAtRisk(model, refDate, fn, { strict: ctx.strict });
        if (pf) raw = raw.filter(function (r) { return (r.partner || "—") === pf; });
        raw.sort(function (a, b) { return a.end - b.end; });
        var rows = raw.map(function (r) {
          var kassaDetails = (r.kassaDetails || []).map(function (kd) {
            return { rnm: kd.rnm, tariff: kd.tariff, end: kd.end, statusText: riskPillText(daysBetween(refDate, kd.end)) };
          });
          return { key: r.key, org: r.org, partner: r.partner, partnerInn: r.partnerInn, kassasToRenew: r.kassasToRenew, end: r.end, exportDays: daysBetween(refDate, r.end), statusHtml: riskPill(daysBetween(refDate, r.end)), kassaDetails: kassaDetails };
        });
        renderClientListTable(tableHolder, expandArea, rows, wrap, model);
      }
      controls.addEventListener("input", renderTable);
      controls.addEventListener("change", renderTable);
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
      var controls = el(
        '<div class="threshold-row">' +
        '<label title="Если заполнено -- и клиент, и счётчик «касс к продлению» считаются ТОЛЬКО по кассам с датой окончания в этом диапазоне (старые кассы вне диапазона не попадают в счёт). Пусто -- как раньше, окно 0-90 дней от сегодня.">от <input type="date" class="from-input"> до <input type="date" class="to-input"></label>' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '<label>ИНН клиента <input type="text" class="f-inn" placeholder="поиск" style="width:110px"></label>' +
        '<label>Наименование клиента <input type="text" class="f-org" placeholder="поиск" style="width:140px"></label>' +
        '<label>ИНН партнёра <input type="text" class="f-pinn" placeholder="поиск" style="width:110px"></label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      var expandArea = el('<div class="expand-scroll" style="margin-top:10px"></div>');
      var caption = el('<div class="stat-label" style="margin-bottom:6px"></div>');
      wrap.appendChild(caption);
      wrap.appendChild(controls);
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
        var raw;
        if (from && to) {
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
        raw.sort(function (a, b) { return a.daysOverdue - b.daysOverdue; }); // недавно ушедшие сверху -- самые актуальные для дозвона
        var rows = raw.map(function (r) {
          var kassaDetails = (r.kassaDetails || []).map(function (kd) {
            return { rnm: kd.rnm, tariff: kd.tariff, end: kd.end, statusText: overduePillText(daysBetween(kd.end, asOf)) };
          });
          return { key: r.key, org: r.org, partner: r.partner, partnerInn: r.partnerInn, kassasToRenew: r.kassasToRenew, end: r.end, exportDays: r.daysOverdue, statusHtml: overduePill(r.daysOverdue), kassaDetails: kassaDetails };
        });
        renderClientListTable(tableHolder, expandArea, rows, wrap, model);
      }
      controls.addEventListener("input", renderTable);
      controls.addEventListener("change", renderTable);
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
      var f = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf).kassas;
      return '<div class="stat-row">' +
        '<div>' + statBlock(fmtNum(f.new), "новые кассы", true) + '</div>' +
        '<div>' + statBlock(fmtNum(f.churn), "отток касс (30+ дн. без продления)", true) + '</div>' +
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
      var series = ctx.M.computeChurnGradient(model, ctx.periodStart, ctx.periodEnd, ctx.asOf, true);
      var activeByMonth = activeCountsAtMonthEnds(model, series.months, ctx, true);
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
        var cum = [], net = [], acc = 0;
        for (var i = 0; i < series.months.length; i++) {
          var n = series.newByMonth[i] - series.churnByMonth[i];
          net.push(n); acc += n; cum.push(acc);
        }
        var tooltips = series.months.map(function (m, i) {
          var sign = net[i] > 0 ? "+" : "";
          return MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear() + ": прирост " + sign + fmtNum(net[i]) + " · накопительно " + fmtNum(cum[i]);
        });
        var chart = lineChart(series.months, [{ label: "Накопительно", values: cum, color: "var(--s1)", tooltips: tooltips }], { area: true });
        var v = el("<div></div>");
        v.appendChild(el('<div>' + chart + '</div>'));
        var tableHolder = el('<div style="margin-top:14px"></div>');
        tableHolder.appendChild(gradientFlowTable(series, activeByMonth, "касс"));
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
          viewHolder.appendChild(monthlyCountBoard(series.months, series.newByMonth, "Новых", "var(--s1)", function (m) { return ctx.M.kassasNewInMonth(model, m); }, Object.assign({ exportTitle: "Прирост базы (кассы) — новые кассы" }, kassaDrillOpts)));
        } else if (v === "churn") {
          viewHolder.appendChild(monthlyCountBoard(series.months, series.churnByMonth, "Отток", "var(--crit)", function (m) { return ctx.M.kassasChurnedInMonth(model, m, ctx.asOf); }, Object.assign({ exportTitle: "Прирост базы (кассы) — отток касс" }, kassaChurnOpts)));
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
      return chartPlusFilterableTable(arr, ctx, buildRows, { caption: "число касс в каждой корзине" }, { hideTariff: true });
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
    title: "Распределение по сроку тарифа", type: "график + таблица", scope: "as-of", span: true,
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
      var arr = Array.from(reserve.byPartner.entries()).map(function (e) { return { name: e[0], count: e[1] }; });
      arr.sort(function (a, b) { return b.count - a.count; });
      var top = arr.slice(0, 50);
      var wrap = el('<div><div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">всего в резерве ' + fmtNum(reserve.total) + ' · старше года — ' + fmtNum(reserve.olderThanYear) + ' · выгрузка — детально по каждому коду, все поля исходной выгрузки</div></div>');
      wrap.appendChild(makeSortableTable([{ label: "Партнёр" }, { label: "Неактивир. кодов", num: true }], top.map(function (p) { return [p.name, p.count]; })));
      // детальная выгрузка (п.22, 2026-08-06) -- как в оригинальной выгрузке, по каждому
      // коду резерва все поля, а не агрегат "партнёр+count"
      wrap._getExportRows = function () {
        return model.reserveRows.map(function (r) {
          return {
            PIN: r.pin, Статус: r.status, Тариф: r.tariff, ТипАктивации: r.activationType,
            ДатаСоздания: fmtDate(r.created), ДатаАктивации: fmtDate(r.activated),
            ДатаОкончания: fmtDate(r.endDate), ОбщаяДатаОкончания: fmtDate(r.overallEnd), РНМ: r.rnm || "",
            Организация: r.org || "", ИННОрганизации: r.innOrg || "", ИННФизлица: r.innPhys || "",
            Партнёр: r.partner || "", ИННПартнёра: r.partnerInn || "", ЦентрПродаж: r.salesCenter || "", ТипПродажи: r.salesType || "",
          };
        });
      };
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-channels"] = {
    title: "Разбивка по каналам", type: "таблица + график", scope: "as-of", span: true,
    render: function (model, ctx) {
      var ch = ctx.M.computeChannels(model, ctx.asOf);
      var chart = barList([
        { label: "Оля Зибер", value: ch["Ольга Зибер"], color: "var(--s1)" },
        { label: "Лариса П.", value: ch["Лариса Пенигина"], color: "var(--s2)" },
        { label: "Партнёры", value: ch["Партнёры"], color: "var(--s3)" },
      ], { caption: "число активных клиентов, закреплённых за каналом, на as-of" });

      var byChannel = ctx.M.computePartnersByChannel(model, ctx.asOf, { strict: ctx.strict });
      var wrap = el('<div></div>');
      wrap.appendChild(el(chart));
      var controls = el(
        '<div class="threshold-row" style="margin-top:12px">' +
        '<label>Канал <select class="f-channel"><option value="">выбери канал, чтобы увидеть партнёров</option>' +
        '<option>Ольга Зибер</option><option>Лариса Пенигина</option><option>Партнёры</option>' +
        '</select></label></div>'
      );
      var tableHolder = el('<div style="margin-top:8px"></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      function apply() {
        var sel = controls.querySelector(".f-channel").value;
        if (!sel) {
          tableHolder.innerHTML = "";
          wrap._getExportRows = function () { return byChannel.map(function (p) { return { Партнёр: p.name, Канал: p.channel, Клиенты: p.clients, Кассы: p.kassas, Резерв: p.reserve }; }); };
          return;
        }
        var filtered = byChannel.filter(function (p) { return p.channel === sel; });
        filtered.sort(function (a, b) { return b.clients - a.clients; });
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">партнёров в канале «' + sel + '»: ' + fmtNum(filtered.length) + '</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "Партнёр" }, { label: "Клиентов", num: true }, { label: "Касс", num: true }, { label: "Резерв", num: true }],
          filtered.map(function (p) { return [p.name, p.clients, p.kassas, p.reserve]; })
        ));
        wrap._getExportRows = function () { return filtered.map(function (p) { return { Партнёр: p.name, Канал: p.channel, Клиенты: p.clients, Кассы: p.kassas, Резерв: p.reserve }; }); };
      }
      controls.addEventListener("change", apply);
      apply();
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-churn-top"] = {
    // Формула п.23 (2026-08-06): было "база на начало периода + retention%", стало
    // "новые + отток + база на КОНЕЦ периода" — три голых числа: пришло/ушло/осталось.
    title: "Топ оттока по партнёрам", type: "таблица, раскрывается", scope: "период", span: true,
    render: function (model, ctx) {
      var rows = ctx.M.computePartnerFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
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
      wrap.appendChild(el('<div style="height:16px"></div>'));
      wrap.appendChild(el('<div class="stat-label" style="margin-bottom:6px">Помесячно по всей базе (не по партнёрам — контекст, почему итог выше может быть занижен)</div>'));
      var series = ctx.M.computeMonthlySeries(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      wrap.appendChild(monthlyFlowTable(series, ctx));
      wrap._getExportRows = function () { return rows.map(function (p) { return { Партнёр: p.name, НовыхКлиентов: p.newClients, КлиентовВОттоке: p.churnedClients, Клиентов0_30Дней: p.pendingClients, КлиентовНаКонецПериода: p.baseAtEnd }; }); };
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-partner-eff"] = {
    title: "Партнёр: новые / отток / % эффективности (кассы)", type: "таблица", scope: "период", span: true,
    render: function (model, ctx) {
      var rows = ctx.M.computePartnerFlowKassas(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
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
      var series = ctx.M.computeMonthlySeriesKassas(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
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
          var lines = [];
          Array.from(p.years.keys()).sort().forEach(function (y) {
            var months = p.years.get(y);
            var parts = [];
            for (var m = 0; m < 12; m++) if (months.get(m)) parts.push(MONTHS_SHORT[m] + ": " + months.get(m));
            lines.push('<div style="margin-bottom:4px"><b>' + y + '</b> — ' + parts.join(", ") + '</div>');
          });
          expandArea.innerHTML = '<div style="font-size:12px;border-top:1px solid var(--line);padding-top:8px">' + (lines.join("") || "нет данных по датам") + '</div>';
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
      var chart = barChartVertical([
        { label: "Создано", value: f.created },
        { label: "Активировано", value: f.activated },
        { label: "Неактивировано", value: f.notActivated },
        { label: "Отозвано", value: f.revoked },
      ], { color: "var(--brand)" });
      var lag = f.avgLagDays !== null ? f.avgLagDays.toFixed(1) + " дн." : "—";
      var caption = '<div class="stat-label" style="margin-top:6px">Активировано — клиент привязал код к себе (статус «Зарегистрировано»). Неактивировано — до сих пор в резерве партнёра (Новый/Выдан). Столбцы 2-4 честно делят «Создано». Среднее время создание → активация: ' + lag + '</div>';
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
    var names = rows.map(function (r) { return r.name; }).sort();
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
  function ccBuildChannelBody(channelName, model, ctx, instanceId) {
    var asn = ccAssignment(model, ctx);
    var mine = asn.byChannel[channelName] || [];
    var free = asn.free;

    var wrap = el('<div></div>');
    var head = el(
      '<div class="cc-settings">' +
      '<button type="button" class="cc-toggle">▸ Партнёры канала (' + mine.length + ')</button>' +
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
      '<div class="cc-list"></div>' +
      '</div>' +
      '</div>'
    );
    var resultsBox = el('<div class="cc-results"></div>');
    wrap.appendChild(head);
    wrap.appendChild(resultsBox);

    var toggleBtn = head.querySelector(".cc-toggle");
    var bodyEl = head.querySelector(".cc-body");
    var searchInput = head.querySelector(".cc-search");
    var listEl = head.querySelector(".cc-list");
    var fromInput = head.querySelector(".cc-from");
    var toInput = head.querySelector(".cc-to");
    var checkInput = head.querySelector(".cc-check");
    var churnInput = head.querySelector(".cc-churn");

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
      var mineF = mine.filter(function (n) { return !term || n.toLowerCase().indexOf(term) !== -1; });
      var freeF = free.filter(function (n) { return !term || n.toLowerCase().indexOf(term) !== -1; });
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

      var html = "";
      html += '<div class="cc-metric">' + statBlock(fmtNum(kassas.length), "Касс к продлению") + '</div>';
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

  var api = { WIDGETS: WIDGETS, widgetShell: widgetShell, fmtNum: fmtNum, fmtDate: fmtDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDWidgets = api;
})(typeof window !== "undefined" ? window : globalThis);
