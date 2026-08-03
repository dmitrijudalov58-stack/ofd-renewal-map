/*
 * Ядро расчётов "Карты продлений ОФД".
 * Чистые функции без DOM — работает и в браузере (<script src>), и в Node (require) для тестов.
 * Формулы соответствуют утверждённой спеке (00 / B1-B4).
 */
(function (root) {
  "use strict";

  var LARISA_CENTERS = new Set([
    'ООО "Астрал Партнёр" ЦП',
    "ОП Калуга Астрал в г. Екатеринбург (Савукова Н.)",
    "ОП ООО АСТРАЛ-СОФТ г. Екатеринбург",
    'Представительство АО "Калуга Астрал" в г. Волгоград ЦП',
    'Представительство АО "Калуга Астрал" в г. Воронеж',
    'Представительство АО "Калуга Астрал" в г. Краснодар ЦП',
    'Представительство АО "Калуга Астрал" в г. Омск ЦП',
    'Представительство АО "Калуга Астрал" в г. Саратов ЦП',
    'Представительство АО "Калуга Астрал" в г. Уфа ЦП',
    'Представительство АО "Калуга Астрал" в г.Новосибирске ЦП',
    'Представительство ООО "АСТРАЛ-СОФТ" в г. Санкт-Петербург ЦП',
  ]);
  var OLYA_PATTERN = /ЛК ОФД|ОПС ЭДО|ОППС ЭДО/;

  function classifyChannel(partner, salesCenter) {
    if (OLYA_PATTERN.test(partner || "")) return "Ольга Зибер";
    if (LARISA_CENTERS.has(salesCenter || "")) return "Лариса Пенигина";
    return "Партнёры";
  }

  function parseTariffMonths(str) {
    var m = /(\d+)/.exec(str || "");
    return m ? parseInt(m[1], 10) : null;
  }

  function addMonths(date, months) {
    var d = new Date(date.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function addDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
  }

  // Индивидуальный конец обслуживания конкретного кода: "Дата окончания",
  // с фолбэком "Дата создания" + "Срок действия тарифа" месяцев, если поле пустое.
  function individualEnd(row) {
    if (row.endDate instanceof Date) return row.endDate;
    var months = parseTariffMonths(row.tariff);
    if (row.created instanceof Date && months) return addMonths(row.created, months);
    return null;
  }

  // ---------- построение модели сущностей из нормализованных строк ----------

  function buildModel(rows) {
    var kassaRows = new Map(); // РНМ -> [registered rows]
    var reserveRows = []; // Новый / Выдан
    var revokedRows = []; // Отозвано

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status === "Зарегистрировано") {
        if (!r.rnm) continue;
        var list = kassaRows.get(r.rnm);
        if (!list) { list = []; kassaRows.set(r.rnm, list); }
        list.push(r);
      } else if (r.status === "Новый" || r.status === "Выдан") {
        reserveRows.push(r);
      } else if (r.status === "Отозвано") {
        revokedRows.push(r);
      }
    }

    var kassas = new Map();
    kassaRows.forEach(function (list, rnm) {
      list.sort(function (a, b) { return a.activated - b.activated; });
      var last = list[list.length - 1];
      var intervals = list.map(function (row) {
        return { start: row.activated, end: individualEnd(row) };
      });
      kassas.set(rnm, {
        rnm: rnm,
        codes: list,
        intervals: intervals,
        renewals: list.length - 1,
        appearance: list[0].activated,
        overallEnd: last.overallEnd || null,
        tariff: last.tariff,
        partner: last.partner,
        salesCenter: last.salesCenter,
        clientKey: last.innOrg || last.innPhys || null,
        channel: classifyChannel(last.partner, last.salesCenter),
      });
    });

    var clients = new Map();
    kassas.forEach(function (k) {
      if (!k.clientKey) return;
      var c = clients.get(k.clientKey);
      if (!c) { c = { key: k.clientKey, kassas: [], phys: false }; clients.set(k.clientKey, c); }
      c.kassas.push(k);
    });

    // резервный резерв: ИНН физлица без ИНН организации, без единой зарегистрированной кассы —
    // считаем клиентом от даты создания (см. решение по 892 строкам).
    var reserveByKey = new Map();
    reserveRows.forEach(function (r) {
      var key = r.innOrg || r.innPhys || null;
      if (!key || clients.has(key)) return;
      var list = reserveByKey.get(key);
      if (!list) { list = []; reserveByKey.set(key, list); }
      list.push(r);
    });
    reserveByKey.forEach(function (list, key) {
      list.sort(function (a, b) { return a.created - b.created; });
      clients.set(key, {
        key: key, kassas: [], phys: true,
        appearance: list[0].created,
        partner: list[list.length - 1].partner,
      });
    });

    clients.forEach(function (c) {
      if (c.phys) return;
      var appearance = null, currentEnd = null, lastRow = null;
      c.kassas.forEach(function (k) {
        if (appearance === null || k.appearance < appearance) appearance = k.appearance;
        if (k.overallEnd && (currentEnd === null || k.overallEnd > currentEnd)) currentEnd = k.overallEnd;
        if (lastRow === null || k.appearance > lastRow.appearance) lastRow = k;
      });
      c.appearance = appearance;
      c.currentEnd = currentEnd;
      c.partner = lastRow ? lastRow.partner : null;
    });

    return { kassas: kassas, clients: clients, reserveRows: reserveRows, revokedRows: revokedRows };
  }

  // была ли касса "лежащей" (без покрытия) в момент atDate: нет интервала [start,end], который его накрывает
  function kassaLapsedAt(kassa, atDate) {
    if (atDate < kassa.appearance) return false; // ещё не существовала
    for (var i = 0; i < kassa.intervals.length; i++) {
      var iv = kassa.intervals[i];
      if (iv.start <= atDate && (!iv.end || atDate <= iv.end)) return false; // покрыта
    }
    return true;
  }

  function clientLapsedAt(client, atDate) {
    if (client.phys) return atDate >= client.appearance; // у резервных клиентов нет касс — статус не применим, трактуем как "не активна"
    if (client.kassas.length === 0) return true;
    for (var i = 0; i < client.kassas.length; i++) {
      if (!kassaLapsedAt(client.kassas[i], atDate)) return false;
    }
    return true;
  }

  // ---------- потоковые метрики (период) ----------

  function inRange(date, start, end) { return date && date >= start && date <= end; }

  function computeFlow(model, periodStart, periodEnd) {
    var reanimWindowEnd = addMonths(periodEnd, 3);

    var newClients = 0, churnedClients = 0, reanimClients = 0;
    model.clients.forEach(function (c) {
      if (inRange(c.appearance, periodStart, periodEnd)) newClients++;
      if (!c.phys && c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd)) churnedClients++;
      if (clientLapsedAt(c, periodEnd)) {
        var reanimated = false;
        if (!c.phys) {
          for (var i = 0; i < c.kassas.length && !reanimated; i++) {
            var k = c.kassas[i];
            for (var j = 0; j < k.intervals.length; j++) {
              var s = k.intervals[j].start;
              if (s > periodEnd && s <= reanimWindowEnd) { reanimated = true; break; }
            }
          }
        }
        if (reanimated) reanimClients++;
      }
    });

    var newKassas = 0, churnedKassas = 0, reanimKassas = 0;
    model.kassas.forEach(function (k) {
      if (inRange(k.appearance, periodStart, periodEnd)) newKassas++;
      if (k.overallEnd && inRange(k.overallEnd, periodStart, periodEnd)) churnedKassas++;
      if (kassaLapsedAt(k, periodEnd)) {
        for (var j = 0; j < k.intervals.length; j++) {
          var s = k.intervals[j].start;
          if (s > periodEnd && s <= reanimWindowEnd) { reanimKassas++; break; }
        }
      }
    });

    return {
      clients: { new: newClients, churn: churnedClients, reanim: reanimClients },
      kassas: { new: newKassas, churn: churnedKassas, reanim: reanimKassas },
    };
  }

  // ---------- снэпшот-метрики (as-of) ----------

  function computeSnapshot(model, asOf) {
    var activeClients = 0, phys = 0;
    var kassaCountBuckets = { "1": 0, "2-3": 0, "4-9": 0, "10+": 0 };
    var ageBuckets = { "1y": 0, "2y": 0, "3y": 0 };

    model.clients.forEach(function (c) {
      var alive = !clientLapsedAt(c, asOf);
      if (alive) activeClients++;
      if (c.phys) phys++;

      if (!c.phys) {
        var n = c.kassas.length;
        var bucket = n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+";
        kassaCountBuckets[bucket]++;
      }
      if (c.appearance) {
        var ageDays = (asOf - c.appearance) / 86400000;
        if (ageDays >= 365) ageBuckets["1y"]++;
        if (ageDays >= 730) ageBuckets["2y"]++;
        if (ageDays >= 1095) ageBuckets["3y"]++;
      }
    });

    var activeKassas = 0;
    var renewalBuckets = { "0": 0, "1-2": 0, "3-5": 0, "6+": 0 };
    var tariffBuckets = {};
    model.kassas.forEach(function (k) {
      if (k.overallEnd && k.overallEnd >= asOf) activeKassas++;
      var r = k.renewals;
      var rb = r === 0 ? "0" : r <= 2 ? "1-2" : r <= 5 ? "3-5" : "6+";
      renewalBuckets[rb]++;
      var t = k.tariff || "—";
      tariffBuckets[t] = (tariffBuckets[t] || 0) + 1;
    });

    return {
      activeClients: activeClients, phys: phys, totalClients: model.clients.size,
      kassaCountBuckets: kassaCountBuckets, ageBuckets: ageBuckets,
      activeKassas: activeKassas, totalKassas: model.kassas.size,
      renewalBuckets: renewalBuckets, tariffBuckets: tariffBuckets,
    };
  }

  // ---------- "под риском" ----------

  function nearestAliveEnd(kassaList, asOf) {
    var min = null;
    kassaList.forEach(function (k) {
      if (k.overallEnd && k.overallEnd >= asOf) {
        if (min === null || k.overallEnd < min) min = k.overallEnd;
      }
    });
    return min;
  }

  function riskFilter(deadlineFn) {
    // deadlineFn(end) -> true если попадает под порог риска
    return deadlineFn;
  }

  function clientsAtRisk(model, asOf, deadlineFn) {
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var end = nearestAliveEnd(c.kassas, asOf);
      if (end && deadlineFn(end)) {
        out.push({ key: c.key, partner: c.partner, kassaCount: c.kassas.length, end: end });
      }
    });
    return out;
  }

  function kassasAtRisk(model, asOf, deadlineFn) {
    var out = [];
    model.kassas.forEach(function (k) {
      if (k.overallEnd && k.overallEnd >= asOf && deadlineFn(k.overallEnd)) {
        out.push({ rnm: k.rnm, partner: k.partner, renewals: k.renewals, tariff: k.tariff, end: k.overallEnd });
      }
    });
    return out;
  }

  function daysThresholdFn(asOf, days) {
    var cutoff = addDays(asOf, days);
    return function (end) { return end <= cutoff; };
  }
  function dateThresholdFn(cutoffDate) {
    return function (end) { return end <= cutoffDate; };
  }

  // ---------- партнёры / каналы ----------

  function computePartners(model, asOf) {
    var byPartner = new Map();
    function bucket(name) {
      var p = byPartner.get(name);
      if (!p) { p = { name: name, clients: new Set(), kassas: 0, reserve: 0 }; byPartner.set(name, p); }
      return p;
    }
    model.clients.forEach(function (c) {
      if (!clientLapsedAt(c, asOf)) bucket(c.partner || "—").clients.add(c.key);
    });
    model.kassas.forEach(function (k) {
      if (k.overallEnd && k.overallEnd >= asOf) bucket(k.partner || "—").kassas++;
    });
    model.reserveRows.forEach(function (r) {
      bucket(r.partner || "—").reserve++;
    });

    var rows = [];
    byPartner.forEach(function (p) {
      rows.push({ name: p.name, clients: p.clients.size, kassas: p.kassas, reserve: p.reserve });
    });
    return rows;
  }

  // партнёры с указанием канала — для фастфильтра и экспорта на виджете "Разбивка по каналам"
  function computePartnersByChannel(model, asOf) {
    var partnerChannel = new Map();
    model.kassas.forEach(function (k) {
      var pn = k.partner || "—";
      if (!partnerChannel.has(pn)) partnerChannel.set(pn, k.channel);
    });
    model.reserveRows.forEach(function (r) {
      var pn = r.partner || "—";
      if (!partnerChannel.has(pn)) partnerChannel.set(pn, classifyChannel(r.partner, r.salesCenter));
    });
    return computePartners(model, asOf).map(function (p) {
      return { name: p.name, channel: partnerChannel.get(p.name) || classifyChannel(p.name, null), clients: p.clients, kassas: p.kassas, reserve: p.reserve };
    });
  }

  function computeChannels(model, asOf) {
    var out = { "Ольга Зибер": 0, "Лариса Пенигина": 0, "Партнёры": 0 };
    model.clients.forEach(function (c) {
      if (c.phys || clientLapsedAt(c, asOf)) return;
      var ch = classifyChannel(c.kassas[c.kassas.length - 1].partner, c.kassas[c.kassas.length - 1].salesCenter);
      out[ch]++;
    });
    return out;
  }

  // ---------- коды ОФД (B4) ----------

  function computeReserve(model, asOf) {
    var total = model.reserveRows.length;
    var olderThanYear = 0;
    var byYear = {};
    var byPartner = new Map();
    model.reserveRows.forEach(function (r) {
      if (!(r.created instanceof Date)) return;
      var ageDays = (asOf - r.created) / 86400000;
      if (ageDays >= 365) olderThanYear++;
      var y = r.created.getFullYear();
      byYear[y] = byYear[y] || {};
      var m = r.created.getMonth();
      byYear[y][m] = (byYear[y][m] || 0) + 1;
      var pn = r.partner || "—";
      byPartner.set(pn, (byPartner.get(pn) || 0) + 1);
    });
    return { total: total, olderThanYear: olderThanYear, byYear: byYear, byPartner: byPartner };
  }

  // резерв в разбивке по партнёру -> год -> месяц (для B4 "неактивированные коды по партнёрам")
  function computeReserveDetail(model) {
    var byPartner = new Map();
    model.reserveRows.forEach(function (r) {
      var pn = r.partner || "—";
      var p = byPartner.get(pn);
      if (!p) { p = { total: 0, years: new Map() }; byPartner.set(pn, p); }
      p.total++;
      if (r.created instanceof Date) {
        var y = r.created.getFullYear(), m = r.created.getMonth();
        var ym = p.years.get(y);
        if (!ym) { ym = new Map(); p.years.set(y, ym); }
        ym.set(m, (ym.get(m) || 0) + 1);
      }
    });
    return byPartner;
  }

  // помесячные счётчики "новых"/"оттока" по всему периоду — для линейных графиков
  function computeMonthlySeries(model, periodStart, periodEnd) {
    var months = [];
    var cursor = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    var end = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    while (cursor <= end) { months.push(new Date(cursor)); cursor = addMonths(cursor, 1); }

    var newByMonth = months.map(function () { return 0; });
    var churnByMonth = months.map(function () { return 0; });

    function monthIndex(date) {
      for (var i = 0; i < months.length; i++) {
        if (date.getFullYear() === months[i].getFullYear() && date.getMonth() === months[i].getMonth()) return i;
      }
      return -1;
    }

    model.clients.forEach(function (c) {
      if (inRange(c.appearance, periodStart, periodEnd)) {
        var i = monthIndex(c.appearance);
        if (i >= 0) newByMonth[i]++;
      }
      if (!c.phys && c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd)) {
        var j = monthIndex(c.currentEnd);
        if (j >= 0) churnByMonth[j]++;
      }
    });

    return { months: months, newByMonth: newByMonth, churnByMonth: churnByMonth };
  }

  // топ партнёров по объёму ЗА ПЕРИОД: новые клиенты / новые кассы / продления
  // Воронка кодов, созданных за период. "Активировано" = клиент привязал код к себе
  // (статус "Зарегистрировано" — по факту эквивалентно "есть ИНН клиента"), "Неактивировано" =
  // до сих пор в резерве партнёра (Новый/Выдан), "Отозвано" — аннулировано. Три бакета честно
  // разбивают "Создано" без пересечений (в отличие от сырого "есть ИНН клиента", который задел бы
  // и отозванные-но-раньше-активированные коды сразу в два столбца).
  function computeFunnel(model, periodStart, periodEnd) {
    var created = 0, activated = 0, notActivated = 0, revoked = 0, totalLagDays = 0, lagCount = 0;
    function walk(row) {
      if (!inRange(row.created, periodStart, periodEnd)) return;
      created++;
      if (row.status === "Зарегистрировано") {
        activated++;
        if (row.activated instanceof Date) {
          totalLagDays += (row.activated - row.created) / 86400000;
          lagCount++;
        }
      } else if (row.status === "Новый" || row.status === "Выдан") {
        notActivated++;
      } else if (row.status === "Отозвано") {
        revoked++;
      }
    }
    model.kassas.forEach(function (k) { k.codes.forEach(walk); });
    model.reserveRows.forEach(walk);
    model.revokedRows.forEach(walk);
    return {
      created: created, activated: activated, notActivated: notActivated, revoked: revoked,
      avgLagDays: lagCount ? totalLagDays / lagCount : null,
    };
  }

  // резерв конкретного партнёра за конкретный (год, месяц) — для 3-го уровня раскрытия B4
  function computeReservePartnersForMonth(model, year, month) {
    var byPartner = new Map();
    model.reserveRows.forEach(function (r) {
      if (!(r.created instanceof Date)) return;
      if (r.created.getFullYear() !== year || r.created.getMonth() !== month) return;
      var pn = r.partner || "—";
      byPartner.set(pn, (byPartner.get(pn) || 0) + 1);
    });
    var out = Array.from(byPartner.entries()).map(function (e) { return { name: e[0], count: e[1] }; });
    out.sort(function (a, b) { return b.count - a.count; });
    return out;
  }

  function computeRevokedInPeriod(model, periodStart, periodEnd) {
    var n = 0;
    model.revokedRows.forEach(function (r) { if (inRange(r.created, periodStart, periodEnd)) n++; });
    return n;
  }

  function computeReserveShare(model, periodStart, periodEnd) {
    var createdTotal = 0, createdReserve = 0;
    function count(row, isReserve) {
      if (!inRange(row.created, periodStart, periodEnd)) return;
      createdTotal++;
      if (isReserve) createdReserve++;
    }
    model.kassas.forEach(function (k) { k.codes.forEach(function (r) { count(r, false); }); });
    model.reserveRows.forEach(function (r) { count(r, true); });
    model.revokedRows.forEach(function (r) { count(r, false); });
    return createdTotal ? createdReserve / createdTotal : 0;
  }

  var api = {
    buildModel: buildModel,
    computeFlow: computeFlow,
    computeSnapshot: computeSnapshot,
    clientsAtRisk: clientsAtRisk,
    kassasAtRisk: kassasAtRisk,
    daysThresholdFn: daysThresholdFn,
    dateThresholdFn: dateThresholdFn,
    computePartners: computePartners,
    computePartnersByChannel: computePartnersByChannel,
    computeChannels: computeChannels,
    computeReserve: computeReserve,
    computeReserveDetail: computeReserveDetail,
    computeReservePartnersForMonth: computeReservePartnersForMonth,
    computeMonthlySeries: computeMonthlySeries,
    computeFunnel: computeFunnel,
    computeRevokedInPeriod: computeRevokedInPeriod,
    computeReserveShare: computeReserveShare,
    classifyChannel: classifyChannel,
    individualEnd: individualEnd,
    addMonths: addMonths,
    addDays: addDays,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDMetrics = api;
})(typeof window !== "undefined" ? window : globalThis);
