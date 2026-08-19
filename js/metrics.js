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

  function buildModel(rows, opts) {
    opts = opts || {};
    // strict (по умолчанию true) = "рокировка": ориентируемся только на клиентов с
    // действующим кодом ОФД. opts.strict:false — прежний формат, для сверки/отката.
    var strict = opts.strict !== false;
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
        partnerInn: last.partnerInn,
        salesCenter: last.salesCenter,
        clientKey: last.innOrg || last.innPhys || null,
        org: last.org,
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

    // Легаси-режим (opts.strict:false): ИНН физлица без ИНН организации, без единой
    // зарегистрированной кассы — считаем клиентом от даты создания кода (решение по 892 строкам).
    // В строгом режиме (default) — это НЕ клиент: код в резерве (Новый/Выдан) ещё не
    // "действующий", клиент появляется только когда есть код со статусом "Зарегистрировано".
    if (!strict) {
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
          partnerInn: list[list.length - 1].partnerInn,
          org: list[list.length - 1].org,
        });
      });
    }

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
      c.partnerInn = lastRow ? lastRow.partnerInn : null;
      c.org = lastRow ? lastRow.org : null;
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

  // Единое определение "действующая касса" (рокировка на "только действующие").
  // strict=true (default): касса жива, если atDate покрыта интервалом какого-то из её
  // кодов — учитывает разрывы между кодами. strict=false: легаси-формула по "Общей дате
  // окончания" (финальный срок, без учёта разрывов) — для отката/сверки.
  function isKassaAlive(kassa, atDate, strict) {
    if (strict === false) return !!(kassa.overallEnd && kassa.overallEnd >= atDate);
    return !kassaLapsedAt(kassa, atDate);
  }

  // Дедлайн кассы по тому же определению — не просто "жива/не жива", а конкретная дата,
  // нужна риск-листам ("сколько дней осталось") и статус-пилюлям.
  function kassaDeadline(kassa, atDate, strict) {
    if (strict === false) return kassa.overallEnd && kassa.overallEnd >= atDate ? kassa.overallEnd : null;
    for (var i = 0; i < kassa.intervals.length; i++) {
      var iv = kassa.intervals[i];
      if (iv.start <= atDate && (!iv.end || atDate <= iv.end)) return iv.end;
    }
    return null;
  }

  // ---------- отток / реанимация (новая формула, согласована с Димой 2026-08-06) ----------
  //
  // Касса/клиент "спасены", если продлились не позже 30-го дня включительно после своей
  // даты окончания. С 31-го дня, если покрытия так и нет — отток. Реанимация — новый код
  // активировался в окне 31-91 день (включительно) после даты окончания; после 91-го дня
  // без продления — потеряна окончательно. Статус относится к месяцу ДАТЫ ОКОНЧАНИЯ
  // (ретроспективно), но становится известным только когда с этой даты прошло 31+ дней
  // от asOf — до этого статус "pending", в отток/реанимацию не засчитывается нигде.
  // ЗАМЕНЯЕТ старую формулу ("Общая дата окончания" в периоде) везде: computeFlow,
  // computeMonthlySeries(Kassas), список "к продлению после окончания", борды по партнёрам.
  var CHURN_GRACE_DAYS = 30;
  var REANIM_WINDOW_START_DAYS = 31;

  // ПРИМЕЧАНИЕ (2026-08-06): раньше здесь была ветка "reanimated" — сравнивала интервалы с
  // overallEnd/currentEnd в поисках чего-то, начавшегося позже. Она была МЁРТВОЙ КОДОМ:
  // overallEnd/currentEnd — это ВСЕГДА максимум по всей цепочке (включая сам возврат, если
  // он был), поэтому "что-то начавшееся позже максимума" математически не могло найтись
  // никогда — проверено эмпирически на реальных данных (0 из 263675 касс, 0 из 150648
  // клиентов). Отток (30/31 день) это не задевало — реанимация была отдельной веткой,
  // отток всегда падал в "churned". Реанимация/возврат теперь отдельная метрика — см.
  // findReturn() ниже, использует правильное сравнение (последний интервал против
  // максимума ВСЕХ ОСТАЛЬНЫХ, не включая его самого).
  function churnStatusFromEnd(end, asOf, lapsedAtFn) {
    if (!end) return null;
    var graceDeadline = addDays(end, CHURN_GRACE_DAYS); // день 30 — последний день, когда продление ещё спасает
    var resolveAt = addDays(end, REANIM_WINDOW_START_DAYS); // день 31 — судьба уже известна
    if (asOf < resolveAt) return "pending";
    return lapsedAtFn(graceDeadline) ? "churned" : "safe";
  }

  function kassaChurnStatus(kassa, asOf) {
    return churnStatusFromEnd(kassa.overallEnd, asOf, function (d) { return kassaLapsedAt(kassa, d); });
  }

  function clientChurnStatus(client, asOf) {
    if (client.phys) return null;
    return churnStatusFromEnd(client.currentEnd, asOf, function (d) { return clientLapsedAt(client, d); });
  }

  // ---------- возврат после оттока (не влияет на отток 30/31 — отдельная метка) ----------
  //
  // Правильное сравнение: берём САМЫЙ ПОЗДНО НАЧАВШИЙСЯ интервал, сравниваем его начало с
  // максимумом ОКОНЧАНИЙ ВСЕХ ОСТАЛЬНЫХ интервалов (не включая его самого) — если между
  // ними разрыв, это и есть возврат. Раньше сравнивали с overallEnd/currentEnd (= максимум
  // ВКЛЮЧАЯ сам возврат) — от этого сравнение было тавтологией, всегда false.
  var RETURN_TAG_MAX_DAYS = 1095; // 3 года — дальше просто новый клиент, без пометки

  function findReturn(intervals) {
    if (intervals.length < 2) return null;
    var sorted = intervals.slice().sort(function (a, b) { return a.start - b.start; });
    var last = sorted[sorted.length - 1];
    var priorMaxEnd = null;
    for (var i = 0; i < sorted.length - 1; i++) {
      var e = sorted[i].end;
      if (e && (priorMaxEnd === null || e > priorMaxEnd)) priorMaxEnd = e;
    }
    if (!priorMaxEnd || last.start <= priorMaxEnd) return null; // разрыва не было -- непрерывная цепочка
    var days = daysBetween(priorMaxEnd, last.start);
    if (days > RETURN_TAG_MAX_DAYS) return null; // 3+ года -- просто новый, без пометки
    return { returnDate: last.start, gapEnd: priorMaxEnd, days: days, tag: days <= 90 ? "вернувшийся" : "возвращённый" };
  }

  function clientReturnInfo(client) {
    if (client.phys) return null;
    var allIntervals = [];
    client.kassas.forEach(function (k) { allIntervals = allIntervals.concat(k.intervals); });
    return findReturn(allIntervals);
  }

  function kassaReturnInfo(kassa) {
    return findReturn(kassa.intervals);
  }


  // ---------- потоковые метрики (период) ----------

  function inRange(date, start, end) { return date && date >= start && date <= end; }

  function computeFlow(model, periodStart, periodEnd, asOf) {
    asOf = asOf || periodEnd; // обратная совместимость со старыми вызовами (напр. test/smoke.js)

    var newClients = 0, churnedClients = 0, returnedClients = 0;
    model.clients.forEach(function (c) {
      if (inRange(c.appearance, periodStart, periodEnd)) newClients++;
      if (!c.phys && c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd) && clientChurnStatus(c, asOf) === "churned") {
        churnedClients++;
      }
      // "вернувшиеся" (0-90 дней) -- считаем по дате самого ВОЗВРАТА в периоде, не по дате
      // окончания. Не пересекается с churnedClients (тот считает по дате окончания).
      if (!c.phys) {
        var ri = clientReturnInfo(c);
        if (ri && ri.tag === "вернувшийся" && inRange(ri.returnDate, periodStart, periodEnd)) returnedClients++;
      }
    });

    var newKassas = 0, churnedKassas = 0, returnedKassas = 0;
    model.kassas.forEach(function (k) {
      if (inRange(k.appearance, periodStart, periodEnd)) newKassas++;
      if (k.overallEnd && inRange(k.overallEnd, periodStart, periodEnd) && kassaChurnStatus(k, asOf) === "churned") {
        churnedKassas++;
      }
      var kri = kassaReturnInfo(k);
      if (kri && kri.tag === "вернувшийся" && inRange(kri.returnDate, periodStart, periodEnd)) returnedKassas++;
    });

    return {
      clients: { new: newClients, churn: churnedClients, reanim: returnedClients },
      kassas: { new: newKassas, churn: churnedKassas, reanim: returnedKassas },
    };
  }

  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

  // Отток/новые по партнёрам за период + retention (1 - отток/база на начало периода) —
  // общая функция для борда "топ оттока по партнёрам" и борда "партнёр: новые/отток/%".
  function computePartnerFlow(model, periodStart, periodEnd, asOf) {
    asOf = asOf || periodEnd;
    var byPartner = new Map();
    function bucket(name) {
      var p = byPartner.get(name);
      if (!p) { p = { name: name, newClients: 0, churnedClients: 0, baseAtStart: 0, baseAtEnd: 0 }; byPartner.set(name, p); }
      return p;
    }
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var name = c.partner || "—";
      if (inRange(c.appearance, periodStart, periodEnd)) bucket(name).newClients++;
      if (c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd) && clientChurnStatus(c, asOf) === "churned") {
        bucket(name).churnedClients++;
      }
      // база "на начало периода" — клиент уже существовал и был жив на дату начала периода
      if (c.appearance && c.appearance < periodStart && !clientLapsedAt(c, periodStart)) {
        bucket(name).baseAtStart++;
      }
      // база "на конец периода" (п.23, 2026-08-06) — сколько осталось: пришло + было, минус ушедшие
      if (c.appearance && c.appearance <= periodEnd && !clientLapsedAt(c, periodEnd)) {
        bucket(name).baseAtEnd++;
      }
    });
    var rows = [];
    byPartner.forEach(function (p) {
      var retention = p.baseAtStart > 0 ? 1 - (p.churnedClients / p.baseAtStart) : null;
      rows.push({ name: p.name, newClients: p.newClients, churnedClients: p.churnedClients, baseAtStart: p.baseAtStart, baseAtEnd: p.baseAtEnd, retention: retention });
    });
    return rows;
  }

  // То же самое, но по кассам (РНМ) вместо клиентов (ИНН) — для борда "Партнёр: новые/
  // отток/% эффективности" (сместили фокус с клиентов на кассы 2026-08-06).
  function computePartnerFlowKassas(model, periodStart, periodEnd, asOf) {
    asOf = asOf || periodEnd;
    var byPartner = new Map();
    function bucket(name) {
      var p = byPartner.get(name);
      if (!p) { p = { name: name, newKassas: 0, churnedKassas: 0, baseAtStart: 0 }; byPartner.set(name, p); }
      return p;
    }
    model.kassas.forEach(function (k) {
      var name = k.partner || "—";
      if (inRange(k.appearance, periodStart, periodEnd)) bucket(name).newKassas++;
      if (k.overallEnd && inRange(k.overallEnd, periodStart, periodEnd) && kassaChurnStatus(k, asOf) === "churned") {
        bucket(name).churnedKassas++;
      }
      if (k.appearance && k.appearance < periodStart && !kassaLapsedAt(k, periodStart)) {
        bucket(name).baseAtStart++;
      }
    });
    var rows = [];
    byPartner.forEach(function (p) {
      var retention = p.baseAtStart > 0 ? 1 - (p.churnedKassas / p.baseAtStart) : null;
      rows.push({ name: p.name, newKassas: p.newKassas, churnedKassas: p.churnedKassas, baseAtStart: p.baseAtStart, retention: retention });
    });
    return rows;
  }

  // ---------- снэпшот-метрики (as-of) ----------

  // "Действующий" = НЕ в оттоке по новой формуле (churnStatus !== "churned") -- НЕ зависит
  // от переключателя "Режим" (strict/legacy), в отличие от computeSnapshot ниже. Используется
  // в "Распределение по числу касс" и "Возрастная структура базы" — эти борды путали людей,
  // когда легаси-режим случайно включён (см. находка 2026-08-06: 150648/151151 — суммы под
  // strict:false, а не баг формулы). Клиент/касса выпадает из "действующих" ровно на 31-й
  // день после окончания, когда статус становится "churned".
  function computeActiveSnapshot(model, asOf) {
    var activeClients = 0;
    var kassaCountBuckets = { "1": 0, "2-3": 0, "4-9": 0, "10+": 0 };
    var ageBuckets = { "0-1y": 0, "1-2y": 0, "2-3y": 0, "3y+": 0 };
    function ageBucketOf(appearance) {
      var days = (asOf - appearance) / 86400000;
      return days < 365 ? "0-1y" : days < 730 ? "1-2y" : days < 1095 ? "2-3y" : "3y+";
    }
    // "Действующий" = код реально покрывает СЕЙЧАС (!clientLapsedAt) -- не "ещё не
    // подтверждён как отток" (churnStatus, тот даёт 30-дневный грейс). Уточнено Димой
    // 2026-08-06: "только действующие клиенты и кассы у которых есть действующий код,
    // отток/возвращённые/прочее сюда не входят" -- тот же чек, что уже использует
    // "Активные клиенты сейчас" (computeSnapshot), просто не завязан на переключатель
    // "Режим" (strict/legacy), из-за которого раньше путались числа 150648/151151.
    model.clients.forEach(function (c) {
      if (c.phys) return;
      if (clientLapsedAt(c, asOf)) return;
      activeClients++;
      var n = c.kassas.length;
      kassaCountBuckets[n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+"]++;
      if (c.appearance) ageBuckets[ageBucketOf(c.appearance)]++;
    });

    var activeKassas = 0;
    var kassaAgeBuckets = { "0-1y": 0, "1-2y": 0, "2-3y": 0, "3y+": 0 };
    model.kassas.forEach(function (k) {
      if (kassaLapsedAt(k, asOf)) return;
      activeKassas++;
      if (k.appearance) kassaAgeBuckets[ageBucketOf(k.appearance)]++;
    });

    return { activeClients: activeClients, kassaCountBuckets: kassaCountBuckets, ageBuckets: ageBuckets, activeKassas: activeKassas, kassaAgeBuckets: kassaAgeBuckets };
  }

  function computeSnapshot(model, asOf, opts) {
    opts = opts || {};
    var strict = opts.strict !== false;
    var activeClients = 0, phys = 0;
    var kassaCountBuckets = { "1": 0, "2-3": 0, "4-9": 0, "10+": 0 };
    // эксклюзивные когорты (не пересекаются, сумма = totalReal) — раньше были кумулятивные
    // ("старше 1 года" включало и "старше 3 лет"), что читалось неоднозначно
    var ageBuckets = { "0-1y": 0, "1-2y": 0, "2-3y": 0, "3y+": 0 };

    model.clients.forEach(function (c) {
      var alive = !clientLapsedAt(c, asOf);
      if (alive) activeClients++;
      if (c.phys) phys++;

      // структурные срезы базы (число касс на клиента, возраст) — в строгом режиме
      // это срез ТОЛЬКО действующих клиентов, в легаси — вся историческая база
      if (!c.phys && (!strict || alive)) {
        var n = c.kassas.length;
        var bucket = n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+";
        kassaCountBuckets[bucket]++;
      }
      if (c.appearance && (!strict || alive)) {
        var ageDays = (asOf - c.appearance) / 86400000;
        var ageBucket = ageDays < 365 ? "0-1y" : ageDays < 730 ? "1-2y" : ageDays < 1095 ? "2-3y" : "3y+";
        ageBuckets[ageBucket]++;
      }
    });

    var activeKassas = 0;
    var renewalBuckets = { "0": 0, "1-2": 0, "3-5": 0, "6+": 0 };
    var tariffBuckets = {};
    model.kassas.forEach(function (k) {
      var kAlive = isKassaAlive(k, asOf, strict);
      if (kAlive) activeKassas++;
      if (!strict || kAlive) {
        var r = k.renewals;
        var rb = r === 0 ? "0" : r <= 2 ? "1-2" : r <= 5 ? "3-5" : "6+";
        renewalBuckets[rb]++;
        var t = k.tariff || "—";
        tariffBuckets[t] = (tariffBuckets[t] || 0) + 1;
      }
    });

    return {
      activeClients: activeClients, phys: phys, totalClients: model.clients.size,
      kassaCountBuckets: kassaCountBuckets, ageBuckets: ageBuckets,
      activeKassas: activeKassas, totalKassas: model.kassas.size,
      renewalBuckets: renewalBuckets, tariffBuckets: tariffBuckets,
    };
  }

  // ---------- "под риском" ----------

  function nearestAliveEnd(kassaList, asOf, strict) {
    var min = null;
    kassaList.forEach(function (k) {
      var end = kassaDeadline(k, asOf, strict);
      if (end !== null && (min === null || end < min)) min = end;
    });
    return min;
  }

  function riskFilter(deadlineFn) {
    // deadlineFn(end) -> true если попадает под порог риска
    return deadlineFn;
  }

  function clientsAtRisk(model, asOf, deadlineFn, opts) {
    opts = opts || {};
    var strict = opts.strict !== false;
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var end = nearestAliveEnd(c.kassas, asOf, strict);
      if (end && deadlineFn(end)) {
        // kassaDetails -- САМИ кассы, которые попали под порог (не только счётчик), для
        // выгрузки по кассам (Дима, 2026-08-18: "у каждого РНМ должна быть дата окончания").
        var matched = c.kassas.filter(function (k) {
          var d = kassaDeadline(k, asOf, strict);
          return d && deadlineFn(d);
        });
        var kassaDetails = matched.map(function (k) { return { rnm: k.rnm, tariff: k.tariff, end: kassaDeadline(k, asOf, strict) }; });
        out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, kassaCount: c.kassas.length, kassasToRenew: matched.length, end: end, kassaDetails: kassaDetails });
      }
    });
    return out;
  }

  // Клиенты, у которых ближайшая касса УЖЕ просрочена (окончание в прошлом относительно
  // checkAsOf), просрочка в [minDays, maxDays] -- зеркало clientsAtRisk, но для прошлого,
  // не будущего. Для борда "Клиенты к продлению после окончания" (окно 0-90 дней).
  function clientsOverdue(model, checkAsOf, minDays, maxDays) {
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys || !c.currentEnd) return;
      if (c.currentEnd >= checkAsOf) return;
      var days = daysBetween(c.currentEnd, checkAsOf);
      if (days < minDays || days > maxDays) return;
      var overdueKassas = c.kassas.filter(function (k) { return k.overallEnd && k.overallEnd <= checkAsOf; });
      var kassaDetails = overdueKassas.map(function (k) { return { rnm: k.rnm, tariff: k.tariff, end: k.overallEnd }; });
      out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, kassaCount: c.kassas.length, kassasToRenew: overdueKassas.length, end: c.currentEnd, daysOverdue: days, kassaDetails: kassaDetails });
    });
    return out;
  }

  // Диапазонная версия для явного "от-до" (Дима, 2026-08-18) -- в отличие от clientsOverdue
  // (окно "N дней от сегодня", считает ВСЕ кассы клиента с датой окончания в прошлом, даже
  // многолетней давности), тут И отбор клиента, И "касс к продлению" целиком определяются
  // попаданием ДАТЫ ОКОНЧАНИЯ КАССЫ в [fromDate, toDate] -- старые кассы вне диапазона
  // (условный "2022 год") в счётчик не попадают вообще.
  function clientsOverdueInRange(model, checkAsOf, fromDate, toDate) {
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var inRange = c.kassas.filter(function (k) { return k.overallEnd && k.overallEnd >= fromDate && k.overallEnd <= toDate; });
      if (!inRange.length) return;
      var nearestEnd = inRange.reduce(function (min, k) { return (!min || k.overallEnd < min) ? k.overallEnd : min; }, null);
      var kassaDetails = inRange.map(function (k) { return { rnm: k.rnm, tariff: k.tariff, end: k.overallEnd }; });
      out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, kassaCount: c.kassas.length, kassasToRenew: inRange.length, end: nearestEnd, daysOverdue: daysBetween(nearestEnd, checkAsOf), kassaDetails: kassaDetails });
    });
    return out;
  }

  // Возвращённые клиенты (91 день - 3 года) за период, по дате возврата.
  function computeReturnedClients(model, periodStart, periodEnd) {
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var ri = clientReturnInfo(c);
      if (ri && ri.tag === "возвращённый" && inRange(ri.returnDate, periodStart, periodEnd)) {
        out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, days: ri.days, kassaCount: c.kassas.length, returnDate: ri.returnDate });
      }
    });
    return out;
  }

  // Помесячный счёт "возвращённых" (91д-3г, по дате возврата) — для вкладки "Возвращённые
  // клиенты" внутри "Прирост базы" (п.3.5, 2026-08-06). Отдельно от computeFlow.reanim
  // (тот — "вернувшиеся", 0-90 дней) и от computeReturnedClients (тот — плоский список).
  function computeReturnedByMonth(model, periodStart, periodEnd) {
    var months = buildMonthRange(periodStart, periodEnd);
    var countByMonth = months.map(function () { return 0; });
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var ri = clientReturnInfo(c);
      if (!ri || ri.tag !== "возвращённый" || !inRange(ri.returnDate, periodStart, periodEnd)) return;
      var i = monthIndexOf(months, ri.returnDate);
      if (i >= 0) countByMonth[i]++;
    });
    return { months: months, countByMonth: countByMonth };
  }

  function activeKassaCountOf(client, asOf) {
    return client.kassas.filter(function (k) { return !kassaLapsedAt(k, asOf); }).length;
  }

  // Раскрытие для вкладки "Новые клиенты" в "Прирост базы" — список тех, чьё первое
  // появление попало в конкретный месяц.
  function clientsNewInMonth(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys || !c.appearance) return;
      if (c.appearance.getFullYear() === y && c.appearance.getMonth() === m) {
        // первое появление -- "ухода" до этого момента не было по определению
        out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, activeKassas: activeKassaCountOf(c, asOf), arrivedAt: c.appearance, leftAt: null });
      }
    });
    return out;
  }

  // Раскрытие для вкладки "Возвращённые клиенты" в "Прирост базы" — список тех, чей
  // возврат (91д-3г) попал в конкретный месяц.
  function clientsReturnedInMonth(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var ri = clientReturnInfo(c);
      if (!ri || ri.tag !== "возвращённый") return;
      if (ri.returnDate.getFullYear() === y && ri.returnDate.getMonth() === m) {
        out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, activeKassas: activeKassaCountOf(c, asOf), arrivedAt: ri.returnDate, leftAt: ri.gapEnd });
      }
    });
    return out;
  }

  // Раскрытие для вкладки "Отток клиентов" в "Прирост базы" (2026-08-06) -- тот же
  // предикат, что и churnByMonth в computeChurnGradient (конец в этом месяце,
  // подтверждённый статус "churned"), иначе счётчик на графике и сумма строк таблицы
  // разойдутся. "Оставшихся активных касс" -- по определению отток клиента = отток ВСЕХ
  // его касс, так что тут всегда 0, но колонку выводим явно (запрошено Димой).
  function clientsChurnedInMonth(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var end = c.currentEnd;
      if (!end || end.getFullYear() !== y || end.getMonth() !== m) return;
      var daysSinceEnd = (asOf - end) / 86400000;
      if (daysSinceEnd <= CHURN_GRACE_DAYS) return;
      if (clientChurnStatus(c, asOf) !== "churned") return;
      out.push({ key: c.key, org: c.org, partner: c.partner, partnerInn: c.partnerInn, end: end, activeKassas: activeKassaCountOf(c, asOf) });
    });
    return out;
  }

  // Кассовые зеркала трёх функций выше — для вкладок Новые/Отток/Возвращённые в "Прирост
  // базы (кассы)" (зеркало п.3.5, 2026-08-06). Отток без раскрытия (как и у клиентов), тут
  // не нужен.
  function computeReturnedByMonthKassas(model, periodStart, periodEnd) {
    var months = buildMonthRange(periodStart, periodEnd);
    var countByMonth = months.map(function () { return 0; });
    model.kassas.forEach(function (k) {
      var ri = kassaReturnInfo(k);
      if (!ri || ri.tag !== "возвращённый" || !inRange(ri.returnDate, periodStart, periodEnd)) return;
      var i = monthIndexOf(months, ri.returnDate);
      if (i >= 0) countByMonth[i]++;
    });
    return { months: months, countByMonth: countByMonth };
  }

  function kassaRowFor(k, model) {
    var client = k.clientKey ? model.clients.get(k.clientKey) : null;
    return { rnm: k.rnm, clientKey: k.clientKey || "—", org: client ? client.org : null, partner: k.partner, partnerInn: k.partnerInn, tariff: k.tariff };
  }

  function kassasNewInMonth(model, monthDate) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    model.kassas.forEach(function (k) {
      if (!k.appearance) return;
      if (k.appearance.getFullYear() === y && k.appearance.getMonth() === m) {
        var row = kassaRowFor(k, model);
        row.arrivedAt = k.appearance; row.leftAt = null;
        out.push(row);
      }
    });
    return out;
  }

  function kassasReturnedInMonth(model, monthDate) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    model.kassas.forEach(function (k) {
      var ri = kassaReturnInfo(k);
      if (!ri || ri.tag !== "возвращённый") return;
      if (ri.returnDate.getFullYear() === y && ri.returnDate.getMonth() === m) {
        var row = kassaRowFor(k, model);
        row.arrivedAt = ri.returnDate; row.leftAt = ri.gapEnd;
        out.push(row);
      }
    });
    return out;
  }

  // Раскрытие для вкладки "Отток касс" в "Прирост базы (кассы)" (2026-08-06) -- тот же
  // предикат, что и churnByMonth в computeChurnGradient(..., true). "Оставшихся активных
  // касс" -- сколько ЕЩЁ действующих касс у клиента-владельца ПОСЛЕ оттока этой (клиент
  // мог не потерять всю базу целиком, в отличие от клиентского оттока).
  function kassasChurnedInMonth(model, monthDate, asOf) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];
    model.kassas.forEach(function (k) {
      var end = k.overallEnd;
      if (!end || end.getFullYear() !== y || end.getMonth() !== m) return;
      var daysSinceEnd = (asOf - end) / 86400000;
      if (daysSinceEnd <= CHURN_GRACE_DAYS) return;
      if (kassaChurnStatus(k, asOf) !== "churned") return;
      var row = kassaRowFor(k, model);
      var client = k.clientKey ? model.clients.get(k.clientKey) : null;
      row.end = end;
      row.activeKassas = client ? activeKassaCountOf(client, asOf) : 0;
      out.push(row);
    });
    return out;
  }

  function kassasAtRisk(model, asOf, deadlineFn, opts) {
    opts = opts || {};
    var strict = opts.strict !== false;
    var out = [];
    model.kassas.forEach(function (k) {
      var end = kassaDeadline(k, asOf, strict);
      if (end && deadlineFn(end)) {
        out.push({ rnm: k.rnm, partner: k.partner, renewals: k.renewals, tariff: k.tariff, end: end });
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

  function computePartners(model, asOf, opts) {
    opts = opts || {};
    var strict = opts.strict !== false;
    var byPartner = new Map();
    function bucket(name) {
      var p = byPartner.get(name);
      if (!p) { p = { name: name, clients: new Set(), kassas: 0, reserve: 0 }; byPartner.set(name, p); }
      return p;
    }
    // Касса не хранит "своего" партнёра для агрегации -- жёсткая связка есть только у
    // клиента и кассы (2026-08-07, разбор с Димой на конкретных строках выгрузки).
    // Партнёр -- это ктО СОПРОВОЖДАЕТ клиента, не кто когда-то провёл конкретную кассу.
    // Раньше касса считалась НЕЗАВИСИМО по собственному (историческому) полю k.partner --
    // если клиент со временем перешёл к другому партнёру (у него появилась более новая
    // касса через партнёра B), его старые, но всё ещё живые кассы через партнёра A
    // продолжали считаться за A, хотя сам клиент (и, значит, отношения с ним) целиком
    // числится за B. Результат -- у A "кассы есть, клиентов нет", что бизнес-логически
    // невозможно (пример: ООО «БЕСТСОФТ» 0 клиентов/1 касса, касса от ИНН 2621004033,
    // у которого более новая касса — через «ООО «Статус»»; проверено на реальных строках
    // выгрузки). Идём ОТ клиента: партнёр кассы = партнёр её текущего владельца-клиента.
    model.clients.forEach(function (c) {
      if (clientLapsedAt(c, asOf)) return;
      var b = bucket(c.partner || "—");
      b.clients.add(c.key);
      c.kassas.forEach(function (k) {
        if (isKassaAlive(k, asOf, strict)) b.kassas++;
      });
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
  function computePartnersByChannel(model, asOf, opts) {
    var partnerChannel = new Map();
    model.kassas.forEach(function (k) {
      var pn = k.partner || "—";
      if (!partnerChannel.has(pn)) partnerChannel.set(pn, k.channel);
    });
    model.reserveRows.forEach(function (r) {
      var pn = r.partner || "—";
      if (!partnerChannel.has(pn)) partnerChannel.set(pn, classifyChannel(r.partner, r.salesCenter));
    });
    return computePartners(model, asOf, opts).map(function (p) {
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
  function buildMonthRange(periodStart, periodEnd) {
    var months = [];
    var cursor = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    var end = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    while (cursor <= end) { months.push(new Date(cursor)); cursor = addMonths(cursor, 1); }
    return months;
  }
  // Месяц полностью "дозрел" (отток за него уже не может измениться), только когда с
  // ПОСЛЕДНЕГО дня месяца прошло 31+ день от as-of — иначе часть кодов месяца ещё в грейсе,
  // а часть уже нет, и смешивать их в одну цифру нечестно. Используется для пометки
  // "данные неполные" в помесячных таблицах (netgrowth, партнёрские борды).
  function monthResolved(monthDate, asOf) {
    var lastDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59);
    return asOf >= addDays(lastDay, REANIM_WINDOW_START_DAYS);
  }

  function monthIndexOf(months, date) {
    for (var i = 0; i < months.length; i++) {
      if (date.getFullYear() === months[i].getFullYear() && date.getMonth() === months[i].getMonth()) return i;
    }
    return -1;
  }

  function computeMonthlySeries(model, periodStart, periodEnd, asOf) {
    asOf = asOf || periodEnd;
    var months = buildMonthRange(periodStart, periodEnd);
    var newByMonth = months.map(function () { return 0; });
    var churnByMonth = months.map(function () { return 0; });

    model.clients.forEach(function (c) {
      if (inRange(c.appearance, periodStart, periodEnd)) {
        var i = monthIndexOf(months, c.appearance);
        if (i >= 0) newByMonth[i]++;
      }
      if (!c.phys && c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd) && clientChurnStatus(c, asOf) === "churned") {
        var j = monthIndexOf(months, c.currentEnd);
        if (j >= 0) churnByMonth[j]++;
      }
    });

    return { months: months, newByMonth: newByMonth, churnByMonth: churnByMonth };
  }

  // тот же ряд, но по кассам — для борда "Нетто-прирост базы (кассы)"
  function computeMonthlySeriesKassas(model, periodStart, periodEnd, asOf) {
    asOf = asOf || periodEnd;
    var months = buildMonthRange(periodStart, periodEnd);
    var newByMonth = months.map(function () { return 0; });
    var churnByMonth = months.map(function () { return 0; });

    model.kassas.forEach(function (k) {
      if (inRange(k.appearance, periodStart, periodEnd)) {
        var i = monthIndexOf(months, k.appearance);
        if (i >= 0) newByMonth[i]++;
      }
      if (k.overallEnd && inRange(k.overallEnd, periodStart, periodEnd) && kassaChurnStatus(k, asOf) === "churned") {
        var j = monthIndexOf(months, k.overallEnd);
        if (j >= 0) churnByMonth[j]++;
      }
    });

    return { months: months, newByMonth: newByMonth, churnByMonth: churnByMonth };
  }

  // 3 градации оттока по месяцам (п.3.1, 2026-08-06) для "Прирост базы":
  // - forecast (прогноз) -- дата окончания в будущем относительно asOf, просто счёт "сколько
  //   кодов заканчивается в этом месяце", без статуса (ещё не наступило)
  // - grace (не продлились) -- дата окончания уже прошла, 0-30 дней назад, и ПРЯМО СЕЙЧАС
  //   (as-of) всё ещё нет покрытия (не путать с "pending"-статусом churnStatus — pending
  //   формально держится весь грейс независимо от того, продлились уже или нет; grace здесь
  //   строго "ещё не продлились на данный момент")
  // - churned (факт. отток) -- подтверждённый отток (30/31 день), как и раньше
  function computeChurnGradient(model, periodStart, periodEnd, asOf, byKassa) {
    asOf = asOf || periodEnd;
    var months = buildMonthRange(periodStart, periodEnd);
    var newByMonth = months.map(function () { return 0; });
    var churnByMonth = months.map(function () { return 0; });
    var graceByMonth = months.map(function () { return 0; });
    var forecastByMonth = months.map(function () { return 0; });

    var coll = byKassa ? model.kassas : model.clients;
    coll.forEach(function (e) {
      if (!byKassa && e.phys) return;
      var appearance = e.appearance;
      var end = byKassa ? e.overallEnd : e.currentEnd;
      if (inRange(appearance, periodStart, periodEnd)) {
        var ni = monthIndexOf(months, appearance);
        if (ni >= 0) newByMonth[ni]++;
      }
      if (!end || !inRange(end, periodStart, periodEnd)) return;
      var mi = monthIndexOf(months, end);
      if (mi < 0) return;
      var daysSinceEnd = (asOf - end) / 86400000;
      if (daysSinceEnd < 0) {
        forecastByMonth[mi]++;
      } else if (daysSinceEnd <= CHURN_GRACE_DAYS) {
        var stillLapsed = byKassa ? kassaLapsedAt(e, asOf) : clientLapsedAt(e, asOf);
        if (stillLapsed) graceByMonth[mi]++;
      } else {
        var status = byKassa ? kassaChurnStatus(e, asOf) : clientChurnStatus(e, asOf);
        if (status === "churned") churnByMonth[mi]++;
      }
    });

    return { months: months, newByMonth: newByMonth, churnByMonth: churnByMonth, graceByMonth: graceByMonth, forecastByMonth: forecastByMonth };
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

  // Калькулятор потенциальной выручки (B5) -- сколько касс должно продлиться в периоде
  // у клиентов заданного набора партнёров ("канал продаж"). Партнёр -- партнёр КЛИЕНТА-
  // владельца (c.partner), та же логика, что в computePartners (см. её комментарий) --
  // не собственное поле кассы. Весь потенциал периода, БЕЗ вычета уже случившегося оттока --
  // % оттока закладывает сам пользователь калькулятора как отдельную ручную поправку
  // (см. tmp/plans/2026-08-19-revenue-calculator.md).
  function computeRevenueForecastKassas(model, partnerSet, periodStart, periodEnd) {
    var count = 0;
    model.clients.forEach(function (c) {
      if (!partnerSet.has(c.partner || "—")) return;
      c.kassas.forEach(function (k) {
        if (inRange(k.overallEnd, periodStart, periodEnd)) count++;
      });
    });
    return count;
  }

  var api = {
    buildModel: buildModel,
    computeFlow: computeFlow,
    computeSnapshot: computeSnapshot,
    computeActiveSnapshot: computeActiveSnapshot,
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
    computeMonthlySeriesKassas: computeMonthlySeriesKassas,
    computeChurnGradient: computeChurnGradient,
    computeReturnedByMonth: computeReturnedByMonth,
    clientsNewInMonth: clientsNewInMonth,
    clientsReturnedInMonth: clientsReturnedInMonth,
    clientsChurnedInMonth: clientsChurnedInMonth,
    computeReturnedByMonthKassas: computeReturnedByMonthKassas,
    kassasNewInMonth: kassasNewInMonth,
    kassasReturnedInMonth: kassasReturnedInMonth,
    kassasChurnedInMonth: kassasChurnedInMonth,
    computeFunnel: computeFunnel,
    kassaChurnStatus: kassaChurnStatus,
    clientChurnStatus: clientChurnStatus,
    clientsOverdue: clientsOverdue,
    clientsOverdueInRange: clientsOverdueInRange,
    computeReturnedClients: computeReturnedClients,
    clientReturnInfo: clientReturnInfo,
    kassaReturnInfo: kassaReturnInfo,
    computePartnerFlow: computePartnerFlow,
    computePartnerFlowKassas: computePartnerFlowKassas,
    monthResolved: monthResolved,
    computeRevokedInPeriod: computeRevokedInPeriod,
    computeReserveShare: computeReserveShare,
    computeRevenueForecastKassas: computeRevenueForecastKassas,
    classifyChannel: classifyChannel,
    isKassaAlive: isKassaAlive,
    kassaDeadline: kassaDeadline,
    individualEnd: individualEnd,
    addMonths: addMonths,
    addDays: addDays,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OFDMetrics = api;
})(typeof window !== "undefined" ? window : globalThis);
