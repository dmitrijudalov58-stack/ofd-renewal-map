/*
 * Раздел «Планирование». Отдельные борды и одна модель параметров.
 * Средние чеки вводятся вручную; вероятности продления и доля покупателей 1С
 * могут рассчитываться из доступной истории и явно подписываются как оценки.
 */
(function (root) {
  "use strict";

  var STORE_KEY = "ofd.planning.v1";
  var GRACE_DAYS = 30;
  var RESOLVE_DAYS = 31;
  var MONEY_TOLERANCE = 0.01;
  var UNASSIGNED = "не назначен";
  var NO_DATA = "Нет данных";
  var NOT_SET = "Не задано";
  var DRAFT = "Черновик — бюджет не завершён";
  var READY = "Подготовлено для согласования";
  var S_OVR = 3, S_MONEY = 4, S_PCT = 5, S_DATE = 6, S_TEXT = 7, S_CALC = 8, S_IN_MONEY = 9, S_IN_PCT = 10;
  var PARAM_PREAMBLE = 12;
  var PARAM_FIRST = PARAM_PREAMBLE + 2;
  var DIRS = [
    { id: "ofd", title: "Продление кодов ОФД", unitQty: "касс", unitCheck: "₽ за продление одной кассы" },
    { id: "onec", title: "Продление Обмена с 1С", unitQty: "касс 1С", unitCheck: "₽ за продление одной кассы 1С" },
    { id: "upsell", title: "Первая продажа Обмена с 1С", unitQty: "сделок с клиентом", unitCheck: "₽ за первую сделку с одним клиентом" },
  ];

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
  function monthKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1); }
  function isPlanMonth(value, year) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""))) return false;
    return String(value).slice(0, 4) === String(year);
  }
  function quarterOf(key) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(key || ""))) return "";
    var m = parseInt(key.slice(5), 10);
    return key.slice(0, 4) + "-Q" + Math.ceil(m / 3);
  }
  function parseTariff(str) {
    var m = /(\d+)/.exec(str == null ? "" : String(str));
    return m ? parseInt(m[1], 10) : null;
  }
  function tariffLabel(code) {
    if (code == null || code === "*" || code === "all" || code === "") return "все тарифы";
    return String(code) + " мес";
  }
  function cycleLabel(c) { return c === "first" ? "первое" : c === "repeat" ? "повторное" : "—"; }
  function isBlank(v) { return v === null || v === undefined || v === ""; }
  function numOrNull(v) {
    if (isBlank(v)) return null;
    var n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
    return isFinite(n) ? n : null;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtQty(v) {
    if (v == null) return NOT_SET;
    return v.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
  }
  function fmtMoney(v) {
    if (v == null) return NOT_SET;
    return v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₽";
  }
  function fmtPct(v) {
    if (v == null) return NO_DATA;
    return (v * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%";
  }
  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return "—";
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear();
  }
  function dirTitle(id) {
    for (var i = 0; i < DIRS.length; i++) if (DIRS[i].id === id) return DIRS[i].title;
    return id;
  }
  function channelNames() {
    var list = (root.OFDMetrics && root.OFDMetrics.CHANNELS) ? root.OFDMetrics.CHANNELS.slice() : ["Корп", "Ольга Зибер", "Пенигина — прямые", "Пенигина — ОП", "Партнёры"];
    if (list.indexOf("Без канала") < 0) list.push("Без канала");
    return list;
  }
  function mergeIntervals(intervals) {
    var sorted = (intervals || []).filter(function (iv) { return iv && iv.start && iv.end; }).slice().sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    sorted.forEach(function (iv) {
      var last = merged[merged.length - 1];
      if (last && iv.start <= last.end) { if (iv.end > last.end) last.end = iv.end; }
      else merged.push({ start: iv.start, end: iv.end });
    });
    return merged;
  }
  function intervalsOf(entity, recordsKey) {
    if (entity.intervals && entity.intervals.length) return entity.intervals;
    var rows = entity[recordsKey || "codes"] || [];
    return rows.map(function (r) { return { start: r.activated || r.tariffStart, end: r.endDate || r.tariffEnd }; });
  }
  function coveredAt(intervals, date, asOf) {
    for (var i = 0; i < intervals.length; i++) {
      var iv = intervals[i];
      if (!iv || !iv.start || !iv.end || iv.start > asOf) continue;
      if (iv.start <= date && iv.end >= date) return true;
    }
    return false;
  }
  function kassaLapsedAt(k, at) {
    var ivs = intervalsOf(k);
    for (var i = 0; i < ivs.length; i++) {
      var iv = ivs[i];
      if (iv.start && iv.start <= at && (!iv.end || at <= iv.end)) return false;
    }
    return true;
  }
  function clientLapsedAt(c, at) {
    if (!c || c.phys || !c.kassas || !c.kassas.length) return true;
    for (var i = 0; i < c.kassas.length; i++) if (!kassaLapsedAt(c.kassas[i], at)) return false;
    return true;
  }
  function channelOfClient(client, overrides) {
    if (!client || !client.kassas || !client.kassas.length) return "Партнёры";
    var last = client.kassas[client.kassas.length - 1];
    return (overrides && overrides[last.partner || "—"]) || last.channel || "Партнёры";
  }
  function forEachKassa(model, fn) {
    if (!model || !model.kassas || !model.kassas.forEach) return;
    model.kassas.forEach(function (k) { fn(k); });
  }
  function clientByInn(model, inn) {
    if (!model || !model.clients || !inn || !model.clients.get) return null;
    return model.clients.get(inn) || null;
  }
  function classifyEnd(end, intervals, asOf) {
    if (!(end instanceof Date) || isNaN(end)) return "insufficient";
    if (end > asOf) return "future";
    var graceEnd = addDays(end, GRACE_DAYS);
    var resolveAt = addDays(end, RESOLVE_DAYS);
    var renewed = coveredAt(intervals, graceEnd, asOf);
    if (!renewed) {
      for (var i = 0; i < intervals.length; i++) {
        var iv = intervals[i];
        if (!iv || !iv.start || iv.start > asOf) continue;
        if (iv.start > end && iv.start <= graceEnd) renewed = true;
      }
    }
    if (asOf < resolveAt) return renewed ? "renewed" : "immature";
    return renewed ? "renewed" : "churned";
  }
  function defaultParams() {
    return { year: 2027, priceMode: "general", vat: null, checks: {}, probManual: {}, events: {}, upsell: {} };
  }
  function validNumberMap(value, percentOnly) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(function (entry) {
      var key = entry[0], number = numOrNull(entry[1]);
      return key.length <= 200 && number != null && number >= 0 && number <= (percentOnly || key.indexOf('v|') === 0 ? 1 : Number.MAX_SAFE_INTEGER / 100);
    }).map(function (entry) { return [entry[0], numOrNull(entry[1])]; }));
  }
  function validChoices(value, isUpsell) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(function (entry) {
      return entry[0].length <= 200 && entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]);
    }).map(function (entry) {
      var item = entry[1];
      return [entry[0], isUpsell
        ? { selected: item.selected === true, month: typeof item.month === 'string' ? item.month.slice(0, 20) : '', comment: typeof item.comment === 'string' ? item.comment.slice(0, 1000) : '' }
        : { excluded: item.excluded === true, month: typeof item.month === 'string' ? item.month.slice(0, 20) : '', comment: typeof item.comment === 'string' ? item.comment.slice(0, 1000) : '' }];
    }));
  }
  function loadParams() {
    var base = defaultParams();
    try {
      var raw = JSON.parse((root.localStorage && root.localStorage.getItem(STORE_KEY)) || 'null');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
      var year = Number(raw.year);
      return {
        year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : base.year,
        priceMode: raw.priceMode === 'partial' ? 'partial' : 'general',
        vat: raw.vat === 'with' || raw.vat === 'without' ? raw.vat : null,
        checks: validNumberMap(raw.checks, false), probManual: validNumberMap(raw.probManual, true),
        events: validChoices(raw.events, false), upsell: validChoices(raw.upsell, true),
      };
    } catch (error) {
      return base;
    }
  }
  function saveParams(p) {
    try {
      if (!root.localStorage) throw new Error('Хранилище браузера недоступно');
      root.localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch (error) {
      Object.keys(views).forEach(function (id) { views[id].feedback = 'Не сохранено: проверьте доступность хранилища браузера.'; });
      console.error('Не удалось сохранить параметры планирования:', error);
      refresh();
      return false;
    }
    cache = null;
    refresh();
    return true;
  }
  function readOverrides() {
    try { return JSON.parse((root.localStorage && root.localStorage.getItem("ofd.channelOverrides.v1")) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function readOnec() {
    var st = root.OFDWidgets && root.OFDWidgets.ofd1cGetState && root.OFDWidgets.ofd1cGetState();
    if (!st || !st.records) return { records: null, fileName: null };
    return { records: st.records, fileName: st.fileName || null };
  }

  function lookupStored(map, key) {
    if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return null;
    return numOrNull(map[key]);
  }

  function retroFromEnds(product, ends, asOf) {
    var events = [];
    var sorted = ends.slice().sort(function (a, b) { return (a.end ? a.end.getTime() : 0) - (b.end ? b.end.getTime() : 0); });
    sorted.forEach(function (item, idx) {
      var prior = 0;
      for (var i = 0; i < idx; i++) if (sorted[i].end) prior++;
      var cycle = prior === 0 ? "first" : "repeat";
      var status = classifyEnd(item.end, item.intervals, asOf);
      var outcome = status === "renewed" ? "продлили" : status === "churned" ? "не продлили" : "";
      var bucket = status === "renewed" || status === "churned" ? "зрелое" : status === "immature" ? "незрелое" : status === "future" ? "будущее" : "недостаточно";
      events.push({
        product: product, inn: item.inn, tariff: item.tariff, cycle: cycle, end: item.end,
        status: bucket, outcome: outcome, unitId: item.unitId,
      });
    });
    return events;
  }

  function segmentKey(product, tariff, cycle) {
    return product + "|" + (tariff == null ? "na" : tariff) + "|" + cycle;
  }
  function aggregateRetro(events) {
    var map = {};
    function touch(key, ev) {
      var row = map[key];
      if (!row) row = map[key] = { key: key, mature: 0, renewed: 0, churned: 0, immature: 0, insufficient: 0, future: 0, innsMature: {}, innsRenewed: {} };
      if (ev.status === "зрелое") {
        row.mature++;
        if (ev.inn) row.innsMature[ev.inn] = 1;
        if (ev.outcome === "продлили") { row.renewed++; if (ev.inn) row.innsRenewed[ev.inn] = 1; }
        if (ev.outcome === "не продлили") row.churned++;
      } else if (ev.status === "незрелое") row.immature++;
      else if (ev.status === "будущее") row.future++;
      else row.insufficient++;
    }
    events.forEach(function (ev) {
      touch(segmentKey(ev.product, ev.tariff == null ? "na" : ev.tariff, ev.cycle), ev);
      touch(segmentKey(ev.product, "all", ev.cycle), ev);
    });
    Object.keys(map).forEach(function (k) {
      var row = map[k];
      row.prob = row.mature > 0 ? row.renewed / row.mature : null;
      row.innsMatureN = Object.keys(row.innsMature).length;
      row.innsRenewedN = Object.keys(row.innsRenewed).length;
      row.clientRate = row.innsMatureN > 0 ? row.innsRenewedN / row.innsMatureN : null;
    });
    return map;
  }
  function effectiveProb(segments, product, tariff, cycle, manual) {
    var specific = segmentKey(product, tariff == null ? "na" : tariff, cycle);
    if (manual != null) return { value: manual, source: "ручной", key: specific };
    var spec = segments[specific];
    if (spec && spec.mature > 0) return { value: spec.prob, source: "ретро", key: specific };
    var generalKey = segmentKey(product, "all", cycle);
    var general = segments[generalKey];
    if (general && general.mature > 0) return { value: general.prob, source: "ретро, все тарифы", key: specific, fallbackKey: generalKey };
    return { value: null, source: NO_DATA, key: specific };
  }

  function directionRetroRate(segments, product) {
    var first = segments[segmentKey(product, "all", "first")];
    var repeat = segments[segmentKey(product, "all", "repeat")];
    var mature = (first ? first.mature : 0) + (repeat ? repeat.mature : 0);
    var renewed = (first ? first.renewed : 0) + (repeat ? repeat.renewed : 0);
    return { value: mature ? renewed / mature : null, mature: mature, renewed: renewed };
  }
  function generalProbKey(product, channel) { return "g|" + product + "|" + channel; }
  function generalCheckKey(product, channel) { return "c|" + product + "|" + channel + "|all"; }
  function privateProbKey(product, ev) {
    if (product === "upsell") return "v|upsell|" + ev.channel;
    return "p|d|" + product + "|" + ev.channel + "|" + (ev.tariff == null ? "na" : ev.tariff) + "|" + ev.cycle;
  }
  function privateCheckKey(product, ev) {
    return "c|" + product + "|" + ev.channel + "|" + (product === "upsell" ? "" : ev.tariff == null ? "na" : ev.tariff);
  }
  function observedBuyerShare(model, buyers, hasRecords, asOf) {
    if (!hasRecords || !model || !model.clients) return { value: null, buyers: 0, active: 0 };
    var active = 0, bought = 0;
    model.clients.forEach(function (client) {
      if (!client || !client.key || client.phys || clientLapsedAt(client, asOf)) return;
      active++;
      if (buyers[client.key]) bought++;
    });
    return { value: active ? bought / active : null, buyers: bought, active: active };
  }

  function roll(rows, kind) {
    var out = { base: 0, included: 0, qty: 0, money: 0, potential: 0, qtyMissing: 0, moneyMissing: 0, inns: {} };
    rows.forEach(function (r) {
      if (kind === "upsell" && !r.selected) return;
      out.base++;
      if (r.inn) out.inns[r.inn] = 1;
      if (!r.included) return;
      out.included++;
      if (r.expectedQty == null) out.qtyMissing++; else out.qty += r.expectedQty;
      if (r.amount == null) out.moneyMissing++; else out.money += r.amount;
      if (r.potential != null) out.potential += r.potential;
    });
    out.innsN = Object.keys(out.inns).length;
    out.qtyKnown = out.qtyMissing === 0 ? out.qty : null;
    out.moneyKnown = out.moneyMissing === 0 ? out.money : null;
    return out;
  }

  function buildPlan(model, asOf, params, records, overrides, meta) {
    params = params || defaultParams();
    meta = meta || {};
    var year = params.year || 2027;
    var exclusions = [];
    var ofdEvents = [];
    var onecEvents = [];
    var retroOfd = [];
    var retroOnec = [];
    var seenOfd = {};
    var minOfd = null, maxOfd = null;
    forEachKassa(model, function (k) {
      var ivs = intervalsOf(k);
      ivs.forEach(function (iv) {
        if (iv.start && (!minOfd || iv.start < minOfd)) minOfd = iv.start;
        if (iv.end && (!maxOfd || iv.end > maxOfd)) maxOfd = iv.end;
      });
      var client = clientByInn(model, k.clientKey);
      var ends = (k.codes && k.codes.length ? k.codes : [{ endDate: null }]).map(function (code, i) {
        var end = (code && (code.endDate || code.overallEnd)) || (ivs[i] && ivs[i].end) || null;
        return {
          end: end, intervals: ivs, inn: k.clientKey || "", tariff: parseTariff(code && code.tariff),
          unitId: k.rnm, code: code,
        };
      });
      if (!k.codes || !k.codes.length) {
        var mergedOnly = mergeIntervals(ivs);
        if (mergedOnly.length) ends = [{ end: mergedOnly[mergedOnly.length - 1].end, intervals: ivs, inn: k.clientKey || "", tariff: parseTariff(k.tariff), unitId: k.rnm, code: null }];
      }
      var part = retroFromEnds("ofd", ends.filter(function (e) { return e.end; }), asOf);
      for (var pi = 0; pi < part.length; pi++) retroOfd.push(part[pi]);
      var merged = mergeIntervals(ivs);
      if (!merged.length) {
        exclusions.push({ product: "ОФД", inn: k.clientKey || "", unit: k.rnm || "", reason: "нет корректной даты окончания покрытия" });
        return;
      }
      var end = merged[merged.length - 1].end;
      if (!end || end.getFullYear() !== year) return;
      if (!k.clientKey) {
        exclusions.push({ product: "ОФД", inn: "", unit: k.rnm || "", reason: "нет ИНН, касса не входит в бюджет" });
        return;
      }
      if (asOf >= addDays(end, RESOLVE_DAYS) && !coveredAt(ivs, addDays(end, GRACE_DAYS), asOf)) {
        exclusions.push({ product: "ОФД", inn: k.clientKey, unit: k.rnm || "", reason: "окно продления закрыто к дате среза" });
        return;
      }
      var id = "ofd|" + k.rnm;
      if (seenOfd[id]) {
        exclusions.push({ product: "ОФД", inn: k.clientKey, unit: k.rnm, reason: "повтор ключа прогноза" });
        return;
      }
      seenOfd[id] = 1;
      var code = null;
      (k.codes || []).forEach(function (c) {
        var e = c.endDate || c.overallEnd;
        if (e && end && e.getTime() === end.getTime()) code = c;
      });
      if (!code && k.codes && k.codes.length) code = k.codes[k.codes.length - 1];
      var prior = 0;
      (k.codes || []).forEach(function (c) {
        var e = c.endDate || c.overallEnd;
        if (e && end && e < end) prior++;
      });
      var cycle = prior > 0 ? "repeat" : "first";
      var tariff = parseTariff(code && code.tariff);
      if (tariff == null) tariff = parseTariff(k.tariff);
      var ov = params.events[id] || {};
      var month = ov.month || monthKey(end);
      ofdEvents.push({
        id: id, product: "ofd", inn: k.clientKey, org: (client && client.org) || k.org || "",
        unit: k.rnm, tariff: tariff, tariffLabel: (code && code.tariff) || k.tariff || tariffLabel(tariff),
        cycle: cycle, channel: channelOfClient(client, overrides),
        baseDate: end, month: month, included: ov.excluded ? 0 : 1, comment: ov.comment || "",
        pin: code && code.pin || "", file: code && code.sourceFile || "", sheet: code && code.sourceSheet || "",
        sourceRow: code && code.sourceRow || "",
      });
    });

    var buyers = {};
    var min1 = null, max1 = null;
    var file1c = meta.file1cName || null;
    if (!records) {
      exclusions.push({ product: "1С", inn: "", unit: "", reason: "файл сверки «Обмен с 1С» не загружен" });
    } else {
      var groups = {};
      records.forEach(function (r) {
        if (r.inn) buyers[r.inn] = 1;
        if (r.tariffStart instanceof Date && (!min1 || r.tariffStart < min1)) min1 = r.tariffStart;
        if (r.tariffEnd instanceof Date && (!max1 || r.tariffEnd > max1)) max1 = r.tariffEnd;
        var reasons = [];
        if (!r.inn) reasons.push("нет ИНН");
        if (!r.kktSerial) reasons.push("нет заводского номера");
        if (!(r.tariffStart instanceof Date) || isNaN(r.tariffStart)) reasons.push("нет даты начала");
        if (!(r.tariffEnd instanceof Date) || isNaN(r.tariffEnd)) reasons.push("нет даты окончания");
        if (reasons.length) {
          exclusions.push({ product: "1С", inn: r.inn || "", unit: r.kktSerial || "", reason: reasons.join(", "), sheet: r.sheetName || "" });
          return;
        }
        var client = clientByInn(model, r.inn);
        if (!client) {
          exclusions.push({ product: "1С", inn: r.inn, unit: r.kktSerial, reason: "ИНН нет в загруженной базе ОФД", sheet: r.sheetName || "" });
          return;
        }
        var key = r.inn + "|" + r.kktSerial;
        if (!groups[key]) groups[key] = { inn: r.inn, serial: r.kktSerial, client: client, records: [] };
        groups[key].records.push(r);
      });
      Object.keys(groups).forEach(function (key) {
        var g = groups[key];
        g.records.sort(function (a, b) { return a.tariffStart - b.tariffStart; });
        var ivs = g.records.map(function (r) { return { start: r.tariffStart, end: r.tariffEnd }; });
        var ends = g.records.map(function (r) {
          return { end: r.tariffEnd, intervals: ivs, inn: g.inn, tariff: r.months, unitId: key };
        });
        var part1 = retroFromEnds("1c", ends, asOf);
        for (var pj = 0; pj < part1.length; pj++) retroOnec.push(part1[pj]);
        var merged = mergeIntervals(ivs);
        if (!merged.length) return;
        var end = merged[merged.length - 1].end;
        if (!end || end.getFullYear() !== year) return;
        if (asOf >= addDays(end, RESOLVE_DAYS) && !coveredAt(ivs, addDays(end, GRACE_DAYS), asOf)) {
          exclusions.push({ product: "1С", inn: g.inn, unit: g.serial, reason: "окно продления закрыто к дате среза" });
          return;
        }
        var last = g.records[g.records.length - 1];
        var prior = 0;
        g.records.forEach(function (r) { if (r.tariffEnd && r.tariffEnd < end) prior++; });
        var ov = params.events["1c|" + key] || {};
        onecEvents.push({
          id: "1c|" + key, product: "onec", inn: g.inn, org: g.client.org || "",
          unit: g.serial, tariff: last.months, tariffLabel: last.months == null ? "тариф не указан" : (last.months + " мес"),
          cycle: prior > 0 ? "repeat" : "first", channel: channelOfClient(g.client, overrides),
          baseDate: end, month: ov.month || monthKey(end), included: ov.excluded ? 0 : 1, comment: ov.comment || "",
          pin: "", file: file1c || "", sheet: last.sheetName || "", sourceRow: "",
        });
      });
    }

    var segOfd = aggregateRetro(retroOfd);
    var segOnec = aggregateRetro(retroOnec);
    var directionRates = { ofd: directionRetroRate(segOfd, "ofd"), onec: directionRetroRate(segOnec, "1c") };
    var observedUpsell = observedBuyerShare(model, buyers, !!records, asOf);
    var priceMode = params.priceMode === "partial" ? "partial" : "general";
    function applyMoney(ev, product) {
      var generalProb = lookupStored(params.probManual, generalProbKey(product, ev.channel));
      var directionRate = directionRates[product].value;
      var legacyProb = lookupStored(params.probManual, segmentKey(product === "onec" ? "1c" : product, ev.tariff, ev.cycle));
      var privateProb = lookupStored(params.probManual, privateProbKey(product, ev));
      var chosenProb = priceMode === "partial" ? (privateProb != null ? privateProb : legacyProb) : null;
      ev.prob = chosenProb != null ? chosenProb : generalProb != null ? generalProb : directionRate;
      ev.probSource = chosenProb != null ? "частный ввод" : generalProb != null ? "общий ввод" : "ретро по направлению";
      ev.probKey = privateProbKey(product, ev);
      ev.checkKey = privateCheckKey(product, ev);
      var commonCheck = lookupStored(params.checks, generalCheckKey(product, ev.channel));
      var tariffCheck = priceMode === "partial" ? lookupStored(params.checks, ev.checkKey) : null;
      ev.check = tariffCheck != null ? tariffCheck : commonCheck;
      if (!ev.included) {
        ev.expectedQty = 0;
        ev.amount = ev.check == null ? null : 0;
        ev.potential = null;
      } else {
        ev.expectedQty = ev.prob == null ? null : ev.prob;
        ev.amount = ev.prob == null || ev.check == null ? null : ev.prob * ev.check;
        ev.potential = ev.check == null ? null : ev.check;
      }
    }
    ofdEvents.forEach(function (ev) { applyMoney(ev, "ofd"); });
    onecEvents.forEach(function (ev) { applyMoney(ev, "onec"); });

    var upsell = [];
    var seenUp = {};
    if (records && model && model.clients && model.clients.forEach) {
      model.clients.forEach(function (c) {
        if (!c || c.phys || !c.key) return;
        if (clientLapsedAt(c, asOf)) return;
        if (buyers[c.key]) return;
        if (seenUp[c.key]) return;
        seenUp[c.key] = 1;
        var sel = params.upsell[c.key] || {};
        var selected = !!sel.selected;
        var channel = channelOfClient(c, overrides);
        var convKey = privateProbKey("upsell", { channel: channel });
        var checkKey = privateCheckKey("upsell", { channel: channel });
        var generalConv = lookupStored(params.probManual, generalProbKey("upsell", channel));
        var specificConv = priceMode === "partial" ? lookupStored(params.checks, convKey) : null;
        var conv = specificConv != null ? specificConv : generalConv != null ? generalConv : observedUpsell.value;
        var generalCheck = lookupStored(params.checks, generalCheckKey("upsell", channel));
        var specificCheck = priceMode === "partial" ? lookupStored(params.checks, checkKey) : null;
        var check = specificCheck != null ? specificCheck : generalCheck;
        var row = {
          id: "up|" + c.key, product: "upsell", inn: c.key, org: c.org || "", unit: c.key,
          tariff: null, tariffLabel: "—", cycle: "", channel: channel,
          baseDate: null, month: selected ? (sel.month || UNASSIGNED) : "",
          included: selected ? 1 : 0, selected: selected, comment: sel.comment || "",
          kassas: (c.kassas || []).filter(function (k) { return !kassaLapsedAt(k, asOf); }).length,
          score: null, reason: "",
          prob: conv, probSource: specificConv != null ? "частный ввод" : generalConv != null ? "общий ввод" : "наблюдаемая доля покупателей 1С (не годовая конверсия)",
          probKey: convKey, checkKey: checkKey, check: check, fallbackKey: "",
          pin: "", file: "", sheet: "", sourceRow: "",
        };
        if (!selected) { row.expectedQty = 0; row.amount = null; row.potential = null; }
        else {
          row.expectedQty = conv == null ? null : conv;
          row.amount = conv == null || check == null ? null : conv * check;
          row.potential = null;
        }
        upsell.push(row);
      });
    }
    if (meta.scores) {
      upsell.forEach(function (r) {
        var s = meta.scores[r.inn];
        if (!s) return;
        r.score = s.score;
        r.reason = s.reason || "";
      });
    }

    var coverage = {
      ofdFrom: minOfd, ofdTo: maxOfd, onecFrom: min1, onecTo: max1,
      observedUpsell: observedUpsell, directionRates: directionRates,
      ofdFiles: meta.sourceFiles || [], onecFile: file1c, onecLoaded: !!records,
      historyNote: records
        ? "Кандидаты первой продажи — действующие клиенты ОФД без покупки 1С в загруженном файле. Отсутствие в файле не доказывает, что покупки не было раньше покрытия файла."
        : "Файл «Обмен с 1С» не загружен: продления 1С и первая продажа не считаются нулём, для них недостаточно данных.",
    };
    var plan = {
      year: year, asOf: asOf, params: params, coverage: coverage,
      ofd: ofdEvents, onec: onecEvents, upsell: upsell, exclusions: exclusions,
      retroOfd: { events: retroOfd, segments: segOfd },
      retroOnec: { events: retroOnec, segments: segOnec },
      buyersN: Object.keys(buyers).length,
    };
    plan.roll = { ofd: roll(ofdEvents), onec: roll(onecEvents), upsell: roll(upsell, "upsell") };
    var union = {};
    ["ofd", "onec", "upsell"].forEach(function (k) {
      Object.keys(plan.roll[k].inns).forEach(function (inn) { union[inn] = 1; });
    });
    plan.roll.unionInns = Object.keys(union).length;
    plan.paramsRows = buildParamRows(plan);
    plan.audit = audit(plan);
    plan.status = planStatus(plan);
    return plan;
  }

  function buildParamRows(plan) {
    var rows = [], seen = new Set();
    var params = plan.params;
    var isPartial = params.priceMode === "partial";
    var byProduct = [
      { id: "ofd", events: plan.ofd, title: DIRS[0].title, unit: DIRS[0].unitCheck, segments: plan.retroOfd.segments, retro: plan.coverage.directionRates.ofd },
      { id: "onec", events: plan.onec, title: DIRS[1].title, unit: DIRS[1].unitCheck, segments: plan.retroOnec.segments, retro: plan.coverage.directionRates.onec },
      { id: "upsell", events: plan.upsell, title: DIRS[2].title, unit: DIRS[2].unitCheck, retro: plan.coverage.observedUpsell },
    ];
    function add(row) {
      if (seen.has(row.key)) return;
      seen.add(row.key);
      rows.push(row);
    }
    byProduct.forEach(function (group) {
      group.events.forEach(function (ev) {
        var checkKey = generalCheckKey(group.id, ev.channel);
        var probKey = generalProbKey(group.id, ev.channel);
        var commonCheck = lookupStored(params.checks, checkKey);
        var commonInput = lookupStored(params.probManual, probKey);
        var estimate = group.retro.value;
        var commonProb = commonInput != null ? commonInput : estimate;
        var probSource = group.id === "upsell"
          ? "Покупатели 1С в доступной истории: " + group.retro.buyers + " из " + group.retro.active + " действующих ОФД; не годовая конверсия"
          : "Зрелые окончания: " + group.retro.mature + ", продлили: " + group.retro.renewed + "; доля по направлению";
        add({ key: "p|" + probKey, storeKey: probKey, direction: group.title, channel: ev.channel,
          tariff: "все тарифы", cycle: "—", metric: group.id === "upsell" ? "Вероятность нового подключения" : "Вероятность продления кассы",
          manual: commonInput, calculated: estimate, effective: commonProb, source: commonInput != null ? "общий ввод" : probSource,
          unit: group.id === "upsell" ? "наблюдаемая доля, не годовой прогноз" : "доля зрелых окончаний",
          inputKind: "prob", storeField: "probManual", scope: "general", retroProduct: group.id });
        add({ key: checkKey, storeKey: checkKey, direction: group.title, channel: ev.channel,
          tariff: "все тарифы", cycle: "—", metric: group.id === "upsell" ? "Средний чек нового подключения" : "Средний чек продления",
          manual: commonCheck, calculated: null, effective: commonCheck, source: commonCheck == null ? NOT_SET : "общий ввод",
          unit: group.unit, inputKind: "money", storeField: "checks", scope: "general" });
        var specificProbKey = privateProbKey(group.id, ev);
        var oldProb = group.id === "upsell" ? lookupStored(params.checks, specificProbKey)
          : lookupStored(params.probManual, segmentKey(group.id === "onec" ? "1c" : "ofd", ev.tariff, ev.cycle));
        var newProb = group.id === "upsell" ? oldProb : lookupStored(params.probManual, specificProbKey);
        var specificProb = newProb != null ? newProb : oldProb;
        var tariffProb = group.segments && group.segments[segmentKey(group.id === "onec" ? "1c" : "ofd", ev.tariff, ev.cycle)];
        add({ key: specificProbKey, storeKey: specificProbKey, direction: group.title, channel: ev.channel,
          tariff: group.id === "upsell" ? "—" : tariffLabel(ev.tariff), cycle: group.id === "upsell" ? "—" : cycleLabel(ev.cycle),
          metric: group.id === "upsell" ? "Вероятность нового подключения" : "Вероятность продления кассы",
          manual: specificProb, calculated: tariffProb && tariffProb.prob, effective: isPartial && specificProb != null ? specificProb : commonProb,
          source: isPartial && specificProb != null ? "частный ввод" : "общий параметр",
          unit: group.id === "upsell" ? "доля клиентов" : "доля касс", inputKind: "prob",
          storeField: group.id === "upsell" ? "checks" : "probManual", scope: "partial", generalKey: "p|" + probKey });
        var specificCheckKey = privateCheckKey(group.id, ev);
        var specificCheck = lookupStored(params.checks, specificCheckKey);
        add({ key: specificCheckKey, storeKey: specificCheckKey, direction: group.title, channel: ev.channel,
          tariff: group.id === "upsell" ? "—" : tariffLabel(ev.tariff), cycle: "—",
          metric: group.id === "upsell" ? "Средний чек нового подключения" : "Средний чек продления",
          manual: specificCheck, calculated: null, effective: isPartial && specificCheck != null ? specificCheck : commonCheck,
          source: isPartial && specificCheck != null ? "частный ввод" : "общий параметр",
          unit: group.unit, inputKind: "money", storeField: "checks", scope: "partial", generalKey: checkKey });
      });
    });
    return rows;
  }

  function sumMoney(rows, pred) {
    var sum = 0, missing = 0, n = 0;
    rows.forEach(function (r) {
      if (pred && !pred(r)) return;
      if (!r.included) return;
      n++;
      if (r.amount == null) missing++; else sum += r.amount;
    });
    return { sum: sum, missing: missing, n: n };
  }
  function monthBucket(ev, year) {
    if (!ev.included) return null;
    return isPlanMonth(ev.month, year) ? ev.month : UNASSIGNED;
  }
  function planStatus(plan) {
    var gaps = [];
    if (!plan.params.vat) gaps.push("не отмечено, с НДС или без НДС средний чек");
    if (!plan.coverage.onecLoaded) gaps.push("нет файла «Обмен с 1С»");
    var missingCheck = 0, missingProb = 0, unassigned = 0, invalidMonth = 0;
    function scan(list) {
      list.forEach(function (r) {
        if (!r.included) return;
        if (r.check == null) missingCheck++;
        if (r.prob == null) missingProb++;
        if (!r.month || r.month === UNASSIGNED) unassigned++;
        else if (!isPlanMonth(r.month, plan.year)) invalidMonth++;
      });
    }
    scan(plan.ofd); scan(plan.onec); scan(plan.upsell);
    if (missingCheck) gaps.push("пустые средние чеки: " + missingCheck);
    if (missingProb) gaps.push("пустые вероятности или конверсия: " + missingProb);
    if (unassigned) gaps.push("месяц не назначен: " + unassigned);
    if (invalidMonth) gaps.push("месяц вне " + plan.year + " года или неверного формата: " + invalidMonth);
    var badAudit = plan.audit ? plan.audit.filter(function (a) { return !a.ok; }) : [];
    badAudit.forEach(function (a) { gaps.push(a.name); });
    return { ready: gaps.length === 0, label: gaps.length ? DRAFT : READY, gaps: gaps, missingCheck: missingCheck, missingProb: missingProb, unassigned: unassigned, invalidMonth: invalidMonth };
  }
  function near(a, b) { return Math.abs(a - b) <= MONEY_TOLERANCE; }
  function audit(plan) {
    var rows = [];
    var ofd = sumMoney(plan.ofd), onec = sumMoney(plan.onec), up = sumMoney(plan.upsell);
    var total = ofd.sum + onec.sum + up.sum;
    rows.push({ name: "Деньги трёх направлений сходятся со сводкой", ok: near(total, ofd.sum + onec.sum + up.sum), left: total, right: ofd.sum + onec.sum + up.sum });
    function monthSum(list) {
      var s = 0;
      list.forEach(function (r) { if (r.included && r.amount != null) s += r.amount; });
      return s;
    }
    ["ofd", "onec", "upsell"].forEach(function (k) {
      var list = plan[k === "ofd" ? "ofd" : k === "onec" ? "onec" : "upsell"];
      var a = sumMoney(list).sum;
      rows.push({ name: "Детализация " + dirTitle(k), ok: near(a, monthSum(list)), left: a, right: monthSum(list) });
      var by = 0;
      list.forEach(function (r) { if (r.included && r.amount != null) by += r.amount; });
      rows.push({ name: "Месяцы + неназначенный = год (" + dirTitle(k) + ")", ok: near(by, a), left: by, right: a });
    });
    var ch = 0;
    [plan.ofd, plan.onec, plan.upsell].forEach(function (list) {
      list.forEach(function (r) { if (r.included && r.amount != null) ch += r.amount; });
    });
    rows.push({ name: "Каналы, включая нераспределённые, дают тот же итог", ok: near(ch, total), left: ch, right: total });
    function retroOk(seg) {
      var ok = true;
      Object.keys(seg).forEach(function (k) {
        var s = seg[k];
        if (s.mature !== s.renewed + s.churned) ok = false;
      });
      return ok;
    }
    rows.push({ name: "Зрелая ретро-база ОФД = продлили + не продлили", ok: retroOk(plan.retroOfd.segments), left: 0, right: 0 });
    rows.push({ name: "Зрелая ретро-база 1С = продлили + не продлили", ok: retroOk(plan.retroOnec.segments), left: 0, right: 0 });
    var ids = {}, dup = false, upIds = {}, upDup = false;
    plan.ofd.concat(plan.onec).forEach(function (r) { if (ids[r.id]) dup = true; ids[r.id] = 1; });
    plan.upsell.forEach(function (r) { if (upIds[r.inn]) upDup = true; upIds[r.inn] = 1; });
    rows.push({ name: "Ключи прогноза и ИНН первой продажи уникальны", ok: !dup && !upDup, left: 0, right: 0 });
    var summedInns = plan.roll.ofd.innsN + plan.roll.onec.innsN + plan.roll.upsell.innsN;
    rows.push({ name: "Уникальные ИНН сводки — объединение, не сумма продуктов", ok: plan.roll.unionInns <= summedInns, left: plan.roll.unionInns, right: summedInns });
    rows.push({ name: "Допуск денег " + MONEY_TOLERANCE + " ₽", ok: true, left: MONEY_TOLERANCE, right: MONEY_TOLERANCE });
    return rows;
  }

  var cache = null;
  function compute(model, ctx, extra) {
    extra = extra || {};
    var params = extra.params || loadParams();
    var asOf = (ctx && ctx.asOf) || extra.asOf || new Date();
    var pack = extra.records1c !== undefined ? { records: extra.records1c, fileName: extra.file1cName || null } : readOnec();
    var overrides = extra.channelOverrides || readOverrides();
    var meta = {
      file1cName: pack.fileName, sourceFiles: extra.sourceFiles || (root.OFDState && root.OFDState.sourceFiles) || [],
      scores: extra.scores || scoreCache,
    };
    var key = null;
    if (!extra.nocache) {
      key = [params.year, params.priceMode, params.vat, asOf.getTime(), pack.records ? pack.records.length : -1, JSON.stringify(params.checks), JSON.stringify(params.probManual), JSON.stringify(params.events), JSON.stringify(params.upsell), JSON.stringify(overrides)].join("~");
      if (cache && cache.key === key && cache.model === model && cache.records === pack.records) return cache.plan;
    }
    var plan = buildPlan(model, asOf, params, pack.records, overrides, meta);
    if (!extra.nocache) cache = { key: key, model: model, records: pack.records, plan: plan };
    return plan;
  }

  function colLetter(i) {
    var s = "";
    for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }
  function qName(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }
  function sheetRange(sheet, col) {
    return qName(sheet.sheetName) + "!$" + col + "$2:$" + col + "$" + Math.max(2, sheet.rows.length + 1);
  }
  function tx(v) { return { v: v == null ? "" : String(v), t: "inlineStr", s: S_TEXT }; }
  function fml(f, v, s) { return { f: f, v: v == null ? "" : v, s: s == null ? S_CALC : s }; }
  function xdate(d) {
    if (!(d instanceof Date) || isNaN(d)) return "";
    return { v: (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000, s: S_DATE };
  }
  function inputCell(value, kind, override) {
    if (isBlank(value)) return { v: "", s: kind === "money" ? S_IN_MONEY : S_IN_PCT };
    return { v: value, s: override ? S_OVR : (kind === "money" ? S_IN_MONEY : S_IN_PCT) };
  }

  function buildWorkbook(plan, opts) {
    opts = opts || {};
    var exportedAt = opts.exportedAt || new Date();
    var board = opts.board || "all";
    var filter = opts.filter || null;
    function pass(ev) {
      if (!filter) return true;
      if (filter.channel && ev.channel !== filter.channel) return false;
      if (filter.month && monthBucket(ev, plan.year) !== filter.month) return false;
      if (filter.tariff && ev.tariffLabel !== filter.tariff) return false;
      if (filter.q) {
        var blob = (ev.inn + " " + ev.org + " " + ev.unit).toLowerCase();
        if (blob.indexOf(filter.q.toLowerCase()) < 0) return false;
      }
      return true;
    }
    var ofd = plan.ofd.filter(pass);
    var onec = plan.onec.filter(pass);
    var upsell = plan.upsell.filter(function (r) {
      if (filter && filter.onlySelected && !r.selected) return false;
      return pass(r);
    });
    if (board === "ofd") { onec = []; upsell = []; }
    if (board === "onec") { ofd = []; upsell = []; }
    if (board === "upsell") { ofd = []; onec = []; }
    if (board === "retro") { ofd = []; onec = []; upsell = []; }
    var lists = { ofd: ofd, onec: onec, upsell: upsell };
    var bookPlan = Object.assign({}, plan, { roll: Object.assign({}, plan.roll, {
      ofd: roll(ofd), onec: roll(onec), upsell: roll(upsell, "upsell"),
    }) });
    bookPlan.audit = audit(bookPlan);
    bookPlan.status = planStatus(bookPlan);
    if (board !== "all" && board !== "summary" && board !== "params") {
      bookPlan.status = Object.assign({}, bookPlan.status, {
        ready: false, label: DRAFT,
        gaps: bookPlan.status.gaps.concat(["выгружен срез борда, не весь бюджет"]),
      });
    }
    var isPartial = board !== "all" && board !== "summary" && board !== "params";
    // В срезе ретро-листы нужны для формул параметров, но не должны раскрывать
    // ИНН/РНМ других клиентов из полной истории. Сохраняем лишь агрегаты.
    var retroO = retroSheet("Ретро ОФД", plan.retroOfd, "ofd", null, isPartial);
    var retroC = retroSheet("Ретро 1С", plan.retroOnec, "1c", null, isPartial);
    var params = paramSheet(bookPlan, exportedAt, { ofd: retroO, onec: retroC }, board);
    var paramLast = Math.max(PARAM_FIRST, PARAM_FIRST + plan.paramsRows.length - 1);
    var ofdSheet = detailSheet("Продления ОФД", ofd, false, plan.year, paramLast);
    var onecSheet = detailSheet("Продления 1С", onec, false, plan.year, paramLast);
    var upSheet = detailSheet("Допродажи 1С", upsell, true, plan.year, paramLast);
    var months = monthSheet(bookPlan, lists);
    var channels = channelSheet(bookPlan, lists);
    var exclusions = exclusionSheet(isPartial ? [] : plan.exclusions);
    var summary = summarySheet(bookPlan, { ofd: ofdSheet, onec: onecSheet, upsell: upSheet });
    var checks = checksSheet(bookPlan, { ofd: ofdSheet, onec: onecSheet, upsell: upSheet, summary: summary, months: months, channels: channels, retroO: retroO, retroC: retroC });
    var sheets = [params, summary, ofdSheet, onecSheet, upSheet, retroO, retroC, months, channels, exclusions, checks];
    if (board === "retro") {
      var retroFilter = function (retro, product, title) {
        var selected = retro.events.filter(function (event) {
          var tariff = event.tariff == null ? "na" : String(event.tariff);
          return (!filter || !filter.retroCycle || event.cycle === filter.retroCycle) &&
            (!filter || !filter.retroTariff || filter.retroTariff === "all" || tariff === filter.retroTariff);
        });
        return retroSheet(title, { events: selected, segments: aggregateRetro(selected) }, product, filter);
      };
      sheets.splice(1, 0,
        retroFilter(plan.retroOfd, "ofd", "Отбор ретро ОФД"),
        retroFilter(plan.retroOnec, "1c", "Отбор ретро 1С"));
    }
    return { sheets: sheets, exportedAt: exportedAt };
  }

  function paramSheet(plan, exportedAt, retroSheets, board) {
    var isPartial = board !== "all" && board !== "summary" && board !== "params";
    var statusGuard = isPartial ? "FALSE" : "TRUE";
    var vat = plan.params.vat === "with" ? "с НДС" : plan.params.vat === "without" ? "без НДС" : "не выбрано";
    var files = (plan.coverage.ofdFiles || []).join(", ") || "файл ОФД в этой сессии";
    var preamble = [
      ["Назначение", (isPartial ? "Срез борда «" + board + "», не полный бюджет. " : "Полный бюджет. ") + "Бюджетный прогноз продлений ОФД, продлений «Обмена с 1С» и первой продажи 1С действующим клиентам. Это не бухгалтерское признание выручки и не утверждённый бюджет."],
      ["Статус", fml('=IF(AND(' + statusGuard + ',OR(B6="с НДС",B6="без НДС"),OR(B12="Общий",B12="Частный"),Проверки!B4=0,Проверки!B5=0,Проверки!B6=0,Проверки!B7=0,Проверки!B8=0,Проверки!B9=0,COUNTIF(Проверки!B10:B100,"РАСХОЖДЕНИЕ")=0),"' + READY + '","' + DRAFT + '")', plan.status.label, S_CALC)],
      ["Год плана", plan.year],
      ["Дата среза", fmtDate(plan.asOf)],
      ["Время выгрузки", exportedAt.toLocaleString("ru-RU")],
      ["Средний чек", vat],
      ["Источники ОФД", files + (plan.coverage.ofdFrom ? "; покрытие " + fmtDate(plan.coverage.ofdFrom) + " — " + fmtDate(plan.coverage.ofdTo) : "")],
      ["Источник 1С", plan.coverage.onecLoaded ? (plan.coverage.onecFile || "файл 1С") + (plan.coverage.onecFrom ? "; " + fmtDate(plan.coverage.onecFrom) + " — " + fmtDate(plan.coverage.onecTo) : "") : "не загружен"],
      ["Допущения", "Один чек за кассу/сделку по направлению и каналу; тарифы учитываются только в частном режиме. Вероятность продления — зрелое ретро по всем тарифам направления. Доля покупателей 1С из доступной истории не является годовой конверсией."],
      ["Покрытие истории", plan.coverage.historyNote],
      ["Допуск сверки", MONEY_TOLERANCE + " ₽. Синие ячейки ввода можно менять: суммы пересчитаются. Ретро-процент и доля покупателей 1С — оценки, а не подтверждённая годовая конверсия."],
      ["Режим параметров", plan.params.priceMode === "partial" ? "Частный" : "Общий", "Покупателей 1С среди действующих ОФД", plan.coverage.observedUpsell.buyers, "Действующих клиентов ОФД", plan.coverage.observedUpsell.active],
    ];
    var rowNumbers = Object.fromEntries(plan.paramsRows.map(function (row, index) { return [row.key, PARAM_FIRST + index]; }));
    var rows = plan.paramsRows.map(function (r, i) {
      var excel = PARAM_FIRST + i;
      var calc = "";
      var calcVal = r.calculated == null ? "" : r.calculated;
      if (r.scope === "general" && r.inputKind === "prob") {
        if (r.retroProduct === "upsell") {
          calc = fml('=IF($F$12=0,"",$D$12/$F$12)', calcVal, S_PCT);
        } else {
          var retro = r.retroProduct === "onec" ? retroSheets.onec : retroSheets.ofd;
          var product = r.retroProduct === "onec" ? "1c" : "ofd";
          var segmentRows = ["first", "repeat"].map(function (cycle) {
            var index = retro._segments.indexOf(segmentKey(product, "all", cycle));
            return index < 0 ? null : index + 4;
          }).filter(Boolean);
          if (segmentRows.length) {
            var mature = segmentRows.map(function (n) { return qName(retro.sheetName) + '!D' + n; }).join(',');
            var renewed = segmentRows.map(function (n) { return qName(retro.sheetName) + '!E' + n; }).join(',');
            calc = fml('=IF(SUM(' + mature + ')=0,"",SUM(' + renewed + ')/SUM(' + mature + '))', calcVal, S_PCT);
          }
        }
      }
      var generalRow = r.generalKey && rowNumbers[r.generalKey];
      var applyF = generalRow
        ? '=IF($B$12="Частный",IF(G' + excel + '="",I' + generalRow + ',G' + excel + '),I' + generalRow + ')'
        : '=IF(G' + excel + '="",IF(H' + excel + '="","Не задано",H' + excel + '),G' + excel + ')';
      var applyV = r.effective == null ? NOT_SET : r.effective;
      return [
        tx(r.key), r.direction, r.channel, r.tariff, r.cycle, r.metric,
        inputCell(r.manual, r.inputKind, r.inputKind === "prob" && r.manual != null),
        calc || (r.scope === "partial" && calcVal !== "" ? { v: calcVal, s: S_PCT } : ""),
        fml(applyF, applyV, r.inputKind === "money" ? S_MONEY : S_PCT),
        r.unit, r.source,
      ];
    });
    return {
      sheetName: "Описание и параметры",
      headers: ["Ключ", "Направление", "Канал", "Тариф", "Цикл", "Показатель", "Ввод", "Расчёт", "Применять", "Единица", "Источник"],
      rows: rows, preamble: preamble,
      colWidths: [28, 36, 24, 16, 14, 32, 14, 14, 14, 42, 28],
      filterRef: "A" + (PARAM_PREAMBLE + 1) + ":K" + (PARAM_PREAMBLE + 1 + rows.length),
    };
  }

  function detailSheet(name, events, upsell, year, paramLast) {
    var headers = ["Ключ", "ИНН", "Клиент", "Единица", "Тариф", "Цикл", "Канал", "Дата основания", "Месяц плана", "В плане", "Комментарий", "Ключ чека", "Ключ вероятности", "Вероятность или конверсия", "Средний чек", "Ожидаемое количество", "Сумма", "Потенциал при полном продлении", "PIN или цепочка", "Файл", "Лист", "Строка источника", "Квартал|ИНН", "Касс ОФД", "Score", "Почему в приоритете", "Месяц корректен"];
    var rows = events.map(function (ev, i) {
      var n = i + 2;
      var probF = '=IF(M' + n + '="","",IFERROR(INDEX(\'Описание и параметры\'!$I$' + PARAM_FIRST + ':$I$' + paramLast +',MATCH(M' + n + ',\'Описание и параметры\'!$A$' + PARAM_FIRST + ':$A$' + paramLast +',0)),"Не задано"))';
      var checkF = '=IF(L' + n + '="","",IFERROR(INDEX(\'Описание и параметры\'!$I$' + PARAM_FIRST + ':$I$' + paramLast +',MATCH(L' + n + ',\'Описание и параметры\'!$A$' + PARAM_FIRST + ':$A$' + paramLast +',0)),"Не задано"))';
      var qtyF = '=IF(J' + n + '=0,0,IF(OR(N' + n + '="",N' + n + '="Не задано"),"",1*N' + n + '))';
      var amtF = '=IF(OR(P' + n + '="",O' + n + '="",O' + n + '="Не задано"),"",P' + n + '*O' + n + ')';
      var potF = upsell ? "" : '=IF(OR(J' + n + '=0,O' + n + '="",O' + n + '="Не задано"),"",O' + n + ')';
      var qInn = ev.included && isPlanMonth(ev.month, year) ? (quarterOf(ev.month) + "|" + ev.inn) : "";
      var planMonth = ev.included ? monthBucket(ev, year) : (ev.month || "");
      var invalidNote = ev.included && ev.month && ev.month !== UNASSIGNED && !isPlanMonth(ev.month, year)
        ? "Месяц вне года плана: " + ev.month : "";
      var monthValidF = '=IF(J' + n + '=0,1,IF(AND(LEN(I' + n + ')=7,IFERROR(VALUE(LEFT(I' + n + ',4)),0)=\'Описание и параметры\'!$B$3,MID(I' + n + ',5,1)="-",IFERROR(VALUE(RIGHT(I' + n + ',2)),0)>=1,IFERROR(VALUE(RIGHT(I' + n + ',2)),0)<=12),1,0))';
      return [
        tx(ev.id), tx(ev.inn), ev.org || "", tx(ev.unit || ""), ev.tariffLabel || "", cycleLabel(ev.cycle), ev.channel || "",
        ev.baseDate ? xdate(ev.baseDate) : "", planMonth, ev.included ? 1 : 0,
        [ev.comment, invalidNote].filter(Boolean).join("; "),
        tx(ev.checkKey || ""), tx(ev.probKey || ""),
        fml(probF, ev.prob == null ? NOT_SET : ev.prob, S_PCT),
        fml(checkF, ev.check == null ? NOT_SET : ev.check, S_MONEY),
        fml(qtyF, ev.expectedQty == null ? "" : ev.expectedQty, S_CALC),
        fml(amtF, ev.amount == null ? "" : ev.amount, S_MONEY),
        potF === "" ? "" : fml(potF, ev.potential == null ? "" : ev.potential, S_MONEY),
        tx(ev.pin || ev.id), ev.file || "", ev.sheet || "", ev.sourceRow || "",
        qInn, upsell ? ev.kassas || 0 : "", upsell ? (ev.score == null ? "" : ev.score) : "", upsell ? (ev.reason || "") : "",
        fml(monthValidF, ev.included && !isPlanMonth(ev.month, year) ? 0 : 1, S_CALC),
      ];
    });
    return {
      sheetName: name, headers: headers, rows: rows,
      colWidths: [24, 16, 36, 22, 16, 14, 24, 16, 16, 12, 28, 28, 28, 18, 16, 18, 16, 22, 20, 28, 18, 14, 24, 12, 10, 40, 16],
      colOutline: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1],
      _events: events,
    };
  }

  function retroSheet(name, retro, product, filter, anonymize) {
    var MAX_RETRO_ROWS = 20000;
    var keys = Object.keys(retro.segments).filter(function (key) {
      if (!filter) return true;
      var parts = key.split("|");
      return (!filter.retroTariff || parts[1] === filter.retroTariff) &&
        (!filter.retroCycle || parts[2] === filter.retroCycle);
    }).sort();
    var capped = retro.events.length > MAX_RETRO_ROWS || !!anonymize;
    var groupedEvents = new Map();
    if (capped) retro.events.forEach(function (event) {
      var bucket = JSON.stringify([event.tariff, event.cycle, event.status, event.outcome]);
      var entry = groupedEvents.get(bucket);
      groupedEvents.set(bucket, entry ? { event: entry.event, count: entry.count + 1 } : { event: event, count: 1 });
    });
    var events = capped ? Array.from(groupedEvents.values()) : retro.events.map(function (event) { return { event: event, count: 1 }; });
    var preambleLen = 3 + keys.length + 1;
    var headerAt = preambleLen + 1;
    var first = headerAt + 1;
    var last = Math.max(first, first + events.length - 1);
    var preamble = [
      [name, capped
        ? "Окончаний " + retro.events.length + ". " + (anonymize ? "Срез борда: полная история сведена к анонимным группам только для пересчёта параметров. " : "Для размера книги одинаковые исходы свернуты в группы. ") + "Столбец «Число событий» хранит кратность; суммы и вероятность пересчитываются формулами. Уникальные ИНН зафиксированы на момент выгрузки: их нельзя пересчитать из сгруппированных строк."
        : "Вероятность кассы = продлили / зрелые окончания. Уникальные ИНН зафиксированы при выгрузке и не пересчитываются при изменении исходных строк Excel. Незрелые окончания в знаменатель не входят."],
      ["", ""],
      ["Ключ", "Тариф", "Цикл", "Зрелая база", "Продлили", "Не продлили", "Незрелые", "Недостаточно", "Будущие", "Вероятность кассы", "ИНН со зрелым событием", "ИНН, продлившие хотя бы одну кассу", "Доля таких ИНН"],
    ];
    keys.forEach(function (key) {
      var seg = retro.segments[key];
      var parts = key.split("|");
      var star = parts[1] === "all";
      var col = star ? "F" : "D";
      var outCol = star ? "G" : "E";
      var excel = preamble.length + 1;
      var range = function (c) { return "$" + c + "$" + first + ":$" + c + "$" + last; };
      var probF = '=IF(D' + excel + '=0,"",E' + excel + '/D' + excel + ')';
      var row = [key, tariffLabel(parts[1] === "na" ? null : parts[1]), cycleLabel(parts[2])];
      var countF = function (column, value) {
        return '=SUMIFS(' + range('J') + ',' + range(column) + ',"' + key + '|' + value + '")';
      };
      row.push(
        fml(countF(col, 'зрелое'), seg.mature, S_CALC), fml(countF(outCol, 'продлили'), seg.renewed, S_CALC),
        fml(countF(outCol, 'не продлили'), seg.churned, S_CALC), fml(countF(col, 'незрелое'), seg.immature, S_CALC),
        fml(countF(col, 'недостаточно'), seg.insufficient, S_CALC), fml(countF(col, 'будущее'), seg.future, S_CALC),
        fml(probF, seg.prob == null ? "" : seg.prob, S_PCT),
        seg.innsMatureN, seg.innsRenewedN
      );
      row.push(fml('=IF(OR(K' + excel + '="",K' + excel + '=0),"",L' + excel + '/K' + excel + ')', seg.clientRate == null ? "" : seg.clientRate, S_PCT));
      preamble.push(row);
    });
    preamble.push(["События ниже — основания агрегатов. Классификация по состоянию до исхода. Возврат после 30 дней не считается своевременным продлением."]);
    var rows = events.map(function (group) {
      var ev = group.event;
      var key = segmentKey(product, ev.tariff == null ? "na" : ev.tariff, ev.cycle);
      var star = segmentKey(product, "all", ev.cycle);
      return [
        capped ? "" : tx(ev.inn || ""), ev.tariff == null ? "" : ev.tariff, cycleLabel(ev.cycle),
        key + "|" + ev.status, ev.outcome ? key + "|" + ev.outcome : "",
        star + "|" + ev.status, ev.outcome ? star + "|" + ev.outcome : "",
        capped ? "" : (ev.end ? xdate(ev.end) : ""), capped ? "" : (ev.unitId || ""), group.count,
      ];
    });
    return {
      sheetName: name,
      headers: ["ИНН", "Тариф, мес", "Цикл", "Ключ статуса", "Ключ исхода", "Ключ всех тарифов", "Исход всех тарифов", "Дата окончания", "Единица", "Число событий"],
      rows: rows, preamble: preamble,
      colWidths: [16, 14, 14, 32, 32, 32, 32, 16, 24, 16],
      filterRef: "A" + headerAt + ":J" + last,
      _segments: keys, _first: first,
    };
  }

  function monthTotals(list, year) {
    var by = {};
    (list || []).forEach(function (r) {
      if (!r.included) return;
      var b = monthBucket(r, year);
      if (!by[b]) by[b] = { qty: 0, money: 0 };
      if (r.expectedQty != null) by[b].qty += r.expectedQty;
      if (r.amount != null) by[b].money += r.amount;
    });
    return by;
  }
  function monthSheet(plan, lists) {
    lists = lists || { ofd: [], onec: [], upsell: [] };
    var rows = [];
    var ofdM = monthTotals(lists.ofd, plan.year), oneM = monthTotals(lists.onec, plan.year), upM = monthTotals(lists.upsell, plan.year);
    var lastOfd = Math.max(2, (lists.ofd || []).length + 1);
    var lastOne = Math.max(2, (lists.onec || []).length + 1);
    var lastUp = Math.max(2, (lists.upsell || []).length + 1);
    function grab(map, key, field) { return map[key] ? map[key][field] : 0; }
    function colRange(sheet, col, last) { return qName(sheet) + "!$" + col + "$2:$" + col + "$" + last; }
    function monthRow(key) {
      function qty(sheet, last) { return "=SUMIFS(" + colRange(sheet, "P", last) + "," + colRange(sheet, "I", last) + ",\"" + key + "\"," + colRange(sheet, "J", last) + ",1)"; }
      function money(sheet, last) { return "=SUMIFS(" + colRange(sheet, "Q", last) + "," + colRange(sheet, "I", last) + ",\"" + key + "\"," + colRange(sheet, "J", last) + ",1)"; }
      var n = rows.length + 2;
      var moneySum = grab(ofdM, key, "money") + grab(oneM, key, "money") + grab(upM, key, "money");
      return [key, key === UNASSIGNED ? "есть в годе, месяц менеджер не выбрал" : "",
        fml(qty("Продления ОФД", lastOfd), grab(ofdM, key, "qty"), S_CALC),
        fml(money("Продления ОФД", lastOfd), grab(ofdM, key, "money"), S_MONEY),
        fml(qty("Продления 1С", lastOne), grab(oneM, key, "qty"), S_CALC),
        fml(money("Продления 1С", lastOne), grab(oneM, key, "money"), S_MONEY),
        fml(qty("Допродажи 1С", lastUp), grab(upM, key, "qty"), S_CALC),
        fml(money("Допродажи 1С", lastUp), grab(upM, key, "money"), S_MONEY),
        fml("=D" + n + "+F" + n + "+H" + n, moneySum, S_MONEY),
      ];
    }
    for (var m = 1; m <= 12; m++) rows.push(monthRow(plan.year + "-" + pad2(m)));
    rows.push(monthRow(UNASSIGNED));
    function sumCached(idx) {
      var s = 0;
      for (var i = 0; i < 13; i++) s += Number(rows[i][idx].v) || 0;
      return s;
    }
    rows.push(["Итого", "",
      fml("=SUM(C2:C14)", sumCached(2), S_CALC), fml("=SUM(D2:D14)", sumCached(3), S_MONEY),
      fml("=SUM(E2:E14)", sumCached(4), S_CALC), fml("=SUM(F2:F14)", sumCached(5), S_MONEY),
      fml("=SUM(G2:G14)", sumCached(6), S_CALC), fml("=SUM(H2:H14)", sumCached(7), S_MONEY),
      fml("=D15+F15+H15", sumCached(3) + sumCached(5) + sumCached(7), S_MONEY),
    ]);
    ["Q1", "Q2", "Q3", "Q4"].forEach(function (q, qi) {
      var a = 2 + qi * 3, b = a + 2, line = 16 + qi;
      function span(idx) {
        var s = 0;
        for (var i = a - 2; i <= b - 2; i++) s += Number(rows[i][idx].v) || 0;
        return s;
      }
      rows.push([plan.year + "-" + q, "уникальные ИНН квартала считаются по детализации, не суммой месяцев",
        fml("=SUM(C" + a + ":C" + b + ")", span(2), S_CALC), fml("=SUM(D" + a + ":D" + b + ")", span(3), S_MONEY),
        fml("=SUM(E" + a + ":E" + b + ")", span(4), S_CALC), fml("=SUM(F" + a + ":F" + b + ")", span(5), S_MONEY),
        fml("=SUM(G" + a + ":G" + b + ")", span(6), S_CALC), fml("=SUM(H" + a + ":H" + b + ")", span(7), S_MONEY),
        fml("=D" + line + "+F" + line + "+H" + line, span(3) + span(5) + span(7), S_MONEY),
      ]);
    });
    return {
      sheetName: "По месяцам",
      headers: ["Месяц", "Примечание", "ОФД, касс", "ОФД, ₽", "1С, касс", "1С, ₽", "Первые продажи, сделок", "Первые продажи, ₽", "Деньги месяца"],
      rows: rows, colWidths: [14, 62, 14, 14, 14, 14, 22, 18, 16],
    };
  }

  function channelSheet(plan, sets) {
    var names = channelNames();
    [sets.ofd, sets.onec, sets.upsell].forEach(function (list) {
      list.forEach(function (ev) { if (names.indexOf(ev.channel) < 0) names.push(ev.channel || "Без канала"); });
    });
    function detailRange(sheet, col, list) {
      return qName(sheet) + '!$' + col + '$2:$' + col + '$' + Math.max(2, list.length + 1);
    }
    var bySheet = {
      "Продления ОФД": sets.ofd,
      "Продления 1С": sets.onec,
      "Допродажи 1С": sets.upsell,
    };
    var rows = names.map(function (ch, i) {
      var n = i + 2;
      function sumChannel(sheet, col) {
        var list = bySheet[sheet];
        return '=SUMIFS(' + detailRange(sheet, col, list) + ',' + detailRange(sheet, 'G', list) + ',"' + ch.replace(/"/g, '""') + '",' + detailRange(sheet, 'J', list) + ',1)';
      }
      function agg(list, field) {
        var s = 0;
        list.forEach(function (r) { if (r.included && r.channel === ch && r[field] != null) s += r[field]; });
        return s;
      }
      var oq = agg(sets.ofd, "expectedQty"), om = agg(sets.ofd, "amount");
      var cq = agg(sets.onec, "expectedQty"), cm = agg(sets.onec, "amount");
      var uq = agg(sets.upsell, "expectedQty"), um = agg(sets.upsell, "amount");
      return [ch,
        fml(sumChannel("Продления ОФД", "P"), oq, S_CALC), fml(sumChannel("Продления ОФД", "Q"), om, S_MONEY),
        fml(sumChannel("Продления 1С", "P"), cq, S_CALC), fml(sumChannel("Продления 1С", "Q"), cm, S_MONEY),
        fml(sumChannel("Допродажи 1С", "P"), uq, S_CALC), fml(sumChannel("Допродажи 1С", "Q"), um, S_MONEY),
        fml("=C" + n + "+E" + n + "+G" + n, om + cm + um, S_MONEY),
        fml('=IF(SUM($H$2:$H$' + (names.length + 1) + ')=0,"",H' + n + '/SUM($H$2:$H$' + (names.length + 1) + '))', null, S_PCT),
      ];
    });
    rows.push(["Итого", fml("=SUM(B2:B" + (names.length + 1) + ")", null, S_CALC), fml("=SUM(C2:C" + (names.length + 1) + ")", null, S_MONEY), fml("=SUM(D2:D" + (names.length + 1) + ")", null, S_CALC), fml("=SUM(E2:E" + (names.length + 1) + ")", null, S_MONEY), fml("=SUM(F2:F" + (names.length + 1) + ")", null, S_CALC), fml("=SUM(G2:G" + (names.length + 1) + ")", null, S_MONEY), fml("=SUM(H2:H" + (names.length + 1) + ")", null, S_MONEY), ""]);
    return {
      sheetName: "По каналам",
      headers: ["Канал", "ОФД, касс", "ОФД, ₽", "1С, касс", "1С, ₽", "Первые продажи", "Первые продажи, ₽", "Деньги", "Доля рассчитанных денег"],
      rows: rows, colWidths: [28, 14, 14, 14, 14, 16, 18, 14, 24],
    };
  }

  function exclusionSheet(list) {
    return {
      sheetName: "Исключения",
      headers: ["Продукт", "ИНН", "Единица", "Причина", "Лист"],
      rows: list.map(function (e) { return [e.product, tx(e.inn || ""), tx(e.unit || ""), e.reason, e.sheet || ""]; }),
      colWidths: [14, 16, 24, 64, 24],
    };
  }

  function summarySheet(plan, sheets) {
    function sumCol(sh, col) {
      if (!sh || !sh.rows) return { f: "0", v: 0 };
      var last = Math.max(2, sh.rows.length + 1);
      return { f: "=SUM(" + qName(sh.sheetName) + "!" + col + "2:" + col + last + ")", v: null };
    }
    var blocks = [
      ["Продление ОФД", plan.roll.ofd, "Продления ОФД"],
      ["Продление 1С", plan.roll.onec, "Продления 1С"],
      ["Первая продажа 1С", plan.roll.upsell, "Допродажи 1С"],
    ];
    var rows = blocks.map(function (b, i) {
      var n = i + 2;
      var money = sumCol({ sheetName: b[2], rows: (b[2] === "Продления ОФД" ? sheets.ofd : b[2] === "Продления 1С" ? sheets.onec : sheets.upsell).rows }, "Q");
      var qty = sumCol({ sheetName: b[2], rows: (b[2] === "Продления ОФД" ? sheets.ofd : b[2] === "Продления 1С" ? sheets.onec : sheets.upsell).rows }, "P");
      return [b[0], b[1].base, b[1].innsN, fml(qty.f, b[1].qty, S_CALC), fml(money.f, b[1].money, S_MONEY), b[1].moneyMissing ? "не все строки посчитаны" : "строки направления посчитаны", b[1].potential ? b[1].potential : ""];
    });
    rows.push(["Рассчитано по заполненным строкам", "", "", "", fml("=E2+E3+E4", plan.roll.ofd.money + plan.roll.onec.money + plan.roll.upsell.money, S_MONEY), "это не итог всего плана, если выше есть пропуски", ""]);
    rows.push(["Статус бюджета", fml("='Описание и параметры'!B2", plan.status.label, S_CALC), "", "", fml('=IF(B6="' + READY + '",E5,"Не завершён")', plan.status.ready ? plan.roll.ofd.money + plan.roll.onec.money + plan.roll.upsell.money : "Не завершён", S_CALC), plan.roll.unionInns + " уникальных ИНН (объединение, не сумма)", ""]);
    return {
      sheetName: "Сводный план",
      headers: ["Направление", "База", "Уникальные ИНН направления", "Ожидаемое количество", "Сумма заполненных строк", "Полнота", "Потенциал базы при полном продлении"],
      rows: rows, colWidths: [32, 14, 28, 24, 28, 42, 36],
    };
  }

  function checksSheet(plan, sheets) {
    var details = [sheets.ofd, sheets.onec, sheets.upsell];
    function countMissing(col) {
      return '=' + details.map(function (sh) {
        var included = sheetRange(sh, 'J'), values = sheetRange(sh, col);
        return 'COUNTIFS(' + included + ',1,' + values + ',"' + NOT_SET + '")+COUNTIFS(' + included + ',1,' + values + ',"")';
      }).join('+');
    }
    function countMonths(value) {
      return '=' + details.map(function (sh) {
        return 'COUNTIFS(' + sheetRange(sh, 'J') + ',1,' + sheetRange(sh, 'I') + ',"' + value + '")';
      }).join('+');
    }
    var rows = [
      ["Статус", fml("='Описание и параметры'!B2", plan.status.label, S_CALC), ""],
      ["Допуск, ₽", MONEY_TOLERANCE, ""],
      ["Пустые чеки у строк в плане", fml(countMissing('O'), plan.status.missingCheck, S_CALC), "формула по включённым строкам"],
      ["Пустые вероятности или конверсия", fml(countMissing('N'), plan.status.missingProb, S_CALC), "формула по включённым строкам"],
      ["Месяц не назначен", fml(countMonths(UNASSIGNED) + '+' + countMonths('').slice(1), plan.status.unassigned + plan.status.invalidMonth, S_CALC), "содержит перенесённые из некорректного года месяцы"],
      ["НДС не отмечен", fml('=IF(OR(\'Описание и параметры\'!B6="с НДС",\'Описание и параметры\'!B6="без НДС"),0,1)', plan.params.vat ? 0 : 1, S_CALC), ""],
      ["Файл 1С не загружен", fml('=IF(\'Описание и параметры\'!B8="не загружен",1,0)', plan.coverage.onecLoaded ? 0 : 1, S_CALC), "отсутствие файла не равно нулевой базе"],
      ["Неверный месяц", fml('=' + details.map(function (sh) {
        return 'COUNTIFS(' + sheetRange(sh, 'J') + ',1,' + sheetRange(sh, 'AA') + ',0,' + sheetRange(sh, 'I') + ',"<>' + UNASSIGNED + '")';
      }).join('+'), 0, S_CALC), "изменённый вручную в Excel месяц вне года плана"],
    ];
    function moneyCheck(name, left, right, cachedLeft, cachedRight) {
      var n = rows.length + 2;
      rows.push([name, fml('=IF(ABS(D' + n + '-E' + n + ')<=$B$3,"OK","РАСХОЖДЕНИЕ")', near(cachedLeft, cachedRight) ? "OK" : "РАСХОЖДЕНИЕ", S_CALC),
        "формульная сверка с допуском", fml(left, cachedLeft, S_MONEY), fml(right, cachedRight, S_MONEY)]);
    }
    var totals = [plan.roll.ofd.money, plan.roll.onec.money, plan.roll.upsell.money];
    var total = totals[0] + totals[1] + totals[2];
    ['D', 'F', 'H'].forEach(function (col, i) {
      moneyCheck('Детализация ' + dirTitle(DIRS[i].id) + ' = месяцы',
        '=SUM(' + sheetRange(details[i], 'Q') + ')', "='По месяцам'!" + col + '15', totals[i], totals[i]);
    });
    moneyCheck('Месяцы = сводка', "='По месяцам'!I15", "='Сводный план'!E5", total, total);
    moneyCheck('Каналы = сводка', '=SUM(' + qName(sheets.channels.sheetName) + '!$H$2:$H$' + sheets.channels.rows.length + ')', "='Сводный план'!E5", total, total);
    ['retroO', 'retroC'].forEach(function (key) {
      var sh = sheets[key], last = 3 + sh._segments.length;
      var range = function (col) { return qName(sh.sheetName) + '!$' + col + '$4:$' + col + '$' + Math.max(4, last); };
      moneyCheck('Зрелое ретро = продлили + не продлили (' + sh.sheetName + ')',
        '=SUM(' + range('D') + ')-SUM(' + range('E') + ')-SUM(' + range('F') + ')', '=0', 0, 0);
    });
    plan.audit.forEach(function (a) {
      rows.push(["На момент выгрузки: " + a.name, a.ok ? "OK" : "РАСХОЖДЕНИЕ", "контроль исходной модели", a.left, a.right]);
    });
    rows.push(["Пропуски на момент выгрузки", plan.status.gaps.join("; ") || "нет", "исправления в Excel не импортируются на сайт"]);
    return {
      sheetName: "Проверки",
      headers: ["Проверка", "Значение", "Комментарий", "Слева", "Справа"],
      rows: rows.map(function (r) { return r.concat(Array(Math.max(0, 5 - r.length)).fill("")); }),
      colWidths: [64, 42, 48, 18, 18],
    };
  }

  function downloadPlan(plan, opts) {
    var spec = buildWorkbook(plan, opts);
    var d = spec.exportedAt;
    var name = "План_" + plan.year + "_" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" + pad2(d.getHours()) + pad2(d.getMinutes());
    var exp = root.OFDExport || (typeof module !== "undefined" ? require("./export.js") : null);
    exp.downloadXlsx(name, spec);
  }

  var listeners = {};
  var views = {};
  var scoreCache = null;
  function refresh() { Object.keys(listeners).forEach(function (id) { try { listeners[id](); } catch (e) { /* один борд не роняет остальные */ } }); }
  function viewOf(id) { if (!views[id]) views[id] = { q: "", channel: "", tariff: "" }; return views[id]; }
  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  function grouped(events) {
    var map = {};
    events.forEach(function (ev) {
      var key = JSON.stringify([ev.month || UNASSIGNED, ev.tariffLabel || "—", ev.channel || "—", ev.cycle || ""]);
      if (!map[key]) map[key] = [];
      map[key].push(ev);
    });
    return Object.keys(map).sort().map(function (key) {
      var list = map[key];
      var money = 0, qty = 0, missing = 0, included = 0, inns = {};
      list.forEach(function (r) {
        if (!r.included) return;
        included++;
        if (r.inn) inns[r.inn] = 1;
        if (r.amount == null || r.expectedQty == null) missing++;
        if (r.amount != null) money += r.amount;
        if (r.expectedQty != null) qty += r.expectedQty;
      });
      return {
        key: key, month: list[0].month, tariff: list[0].tariffLabel,
        channel: list[0].channel, cycle: list[0].cycle, prob: list[0].prob,
        source: list[0].probSource, check: list[0].check,
        base: list.length, included: included, inns: Object.keys(inns).length,
        qty: qty, money: money, miss: missing, rows: list,
      };
    });
  }

  var GROUP_PAGE_SIZE = 50;
  var DETAIL_PAGE_SIZE = 100;
  function toolbar(plan, board, view) {
    return '<div class="pl-toolbar"><span class="pl-status ' + (plan.status.ready ? 'pl-ready' : 'pl-draft') + '">' + esc(plan.status.label) + '</span>' +
      '<span class="pl-feedback" role="status">' + esc(view && view.feedback || '') + '</span>' +
      '<button type="button" class="refresh-chart-btn pl-xlsx">Скачать Excel: ' + (board === 'summary' ? 'весь план' : 'этот борд') + '</button></div>';
  }
  function bindExport(box, plan, board) {
    var btn = box.querySelector(".pl-xlsx");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var v = viewOf(box.dataset.plId || "");
      try {
        downloadPlan(plan, { board: board, filter: board === "summary" ? null : { q: v.q, channel: v.channel, tariff: v.tariff, month: v.month, retroTariff: v.retroTariff, retroCycle: v.retroCycle } });
      } catch (error) {
        box.querySelector('.pl-feedback').textContent = 'Не удалось собрать Excel: ' + (error && error.message || 'ошибка');
        console.error('Ошибка выгрузки плана:', error);
      }
    });
  }
  function filterBar(view, allRows, year) {
    function options(values, selected, defaultLabel) {
      return '<option value="">' + defaultLabel + '</option>' + values.map(function (value) {
        return '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>';
      }).join('');
    }
    var channels = Array.from(new Set(allRows.map(function (r) { return r.channel; }).filter(Boolean))).sort();
    var tariffs = Array.from(new Set(allRows.map(function (r) { return r.tariffLabel; }).filter(Boolean))).sort();
    var months = Array.from(new Set(allRows.map(function (r) { return monthBucket(r, year); }).filter(Boolean))).sort();
    return '<div class="pl-filterbar"><label>Поиск <input type="search" class="pl-q" placeholder="ИНН, клиент или номер кассы" value="' + esc(view.q) + '"></label>' +
      '<label>Канал <select class="pl-ch">' + options(channels, view.channel, 'Все каналы') + '</select></label>' +
      '<label>Тариф <select class="pl-tf">' + options(tariffs, view.tariff, 'Все тарифы') + '</select></label>' +
      '<label>Месяц <select class="pl-mf">' + options(months, view.month, 'Все месяцы') + '</select></label></div>';
  }
  function bindFilters(box, instanceId, redraw) {
    var search = box.querySelector('.pl-q');
    if (search) {
      search.addEventListener('input', function () {
        var value = search.value;
        clearTimeout(search._plTimer);
        search._plTimer = setTimeout(function () {
          var v = viewOf(instanceId);
          v.q = value; v.page = 0; v.groupPage = 0;
          redraw();
          var next = box.querySelector('.pl-q');
          if (next && document.activeElement === document.body) { next.focus(); next.setSelectionRange(value.length, value.length); }
        }, 180);
      });
    }
    [['pl-ch', 'channel'], ['pl-tf', 'tariff'], ['pl-mf', 'month']].forEach(function (pair) {
      var node = box.querySelector('.' + pair[0]);
      if (!node) return;
      node.addEventListener('change', function () {
        var v = viewOf(instanceId);
        v[pair[1]] = node.value; v.page = 0; v.groupPage = 0;
        redraw();
      });
    });
  }
  function applyView(list, view, year) {
    var query = (view.q || '').trim().toLocaleLowerCase('ru-RU');
    return list.filter(function (ev) {
      if (view.channel && ev.channel !== view.channel) return false;
      if (view.month && monthBucket(ev, year) !== view.month) return false;
      if (view.tariff && ev.tariffLabel !== view.tariff) return false;
      if (!query) return true;
      return (ev.inn + ' ' + (ev.org || '') + ' ' + (ev.unit || '')).toLocaleLowerCase('ru-RU').indexOf(query) >= 0;
    });
  }
  function openBoard(boardId, focusKey, preset) {
    var selector = '.widget[data-widget-id="' + boardId + '"]';
    var target = document.querySelector('#canvas ' + selector);
    if (!target && root.OFDCanvas && root.OFDCanvas.addWidget) {
      root.OFDCanvas.addWidget(boardId);
      target = document.querySelector('#canvas ' + selector);
    }
    if (!target) {
      var library = document.querySelector('[data-widget="' + boardId + '"]');
      if (library && library.scrollIntoView) library.scrollIntoView({ block: 'center' });
      return;
    }
    if (preset && (preset.month || preset.channel)) {
      var body = target.querySelector('.pl-board');
      var id = body && body.dataset.plId;
      if (id) {
        views[id] = Object.assign({}, viewOf(id), { month: preset.month || '', channel: preset.channel || '', groupPage: 0, page: 0 });
        if (listeners[id]) listeners[id]();
      }
    }
    if (target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var row = focusKey && Array.from(target.querySelectorAll('.pl-param-row')).find(function (r) { return r.dataset.key === focusKey; });
    if (row) {
      row.classList.add('pl-highlight');
      var input = row.querySelector('.pl-in');
      if (input) input.focus();
    }
  }
  function bindNavigation(box) {
    box.querySelectorAll('[data-pl-target]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openBoard(btn.dataset.plTarget, btn.dataset.plFocus || '', { month: btn.dataset.plMonth, channel: btn.dataset.plChannel });
      });
    });
    var upload = box.querySelector('.pl-load-1c');
    if (upload) upload.addEventListener('click', function () {
      var picker = document.getElementById('ofd1cFileInput');
      if (picker) picker.click();
    });
  }
  function cards(plan) {
    function card(direction, roll, unit, board, isAvailable) {
      if (!isAvailable) return '<div class="pl-card"><div class="stat-label">' + esc(direction) + '</div><b>Нет данных 1С</b><p>Загрузите сверку, чтобы увидеть базу и сумму.</p></div>';
      var complete = Math.max(0, roll.included - roll.moneyMissing);
      return '<div class="pl-card"><div class="stat-label">' + esc(direction) + '</div>' +
        '<div>База: <b>' + fmtQty(roll.base) + '</b> ' + esc(unit) + ' · ИНН: ' + fmtQty(roll.innsN) + '</div>' +
        '<div>Ожидаемое: <b>' + (roll.qtyMissing ? fmtQty(roll.qty) + ' по заполненным' : fmtQty(roll.qtyKnown)) + '</b></div>' +
        '<div>Сумма: <b>' + fmtMoney(roll.money) + '</b> · рассчитано ' + complete + ' из ' + roll.included + '</div>' +
        (roll.potential ? '<div class="muted">Потенциал при 100%: ' + fmtMoney(roll.potential) + ' (не план)</div>' : '') +
        '<button type="button" class="pl-link" data-pl-target="' + board + '">Открыть детализацию →</button></div>';
    }
    var total = plan.roll.ofd.money + plan.roll.onec.money + plan.roll.upsell.money;
    return '<div class="pl-cards">' + card(DIRS[0].title, plan.roll.ofd, 'касс', 'pl-ofd', true) +
      card(DIRS[1].title, plan.roll.onec, 'касс 1С', 'pl-1c', plan.coverage.onecLoaded) +
      card(DIRS[2].title, plan.roll.upsell, 'кандидатов', 'pl-upsell', plan.coverage.onecLoaded) +
      '<div class="pl-card pl-total"><div class="stat-label">Общий денежный план</div><div class="stat-value">' + esc(plan.status.ready ? fmtMoney(total) : 'Не завершён') + '</div>' +
      '<div>По заполненным строкам: ' + fmtMoney(total) + '</div><div class="muted">Уникальных ИНН: ' + fmtQty(plan.roll.unionInns) + '. Не сумма показателей продуктов.</div></div></div>';
  }
  function planSteps(plan) {
    var used = plan.ofd.concat(plan.onec, plan.upsell).filter(function (ev) { return ev.included; });
    var checks = new Set(used.filter(function (ev) { return ev.check == null; }).map(function (ev) { return ev.checkKey; }));
    var probs = new Set(used.filter(function (ev) { return ev.prob == null; }).map(function (ev) { return ev.probKey; }));
    var steps = [
      ['1. Данные ОФД', 'Загружены · ' + (plan.coverage.ofdFiles || []).length + ' файл(ов)', ''],
      ['2. Сверка «Обмен с 1С»', plan.coverage.onecLoaded ? 'Загружена: ' + (plan.coverage.onecFile || 'файл 1С') : 'Не загружена — направления 1С не посчитаны', plan.coverage.onecLoaded ? '' : '<button type="button" class="pl-load-1c">Загрузить сверку 1С</button>'],
      ['3. Чеки и вероятности', 'Чеков без ввода: ' + checks.size + ' · вероятностей/конверсий: ' + probs.size + ' · НДС: ' + (plan.params.vat ? 'выбран' : 'не выбран'), '<button type="button" class="pl-open-params" data-pl-target="pl-params"' + (checks.size ? ' data-pl-focus="' + esc(plan.params.priceMode === 'partial' ? used.find(function (ev) { return ev.check == null; }).checkKey : generalCheckKey(used.find(function (ev) { return ev.check == null; }).product, used.find(function (ev) { return ev.check == null; }).channel)) + '"' : '') + '>Открыть параметры</button>'],
      ['4. Первая продажа и месяцы', 'Выбрано кандидатов: ' + plan.roll.upsell.included + ' · без месяца: ' + (plan.status.unassigned + plan.status.invalidMonth), '<button type="button" data-pl-target="pl-upsell">Отобрать клиентов</button>'],
      ['5. Проверка и выгрузка', plan.status.ready ? 'Подготовлено для согласования' : 'Черновик · ' + plan.status.gaps.length + ' причины', '<button type="button" data-pl-target="pl-params">Проверить бюджет</button>'],
    ];
    return '<section class="pl-steps" aria-label="Шаги составления бюджета"><h4>Как собрать бюджет</h4><ol>' + steps.map(function (s) {
      return '<li><strong>' + esc(s[0]) + '</strong><span>' + esc(s[1]) + '</span>' + s[2] + '</li>';
    }).join('') + '</ol></section>';
  }
  function planSources(plan) {
    var ofd = plan.coverage.ofdFrom ? fmtDate(plan.coverage.ofdFrom) + ' — ' + fmtDate(plan.coverage.ofdTo) : 'нет дат';
    var onec = plan.coverage.onecLoaded ? fmtDate(plan.coverage.onecFrom) + ' — ' + fmtDate(plan.coverage.onecTo) : 'не загружена';
    return '<p class="pl-source">Срез ' + fmtDate(plan.asOf) + '. История ОФД: ' + ofd + '; история 1С: ' + onec + '. ' + esc(plan.coverage.historyNote) + '</p>';
  }
  function pager(page, length, size, className) {
    if (length <= size) return '';
    var pages = Math.ceil(length / size);
    return '<nav class="pl-pager" aria-label="Страницы таблицы"><button type="button" class="' + className + '-prev"' + (page <= 0 ? ' disabled' : '') + '>← Назад</button>' +
      '<span>Страница ' + (page + 1) + ' из ' + pages + ' · строк: ' + length + '</span>' +
      '<button type="button" class="' + className + '-next"' + (page + 1 >= pages ? ' disabled' : '') + '>Далее →</button></nav>';
  }
  function bindPager(box, className, view, field, total, size, redraw) {
    var pages = Math.max(1, Math.ceil(total / size));
    ['prev', 'next'].forEach(function (direction) {
      var node = box.querySelector('.' + className + '-' + direction);
      if (!node) return;
      node.addEventListener('click', function () {
        view[field] = Math.max(0, Math.min(pages - 1, (view[field] || 0) + (direction === 'next' ? 1 : -1)));
        redraw();
      });
    });
  }
  function groupTable(groups, view) {
    var page = Math.min(view.groupPage || 0, Math.max(0, Math.ceil(groups.length / GROUP_PAGE_SIZE) - 1));
    view.groupPage = page;
    var html = '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>Группа</th><th>Месяц</th><th>Тариф</th><th>Цикл</th><th>Канал</th><th>Касс: в плане / всего</th><th>ИНН</th><th>Вероятность</th><th>Ожидаемое, касс</th><th>Чек, ₽</th><th>Сумма, ₽</th></tr></thead><tbody>';
    groups.slice(page * GROUP_PAGE_SIZE, (page + 1) * GROUP_PAGE_SIZE).forEach(function (g) {
      html += '<tr><td><button type="button" class="pl-expand" data-key="' + esc(g.key) + '" aria-expanded="' + (view.openKey === g.key ? 'true' : 'false') + '">'
        + (view.openKey === g.key ? 'Свернуть' : 'Раскрыть') + '</button></td><td>' + esc(g.month) + '</td><td>' + esc(g.tariff) + '</td><td>' + esc(cycleLabel(g.cycle)) + '</td><td>' + esc(g.channel) + '</td>'
        + '<td>' + g.included + ' / ' + g.base + '</td><td>' + g.inns + '</td><td>' + fmtPct(g.prob) + ' <small>' + esc(g.source) + '</small></td>'
        + '<td>' + (g.miss ? fmtQty(g.qty) + ' по заполненным' : fmtQty(g.qty)) + '</td><td>' + fmtMoney(g.check) + '</td>'
        + '<td>' + (g.miss ? fmtMoney(g.money) + ' по заполненным' : fmtMoney(g.money)) + '</td></tr>';
    });
    return html + '</tbody></table></div>' + pager(page, groups.length, GROUP_PAGE_SIZE, 'pl-groups');
  }
  function detailHtml(group, kind, view, year) {
    var page = Math.min(view.detailPage || 0, Math.max(0, Math.ceil(group.rows.length / DETAIL_PAGE_SIZE) - 1));
    view.detailPage = page;
    var html = '<div class="pl-detail-head"><h4>Строки группы: ' + group.rows.length + '</h4><span>Изменения плана не меняют исходную выгрузку.</span></div>' +
      '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>Исключить</th><th>ИНН</th><th>Клиент</th><th>' + (kind === 'onec' ? 'Заводской номер' : 'РНМ') + '</th><th>Окончание</th><th>Месяц плана</th><th>Комментарий</th></tr></thead><tbody>';
    group.rows.slice(page * DETAIL_PAGE_SIZE, (page + 1) * DETAIL_PAGE_SIZE).forEach(function (r) {
      html += '<tr data-id="' + esc(r.id) + '"><td><input type="checkbox" class="pl-ex" aria-label="Исключить ' + esc(r.unit) + '" ' + (r.included ? '' : 'checked') + '></td>' +
        '<td>' + esc(r.inn) + '</td><td>' + esc(r.org) + '</td><td>' + esc(r.unit) + '</td><td>' + fmtDate(r.baseDate) + '</td>' +
        '<td><input type="month" class="pl-month" aria-label="Месяц для ' + esc(r.unit) + '" min="' + year + '-01" max="' + year + '-12" value="' + esc(isPlanMonth(r.month, year) ? r.month : '') + '"><div class="pl-error" role="alert"></div></td>' +
        '<td><input class="pl-note" aria-label="Комментарий для ' + esc(r.unit) + '" maxlength="1000" value="' + esc(r.comment) + '"></td></tr>';
    });
    return html + '</tbody></table></div>' + pager(page, group.rows.length, DETAIL_PAGE_SIZE, 'pl-details');
  }
  function saveEventParam(params, id, patch, instanceId) {
    var nextEvents = Object.assign({}, params.events, { [id]: Object.assign({}, params.events[id] || {}, patch) });
    viewOf(instanceId).feedback = 'Сохранено, план пересчитан';
    return saveParams(Object.assign({}, params, { events: nextEvents }));
  }
  function bindDetail(box, plan, instanceId) {
    box.querySelectorAll('tr[data-id]').forEach(function (tr) {
      var id = tr.getAttribute('data-id');
      tr.querySelector('.pl-ex').addEventListener('change', function (e) {
        saveEventParam(plan.params, id, { excluded: e.target.checked }, instanceId);
      });
      tr.querySelector('.pl-month').addEventListener('change', function (e) {
        var value = e.target.value.trim();
        var error = tr.querySelector('.pl-error');
        if (value && !isPlanMonth(value, plan.year)) {
          error.textContent = 'Укажи месяц ' + plan.year + ' года.';
          return;
        }
        error.textContent = '';
        var event = plan.ofd.find(function (r) { return r.id === id; }) || plan.onec.find(function (r) { return r.id === id; });
        if (event) {
          viewOf(instanceId).openKey = JSON.stringify([value || UNASSIGNED, event.tariffLabel || '—', event.channel || '—', event.cycle || '']);
          viewOf(instanceId).detailPage = 0;
        }
        saveEventParam(plan.params, id, { month: value || UNASSIGNED }, instanceId);
      });
      tr.querySelector('.pl-note').addEventListener('change', function (e) {
        saveEventParam(plan.params, id, { comment: e.target.value }, instanceId);
      });
    });
  }

  var PARAM_PAGE_SIZE = 60;
  function parameterFilter(view, rows, mode) {
    var query = (view.paramQ || '').trim().toLocaleLowerCase('ru-RU');
    return rows.filter(function (row) {
      if (row.scope !== mode) return false;
      if (view.paramDir && row.direction !== view.paramDir) return false;
      if (view.paramCh && row.channel !== view.paramCh) return false;
      if (view.paramTariff && row.tariff !== view.paramTariff) return false;
      return !query || [row.direction, row.channel, row.tariff, row.cycle, row.metric].join(' ').toLocaleLowerCase('ru-RU').indexOf(query) >= 0;
    });
  }
  function parameterFilters(view, rows, mode) {
    function select(cls, label, key) {
      var values = Array.from(new Set(rows.map(function (row) { return row[key]; }).filter(function (v) { return v && v !== '—'; }))).sort();
      return '<label>' + label + ' <select class="' + cls + '"><option value="">Все</option>' + values.map(function (v) {
        return '<option value="' + esc(v) + '"' + (view[key === 'direction' ? 'paramDir' : key === 'channel' ? 'paramCh' : 'paramTariff'] === v ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('') + '</select></label>';
    }
    return '<div class="pl-filterbar"><label>Найти параметр <input class="pl-param-q" type="search" placeholder="Направление, тариф, канал" value="' + esc(view.paramQ || '') + '"></label>' +
      select('pl-param-dir', 'Направление', 'direction') + select('pl-param-ch', 'Канал', 'channel') + (mode === 'partial' ? select('pl-param-tf', 'Тариф', 'tariff') : '') + '</div>';
  }
  function generalParameterTable(rows) {
    var groups = new Map();
    rows.forEach(function (row) {
      var key = row.direction + '|' + row.channel;
      if (!groups.has(key)) groups.set(key, { direction: row.direction, channel: row.channel });
      var pair = groups.get(key);
      pair[row.inputKind] = row;
    });
    function input(row) {
      if (!row) return '—';
      var isMoney = row.inputKind === 'money';
      var shown = row.manual == null ? '' : isMoney ? String(row.manual) : String(Math.round(row.manual * 10000) / 100);
      var source = isMoney ? row.unit :
        row.calculated == null ? 'Нет данных для оценки' : 'Оценка: ' + fmtPct(row.calculated);
      return '<div class="pl-general-input" data-key="' + esc(row.storeKey) + '"><label class="pl-input-label">' +
        '<input type="number" class="pl-in" min="0"' + (isMoney ? '' : ' max="100"') +
        ' step="any" inputmode="decimal" aria-label="' + esc(row.metric + ', ' + row.direction + ', ' + row.channel) +
        '" value="' + esc(shown) + '"><span>' + (isMoney ? '₽' : '%') + '</span></label>' +
        '<small>' + esc(source || row.unit) + '</small><span class="pl-error" role="alert"></span></div>';
    }
    var html = '<div class="pl-table-wrap"><table class="pl-table pl-general-table"><thead><tr>' +
      '<th>Направление</th><th>Канал продаж</th><th>Средний чек на продления</th><th>Средний чек на новые подключения</th>' +
      '<th>Вероятность продления</th><th>Вероятность новых подключений</th></tr></thead><tbody>';
    groups.forEach(function (group) {
      var isNew = group.direction === DIRS[2].title;
      html += '<tr><td><strong>' + esc(group.direction) + '</strong></td><td>' + esc(group.channel) + '</td>' +
        '<td>' + (isNew ? '—' : input(group.money)) + '</td><td>' + (isNew ? input(group.money) : '—') + '</td>' +
        '<td>' + (isNew ? '—' : input(group.prob)) + '</td><td>' + (isNew ? input(group.prob) : '—') + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  function parameterTable(rows, view) {
    var page = Math.min(view.paramPage || 0, Math.max(0, Math.ceil(rows.length / PARAM_PAGE_SIZE) - 1));
    view.paramPage = page;
    var html = '<div class="pl-table-wrap"><table class="pl-table pl-parameters"><thead><tr><th>Направление</th><th>Канал / тариф / цикл</th><th>Показатель и единица</th><th>Ввод</th><th>Ретро</th><th>Применяется</th></tr></thead><tbody>';
    rows.slice(page * PARAM_PAGE_SIZE, (page + 1) * PARAM_PAGE_SIZE).forEach(function (row) {
      var money = row.inputKind === 'money';
      var shown = row.manual == null ? '' : money ? String(row.manual) : String(Math.round(row.manual * 10000) / 100);
      var unit = money ? '₽' : '%';
      var calculated = row.metric.indexOf('Вероятность') >= 0 ? fmtPct(row.calculated) : '—';
      var applied = row.effective == null ? NOT_SET : money ? fmtMoney(row.effective) : fmtPct(row.effective);
      html += '<tr class="pl-param-row" data-key="' + esc(row.storeKey) + '"><td><strong>' + esc(row.direction) + '</strong></td>' +
        '<td>' + esc(row.channel) + '<br>' + esc(row.tariff) + ' · ' + esc(row.cycle) + '</td>' +
        '<td>' + esc(row.metric) + '<small>' + esc(row.unit) + '</small></td>' +
        '<td><label class="pl-input-label"><input type="number" class="pl-in" min="0"' + (money ? '' : ' max="100"') + ' step="any" inputmode="decimal" aria-label="' + esc(row.metric + ', ' + row.direction + ', ' + row.channel + ', ' + row.tariff + ', ' + unit) + '" value="' + esc(shown) + '"><span>' + unit + '</span></label><span class="pl-error" role="alert"></span></td>' +
        '<td>' + calculated + '</td><td>' + applied + '<small>' + esc(row.source) + '</small>' +
        (!money && row.metric.indexOf('Вероятность') >= 0 && row.manual != null ? '<button type="button" class="pl-back">Вернуть расчётное</button>' : '') + '</td></tr>';
    });
    return html + '</tbody></table></div>' + pager(page, rows.length, PARAM_PAGE_SIZE, 'pl-params-page');
  }
  function updateParameter(params, row, raw) {
    var money = row.inputKind === 'money';
    var number = Number(raw.replace(',', '.'));
    if (raw !== '' && (!isFinite(number) || number < 0 || number > (money ? Number.MAX_SAFE_INTEGER / 100 : 100))) {
      return { error: money ? 'Введите сумму от 0 ₽ без отрицательного знака.' : 'Введите процент от 0 до 100.' };
    }
    if (raw !== '' && money && Math.abs(number * 100 - Math.round(number * 100)) > 1e-6) {
      return { error: 'Укажите рубли с точностью до копейки (не больше двух знаков после запятой).' };
    }
    var field = row.storeField || (row.inputKind === 'prob' ? 'probManual' : 'checks');
    var values = Object.fromEntries(Object.entries(params[field]).filter(function (pair) { return pair[0] !== row.storeKey; }));
    if (raw !== '') values[row.storeKey] = money ? number : number / 100;
    return { params: Object.assign({}, params, { [field]: values }) };
  }
  function bindParameterRows(box, plan, view, rows) {
    box.querySelectorAll('.pl-param-row, .pl-general-input').forEach(function (tr) {
      var row = rows.find(function (r) { return r.storeKey === tr.dataset.key; });
      if (!row) return;
      var input = tr.querySelector('.pl-in');
      input.addEventListener('change', function () {
        var result = updateParameter(plan.params, row, input.value.trim());
        if (result.error) { tr.querySelector('.pl-error').textContent = result.error; return; }
        tr.querySelector('.pl-error').textContent = '';
        view.feedback = 'Сохранено, план пересчитан';
        saveParams(result.params);
      });
      var back = tr.querySelector('.pl-back');
      if (back) back.addEventListener('click', function () {
        var result = updateParameter(plan.params, row, '');
        view.feedback = 'Расчётная вероятность восстановлена, план пересчитан';
        saveParams(result.params);
      });
    });
  }
  function registerBoards() {
    if (!root.document || !root.OFDWidgets || !root.OFDWidgets.WIDGETS) return;
    var W = root.OFDWidgets.WIDGETS;
    function board(id, title, draw) {
      W[id] = {
        title: title, type: "таблица", scope: "план", span: true, defaultH: 10,
        render: function (model, ctx, instanceId) {
          var box = el('<div class="pl-board"></div>');
          box.dataset.plId = instanceId;
          function run() {
            var plan = compute(model, ctx);
            draw(box, plan, instanceId);
          }
          listeners[instanceId] = run;
          run();
          return box;
        },
        onRemove: function (instanceId) { delete listeners[instanceId]; },
        getPersistState: function (instanceId) { return views[instanceId] || null; },
        applyPersistState: function (instanceId, saved) { if (saved) views[instanceId] = saved; },
      };
    }
    board("pl-summary", "Планирование — сводный план", function (box, plan, instanceId) {
      var vat = plan.params.vat === "with" ? "с НДС" : plan.params.vat === "without" ? "без НДС" : "не выбрано";
      box.innerHTML = toolbar(plan, 'summary', viewOf(instanceId)) +
        '<div class="pl-summary-top"><label>Год плана <input class="pl-year" type="number" min="2000" max="2100" step="1" value="' + plan.year + '"></label>' +
        '<span>Средний чек: ' + esc(vat) + '</span><span>Параметры: ' + (plan.params.priceMode === 'partial' ? 'частные по тарифам' : 'общие по направлению и каналу') + '</span><span class="pl-error" role="alert"></span></div>' +
        planSources(plan) + planSteps(plan) + cards(plan);
      box.querySelector('.pl-year').addEventListener('change', function (e) {
        var year = Number(e.target.value);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) {
          box.querySelector('.pl-error').textContent = 'Год должен быть целым числом от 2000 до 2100.';
          return;
        }
        viewOf(instanceId).feedback = 'Год изменён. Месяцы прежнего года требуют переназначения.';
        saveParams(Object.assign({}, plan.params, { year: year }));
      });
      bindExport(box, plan, 'summary');
      bindNavigation(box);
    });
    function renewalBoard(id, title, key, kind) {
      board(id, title, function (box, plan, instanceId) {
        var view = viewOf(instanceId);
        if (kind === 'onec' && !plan.coverage.onecLoaded) {
          box.innerHTML = toolbar(plan, kind, view) + '<div class="pl-empty">Нет данных 1С. Загрузите сверку через кнопку «Обмен с 1С» в шапке. <button type="button" class="pl-load-1c">Загрузить сверку 1С</button></div>';
          bindExport(box, plan, kind); bindNavigation(box);
          return;
        }
        var list = applyView(plan[key], view, plan.year);
        var groups = grouped(list);
        box.innerHTML = toolbar(plan, kind, view) + filterBar(view, plan[key], plan.year) +
          '<p class="pl-hint">Ожидаемые продления, касс. ' + groups.length + ' групп · ' + list.length + ' из ' + plan[key].length + ' строк. Нажмите «Раскрыть», чтобы изменить плановые поля кассы.</p>' +
          (groups.length ? groupTable(groups, view) : '<div class="pl-empty">По этим фильтрам строк нет. Измените поиск, канал или тариф.</div>') + '<div class="pl-drill"></div>';
        bindExport(box, plan, kind);
        bindFilters(box, instanceId, function () { listeners[instanceId](); });
        bindPager(box, 'pl-groups', view, 'groupPage', groups.length, GROUP_PAGE_SIZE, function () { listeners[instanceId](); });
        var holder = box.querySelector('.pl-drill');
        function renderDetail() {
          var group = groups.find(function (g) { return g.key === view.openKey; });
          holder.innerHTML = group ? detailHtml(group, kind, view, plan.year) : '';
          if (!group) return;
          bindDetail(holder, plan, instanceId);
          bindPager(holder, 'pl-details', view, 'detailPage', group.rows.length, DETAIL_PAGE_SIZE, renderDetail);
        }
        box.querySelectorAll('.pl-expand').forEach(function (button) {
          button.addEventListener('click', function () {
            var keyOfGroup = button.getAttribute('data-key');
            view.openKey = view.openKey === keyOfGroup ? '' : keyOfGroup;
            view.detailPage = 0;
            box.querySelectorAll('.pl-expand').forEach(function (node) {
              var expanded = node.getAttribute('data-key') === view.openKey;
              node.setAttribute('aria-expanded', String(expanded));
              node.textContent = expanded ? 'Свернуть' : 'Раскрыть';
            });
            renderDetail();
          });
        });
        renderDetail();
      });
    }
    renewalBoard("pl-ofd", "Планирование — продления кодов ОФД", "ofd", "ofd");
    renewalBoard("pl-1c", "Планирование — продления Обмена с 1С", "onec", "onec");
    board("pl-upsell", "Планирование — допродажи Обмена с 1С", function (box, plan, instanceId) {
      var view = viewOf(instanceId);
      if (!plan.coverage.onecLoaded) {
        box.innerHTML = toolbar(plan, 'upsell', view) + '<div class="pl-empty">Нет данных 1С. Без сверки нельзя отделить покупателей от кандидатов. <button type="button" class="pl-load-1c">Загрузить сверку 1С</button></div>';
        bindExport(box, plan, 'upsell'); bindNavigation(box);
        return;
      }
      var list = applyView(plan.upsell, view, plan.year).sort(function (a, b) { return (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score); });
      var page = Math.min(view.page || 0, Math.max(0, Math.ceil(list.length / DETAIL_PAGE_SIZE) - 1));
      view.page = page;
      var shown = list.slice(page * DETAIL_PAGE_SIZE, (page + 1) * DETAIL_PAGE_SIZE);
      var selectedInFilter = list.filter(function (r) { return r.selected; });
      var html = toolbar(plan, 'upsell', view) + filterBar(view, plan.upsell, plan.year) +
        '<p class="pl-hint">Без покупки в доступной истории: ' + plan.upsell.length + ' ИНН. По фильтру: ' + list.length + ', выбрано: ' + selectedInFilter.length + '. Score — приоритет, не вероятность. Конверсию и чек вводят в параметрах.</p>' +
        '<div class="pl-actions"><button type="button" class="pl-all">Выбрать все ' + list.length + ' в фильтре</button>' +
        '<button type="button" class="pl-none">Снять выбор в фильтре</button>' +
        '<label>Месяц выбранным <input class="pl-mass" type="month" min="' + plan.year + '-01" max="' + plan.year + '-12"></label>' +
        '<button type="button" class="pl-setm">Назначить месяц ' + selectedInFilter.length + ' выбранным</button>' +
        '<button type="button" class="pl-score">Рассчитать score</button><span class="pl-error" role="alert"></span></div>' +
        '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>В план</th><th>ИНН</th><th>Клиент</th><th>Канал</th><th>Касс ОФД</th><th>Score</th><th>Месяц</th><th>Почему в приоритете</th></tr></thead><tbody>';
      shown.forEach(function (r) {
        html += '<tr data-inn="' + esc(r.inn) + '"><td><input type="checkbox" class="pl-sel" aria-label="Включить ' + esc(r.inn) + '"' + (r.selected ? ' checked' : '') + '></td><td>' + esc(r.inn) + '</td><td>' + esc(r.org) + '</td><td>' + esc(r.channel) + '</td><td>' + r.kassas + '</td><td>' + (r.score == null ? '—' : r.score) + '</td><td>' + esc(r.selected ? (r.month || UNASSIGNED) : '') + '</td><td>' + esc(r.reason || '') + '</td></tr>';
      });
      html += '</tbody></table></div>' + (list.length ? pager(page, list.length, DETAIL_PAGE_SIZE, 'pl-up') : '<div class="pl-empty">По этим фильтрам кандидатов нет.</div>');
      box.innerHTML = html;
      bindExport(box, plan, 'upsell');
      bindFilters(box, instanceId, function () { listeners[instanceId](); });
      bindPager(box, 'pl-up', view, 'page', list.length, DETAIL_PAGE_SIZE, function () { listeners[instanceId](); });
      function saveSelection(changes, message) {
        var next = Object.assign({}, plan.params.upsell, changes);
        view.feedback = message;
        saveParams(Object.assign({}, plan.params, { upsell: next }));
      }
      function setFiltered(selected) {
        if (list.length > DETAIL_PAGE_SIZE && root.confirm && !root.confirm((selected ? 'Включить ' : 'Исключить ') + list.length + ' клиентов по текущему фильтру?')) return;
        var changes = {};
        list.forEach(function (r) { changes[r.inn] = Object.assign({}, plan.params.upsell[r.inn] || {}, { selected: selected }); });
        saveSelection(changes, 'Сохранено: ' + list.length + ' клиентов. План пересчитан.');
      }
      box.querySelector('.pl-all').addEventListener('click', function () { setFiltered(true); });
      box.querySelector('.pl-none').addEventListener('click', function () { setFiltered(false); });
      box.querySelector('.pl-setm').addEventListener('click', function () {
        var month = box.querySelector('.pl-mass').value;
        if (!isPlanMonth(month, plan.year)) { box.querySelector('.pl-error').textContent = 'Укажите месяц ' + plan.year + ' года.'; return; }
        if (!selectedInFilter.length) { box.querySelector('.pl-error').textContent = 'Сначала выберите клиентов в текущем фильтре.'; return; }
        var changes = {};
        selectedInFilter.forEach(function (r) { changes[r.inn] = Object.assign({}, plan.params.upsell[r.inn] || {}, { month: month }); });
        saveSelection(changes, 'Сохранено: месяц ' + month + ' назначен ' + selectedInFilter.length + ' клиентам.');
      });
      box.querySelector('.pl-score').addEventListener('click', function () {
        if (!root.OFDWidgets.ofd1cScoringCandidates || !root.OFDState || !root.OFDState.model) {
          box.querySelector('.pl-error').textContent = 'Для score загрузите данные ОФД.';
          return;
        }
        try {
          var res = root.OFDWidgets.ofd1cScoringCandidates(root.OFDState.model, new Set(), root.OFDState.ctx, null, null);
          scoreCache = {};
          (res.list || []).forEach(function (c) { scoreCache[c.key] = { score: c.score, reason: c.reason }; });
          view.feedback = 'Score рассчитан. Это приоритет, не вероятность.';
          cache = null; refresh();
        } catch (error) {
          box.querySelector('.pl-error').textContent = 'Не удалось рассчитать score: ' + (error && error.message || 'ошибка');
          console.error('Ошибка score Планирования:', error);
        }
      });
      box.querySelectorAll('.pl-sel').forEach(function (node) {
        node.addEventListener('change', function () {
          var inn = node.closest('tr').getAttribute('data-inn');
          saveSelection({ [inn]: Object.assign({}, plan.params.upsell[inn] || {}, { selected: node.checked }) }, 'Сохранено, план пересчитан');
        });
      });
    });
    board("pl-retro", "Планирование — ретро и вероятности", function (box, plan, instanceId) {
      var view = viewOf(instanceId);
      var segments = Object.assign({}, plan.retroOfd.segments, plan.retroOnec.segments);
      var tariffs = Array.from(new Set(Object.keys(segments).map(function (key) { return key.split('|')[1]; }))).sort();
      var filters = '<div class="pl-filterbar"><label>Тариф <select class="pl-retro-tariff"><option value="">Все тарифы</option>' + tariffs.map(function (tariff) {
        return '<option value="' + esc(tariff) + '"' + (view.retroTariff === tariff ? ' selected' : '') + '>' + esc(tariff === 'all' ? 'Все тарифы (агрегат)' : tariffLabel(tariff)) + '</option>';
      }).join('') + '</select></label><label>Цикл <select class="pl-retro-cycle"><option value="">Все циклы</option>' +
        ['first', 'repeat'].map(function (cycle) { return '<option value="' + cycle + '"' + (view.retroCycle === cycle ? ' selected' : '') + '>' + cycleLabel(cycle) + '</option>'; }).join('') + '</select></label></div>';
      function periodOf(events) {
        var from = null, to = null;
        events.forEach(function (event) {
          if (event.status !== 'зрелое' || !event.end) return;
          if (!from || event.end < from) from = event.end;
          if (!to || event.end > to) to = event.end;
        });
        return from ? fmtDate(from) + ' — ' + fmtDate(to) : 'нет зрелых окончаний';
      }
      function table(title, retro, product) {
        var keys = Object.keys(retro.segments).sort().filter(function (key) {
          var parts = key.split('|');
          return (!view.retroTariff || parts[1] === view.retroTariff) && (!view.retroCycle || parts[2] === view.retroCycle);
        });
        var html = '<h4>' + esc(title) + '</h4><p class="pl-hint">Период зрелого наблюдения: ' + periodOf(retro.events) + '. Незрелые окончания не входят в вероятность.</p>' +
          '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>Тариф</th><th>Цикл</th><th>Зрелая база</th><th>Продлили</th><th>Не продлили</th><th>Незрелые / недостаточно</th><th>Ретро, % касс</th><th>Применяется / источник</th><th>ИНН, ≥1 касса</th></tr></thead><tbody>';
        keys.forEach(function (key) {
          var seg = retro.segments[key], parts = key.split('|');
          var parameter = plan.paramsRows.find(function (r) { return r.storeKey === key && r.direction === dirTitle(product); });
          var applied = parameter ? fmtPct(parameter.effective) : fmtPct(seg.prob);
          var source = parameter ? parameter.source : 'ретро (все тарифы)';
          html += '<tr><td>' + esc(parts[1] === 'all' ? 'Все тарифы' : tariffLabel(parts[1])) + '</td><td>' + esc(cycleLabel(parts[2])) + '</td>' +
            '<td>' + seg.mature + '</td><td>' + seg.renewed + '</td><td>' + seg.churned + '</td><td>' + seg.immature + ' / ' + seg.insufficient + '</td>' +
            '<td>' + fmtPct(seg.prob) + '</td><td>' + applied + ' · ' + esc(source) + (parameter ? ' <button type="button" class="pl-link" data-pl-target="pl-params" data-pl-focus="' + esc(key) + '">Изменить</button>' : '') + '</td>' +
            '<td>' + (seg.clientRate == null ? '—' : fmtPct(seg.clientRate) + ' из ' + seg.innsMatureN) + '</td></tr>';
        });
        return html + '</tbody></table></div>' + (keys.length ? '' : '<div class="pl-empty">В этом разрезе ретро-сегментов нет.</div>');
      }
      box.innerHTML = toolbar(plan, 'retro', view) + filters + table('Коды ОФД', plan.retroOfd, 'ofd') +
        (plan.coverage.onecLoaded ? table('Обмен с 1С', plan.retroOnec, 'onec') : '<div class="pl-empty">Нет данных ретро 1С: сверка не загружена. <button type="button" class="pl-load-1c">Загрузить сверку 1С</button></div>');
      bindExport(box, plan, 'retro'); bindNavigation(box);
      [['.pl-retro-tariff', 'retroTariff'], ['.pl-retro-cycle', 'retroCycle']].forEach(function (pair) {
        box.querySelector(pair[0]).addEventListener('change', function (event) { view[pair[1]] = event.target.value; listeners[instanceId](); });
      });
    });
    board("pl-months", "Планирование — план по месяцам", function (box, plan, instanceId) {
      var keys = Array.from({ length: 12 }, function (_, i) { return plan.year + '-' + pad2(i + 1); }).concat(UNASSIGNED);
      var source = [plan.ofd, plan.onec, plan.upsell];
      var buckets = source.map(function (list) {
        var result = {};
        list.forEach(function (event) {
          var key = monthBucket(event, plan.year);
          if (!key) return;
          if (!result[key]) result[key] = { qty: 0, money: 0, missing: 0, inns: {} };
          var entry = result[key];
          if (event.inn) entry.inns[event.inn] = true;
          if (event.expectedQty == null || event.amount == null) entry.missing++;
          if (event.expectedQty != null) entry.qty += event.expectedQty;
          if (event.amount != null) entry.money += event.amount;
        });
        return result;
      });
      function cell(key, productIndex, money) {
        if (productIndex > 0 && !plan.coverage.onecLoaded) return '<td>Нет данных</td>';
        var value = buckets[productIndex][key] || { qty: 0, money: 0, missing: 0 };
        var label = money ? fmtMoney(value.money) : fmtQty(value.qty);
        var board = ['pl-ofd', 'pl-1c', 'pl-upsell'][productIndex];
        return '<td><button type="button" class="pl-cell" data-pl-target="' + board + '" data-pl-month="' + esc(key) + '" aria-label="Строки ' + esc(board + ' ' + key) + '">' + label + (value.missing ? ' *' : '') + '</button></td>';
      }
      var html = toolbar(plan, 'months', viewOf(instanceId)) + '<p class="pl-hint">Кликните по числу, чтобы открыть строки месяца. Звёздочка — есть незаполненные параметры; показана только рассчитанная часть.</p>' +
        '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>Месяц</th><th>ОФД, касс</th><th>ОФД, ₽</th><th>1С, касс</th><th>1С, ₽</th><th>Первые продажи, сделок</th><th>Первые продажи, ₽</th></tr></thead><tbody>';
      keys.forEach(function (key) {
        html += '<tr><th scope="row">' + esc(key) + '</th>' + cell(key, 0, false) + cell(key, 0, true) + cell(key, 1, false) + cell(key, 1, true) + cell(key, 2, false) + cell(key, 2, true) + '</tr>';
      });
      function totalsFor(months, index) {
        return months.reduce(function (sum, key) {
          var entry = buckets[index][key];
          return { qty: sum.qty + (entry ? entry.qty : 0), money: sum.money + (entry ? entry.money : 0) };
        }, { qty: 0, money: 0 });
      }
      function totalRow(label, months) {
        var values = [0, 1, 2].map(function (i) { return totalsFor(months, i); });
        html += '<tr class="pl-subtotal"><th scope="row">' + esc(label) + '</th>' + values.map(function (v, i) {
          return i > 0 && !plan.coverage.onecLoaded ? '<td>Нет данных</td><td>Нет данных</td>' : '<td>' + fmtQty(v.qty) + '</td><td>' + fmtMoney(v.money) + '</td>';
        }).join('') + '</tr>';
      }
      for (var q = 0; q < 4; q++) totalRow('Квартал ' + (q + 1), keys.slice(q * 3, q * 3 + 3));
      totalRow('Итого за год (включая неназначенное)', keys);
      html += '</tbody></table></div><div class="pl-quarter-inns">';
      for (var qi = 1; qi <= 4; qi++) {
        var inns = new Set();
        source.forEach(function (list) { list.forEach(function (event) {
          if (event.included && event.inn && quarterOf(monthBucket(event, plan.year)) === plan.year + '-Q' + qi) inns.add(event.inn);
        }); });
        html += '<span>Квартал ' + qi + ': ' + inns.size + ' уникальных ИНН</span>';
      }
      box.innerHTML = html + '</div>';
      bindExport(box, plan, 'months'); bindNavigation(box);
    });
    board("pl-channels", "Планирование — план по каналам", function (box, plan, instanceId) {
      var names = channelNames();
      var source = [plan.ofd, plan.onec, plan.upsell];
      var map = {};
      source.forEach(function (list, index) {
        list.forEach(function (event) {
          if (names.indexOf(event.channel) < 0) names.push(event.channel || 'Без канала');
          if (!event.included) return;
          var channel = event.channel || 'Без канала';
          if (!map[channel]) map[channel] = [{ qty: 0, money: 0, missing: 0, months: {} }, { qty: 0, money: 0, missing: 0, months: {} }, { qty: 0, money: 0, missing: 0, months: {} }];
          var data = map[channel][index];
          if (event.expectedQty != null) data.qty += event.expectedQty;
          if (event.amount != null) data.money += event.amount;
          if (event.amount == null || event.expectedQty == null) data.missing++;
          var month = monthBucket(event, plan.year);
          data.months[month] = (data.months[month] || 0) + (event.amount || 0);
        });
      });
      var total = plan.roll.ofd.money + plan.roll.onec.money + plan.roll.upsell.money;
      function amount(data, index) {
        if (index > 0 && !plan.coverage.onecLoaded) return 'Нет данных';
        return fmtQty(data.qty) + ' / ' + fmtMoney(data.money) + (data.missing ? ' *' : '');
      }
      var html = toolbar(plan, 'channels', viewOf(instanceId)) + '<p class="pl-hint">В каждом направлении: ожидаемое количество / сумма по заполненным строкам. Звёздочка — неполный расчёт. Доля показана только от уже рассчитанных денег.</p>' +
        '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>Канал</th><th>ОФД, касс / ₽</th><th>1С, касс / ₽</th><th>Первая продажа, сделок / ₽</th><th>Деньги, ₽</th><th>Доля рассчитанного</th></tr></thead><tbody>';
      names.forEach(function (channel) {
        var data = map[channel] || [{ qty: 0, money: 0, missing: 0, months: {} }, { qty: 0, money: 0, missing: 0, months: {} }, { qty: 0, money: 0, missing: 0, months: {} }];
        var money = data.reduce(function (sum, entry) { return sum + entry.money; }, 0);
        html += '<tr><th scope="row">' + esc(channel) + '<details class="pl-channel-months"><summary>По месяцам</summary><div class="pl-channel-links">' +
          Array.from({ length: 12 }, function (_, i) {
            var month = plan.year + '-' + pad2(i + 1);
            return '<span>' + month + ' · ' + fmtMoney(data.reduce(function (sum, entry) { return sum + (entry.months[month] || 0); }, 0)) + '</span>';
          }).join('') + '</div></details></th>' +
          data.map(function (entry, index) { return '<td><button type="button" class="pl-cell" data-pl-target="' + ['pl-ofd', 'pl-1c', 'pl-upsell'][index] + '" data-pl-channel="' + esc(channel) + '">' + amount(entry, index) + '</button></td>'; }).join('') +
          '<td>' + (plan.coverage.onecLoaded ? fmtMoney(money) : fmtMoney(data[0].money) + ' по ОФД') + '</td>' +
          '<td>' + (total ? fmtPct(money / total) : '—') + '</td></tr>';
      });
      box.innerHTML = html + '</tbody></table></div>';
      bindExport(box, plan, 'channels'); bindNavigation(box);
    });
    board("pl-params", "Планирование — параметры и проверка бюджета", function (box, plan, instanceId) {
      var view = viewOf(instanceId);
      var mode = plan.params.priceMode === 'partial' ? 'partial' : 'general';
      var modeRows = plan.paramsRows.filter(function (row) { return row.scope === mode; });
      var rows = parameterFilter(view, modeRows, mode);
      var vatName = 'pl-vat-' + instanceId;
      var modeName = 'pl-price-mode-' + instanceId;
      var html = '<div class="pl-params-top"><label>Год плана <input class="pl-year" type="number" min="2000" max="2100" step="1" value="' + plan.year + '"></label>' +
        '<fieldset class="pl-vat"><legend>Средний чек</legend><label><input type="radio" name="' + esc(vatName) + '" value="with"' + (plan.params.vat === 'with' ? ' checked' : '') + '> с НДС</label>' +
        '<label><input type="radio" name="' + esc(vatName) + '" value="without"' + (plan.params.vat === 'without' ? ' checked' : '') + '> без НДС</label></fieldset>' +
        '<button type="button" class="pl-allxlsx">Скачать весь план в Excel</button><span class="pl-feedback" role="status">' + esc(view.feedback || '') + '</span><span class="pl-error" role="alert"></span></div>' +
        '<p class="pl-hint">Вводите средний чек в рублях, проценты — числом от 0 до 100. Общие чеки после обновления пустые: старые тарифные цены сохранены только в частном режиме. Ретро-продления рассчитаны по зрелым окончаниям касс; наблюдаемая доля покупателей 1С из неполной истории — не годовая конверсия. Изменения сохраняются после выхода из поля или Enter.</p>' +
        '<fieldset class="pl-mode"><legend>Расчёт бюджета</legend><label><input type="radio" name="' + esc(modeName) + '" value="general"' + (mode === 'general' ? ' checked' : '') + '> Общий: направление × канал, без тарифов</label><label><input type="radio" name="' + esc(modeName) + '" value="partial"' + (mode === 'partial' ? ' checked' : '') + '> Частный: тариф/цикл, общий как запасной</label></fieldset>' +
        '<div class="pl-gaps"><strong>' + esc(plan.status.label) + '</strong>' +
        (plan.status.gaps.length ? '<ul>' + plan.status.gaps.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>' : '<span> Все параметры заполнены.</span>') +
        (!plan.coverage.onecLoaded ? '<button type="button" class="pl-load-1c">Загрузить сверку 1С</button>' : '') + '</div>' +
        parameterFilters(view, modeRows, mode) +
        '<p class="pl-hint">Строк параметров: ' + rows.length + ' из ' + modeRows.length + '. Чек — за одну кассу или первую сделку, не за весь ИНН.</p>' +
        (rows.length ? (mode === 'general' ? generalParameterTable(rows) : parameterTable(rows, view)) : '<div class="pl-empty">Параметров по этим фильтрам нет.</div>') +
        '<details class="pl-checks"><summary>Контрольные сверки · ' + plan.audit.filter(function (a) { return !a.ok; }).length + ' расхождений</summary><ul>' +
        plan.audit.map(function (a) { return '<li>' + (a.ok ? '✓ ' : '⚠ ') + esc(a.name) + '</li>'; }).join('') + '</ul></details>' +
        '<details class="pl-exclusions"><summary>Исключения: ' + plan.exclusions.length + '</summary><ul>' +
        plan.exclusions.slice(0, 30).map(function (e) { return '<li>' + esc(e.product + ' · ' + (e.inn || e.unit || '—') + ': ' + e.reason) + '</li>'; }).join('') +
        '</ul>' + (plan.exclusions.length > 30 ? '<p>Полный список — в Excel.</p>' : '') + '</details>';
      box.innerHTML = html;
      bindNavigation(box);
      box.querySelectorAll('.pl-mode input').forEach(function (node) {
        node.addEventListener('change', function () {
          if (!node.checked) return;
          view.feedback = 'Режим изменён, план пересчитан';
          view.paramPage = 0;
          view.paramTariff = '';
          saveParams(Object.assign({}, plan.params, { priceMode: node.value === 'partial' ? 'partial' : 'general' }));
        });
      });
      box.querySelector('.pl-year').addEventListener('change', function (e) {
        var year = Number(e.target.value);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) { box.querySelector('.pl-params-top .pl-error').textContent = 'Укажите год от 2000 до 2100.'; return; }
        view.feedback = 'Год изменён. Месяцы прежнего года требуют переназначения.';
        saveParams(Object.assign({}, plan.params, { year: year }));
      });
      box.querySelectorAll('.pl-vat input').forEach(function (node) {
        node.addEventListener('change', function () {
          if (!node.checked) return;
          view.feedback = 'НДС отмечен, план пересчитан';
          saveParams(Object.assign({}, plan.params, { vat: node.value }));
        });
      });
      box.querySelector('.pl-allxlsx').addEventListener('click', function () {
        try { downloadPlan(plan, { board: 'all' }); }
        catch (error) {
          box.querySelector('.pl-params-top .pl-error').textContent = 'Не удалось собрать Excel: ' + (error && error.message || 'ошибка');
          console.error('Ошибка полной выгрузки плана:', error);
        }
      });
      bindParameterRows(box, plan, view, rows);
      bindPager(box, 'pl-params-page', view, 'paramPage', rows.length, PARAM_PAGE_SIZE, function () { listeners[instanceId](); });
      [['.pl-param-dir', 'paramDir'], ['.pl-param-ch', 'paramCh'], ['.pl-param-tf', 'paramTariff']].forEach(function (pair) {
        var node = box.querySelector(pair[0]);
        if (node) node.addEventListener('change', function (e) { view[pair[1]] = e.target.value; view.paramPage = 0; listeners[instanceId](); });
      });
      var search = box.querySelector('.pl-param-q');
      search.addEventListener('input', function () {
        var value = search.value;
        clearTimeout(search._plTimer);
        search._plTimer = setTimeout(function () {
          view.paramQ = value; view.paramPage = 0; listeners[instanceId]();
          var next = box.querySelector('.pl-param-q');
          if (next && document.activeElement === document.body) { next.focus(); next.setSelectionRange(value.length, value.length); }
        }, 180);
      });
    });
  }

  var api = {
    compute: compute, buildPlan: buildPlan, buildWorkbook: buildWorkbook, downloadPlan: downloadPlan,
    loadParams: loadParams, saveParams: saveParams, defaultParams: defaultParams, refresh: refresh,
    MONEY_TOLERANCE: MONEY_TOLERANCE, DRAFT: DRAFT, READY: READY, classifyEnd: classifyEnd,
    aggregateRetro: aggregateRetro,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OFDPlanning = api;
  registerBoards();
})(typeof window !== "undefined" ? window : globalThis);
