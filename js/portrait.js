/*
 * B10 «Портрет клиента»: виджеты поверх portrait-data.json.
 *
 * Данные готовит офлайн-скрипт scripts/build-portrait-data.js (выгрузка ОФД + DaData-кэш +
 * ФНС + модель «шанс вернуться»). В BI файл загружается кнопкой «Портрет» в шапке; на сайт
 * он не кладётся (в нём телефоны и email отвалившихся для CSV продаж).
 * Расчёты клиента/кассы/оттока здесь не повторяются: всё приходит готовым, виджеты только
 * рисуют и фильтруют. Регистрация в OFDWidgets.WIDGETS, без правок widgets.js.
 */
(function (root) {
  "use strict";
  var OW = root.OFDWidgets;
  if (!OW || !OW.WIDGETS) return;
  var WIDGETS = OW.WIDGETS;
  var SEGS = ["A", "B", "C", "D"];
  var COL = { A: "#2a52e0", B: "#7a5cf0", C: "#14a89a", D: "#e0963a" };
  var RNG = { A: "10 и более касс", B: "6–9 касс", C: "2–5 касс", D: "1 касса" };
  var STATE = { data: null, fileName: null };
  var REFRESH = {};

  // ---------- утилиты
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function fmt(x) { return Math.round(x).toLocaleString("ru-RU"); }
  function pc(a, b, d) { return b ? (100 * a / b).toFixed(d === undefined ? 1 : d).replace(".", ",") + "%" : "—"; }
  function num(x, d) { return Number(x).toFixed(d === undefined ? 1 : d).replace(".", ","); }
  function segOf(k) { return k >= 10 ? "A" : k >= 6 ? "B" : k >= 2 ? "C" : "D"; }
  function tip() { return esc(Array.prototype.slice.call(arguments).join("<br>")); }
  function liq(l, t) { return t ? '<span class="pt-liq">' + fmt(l) + " · " + pc(l, t) + "</span>" : ""; }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
  function q(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
  function csvDownload(name, text) {
    var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function fmtPhone(p) {
    if (!p) return "";
    var d = String(p).replace(/\D/g, "");
    if (d.length === 11 && (d[0] === "7" || d[0] === "8")) return "+7 (" + d.slice(1, 4) + ") " + d.slice(4, 7) + "-" + d.slice(7, 9) + "-" + d.slice(9);
    return String(p);
  }
  function innCell(v) { return '="' + String(v) + '"'; }

  // общая подсказка по [data-tip] (один обработчик на страницу)
  var tipEl = null;
  function ensureTip() {
    if (tipEl) return;
    tipEl = document.createElement("div"); tipEl.className = "pt-tip"; document.body.appendChild(tipEl);
    document.addEventListener("mousemove", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!t) { tipEl.style.display = "none"; return; }
      tipEl.innerHTML = t.getAttribute("data-tip"); tipEl.style.display = "block";
      var x = e.clientX + 14, y = e.clientY + 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
      tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
    });
  }

  // обёртка виджета: до загрузки файла показывает подсказку, после загрузки рисует body(wrap, data)
  function def(title, type, defaultH, body) {
    return {
      title: title, type: type, scope: "as-of", span: true, defaultH: defaultH,
      render: function (model, ctx, instanceId) {
        ensureTip();
        var wrap = document.createElement("div"); wrap.className = "pt";
        function draw() {
          wrap.innerHTML = "";
          if (!STATE.data) { wrap.appendChild(el('<div class="placeholder-body">Файл не загружен: нажми «Портрет» в шапке и выбери portrait-data.json (его готовит scripts/build-portrait-data.js).</div>')); return; }
          body(wrap, STATE.data);
        }
        draw();
        if (instanceId) REFRESH[instanceId] = draw;
        return wrap;
      },
      onRemove: function (instanceId) { delete REFRESH[instanceId]; },
    };
  }
  function tabs(items, onPick, cls) {
    var box = el('<div class="pt-tabs ' + (cls || "") + '">' + items.map(function (x, i) { return '<button type="button" data-v="' + esc(x[0]) + '"' + (i === 0 ? ' class="on"' : "") + ">" + esc(x[1]) + "</button>"; }).join("") + "</div>");
    box.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      Array.prototype.forEach.call(box.children, function (x) { x.classList.toggle("on", x === b); });
      onPick(b.dataset.v);
    });
    return box;
  }

  // ---------- 1. Сводка
  WIDGETS["b10-summary"] = def("Портрет: сводка действующих клиентов", "карточки", 5, function (w, D) {
    var T = D.tot, live = T.clients - T.liq - T.risk - T.nodata, d = D.meta.asOf.split("-");
    w.appendChild(el('<div class="pt-hero"><div><div class="pt-eyebrow">Действующие клиенты · as-of ' + d[2] + "." + d[1] + "." + d[0] + '</div><div class="pt-hero-num">' + fmt(T.clients) +
      '</div><div class="pt-sub">клиентов (ИНН) с хотя бы одной действующей кассой · ' + fmt(T.kassas) + " касс</div></div>" +
      '<div class="pt-tiles"><div class="pt-tile red"><div class="pt-tl">Из них ликвидировано</div><div class="pt-tv">' + fmt(T.liq) + '</div><div class="pt-ts">' + pc(T.liq, T.clients) + " клиентов · " + fmt(T.liqKassas) + " касс</div></div>" +
      '<div class="pt-tile amber"><div class="pt-tl">Ещё в процессе</div><div class="pt-tv">' + fmt(T.risk) + '</div><div class="pt-ts">ликвидация, банкротство, реорганизация</div></div>' +
      '<div class="pt-tile green"><div class="pt-tl">Реально работают</div><div class="pt-tv">' + fmt(live) + '</div><div class="pt-ts">' + pc(live, T.clients) + " · статус ACTIVE в ЕГРЮЛ/ЕГРИП</div></div></div></div>"));
    w.appendChild(el('<div class="pt-note">Красная метка <span class="pt-liq">N · %</span> в разделах показывает ликвидированных в каждом срезе. Источник: выгрузка ' + esc(D.meta.exportFile) + " и DaData.</div>"));
  });

  // ---------- 2. Сегменты
  WIDGETS["b10-segments"] = def("Портрет: сегменты A/B/C/D", "карточки", 5, function (w, D) {
    var h = '<div class="pt-grid4">';
    SEGS.forEach(function (k) {
      var s = D.seg[k];
      h += '<div class="pt-card" style="--c:' + COL[k] + '"><div class="pt-seg-top"><span class="pt-seg-k">' + k + '</span><span class="pt-pill">' + RNG[k] + '</span></div><div class="pt-seg-n">' + fmt(s.clients) +
        '</div><div class="pt-sub">' + pc(s.clients, D.tot.clients) + " клиентов · " + fmt(s.kassas) + " касс (" + pc(s.kassas, D.tot.kassas, 0) + ')</div><div class="pt-seg-liq">' + liq(s.liq, s.clients) + '<span class="pt-sub"> ликвидировано</span></div></div>';
    });
    w.appendChild(el(h + "</div>"));
    w.appendChild(el('<div class="pt-note">Сегмент = число действующих касс (РНМ) клиента-ИНН. A: 10 и более · B: 6–9 · C: 2–5 · D: 1.</div>'));
  });

  // ---------- 3. Портреты сегментов
  WIDGETS["b10-portraits"] = def("Портрет: портреты сегментов", "карточки", 8, function (w, D) {
    var h = '<div class="pt-grid4">';
    SEGS.forEach(function (k) {
      var s = D.seg[k], ok = D.okved[k].cls.slice(0, 3);
      var li = ok.map(function (x) { return "<li><span>" + esc(x[1] || "раздел " + x[0]) + "</span><b>" + pc(x[2], s.clients, 0) + "</b></li>"; }).join("");
      var fm = {}; s.form.forEach(function (x) { fm[x[0]] = x; });
      var ip = fm["ИП"] || [0, 0, 0], yl = fm["ЮЛ"] || [0, 0, 0];
      var reg = s.region.slice(0, 3).map(function (r) { return esc(r[0]) + " " + pc(r[1], s.clients, 0); }).join(", ");
      var ba = {}; s.bizAge.forEach(function (x) { ba[x[0]] = x[1]; });
      var t36 = (D.tariff.seg[k]["36 месяцев"]) || 0;
      h += '<div class="pt-card" style="--c:' + COL[k] + '"><h4><span class="pt-dot"></span>Сегмент ' + k + "<small>" + RNG[k] + "</small></h4>" +
        '<div class="pt-pl">Отрасль, топ-3</div><ul class="pt-kv">' + li + "</ul>" +
        '<div class="pt-pl">Форма</div><div class="pt-kvrow">ИП <b>' + pc(ip[1], s.clients, 0) + "</b> · ЮЛ <b>" + pc(yl[1], s.clients, 0) + "</b></div>" +
        '<div class="pt-pl">Касс на клиента</div><div class="pt-kvrow"><b>' + num(s.kassas / s.clients) + "</b></div>" +
        '<div class="pt-pl">Регионы, топ-3</div><div class="pt-kvrow pt-small">' + reg + "</div>" +
        '<div class="pt-pl">Бизнесу 7+ лет</div><div class="pt-kvrow"><b>' + pc(ba["7+ лет"] || 0, s.clients, 0) + "</b></div>" +
        '<div class="pt-pl">Касс на тарифе 36 мес.</div><div class="pt-kvrow"><b>' + pc(t36, s.kassas, 0) + "</b></div>" +
        '<div class="pt-redline"><span>Ликвидировано</span>' + liq(s.liq, s.clients) + "</div></div>";
    });
    w.appendChild(el(h + "</div>"));
  });

  // ---------- 4. ОКВЭД
  WIDGETS["b10-okved"] = def("Портрет: топ-10 видов деятельности", "таблица", 12, function (w, D) {
    var oc = D.okvedCheck, oldn = 0, oldl = 0;
    SEGS.forEach(function (k) { oldn += D.okved[k].old; oldl += D.okved[k].oldLiq; });
    function tables(kind) {
      var h = '<div class="pt-grid2">';
      SEGS.forEach(function (k) {
        var o = D.okved[k], s = D.seg[k], lst = o[kind], mx = lst.length ? lst[0][2] : 1, rows = "", shown = 0;
        lst.forEach(function (x, i) {
          shown += x[2];
          var t = tip("<b>" + x[0] + " · " + (x[1] || "") + "</b>", "Клиентов: " + fmt(x[2]) + " (" + pc(x[2], s.clients) + " сегмента " + k + ")", "Ликвидировано: " + fmt(x[3]) + " (" + pc(x[3], x[2]) + ")");
          rows += '<tr><td class="pt-mut">' + (i + 1) + "</td><td><b>" + esc(x[0]) + "</b> " + esc(x[1] || "") + '<div class="pt-bar"><i data-tip="' + t + '" style="width:' + (100 * x[2] / mx).toFixed(0) + "%;background:" + COL[k] + '"></i></div></td><td class="r">' + fmt(x[2]) + '</td><td class="r pt-mut">' + pc(x[2], s.clients) + '</td><td class="r">' + (x[3] ? '<span class="pt-liq">' + fmt(x[3]) + "</span>" : '<span class="pt-mut">0</span>') + "</td></tr>";
        });
        var rest = s.clients - shown - o.noOkved - o.old;
        rows += '<tr><td class="pt-mut">…</td><td class="pt-mut">Остальные виды деятельности</td><td class="r">' + fmt(rest) + '</td><td class="r pt-mut">' + pc(rest, s.clients) + "</td><td></td></tr>";
        if (o.old) rows += '<tr><td class="pt-mut">—</td><td class="pt-mut">Старый код ОКВЭД-1 (в ОКВЭД-2 не существует)</td><td class="r">' + fmt(o.old) + '</td><td class="r pt-mut">' + pc(o.old, s.clients, 2) + '</td><td class="r"><span class="pt-liq">' + fmt(o.oldLiq) + "</span></td></tr>";
        if (o.noOkved) rows += '<tr><td class="pt-mut">—</td><td class="pt-mut">ОКВЭД не указан в источнике</td><td class="r">' + fmt(o.noOkved) + '</td><td class="r pt-mut">' + pc(o.noOkved, s.clients, 2) + "</td><td></td></tr>";
        h += '<div class="pt-card" style="--c:' + COL[k] + '"><h4><span class="pt-dot"></span>' + k + '</h4><table class="pt-table"><thead><tr><th>#</th><th>Вид деятельности</th><th class="r">Клиентов</th><th class="r">Доля</th><th class="r">Ликвид.</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
      });
      return h + "</div>";
    }
    w.appendChild(el('<div class="pt-note" style="margin:0 0 10px">Справочник ОКВЭД-2 (Росстат). Из ' + fmt(oc.total) + " клиентов: " + fmt(oc.total - oldn - oc.noOkved) + " с названием, " + fmt(oldn) + " со старым кодом ОКВЭД-1 (все " + fmt(oldl) + " ликвидированы), " + fmt(oc.noOkved) + " без кода в источнике.</div>"));
    w.appendChild(tabs([["cls", "Раздел (2 знака)"], ["grp", "Полный код"]], function (v) { box.innerHTML = tables(v); }));
    var box = el("<div></div>"); box.innerHTML = tables("cls"); w.appendChild(box);
  });

  // ---------- 5. Форма бизнеса
  WIDGETS["b10-form"] = def("Портрет: форма бизнеса (ИП / ЮЛ)", "график", 6, function (w, D) {
    var h = "";
    SEGS.forEach(function (k) {
      var s = D.seg[k], fm = {}; s.form.forEach(function (x) { fm[x[0]] = x; });
      var ip = fm["ИП"] || [0, 0, 0], yl = fm["ЮЛ"] || [0, 0, 0], t = ip[1] + yl[1] || 1;
      function part(lbl, v, l, col) {
        var wd = 100 * v / t, lw = v ? 100 * l / v : 0;
        return '<div class="pt-fb" style="width:' + wd.toFixed(2) + '%"><div class="pt-fbx" data-tip="' + tip("<b>" + lbl + ", сегмент " + k + "</b>", "Клиентов: " + fmt(v) + " (" + pc(v, t) + ")", "Ликвидировано: " + fmt(l) + " (" + pc(l, v) + ")") + '" style="background:' + col + '"><i class="pt-fl" style="height:' + lw.toFixed(1) + '%"></i></div><div class="pt-fbl">' + lbl + " " + pc(v, t, 0) + "</div></div>";
      }
      h += '<div class="pt-frow"><b class="pt-fk" style="color:' + COL[k] + '">' + k + '</b><div class="pt-fbars">' + part("ИП", ip[1], ip[2], "#9db2f2") + part("ЮЛ", yl[1], yl[2], "#c9bff5") + '</div><div class="pt-fnote"><span>ИП ' + fmt(ip[1]) + ": ликвидировано " + liq(ip[2], ip[1]) + "</span><span>ЮЛ " + fmt(yl[1]) + ": ликвидировано " + liq(yl[2], yl[1]) + "</span></div></div>";
    });
    w.appendChild(el("<div>" + h + "</div>"));
    w.appendChild(el('<div class="pt-note">Красная заливка внутри столбца: доля ликвидированных в этой группе.</div>'));
  });

  // ---------- 6. Возраст бизнеса
  WIDGETS["b10-bizage"] = def("Портрет: возраст бизнеса", "график", 6, function (w, D) {
    var order = ["<1 г", "1–3 г", "3–7 г", "7+ лет"], cols = ["#d9dff5", "#9db2f2", "#5f80e6", "#2a52e0"], h = "";
    SEGS.forEach(function (k) {
      var d = {}, t = 0; D.seg[k].bizAge.forEach(function (x) { d[x[0]] = x; t += x[1]; });
      var seg = "";
      order.forEach(function (o, i) {
        if (!d[o]) return;
        seg += '<div class="pt-sb" data-tip="' + tip("<b>Возраст бизнеса " + o + ", сегмент " + k + "</b>", "Клиентов: " + fmt(d[o][1]) + " (" + pc(d[o][1], t) + ")", "Ликвидировано: " + fmt(d[o][2]) + " (" + pc(d[o][2], d[o][1]) + ")") + '" style="width:' + (100 * d[o][1] / t).toFixed(2) + "%;background:" + cols[i] + ";color:" + (i >= 2 ? "#fff" : "#0d1220") + '"><span>' + o + " " + pc(d[o][1], t, 0) + "</span></div>";
      });
      var note = order.filter(function (o) { return d[o]; }).map(function (o) { return o + ': <span class="pt-liq">' + pc(d[o][2], d[o][1]) + "</span>"; }).join(" · ");
      h += '<div class="pt-frow"><b class="pt-fk" style="color:' + COL[k] + '">' + k + '</b><div class="pt-stackb">' + seg + '</div><div class="pt-fnote"><span>Доля ликвидированных по возрасту: ' + note + "</span></div></div>";
    });
    w.appendChild(el("<div>" + h + "</div>"));
    w.appendChild(el('<div class="pt-note">Возраст по дате регистрации в ЕГРЮЛ/ЕГРИП (не срок в ОФД).</div>'));
  });

  // ---------- 7. Тарифы
  var TORD = ["1 месяц", "3 месяца", "6 месяцев", "13 месяцев", "15 месяцев", "36 месяцев"];
  var TCOL = { "1 месяц": "#c9bff5", "3 месяца": "#b6a8f0", "6 месяцев": "#9db2f2", "13 месяцев": "#14a89a", "15 месяцев": "#7a5cf0", "36 месяцев": "#2a52e0" };
  function tDark(o) { return o === "1 месяц" || o === "3 месяца" || o === "6 месяцев"; }
  function tShort(o) { return o.replace(" месяцев", " мес.").replace(" месяца", " мес.").replace(" месяц", " мес."); }
  function sumVals(o) { return Object.keys(o).reduce(function (s, k) { return s + o[k]; }, 0); }
  WIDGETS["b10-tariffs"] = def("Портрет: тарифы (срок действия кода)", "график + таблица", 10, function (w, D) {
    var h = "";
    SEGS.forEach(function (k) {
      var d = D.tariff.seg[k], t = sumVals(d) || 1, seg = "";
      TORD.forEach(function (o) {
        var v = d[o] || 0; if (!v) return;
        var wd = Math.max(100 * v / t, 0.6);
        seg += '<div class="pt-sb" data-tip="' + tip("<b>Тариф " + o + ", сегмент " + k + "</b>", "Действующих касс: " + fmt(v) + " (" + pc(v, t) + " касс сегмента)") + '" style="width:' + wd.toFixed(2) + "%;background:" + TCOL[o] + ";color:" + (tDark(o) ? "#0d1220" : "#fff") + '"><span>' + (100 * v / t >= 6 ? tShort(o) + " " + pc(v, t, 0) : "") + "</span></div>";
      });
      h += '<div class="pt-frow"><b class="pt-fk" style="color:' + COL[k] + '">' + k + '</b><div class="pt-stackb">' + seg + "</div></div>";
    });
    var head = SEGS.map(function (k) { return '<th class="r">' + k + "</th>"; }).join(""), rows = "", ta = sumVals(D.tariff.all) || 1;
    TORD.forEach(function (o) {
      var cells = SEGS.map(function (k) { var v = D.tariff.seg[k][o] || 0; return '<td class="r">' + fmt(v) + ' <span class="pt-mut">· ' + pc(v, sumVals(D.tariff.seg[k])) + "</span></td>"; }).join("");
      var tt = D.tariff.all[o] || 0;
      rows += '<tr><td><span class="pt-tag" style="background:' + TCOL[o] + ";color:" + (tDark(o) ? "#0d1220" : "#fff") + '">' + o + "</span></td>" + cells + '<td class="r"><b>' + fmt(tt) + '</b> <span class="pt-mut">· ' + pc(tt, ta) + "</span></td></tr>";
    });
    rows += "<tr><td><b>Всего касс</b></td>" + SEGS.map(function (k) { return '<td class="r"><b>' + fmt(sumVals(D.tariff.seg[k])) + "</b></td>"; }).join("") + '<td class="r"><b>' + fmt(ta) + "</b></td></tr>";
    w.appendChild(el("<div>" + h + "</div>"));
    w.appendChild(el('<div class="pt-note">В выгрузке поле «Срок действия тарифа» хранит срок кода: 1, 3, 6, 13, 15 или 36 месяцев. Считаются действующие кассы по сроку их последнего кода.</div>'));
    w.appendChild(el('<div class="pt-scroll" style="margin-top:12px"><table class="pt-table"><thead><tr><th>Срок кода</th>' + head + '<th class="r">Все сегменты</th></tr></thead><tbody>' + rows + "</tbody></table></div>"));
  });

  // ---------- 8. Срок жизни по типу продаж
  WIDGETS["b10-life"] = def("Портрет: срок жизни касс по типу продаж", "карточки", 5, function (w, D) {
    var nm = { "1C": "1С", "КА": "КА", "Обособки": "Обособки", "Прямые": "Прямые" }, h = '<div class="pt-grid4">';
    ["1C", "КА", "Обособки", "Прямые"].forEach(function (t) {
      var x = D.life.filter(function (a) { return a.type === t; })[0]; if (!x) return;
      var yrs = Math.floor(x.days / 365), mo = Math.round((x.days - yrs * 365) / 30.4375);
      h += '<div class="pt-card" style="--c:#2a52e0"><div class="pt-seg-top"><span class="pt-seg-k" style="font-size:24px">' + nm[t] + '</span></div><div class="pt-seg-n">' + num(x.months) + ' <small>мес.</small></div><div class="pt-sub">' + yrs + " г. " + mo + " мес. · " + fmt(x.days) + " дн. · " + fmt(x.kassas) + ' касс</div><div class="pt-seg-liq">' + liq(x.liqKassas, x.kassas) + '<span class="pt-sub"> касс у ликвидированных</span></div></div>';
    });
    w.appendChild(el(h + "</div>"));
    w.appendChild(el('<div class="pt-note">Средняя длительность работы действующей кассы (РНМ) в ОФД по «Типу продаж» первого кода. Только действующие кассы.</div>'));
  });

  // ---------- 9. Крупнейшие клиенты
  WIDGETS["b10-top"] = def("Портрет: крупнейшие клиенты сегмента", "таблица", 10, function (w, D) {
    var ST = { 0: '<span class="pt-tag ok">работает</span>', 1: '<span class="pt-tag no">ликвидирован</span>', 2: '<span class="pt-tag wait">в процессе</span>', 3: '<span class="pt-tag">нет данных</span>' };
    var panes = {};
    SEGS.forEach(function (k) {
      var rows = D.top[k].map(function (c, i) {
        return '<tr><td class="pt-mut">' + (i + 1) + "</td><td><b>" + esc(c.org || "—") + "</b></td><td>" + esc(c.okved || "—") + ' <span class="pt-mut">' + esc(c.okvedLabel || "") + "</span></td><td>" + esc(c.region || "—") + '</td><td class="r"><b>' + fmt(c.kassas) + '</b></td><td class="r pt-mut">' + esc(String(c.since).slice(0, 4)) + "</td><td>" + ST[c.st] + "</td></tr>";
      }).join("");
      panes[k] = '<div class="pt-scroll"><table class="pt-table"><thead><tr><th>#</th><th>Клиент (DaData)</th><th>ОКВЭД</th><th>Регион</th><th class="r">Касс</th><th class="r">В ОФД с</th><th>Статус</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
    });
    var box = el("<div></div>"); box.innerHTML = panes.A;
    w.appendChild(tabs(SEGS.map(function (k) { return [k, "Сегмент " + k]; }), function (v) { box.innerHTML = panes[v]; }));
    w.appendChild(box);
    w.appendChild(el('<div class="pt-note">Больше касс выше, при равенстве выше тот, кто дольше с нами. В сегменте D у всех по одной кассе, поэтому порядок только по сроку в ОФД.</div>'));
  });

  // ---------- 10. Регионы
  WIDGETS["b10-regions"] = def("Портрет: регионы, как мы представлены", "таблица", 12, function (w, D) {
    var rows0 = D.cand.rows, regs = D.cand.regs, RG = D.reg, codes = Object.keys(RG), rs = { seg: "ALL", key: "ours", dir: -1 }, curReg = [];
    var RH = [["Регион", "name", 1, "Регион регистрации юрлица по DaData"], ["ККТ в регионе", "market", -1, "Все зарегистрированные кассы региона по данным ФНС (активные, неактивные и автономные)"], ["Наши кассы", "ours", -1, "Наши действующие кассы на дату, совпадающую с месяцем ФНС: " + D.meta.fnsAlignedTo], ["Доля ОФД", "share", -1, "Наши кассы ÷ ККТ в регионе по ФНС"], ["Клиентов сейчас", "cl", -1, "Действующие клиенты (ИНН) на as-of"], ["Касс сейчас", "ks", -1, "Действующие кассы (РНМ) на as-of"], ["Отвалились, но живы", "alive", -1, "Ушедшие клиенты, которые по ЕГРЮЛ/ЕГРИП ещё существуют: их можно возвращать"], ["Ликвидировано среди действующих", "lc", -1, "Действующие клиенты со статусом «ликвидирована» в ЕГРЮЛ/ЕГРИП"]];
    var RCOLS = [4, 22, 11, 10, 8, 10, 9, 13, 13];
    var ctr = el('<div class="pt-ctrls"><select><option value="ALL">Все сегменты</option><option value="A">Сегмент A</option><option value="B">Сегмент B</option><option value="C">Сегмент C</option><option value="D">Сегмент D</option></select><button type="button" class="pt-btn">Скачать CSV</button></div>');
    var scroll = el('<div class="pt-scroll"><table class="pt-table pt-fixed"></table></div>'), table = scroll.firstElementChild;
    function regRows() {
      var aliveBy = {};
      rows0.forEach(function (r) { var code = regs[r[1]][0]; if (rs.seg !== "ALL" && segOf(r[4]) !== rs.seg) return; aliveBy[code] = (aliveBy[code] || 0) + 1; });
      return codes.map(function (c) {
        var g = RG[c], sg = rs.seg === "ALL" ? SEGS : [rs.seg], o = { code: c, name: g.name, market: g.market, ours: 0, cl: 0, ks: 0, lc: 0, alive: aliveBy[c] || 0 };
        sg.forEach(function (s) { o.ours += g.aug[s][1]; o.cl += g.cur[s][0]; o.ks += g.cur[s][1]; o.lc += g.cur[s][2]; });
        o.share = g.market ? o.ours / g.market : 0; return o;
      }).filter(function (o) { return o.cl || o.ours || o.alive || o.market; });
    }
    function draw() {
      var arr = regRows(), k = rs.key, d = rs.dir;
      arr.sort(function (a, b) { return k === "name" ? d * a.name.localeCompare(b.name, "ru") : d * (a[k] - b[k]) || b.ours - a.ours; });
      curReg = arr;
      var h = "<colgroup>" + RCOLS.map(function (x) { return '<col style="width:' + x + '%">'; }).join("") + "</colgroup><thead><tr><th>#</th>" + RH.map(function (x) {
        return '<th class="pt-sortable' + (rs.key === x[1] ? " sorted" : "") + (x[1] === "name" ? "" : " r") + '" data-k="' + x[1] + '" data-d="' + x[2] + '" data-tip="' + esc(x[3]) + '">' + esc(x[0]) + (rs.key === x[1] ? (rs.dir < 0 ? " ▼" : " ▲") : "") + "</th>";
      }).join("") + "</tr></thead><tbody>";
      var T = { market: 0, ours: 0, cl: 0, ks: 0, lc: 0, alive: 0 };
      arr.forEach(function (o, i) {
        Object.keys(T).forEach(function (z) { T[z] += o[z]; });
        h += '<tr><td class="pt-mut">' + (i + 1) + "</td><td>" + esc(o.name) + '</td><td class="r pt-mut">' + (o.market ? fmt(o.market) : "—") + '</td><td class="r">' + fmt(o.ours) + '</td><td class="r"><b>' + (o.market ? pc(o.ours, o.market) : "—") + '</b></td><td class="r">' + fmt(o.cl) + '</td><td class="r">' + fmt(o.ks) +
          '</td><td class="r">' + (o.alive ? '<span class="pt-grn">' + fmt(o.alive) + "</span>" : '<span class="pt-mut">0</span>') + '</td><td class="r">' + (o.lc ? '<span class="pt-liq">' + fmt(o.lc) + " · " + pc(o.lc, o.cl) + "</span>" : '<span class="pt-mut">0</span>') + "</td></tr>";
      });
      h += '<tr class="pt-tot"><td></td><td><b>Россия</b></td><td class="r"><b>' + fmt(T.market) + '</b></td><td class="r"><b>' + fmt(T.ours) + '</b></td><td class="r"><b>' + pc(T.ours, T.market) + '</b></td><td class="r"><b>' + fmt(T.cl) + '</b></td><td class="r"><b>' + fmt(T.ks) + '</b></td><td class="r"><b>' + fmt(T.alive) + '</b></td><td class="r"><b>' + fmt(T.lc) + " · " + pc(T.lc, T.cl) + "</b></td></tr></tbody>";
      table.innerHTML = h;
    }
    table.addEventListener("click", function (e) {
      var th = e.target.closest("th.pt-sortable"); if (!th) return;
      var k = th.dataset.k; if (rs.key === k) rs.dir = -rs.dir; else { rs.key = k; rs.dir = +th.dataset.d; }
      draw();
    });
    ctr.querySelector("select").addEventListener("change", function (e) { rs.seg = e.target.value; draw(); });
    ctr.querySelector("button").addEventListener("click", function () {
      var head = ["Код региона", "Регион", "ККТ в регионе (ФНС, " + D.meta.fnsMonth + ")", "Наши кассы на " + D.meta.fnsAlignedTo, "Доля ОФД, %", "Клиентов сейчас", "Касс сейчас", "Отвалились, но живы", "Ликвидировано среди действующих"];
      var lines = [head.map(q).join(";")];
      curReg.forEach(function (o) { lines.push([o.code, q(o.name), o.market, o.ours, o.market ? num(100 * o.ours / o.market, 2) : "", o.cl, o.ks, o.alive, o.lc].join(";")); });
      csvDownload("regiony-" + (rs.seg === "ALL" ? "vse-segmenty" : "segment-" + rs.seg) + ".csv", lines.join("\r\n"));
    });
    w.appendChild(el('<div class="pt-note" style="margin:0 0 10px">Клик по заголовку сортирует (первый клик от большего к меньшему, повторный наоборот). «ККТ в регионе»: все зарегистрированные кассы региона по данным ФНС за <b>' + esc(D.meta.fnsMonth) + "</b> (последний опубликованный месяц). Наши кассы для сравнения взяты на " + esc(D.meta.fnsAlignedTo) + ", остальные столбцы на " + esc(D.meta.asOf) + ". «Ликвидировано среди действующих» стоит в конце: это небольшая погрешность базы.</div>"));
    w.appendChild(ctr); w.appendChild(scroll); draw();
  });

  // ---------- 11. Кого вернуть
  WIDGETS["b10-return"] = def("Портрет: кого можно вернуть (шанс вернуться)", "таблица", 14, function (w, D) {
    var C = D.cand, rows = C.rows, N = rows.length, cs = { reg: "all", sec: "all", seg: "all", min: 0, key: "p", dir: -1 }, curIdx = [];
    var KEYS = { kass: 4, ten: 5, since: 6, p: 7 };
    var HEAD = [["#", null, ""], ["Клиент", "org", ""], ["Регион", "reg", ""], ["Отрасль", "sec", ""], ["Касс", "kass", "r"], ["Был с нами, мес.", "ten", "r"], ["Ушёл, мес. назад", "since", "r"], ["Шанс вернуться", "p", ""]];
    var COLS = [4, 23, 13, 23, 6, 8, 8, 15];
    var kpi = el('<div class="pt-kpi"></div>');
    var sRegOpts = C.regs.map(function (r, i) { return [r[1], i]; }).sort(function (a, b) { return a[0].localeCompare(b[0], "ru"); });
    var sSecOpts = C.secs.map(function (r, i) { return [r[0] + " " + r[1], i]; }).sort(function (a, b) { return a[0].localeCompare(b[0], "ru"); });
    var ctr = el('<div class="pt-ctrls"><select data-f="reg"><option value="all">Все регионы</option>' + sRegOpts.map(function (x) { return '<option value="' + x[1] + '">' + esc(x[0]) + "</option>"; }).join("") + '</select><select data-f="sec"><option value="all">Все отрасли</option>' + sSecOpts.map(function (x) { return '<option value="' + x[1] + '">' + esc(x[0]) + "</option>"; }).join("") +
      '</select><select data-f="seg"><option value="all">Любой сегмент</option><option value="A">Сегмент A (10+ касс)</option><option value="B">Сегмент B (6–9)</option><option value="C">Сегмент C (2–5)</option><option value="D">Сегмент D (1)</option></select><select data-f="min"><option value="0">Шанс вернуться: любой</option><option value="5">не ниже 5%</option><option value="10">не ниже 10%</option><option value="15">не ниже 15%</option><option value="30">не ниже 30%</option></select><button type="button" class="pt-btn">Скачать CSV с контактами</button></div>');
    var scroll = el('<div class="pt-scroll"><table class="pt-table pt-fixed"></table></div>'), table = scroll.firstElementChild, note = el('<div class="pt-note"></div>');
    function filtered() {
      var out = [];
      for (var i = 0; i < N; i++) {
        var r = rows[i];
        if (cs.reg !== "all" && r[1] !== +cs.reg) continue;
        if (cs.sec !== "all" && r[2] !== +cs.sec) continue;
        if (cs.seg !== "all" && segOf(r[4]) !== cs.seg) continue;
        if (r[7] < cs.min * 10) continue;
        out.push(i);
      }
      return out;
    }
    function sortIdx(idx) {
      var k = cs.key, d = cs.dir;
      idx.sort(function (a, b) {
        var A = rows[a], B = rows[b];
        if (k === "org") return d * String(A[0]).localeCompare(String(B[0]), "ru");
        if (k === "reg") return d * C.regs[A[1]][1].localeCompare(C.regs[B[1]][1], "ru");
        if (k === "sec") return d * C.secs[A[2]][1].localeCompare(C.secs[B[2]][1], "ru");
        return d * (A[KEYS[k]] - B[KEYS[k]]) || (B[7] - A[7]);
      });
      return idx;
    }
    function tier(p) { return p >= 300 ? "t3" : p >= 150 ? "t2" : "t1"; }
    function draw() {
      var idx = sortIdx(filtered()); curIdx = idx;
      var t3 = 0, t2 = 0; idx.forEach(function (i) { var p = rows[i][7]; if (p >= 300) t3++; else if (p >= 150) t2++; });
      var st = C.stats;
      kpi.innerHTML = '<div class="pt-tile"><div class="pt-tl">Отвалились всего</div><div class="pt-tv">' + fmt(st.churned) + '</div><div class="pt-ts">все клиенты, ушедшие по формуле оттока</div></div>' +
        '<div class="pt-tile red"><div class="pt-tl">Ликвидированы</div><div class="pt-tv">' + fmt(st.liq) + '</div><div class="pt-ts">' + pc(st.liq, st.churned) + " · вернуть нельзя</div></div>" +
        '<div class="pt-tile amber"><div class="pt-tl">В процессе / нет данных</div><div class="pt-tv">' + fmt(st.proc + st.nodata) + '</div><div class="pt-ts">ликвидация, банкротство, реорганизация</div></div>' +
        '<div class="pt-tile green"><div class="pt-tl">Живы: можно вернуть</div><div class="pt-tv">' + fmt(st.alive) + '</div><div class="pt-ts">' + pc(st.alive, st.churned) + " отвалившихся</div></div>" +
        '<div class="pt-tile blue"><div class="pt-tl">В текущей выборке</div><div class="pt-tv">' + fmt(idx.length) + '</div><div class="pt-ts">шанс 30% и выше: ' + fmt(t3) + "<br>шанс 15–30%: " + fmt(t2) + "</div></div>";
      var h = "<colgroup>" + COLS.map(function (x) { return '<col style="width:' + x + '%">'; }).join("") + "</colgroup><thead><tr>" + HEAD.map(function (x) {
        return x[1] ? '<th class="pt-sortable ' + x[2] + (cs.key === x[1] ? " sorted" : "") + '" data-k="' + x[1] + '">' + x[0] + (cs.key === x[1] ? (cs.dir < 0 ? " ▼" : " ▲") : "") + "</th>" : "<th>" + x[0] + "</th>";
      }).join("") + "</tr></thead><tbody>";
      idx.slice(0, 50).forEach(function (i, n) {
        var r = rows[i], pct = r[7] / 10;
        h += '<tr><td class="pt-mut">' + (n + 1) + "</td><td><b>" + esc(r[0]) + '</b><div class="pt-sub2">' + (r[3] ? "ЮЛ" : "ИП") + " · ИНН " + esc(r[8]) + "</div></td><td>" + esc(C.regs[r[1]][1]) + "</td><td>" + esc(C.secs[r[2]][1]) + '</td><td class="r"><b>' + fmt(r[4]) + '</b></td><td class="r">' + fmt(r[5]) + '</td><td class="r">' + fmt(r[6]) +
          '</td><td><div class="pt-sc ' + tier(r[7]) + '" data-tip="' + tip("<b>" + esc(r[0]) + "</b>", "Шанс вернуться за 12 мес.: " + num(pct) + "%", "Ушёл " + r[6] + " мес. назад", "Был с нами " + r[5] + " мес.", "Макс. касс: " + r[4]) + '"><i style="width:' + Math.min(100, pct).toFixed(0) + '%"></i><b>' + num(pct) + "%</b></div></td></tr>";
      });
      table.innerHTML = h + "</tbody>";
      note.textContent = (idx.length > 50 ? "Показаны первые 50 из " + fmt(idx.length) + ". " : "Показаны все " + fmt(idx.length) + ". ") + "Полный список с телефонами и email: кнопка «Скачать CSV с контактами».";
    }
    table.addEventListener("click", function (e) {
      var th = e.target.closest("th.pt-sortable"); if (!th) return;
      var k = th.dataset.k; if (cs.key === k) cs.dir = -cs.dir; else { cs.key = k; cs.dir = (k === "org" || k === "reg" || k === "sec") ? 1 : -1; }
      draw();
    });
    ctr.addEventListener("change", function (e) { var f = e.target.dataset.f; if (!f) return; cs[f] = f === "min" ? (+e.target.value || 0) : e.target.value; draw(); });
    ctr.querySelector("button").addEventListener("click", function () {
      var head = ["ИНН", "Клиент", "Телефон", "Email", "Регион", "Отрасль (ОКВЭД)", "Форма", "Макс. касс", "Был с нами, мес.", "Ушёл, мес. назад", "Шанс вернуться за 12 мес., %"];
      var lines = [head.map(q).join(";")];
      curIdx.forEach(function (i) {
        var r = rows[i];
        lines.push([q(innCell(r[8])), q(r[0]), q(fmtPhone(r[9])), q(r[10] || ""), q(C.regs[r[1]][1]), q(C.secs[r[2]][1]), r[3] ? "ЮЛ" : "ИП", r[4], r[5], r[6], num(r[7] / 10)].join(";"));
      });
      csvDownload("otvalivshiesya-shans-vernutsya.csv", lines.join("\r\n"));
    });
    w.appendChild(el('<div class="pt-note" style="margin:0 0 10px">Клиенты, которые от нас ушли (31-й день после окончания без продления) и по ЕГРЮЛ/ЕГРИП ещё существуют. «Шанс вернуться» — вероятность новой покупки кода за 12 месяцев (как посчитан: виджет «Портрет: как посчитан шанс вернуться»).</div>'));
    w.appendChild(kpi); w.appendChild(ctr); w.appendChild(scroll); w.appendChild(note); draw();
  });

  // ---------- 12. Как посчитан шанс
  var FNAME = { tsc: "Сколько прошло с ухода", chan: "Канал продаж", reg2: "Регион (по ИНН)", partner: "Партнёр", ok2: "Отрасль (ОКВЭД)", bizage: "Возраст бизнеса", stype: "Тип продаж", hasEm: "Есть ли email в карточке", ten: "Срок работы с нами", center: "Центр продаж", lastLen: "Длина последнего периода", form: "ИП или ЮЛ" };
  var TLAB = { "(1, 2]": "до 2 мес.", "(2, 3]": "2–3 мес.", "(3, 6]": "3–6 мес.", "(6, 12]": "6–12 мес.", "(12, 24]": "1–2 года", "(24, 48]": "2–4 года", "(48, 200]": "4 года и больше" };
  WIDGETS["b10-model"] = def("Портрет: как посчитан шанс вернуться", "таблица", 14, function (w, D) {
    var M = D.model, rows = D.cand.rows, n30 = 0, n15 = 0, sp = 0;
    rows.forEach(function (r) { sp += r[7]; if (r[7] >= 300) n30++; else if (r[7] >= 150) n15++; });
    var imp = M.imp.filter(function (x) { return FNAME[x[0]]; }).slice(0, 8), mx = imp.length ? imp[0][1] : 1;
    var facs = imp.map(function (x) { return '<div class="pt-mrow"><span>' + FNAME[x[0]] + '</span><div class="pt-mb"><i style="width:' + (100 * x[1] / mx).toFixed(0) + '%"></i></div><b>' + Math.round(100 * x[1] / mx) + "</b></div>"; }).join("");
    var dec = M.dec.map(function (x, i) { return "<tr><td>" + (i === 0 ? "Худшие 10%" : i === 9 ? "Лучшие 10%" : (i * 10 + 1) + "–" + (i * 10 + 10) + "%") + '</td><td class="r">' + pc(x[1], 1) + '</td><td class="r"><b>' + pc(x[2], 1) + "</b></td></tr>"; }).join("");
    var tsc = M.tsc.map(function (x) { return "<tr><td>" + esc(TLAB[x[0]] || x[0]) + '</td><td class="r">' + fmt(x[1]) + '</td><td class="r"><b>' + pc(x[2], 1) + "</b></td></tr>"; }).join("");
    var t1 = M.top["0.1"];
    w.appendChild(el('<div class="pt-mdl"><div><h4>Что это за число</h4><p>Вероятность того, что отвалившийся клиент (тот же ИНН) снова купит код ОФД в течение 12 месяцев. Не оценка «по ощущению», а доля реально вернувшихся среди клиентов с такими же признаками в прошлом.</p>' +
      "<h4>Откуда оценка</h4><ul><li>Взято " + fmt(M.allRows) + " наблюдений за прошлые годы: «клиент ушёл, живой по ЕГРЮЛ, вернулся ли он за следующие 12 мес.».</li><li>Признаки: время с ухода, срок и размер клиента, число прежних возвратов, срок последнего тарифа, тип и канал продаж, партнёр, центр продаж, регион (по ИНН), отрасль и возраст бизнеса (DaData), ИП/ЮЛ, наличие телефона и email, цена (РРЦ), промокод, перезакреп.</li><li>Модель: градиентный бустинг. Каждый признак известен только на дату наблюдения, «подглядывания в будущее» нет.</li></ul>" +
      "<h4>Что в списке</h4><p>Шанс 30% и выше: <b>" + fmt(n30) + "</b> клиентов. Шанс 15–30%: <b>" + fmt(n15) + "</b>. Средний шанс по всем " + fmt(rows.length) + " живым отвалившимся: " + pc(sp / rows.length / 1000, 1) + ".</p></div>" +
      "<div><h4>Проверка на данных, которых модель не видела</h4><p>Проверочный период: " + fmt(M.testRows) + " наблюдений. Различающая способность AUC = <b>" + num(M.auc, 2) + "</b> (0,5 = случайно, 1,0 = идеально).</p>" +
      '<table class="pt-table pt-cal"><thead><tr><th>Группа клиентов по оценке</th><th class="r">Модель обещала</th><th class="r">Вернулись по факту</th></tr></thead><tbody>' + dec + "</tbody></table>" +
      "<p>Лучшие 10% по оценке дали " + pc(t1[0], 1) + " возвратов при среднем " + pc(M.base, 1) + ": в " + num(t1[0] / M.base) + " раза лучше случайного обзвона; в эти 10% попало " + pc(t1[1], 1, 0).replace(/,\d/, "") + " всех, кто вернулся.</p></div></div>"));
    w.appendChild(el('<div class="pt-mdl" style="margin-top:16px"><div><h4>Что сильнее всего влияет на шанс</h4><p class="pt-sub2">Относительная важность признака, 100 = самый важный</p>' + facs + '</div><div><h4>Шанс вернуться по времени с ухода</h4><p class="pt-sub2">Проверочный период</p><table class="pt-table pt-cal"><thead><tr><th>Ушёл</th><th class="r">Наблюдений</th><th class="r">Вернулись за 12 мес.</th></tr></thead><tbody>' + tsc + "</tbody></table></div></div>"));
    w.appendChild(el('<h4 style="margin-top:16px">Ограничения</h4><ul class="pt-lim"><li>Возврат считается только по тому же ИНН. Возврат под другим ИНН или через другого партнёра модель не видит.</li><li>Причины ухода, цены конкурентов и история звонков в выгрузку не попадают. Модель обучена на покупках, а не на реакции на звонки.</li><li>Оценка показывает, кто вернётся сам при обычном поведении. Для кого звонок реально меняет решение, из этих данных не узнать: нужен тестовый обзвон с контрольной группой.</li><li>Статус ЕГРЮЛ/ЕГРИП, отрасль и возраст бизнеса взяты из DaData на дату обогащения.</li></ul>'));
  });

  // ---------- загрузка файла из шапки
  function broadcast() { Object.keys(REFRESH).forEach(function (id) { try { REFRESH[id](); } catch (e) { console.error(e); } }); }
  function validate(d) {
    var need = ["meta", "tot", "seg", "okved", "okvedCheck", "tariff", "top", "life", "reg", "cand", "model"];
    for (var i = 0; i < need.length; i++) if (!d || d[need[i]] === undefined) throw new Error("в файле нет раздела «" + need[i] + "»");
    if (!d.cand.rows || !d.cand.regs || !d.cand.secs) throw new Error("в файле нет списка отвалившихся");
    return d;
  }
  function handleFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { try { resolve(validate(JSON.parse(fr.result))); } catch (e) { reject(e); } };
      fr.onerror = function () { reject(new Error("не удалось прочитать файл")); };
      fr.readAsText(file);
    });
  }
  function bindInput() {
    var input = document.getElementById("portraitFileInput"), label = document.getElementById("portraitBtnLabel"), loader = document.getElementById("portraitFileLoader");
    if (!input) return;
    input.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      if (loader) loader.classList.add("active");
      handleFile(f).then(function (d) {
        STATE.data = d; STATE.fileName = f.name;
        if (loader) loader.classList.remove("active");
        if (label) { label.textContent = "Портрет ✓"; label.parentNode.title = f.name + " · данные на " + d.meta.asOf + " · клиентов " + fmt(d.tot.clients); }
        broadcast();
      }).catch(function (err) {
        console.error(err);
        if (loader) loader.classList.remove("active");
        if (label) { label.textContent = "Портрет: ошибка"; label.parentNode.title = "Ошибка файла: " + err.message; }
      });
      input.value = "";
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindInput); else bindInput();

  root.OFDPortrait = { state: STATE, handleFile: handleFile, load: function (d) { STATE.data = validate(d); broadcast(); } };
})(typeof window !== "undefined" ? window : globalThis);
