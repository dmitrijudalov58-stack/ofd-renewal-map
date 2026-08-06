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

  // Таблица касс с фастфильтрами (партнёр / тариф / статус / ИНН клиента / мин. продлений) —
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
      '<label>Продлений от <input type="number" class="f-minren" min="0" style="width:56px"></label>' +
      '</div>'
    );
    var tableHolder = el('<div></div>');
    var expandArea = el('<div style="margin-top:10px"></div>');
    wrap.appendChild(controls);
    wrap.appendChild(tableHolder);
    wrap.appendChild(expandArea);

    function apply() {
      var pf = controls.querySelector(".f-partner").value;
      var tf = controls.querySelector(".f-tariff").value;
      var sf = controls.querySelector(".f-status").value;
      var innf = controls.querySelector(".f-inn").value.trim().toLowerCase();
      var minr = parseInt(controls.querySelector(".f-minren").value, 10) || 0;
      var filtered = kassaArray.filter(function (k) {
        var alive = aliveOf(k);
        if (pf && (k.partner || "—") !== pf) return false;
        if (tf && (k.tariff || "—") !== tf) return false;
        if (sf === "alive" && !alive) return false;
        if (sf === "lapsed" && alive) return false;
        if (innf && !(k.clientKey || "").toLowerCase().includes(innf)) return false;
        if (k.renewals < minr) return false;
        return true;
      });
      filtered.sort(function (a, b) { return b.renewals - a.renewals; });
      var top = filtered.slice(0, limit);
      var rows = top.map(function (k) {
        var deadline = deadlineOf(k);
        var status = deadline ? riskPill(daysBetween(asOf, deadline)) : '<span class="status-pill crit"><span class="dot"></span>в оттоке</span>';
        return [k.rnm, k.clientKey || "—", k.partner || "—", k.renewals, k.tariff || "—", fmtDate(deadline), status];
      });
      tableHolder.innerHTML = "";
      expandArea.innerHTML = "";
      tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(filtered.length) + (filtered.length > top.length ? " · показаны первые " + top.length + ", остальное — через экспорт" : "") + ' · клик по строке — история тарифов кассы</div>'));
      var tableWrap = makeSortableTable(
        [{ label: "РНМ" }, { label: "ИНН клиента" }, { label: "Партнёр" }, { label: "Продлений", num: true }, { label: "Тариф" }, { label: "Окончание" }, { label: "Статус", html: true }],
        rows
      );
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
          var lines = k.codes.map(function (code, i) {
            var end = M ? M.individualEnd(code) : code.endDate;
            return '<div style="padding:4px 0;border-bottom:1px solid var(--line)">' +
              '<b>#' + (i + 1) + '</b> · активирован ' + fmtDate(code.activated) + ' · тариф «' + esc(code.tariff || "—") + '» · окончание ' + fmtDate(end) + '</div>';
          });
          expandArea.innerHTML = '<div style="font-size:12px;border-top:2px solid var(--ink);padding-top:8px"><b>РНМ ' + esc(rnm) + '</b> · история кодов (' + k.codes.length + '):' + lines.join("") + '</div>';
        });
      });
      wrap._getExportRows = function () {
        return filtered.map(function (k) {
          var alive = aliveOf(k);
          return { РНМ: k.rnm, ИННКлиента: k.clientKey || "", Партнёр: k.partner || "", Продлений: k.renewals, Тариф: k.tariff || "", ОбщаяДатаОкончания: fmtDate(deadlineOf(k)), Статус: alive ? "активна" : "в оттоке" };
        });
      };
      wrap._getFilteredKassas = function () { return filtered; };
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

  function widgetShell(id, title, type, scope, bodyHTML, footHTML, span2) {
    var scopeClass = scope === "период" ? "wchip period" : "wchip";
    var node = el(
      '<div class="widget' + (span2 ? " span-2" : "") + '" data-widget-id="' + id + '">' +
      '<div class="widget-head"><span class="grip">⋮⋮</span><h3>' + title + '</h3>' +
      '<span class="wchip">' + type + '</span><span class="' + scopeClass + '">' + scope + '</span>' +
      '<button class="remove-btn" aria-label="Убрать виджет">×</button></div>' +
      '<div class="widget-body"></div>' +
      (footHTML ? '<div class="widget-foot">' + footHTML + '</div>' : '') +
      '</div>'
    );
    node.querySelector(".widget-body").appendChild(bodyHTML instanceof Node ? bodyHTML : el('<div>' + bodyHTML + '</div>'));
    node.querySelector(".remove-btn").addEventListener("click", function () { node.remove(); });
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
      var head = statBlock(fmtNum(flow.clients.new), "новых клиентов за период", true);
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
    title: "Реанимированные клиенты", type: "карточка", scope: "период",
    render: function (model, ctx) {
      var flow = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      return statBlock(fmtNum(flow.clients.reanim), "вернулись в окне 31–91 день после даты окончания");
    },
  };

  WIDGETS["b1-netgrowth"] = {
    title: "Нетто-прирост базы", type: "график", scope: "период", span: true,
    render: function (model, ctx) {
      var series = ctx.M.computeMonthlySeries(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
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

      var rows = series.months.map(function (m, i) {
        var sign = net[i] > 0 ? "+" : "";
        return [MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear(), series.newByMonth[i], series.churnByMonth[i], sign + fmtNum(net[i])];
      });
      var table = makeSortableTable(
        [{ label: "Месяц" }, { label: "Новые", num: true }, { label: "Отток", num: true }, { label: "Нетто", num: true }],
        rows
      );
      var wrap = el("<div></div>");
      wrap.appendChild(el('<div>' + chart + '</div>'));
      var tableHolder = el('<div style="margin-top:14px"></div>');
      tableHolder.appendChild(table);
      wrap.appendChild(tableHolder);
      return wrap;
    },
  };

  WIDGETS["b1-kassdist"] = {
    title: "Распределение по числу касс", type: "график", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeSnapshot(model, ctx.asOf, { strict: ctx.strict });
      var b = s.kassaCountBuckets;
      return barList([
        { label: "1 касса", value: b["1"], color: "#3987e5" },
        { label: "2–3 кассы", value: b["2-3"], color: "#256abf" },
        { label: "4–9 касс", value: b["4-9"], color: "#184f95" },
        { label: "10+ касс", value: b["10+"], color: "#104281" },
      ]);
    },
  };

  WIDGETS["b1-risk"] = {
    title: "Клиенты «под риском»", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      var controlsId = "risk-days-" + Math.random().toString(36).slice(2, 7);
      var partnerOptions = Array.from(new Set(Array.from(model.clients.values()).filter(function (c) { return !c.phys; }).map(function (c) { return c.partner || "—"; }))).sort();
      var controls = el(
        '<div class="threshold-row">' +
        '<label><input type="radio" name="' + controlsId + '" checked> дней до окончания <input type="number" value="30" min="1" class="days-input"></label>' +
        '<label><input type="radio" name="' + controlsId + '"> дата окончания <input type="date" class="date-input"></label>' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      function renderTable() {
        var daysRadio = controls.querySelector('input[type="radio"]');
        var days = parseInt(controls.querySelector(".days-input").value, 10) || 30;
        var dateVal = controls.querySelector(".date-input").value;
        var pf = controls.querySelector(".f-partner").value;
        var fn = daysRadio.checked ? ctx.M.daysThresholdFn(ctx.asOf, days) : ctx.M.dateThresholdFn(dateVal ? new Date(dateVal) : ctx.asOf);
        var rows = ctx.M.clientsAtRisk(model, ctx.asOf, fn, { strict: ctx.strict });
        if (pf) rows = rows.filter(function (r) { return (r.partner || "—") === pf; });
        rows.sort(function (a, b) { return a.end - b.end; });
        var top = rows.slice(0, 100);
        var body = top.map(function (r) {
          var d = daysBetween(ctx.asOf, r.end);
          return [r.key, r.partner || "—", r.kassaCount, fmtDate(r.end), riskPill(d)];
        });
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(rows.length) + (rows.length > 100 ? " · показаны первые 100, остальное — через экспорт" : "") + '</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "ИНН" }, { label: "Партнёр" }, { label: "Касс", num: true }, { label: "Окончание" }, { label: "Статус", html: true }],
          body
        ));
        wrap._getExportRows = function () { return rows.map(function (r) { return { ИНН: r.key, Партнёр: r.partner, Касс: r.kassaCount, Окончание: fmtDate(r.end), Дней: daysBetween(ctx.asOf, r.end) }; }); };
      }
      controls.addEventListener("input", renderTable);
      controls.addEventListener("change", renderTable);
      renderTable();
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b1-age"] = {
    title: "Возрастная структура базы", type: "график", scope: "as-of",
    render: function (model, ctx) {
      var s = ctx.M.computeSnapshot(model, ctx.asOf, { strict: ctx.strict });
      var b = s.ageBuckets;
      return barList([
        { label: "младше 1 года", value: b["0-1y"], color: "#3987e5" },
        { label: "1–2 года", value: b["1-2y"], color: "#256abf" },
        { label: "2–3 года", value: b["2-3y"], color: "#184f95" },
        { label: "старше 3 лет", value: b["3y+"], color: "#104281" },
      ], { caption: "когорты не пересекаются, каждый клиент только в одной корзине" });
    },
  };

  WIDGETS["b1-churned"] = {
    title: "Клиенты к продлению после окончания", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      var partnerOptions = Array.from(new Set(Array.from(model.clients.values()).filter(function (c) { return !c.phys; }).map(function (c) { return c.partner || "—"; }))).sort();
      var controls = el(
        '<div class="threshold-row">' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      function renderTable() {
        var pf = controls.querySelector(".f-partner").value;
        var rows = ctx.M.clientsChurned(model, ctx.asOf);
        if (pf) rows = rows.filter(function (r) { return (r.partner || "—") === pf; });
        rows.sort(function (a, b) { return a.daysLapsed - b.daysLapsed; }); // недавно ушедшие сверху -- самые актуальные для дозвона
        var top = rows.slice(0, 100);
        var body = top.map(function (r) { return [r.key, r.partner || "—", r.kassaCount, fmtDate(r.end), r.daysLapsed + " дн."]; });
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(rows.length) + (rows.length > 100 ? " · показаны первые 100 (самые недавние), остальное — через экспорт" : "") + ' · не продлились 30+ дней, ещё не вернулись</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "ИНН" }, { label: "Партнёр" }, { label: "Касс", num: true }, { label: "Окончание" }, { label: "Дней в оттоке", num: true }],
          body
        ));
        wrap._getExportRows = function () { return rows.map(function (r) { return { ИНН: r.key, Партнёр: r.partner, Касс: r.kassaCount, Окончание: fmtDate(r.end), ДнейВОттоке: r.daysLapsed }; }); };
      }
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
    title: "Новые / отток / реанимация касс", type: "карточки", scope: "период", span: true,
    render: function (model, ctx) {
      var f = ctx.M.computeFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf).kassas;
      return '<div class="stat-row">' +
        '<div>' + statBlock(fmtNum(f.new), "новые кассы", true) + '</div>' +
        '<div>' + statBlock(fmtNum(f.churn), "отток касс (30+ дн. без продления)", true) + '</div>' +
        '<div>' + statBlock(fmtNum(f.reanim), "реанимация (31–91 день)", true) + '</div>' +
        '</div>';
    },
  };

  WIDGETS["b2-netgrowth"] = {
    title: "Нетто-прирост базы (кассы)", type: "график", scope: "период", span: true,
    render: function (model, ctx) {
      var series = ctx.M.computeMonthlySeriesKassas(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
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

      var rows = series.months.map(function (m, i) {
        var sign = net[i] > 0 ? "+" : "";
        return [MONTHS_SHORT[m.getMonth()] + " " + m.getFullYear(), series.newByMonth[i], series.churnByMonth[i], sign + fmtNum(net[i])];
      });
      var table = makeSortableTable(
        [{ label: "Месяц" }, { label: "Новые", num: true }, { label: "Отток", num: true }, { label: "Нетто", num: true }],
        rows
      );
      var wrap = el("<div></div>");
      wrap.appendChild(el('<div>' + chart + '</div>'));
      var tableHolder = el('<div style="margin-top:14px"></div>');
      tableHolder.appendChild(table);
      wrap.appendChild(tableHolder);
      return wrap;
    },
  };

  WIDGETS["b2-renewals"] = {
    title: "Кассы и продления", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var arr = Array.from(model.kassas.values());
      var wrap = kassaDetailTable(arr, ctx.asOf, { M: ctx.M, strict: ctx.strict });
      return wrap;
    },
    exportable: true,
  };

  // общий каркас "график сверху (снэпшот по ВСЕМ кассам) + кнопка рефреша + таблица с
  // фастфильтрами снизу" -- используется в b2-renewdist и b2-tariff. Без кнопки график и
  // отфильтрованная таблица расходятся в цифрах; рефреш пересчитывает график по текущему
  // фильтру таблицы (не автоматически на каждое изменение фильтра, только по клику).
  function chartPlusFilterableTable(arr, ctx, buildChartRows, chartOpts) {
    var wrap = el('<div></div>');
    var chartHolder = el('<div></div>');
    chartHolder.appendChild(el(barList(buildChartRows(arr), chartOpts)));
    var refreshBtn = el('<button class="export-btn" style="margin-top:8px">⟳ обновить график по текущему фильтру</button>');
    wrap.appendChild(chartHolder);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(el('<div style="height:14px"></div>'));
    var table = kassaDetailTable(arr, ctx.asOf, { M: ctx.M, strict: ctx.strict });
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
    title: "Распределение продлений", type: "график + таблица", scope: "as-of", span: true,
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
      return chartPlusFilterableTable(arr, ctx, buildRows, { caption: "число касс в каждой корзине" });
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

  WIDGETS["b2-risk"] = {
    title: "Кассы «под риском»", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var wrap = el('<div></div>');
      var controlsId = "krisk-" + Math.random().toString(36).slice(2, 7);
      var partnerOptions = Array.from(new Set(Array.from(model.kassas.values()).map(function (k) { return k.partner || "—"; }))).sort();
      var controls = el(
        '<div class="threshold-row">' +
        '<label><input type="radio" name="' + controlsId + '" checked> дней до окончания <input type="number" value="30" min="1" class="days-input"></label>' +
        '<label><input type="radio" name="' + controlsId + '"> дата окончания <input type="date" class="date-input"></label>' +
        '<label>Партнёр <select class="f-partner"><option value="">все</option>' + partnerOptions.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("") + '</select></label>' +
        '</div>'
      );
      var tableHolder = el('<div></div>');
      wrap.appendChild(controls); wrap.appendChild(tableHolder);
      function renderTable() {
        var daysRadio = controls.querySelector('input[type="radio"]');
        var days = parseInt(controls.querySelector(".days-input").value, 10) || 30;
        var dateVal = controls.querySelector(".date-input").value;
        var pf = controls.querySelector(".f-partner").value;
        var fn = daysRadio.checked ? ctx.M.daysThresholdFn(ctx.asOf, days) : ctx.M.dateThresholdFn(dateVal ? new Date(dateVal) : ctx.asOf);
        var rows = ctx.M.kassasAtRisk(model, ctx.asOf, fn, { strict: ctx.strict });
        if (pf) rows = rows.filter(function (r) { return (r.partner || "—") === pf; });
        rows.sort(function (a, b) { return a.end - b.end; });
        var top = rows.slice(0, 100);
        var body = top.map(function (r) { return [r.rnm, r.partner || "—", r.renewals, fmtDate(r.end), riskPill(daysBetween(ctx.asOf, r.end))]; });
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(rows.length) + '</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "РНМ" }, { label: "Партнёр" }, { label: "Продлений", num: true }, { label: "Окончание" }, { label: "Статус", html: true }], body
        ));
        wrap._getExportRows = function () { return rows.map(function (r) { return { РНМ: r.rnm, Партнёр: r.partner, Продлений: r.renewals, Окончание: fmtDate(r.end) }; }); };
      }
      controls.addEventListener("input", renderTable);
      controls.addEventListener("change", renderTable);
      renderTable();
      return wrap;
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
      var active = partners.filter(function (p) { return p.clients > 0 || p.kassas > 0; }).length;
      return statBlock(fmtNum(active), "с хотя бы 1 активной кассой/клиентом на as-of");
    },
  };

  WIDGETS["b3-table"] = {
    title: "Таблица по партнёрам", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var partners = ctx.M.computePartners(model, ctx.asOf, { strict: ctx.strict });
      var wrap = el('<div></div>');
      var controls = el('<div class="threshold-row"><label>Партнёр <input type="text" class="f-name" placeholder="поиск по названию" style="width:220px"></label></div>');
      var tableHolder = el('<div></div>');
      wrap.appendChild(controls);
      wrap.appendChild(tableHolder);

      function apply() {
        var q = controls.querySelector(".f-name").value.trim().toLowerCase();
        var filtered = q ? partners.filter(function (p) { return p.name.toLowerCase().includes(q); }) : partners.slice();
        filtered.sort(function (a, b) { return b.clients - a.clients; });
        var top = filtered.slice(0, 150);
        var rows = top.map(function (p) { return [p.name, p.clients, p.kassas, p.reserve]; });
        tableHolder.innerHTML = "";
        tableHolder.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">найдено ' + fmtNum(filtered.length) + (filtered.length > top.length ? " · показаны первые 150, остальное — через экспорт" : "") + '</div>'));
        tableHolder.appendChild(makeSortableTable(
          [{ label: "Партнёр" }, { label: "Клиентов", num: true }, { label: "Касс", num: true }, { label: "Резерв", num: true }], rows
        ));
        wrap._getExportRows = function () { return filtered.map(function (p) { return { Партнёр: p.name, Клиенты: p.clients, Кассы: p.kassas, Резерв: p.reserve }; }); };
      }
      controls.addEventListener("input", apply);
      apply();
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-top"] = {
    // Изначально считался по новым клиентам/кассам/продлениям ЗА ПЕРИОД — по фидбэку упростили
    // до общих количеств на as-of (то же, что в "Таблице по партнёрам", но с фокусом на топ по объёму).
    // Раз метрика перестала быть потоковой — чип "период" на "as-of", иначе он бы врал.
    title: "Топ партнёров по объёму", type: "таблица", scope: "as-of", span: true,
    render: function (model, ctx) {
      var arr = ctx.M.computePartners(model, ctx.asOf, { strict: ctx.strict });
      arr.sort(function (a, b) { return b.clients - a.clients; });
      var top = arr.slice(0, 100);
      var rows = top.map(function (p) { return [p.name, p.clients, p.kassas]; });
      var wrap = el('<div></div>');
      wrap.appendChild(makeSortableTable(
        [{ label: "Партнёр" }, { label: "Количество клиентов", num: true }, { label: "Количество касс", num: true }], rows
      ));
      wrap._getExportRows = function () { return arr.map(function (p) { return { Партнёр: p.name, КоличествоКлиентов: p.clients, КоличествоКасс: p.kassas }; }); };
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
      var wrap = el('<div><div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">всего в резерве ' + fmtNum(reserve.total) + ' · старше года — ' + fmtNum(reserve.olderThanYear) + '</div></div>');
      wrap.appendChild(makeSortableTable([{ label: "Партнёр" }, { label: "Неактивир. кодов", num: true }], top.map(function (p) { return [p.name, p.count]; })));
      wrap._getExportRows = function () { return arr.map(function (p) { return { Партнёр: p.name, НеактивированныеКоды: p.count }; }); };
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
    title: "Топ оттока по партнёрам", type: "таблица", scope: "период", span: true,
    render: function (model, ctx) {
      var rows = ctx.M.computePartnerFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      rows = rows.filter(function (p) { return p.churnedClients > 0; });
      rows.sort(function (a, b) { return b.churnedClients - a.churnedClients; });
      var top = rows.slice(0, 100);
      var body = top.map(function (p) { return [p.name, p.churnedClients, p.retention !== null ? fmtPct(p.retention) : "—"]; });
      var wrap = el('<div></div>');
      wrap.appendChild(el('<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">retention = 1 − (отток / клиентов у партнёра на начало периода) · отток по формуле «не продлился 30+ дней»</div>'));
      wrap.appendChild(makeSortableTable(
        [{ label: "Партнёр" }, { label: "Клиентов в оттоке", num: true }, { label: "Retention" }],
        body
      ));
      wrap._getExportRows = function () { return rows.map(function (p) { return { Партнёр: p.name, КлиентовВОттоке: p.churnedClients, Retention: p.retention !== null ? (p.retention * 100).toFixed(1) + "%" : "" }; }); };
      return wrap;
    },
    exportable: true,
  };

  WIDGETS["b3-partner-eff"] = {
    title: "Партнёр: новые / отток / % эффективности", type: "таблица", scope: "период", span: true,
    render: function (model, ctx) {
      var rows = ctx.M.computePartnerFlow(model, ctx.periodStart, ctx.periodEnd, ctx.asOf);
      rows.sort(function (a, b) { return b.newClients - a.newClients; });
      var top = rows.slice(0, 150);
      var body = top.map(function (p) { return [p.name, p.newClients, p.churnedClients, p.retention !== null ? fmtPct(p.retention) : "—"]; });
      var wrap = el('<div></div>');
      wrap.appendChild(makeSortableTable(
        [{ label: "Партнёр" }, { label: "Новых", num: true }, { label: "Отток", num: true }, { label: "% эффективности (retention)" }],
        body
      ));
      wrap._getExportRows = function () { return rows.map(function (p) { return { Партнёр: p.name, Новых: p.newClients, Отток: p.churnedClients, Эффективность: p.retention !== null ? (p.retention * 100).toFixed(1) + "%" : "" }; }); };
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
          var partnerArea = el('<div style="margin-top:10px"></div>');
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
      var expandArea = el('<div style="margin-top:10px"></div>');
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

  var api = { WIDGETS: WIDGETS, widgetShell: widgetShell, fmtNum: fmtNum, fmtDate: fmtDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDWidgets = api;
})(typeof window !== "undefined" ? window : globalThis);
