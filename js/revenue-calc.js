/*
 * Каналы продаж — калькулятор потенциальной выручки. Фиксированная панель в левом
 * сайдбаре (НЕ виджет холста, не через GridStack/dnd.js) -- всегда на виду, три заданных
 * канала (те же самые, что и в classifyChannel/computeChannels в metrics.js: "Ольга
 * Зибер" / "Лариса Пенигина" / "Партнёры"), не произвольное число как было в первой
 * версии (снесена 2026-08-19 по фидбэку Димы -- список из сотни чекбоксов нечитаем).
 *
 * Дефолтная привязка партнёра к каналу = та же classifyChannel, что использует "Разбивка
 * по каналам" (b3-channels). Ручное перезакрепление партнёра в другой канал -- override,
 * хранится в localStorage по ИМЕНИ партнёра (переживает новую выгрузку/перезагрузку,
 * пока имя не меняется). "" -- партнёр явно снят откуда-то и ещё нигде не закреплён
 * (свободен), отличается от отсутствия записи (= "используй авто-классификацию").
 *
 * Один общий период "с — по" на все три канала (не свой у каждого, как было раньше) --
 * весь смысл в сравнении "сколько получим со всех каналов за один и тот же отрезок".
 */
(function (root) {
  "use strict";

  var CHANNELS = ["Ольга Зибер", "Лариса Пенигина", "Партнёры"];
  var OVERRIDE_KEY = "ofd-channel-overrides-v1";

  var mount = null;
  var built = false;
  var els = {}; // channelKey -> {headEl, countEl, checkInput, churnInput, revenueEl, bodyEl, searchInput, listEl, arrowEl}
  var totalEl = null, fromInput = null, toInput = null;
  var openChannel = null;
  var overrides = loadOverrides(); // partnerName -> channelKey | "" (явно свободен)
  var lastModel = null, lastCtx = null;
  var byChannel = {}; // channelKey -> [partnerName,...] (текущее назначение, пересчитывается из overrides+авто)
  var freeList = []; // партнёры, явно снятые откуда-то и ещё никуда не взятые

  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "{}"); } catch (e) { return {}; }
  }
  function saveOverrides() {
    try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides)); } catch (e) { /* приватный режим и т.п. -- не критично */ }
  }

  function fmtNum(n) { return (n || 0).toLocaleString("ru-RU"); }
  function esc(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  function effectiveChannel(name, autoMap) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name]; // "" = явно свободен
    var auto = autoMap.get(name);
    return CHANNELS.indexOf(auto) !== -1 ? auto : "Партнёры";
  }

  // Пересчитывает byChannel/freeList из текущей модели (авто-классификация +
  // ручные overrides) -- вызывается при каждой смене модели/as-of/strict, НЕ трогает
  // DOM-значения чек/оттока/периода (они живут прямо в input.value, построены один раз).
  function rebuildAssignment(model, ctx) {
    var rows = ctx.M.computePartnersByChannel(model, ctx.asOf, { strict: ctx.strict });
    var autoMap = new Map(rows.map(function (r) { return [r.name, r.channel]; }));
    var allNames = rows.map(function (r) { return r.name; }).sort();
    byChannel = {}; CHANNELS.forEach(function (c) { byChannel[c] = []; });
    freeList = [];
    allNames.forEach(function (name) {
      var eff = effectiveChannel(name, autoMap);
      if (eff === "") { freeList.push(name); return; }
      (byChannel[eff] || byChannel["Партнёры"]).push(name);
    });
  }

  function buildShell() {
    mount = document.getElementById("channelCalc");
    if (!mount) return;
    var periodRow = el(
      '<div class="cc-period">' +
      '<label>с <input type="date" class="cc-from"></label>' +
      '<label>по <input type="date" class="cc-to"></label>' +
      '</div>'
    );
    fromInput = periodRow.querySelector(".cc-from");
    toInput = periodRow.querySelector(".cc-to");
    totalEl = el('<div class="cc-total"></div>');
    var channelsHost = el('<div class="cc-channels"></div>');
    mount.appendChild(periodRow);
    mount.appendChild(totalEl);
    mount.appendChild(channelsHost);

    CHANNELS.forEach(function (name) {
      var block = el(
        '<div class="cc-channel">' +
        '<button type="button" class="cc-head">' +
        '<span class="cc-arrow">▸</span><span class="cc-name">' + esc(name) + '</span><span class="cc-count"></span>' +
        '</button>' +
        '<div class="cc-fields">' +
        '<label>чек, ₽ <input type="number" min="0" step="1" class="cc-check"></label>' +
        '<label>% оттока <input type="number" min="0" max="100" step="1" class="cc-churn"></label>' +
        '</div>' +
        '<div class="cc-revenue"></div>' +
        '<div class="cc-body hidden">' +
        '<input type="text" class="cc-search" placeholder="поиск партнёра…">' +
        '<div class="cc-list"></div>' +
        '</div>' +
        '</div>'
      );
      channelsHost.appendChild(block);
      var e = {
        blockEl: block,
        headEl: block.querySelector(".cc-head"),
        arrowEl: block.querySelector(".cc-arrow"),
        countEl: block.querySelector(".cc-count"),
        checkInput: block.querySelector(".cc-check"),
        churnInput: block.querySelector(".cc-churn"),
        revenueEl: block.querySelector(".cc-revenue"),
        bodyEl: block.querySelector(".cc-body"),
        searchInput: block.querySelector(".cc-search"),
        listEl: block.querySelector(".cc-list"),
      };
      els[name] = e;

      e.headEl.addEventListener("click", function () {
        openChannel = openChannel === name ? null : name;
        refreshAccordion();
      });
      e.checkInput.addEventListener("input", recomputeAll);
      e.churnInput.addEventListener("input", recomputeAll);
      e.searchInput.addEventListener("input", function () { renderPartnerList(name); });
    });

    fromInput.addEventListener("change", recomputeAll);
    toInput.addEventListener("change", recomputeAll);
    built = true;
  }

  function refreshAccordion() {
    CHANNELS.forEach(function (name) {
      var e = els[name];
      var isOpen = openChannel === name;
      e.bodyEl.classList.toggle("hidden", !isOpen);
      e.arrowEl.textContent = isOpen ? "▾" : "▸";
      if (isOpen) renderPartnerList(name);
    });
  }

  function renderPartnerList(channelKey) {
    var e = els[channelKey];
    if (!e || e.bodyEl.classList.contains("hidden")) return;
    var term = e.searchInput.value.trim().toLowerCase();
    var mine = (byChannel[channelKey] || []).filter(function (n) { return !term || n.toLowerCase().indexOf(term) !== -1; });
    var free = freeList.filter(function (n) { return !term || n.toLowerCase().indexOf(term) !== -1; });

    var html = "";
    if (mine.length) {
      html += '<div class="cc-group-label">В канале (' + mine.length + ')</div>';
      html += mine.map(function (n) { return partnerRowHTML(n, true); }).join("");
    }
    if (free.length) {
      html += '<div class="cc-group-label">Свободные (' + free.length + ')</div>';
      html += free.map(function (n) { return partnerRowHTML(n, false); }).join("");
    }
    if (!mine.length && !free.length) html = '<div class="cc-empty">Ничего не найдено</div>';
    e.listEl.innerHTML = html;

    e.listEl.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var name = cb.dataset.partner;
        overrides[name] = cb.checked ? channelKey : "";
        saveOverrides();
        rebuildAssignment(lastModel, lastCtx);
        recomputeAll();
        renderPartnerList(channelKey);
      });
    });
  }

  function partnerRowHTML(name, checked) {
    return '<label class="cc-partner-row"><input type="checkbox" data-partner="' + esc(name) + '"' + (checked ? " checked" : "") + '> ' + esc(name) + '</label>';
  }

  function recomputeChannel(name) {
    var e = els[name];
    var count = (byChannel[name] || []).length;
    e.countEl.textContent = count ? String(count) : "";
    var check = parseFloat(e.checkInput.value) || 0;
    var churn = parseFloat(e.churnInput.value) || 0;
    var fromVal = fromInput.value, toVal = toInput.value;
    var from = fromVal ? new Date(fromVal + "T00:00:00") : null;
    var to = toVal ? new Date(toVal + "T23:59:59") : null;
    if (!count || !from || !to || from > to || !lastModel) {
      e.revenueEl.textContent = "";
      return 0;
    }
    var set = new Set(byChannel[name]);
    var kassaCount = lastCtx.M.computeRevenueForecastKassas(lastModel, set, from, to);
    var revenue = kassaCount * check * (1 - churn / 100);
    e.revenueEl.textContent = fmtNum(Math.round(revenue)) + " ₽  ·  " + fmtNum(kassaCount) + " касс";
    return revenue;
  }

  function recomputeAll() {
    if (!built || !lastModel) return;
    var total = 0;
    CHANNELS.forEach(function (name) { total += recomputeChannel(name); });
    totalEl.textContent = "Итого по всем каналам: " + fmtNum(Math.round(total)) + " ₽";
  }

  function init(model, ctx) {
    if (!built) buildShell();
    if (!built) return; // markup ещё не вставлен в index.html -- защита от молчаливого краша
    lastModel = model; lastCtx = ctx;
    if (!fromInput.value) fromInput.value = fmtInputDate(ctx.periodStart);
    if (!toInput.value) toInput.value = fmtInputDate(ctx.periodEnd);
    rebuildAssignment(model, ctx);
    recomputeAll();
    if (openChannel) renderPartnerList(openChannel);
  }

  function fmtInputDate(d) {
    if (!(d instanceof Date)) return "";
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  root.OFDChannelCalc = { init: init, refresh: init };
})(typeof window !== "undefined" ? window : globalThis);
