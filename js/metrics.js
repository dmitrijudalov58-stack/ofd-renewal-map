/*
 * Ядро расчётов "Карты продлений ОФД".
 * Чистые функции без DOM — работает и в браузере (<script src>), и в Node (require) для тестов.
 * Формулы соответствуют утверждённой спеке (00 / B1-B4).
 */
(function (root) {
  "use strict";

  // Лариса Пенигина -- ФИКСИРОВАННЫЙ список организаций поля "Партнёр" (Дима, 2026-09-02),
  // заменил прежнюю привязку по "Центр продаж" (LARISA_CENTERS) целиком -- сверено с
  // реальной выгрузкой, все 11 строк точно совпадают со значениями "Партнёр" (0 совпадений
  // с "Центр продаж"), так что матчим теперь тот же параметр partner, что и Ольга Зибер.
  var LARISA_PARTNERS = new Set([
    'Представительство АО "Калуга Астрал" в г. Волгоград',
    'Представительство АО "Калуга Астрал" в г. Воронеж, (Партнер)',
    "ОП АСТРАЛ-СОФТ г. Екатеринбург",
    'АО "Калуга Астрал" Партнер',
    "Представительство АО Калуга Астрал в г. Краснодар",
    'Представительство АО "Калуга Астрал" в г. Новосибирске',
    'Представительство АО "Калуга Астрал" в г. Омск',
    'Представительство АО "Калуга Астрал" в г. Омск (АстралОтчет)',
    'Представительство АО "Калуга Астрал" в г. Саратов П',
    'Представительство ООО "АСТРАЛ-СОФТ" в г. Санкт-Петербург',
    'Представительство АО "Калуга Астрал" в г. Уфа',
  ]);
  // Ольга Зибер -- та же смена архитектуры, что у Ларисы (Дима, 2026-09-02): раньше был
  // substring-паттерн ("ЛК ОФД"/"ОПС ЭДО"/"ОППС ЭДО" где угодно в partner), теперь точный
  // список из 6 значений. Дима присылал список голосом -- 3 фрагмента ("Ингосстрах", "ЮКБ",
  // "Консультант-Сервис"/"КонсСерв АО") не нашлись НИ В ОДНОМ из 6 проверенных экспортов
  // (2017-2026, 3322 уникальных значения "Партнёр") -- подтверждены им как пояснения
  // голосового ввода, не отдельные организации, в список не входят.
  var OLYA_PARTNERS = new Set([
    'АО "Калуга Астрал" (ЛК ОФД)',
    'ООО "Астрал-Софт" ОПС ЭДО',
    'ООО "Астрал-Софт" ОППС ЭДО',
    "ООО \"Астрал-Софт\" ОКС М",
    'ООО «Астрал-Софт" ОПС (КонсультантС)',
    'ООО "Псков.Ком"',
  ]);

  function classifyChannel(partner) {
    if (OLYA_PARTNERS.has(partner || "")) return "Ольга Зибер";
    if (LARISA_PARTNERS.has(partner || "")) return "Лариса Пенигина";
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
        phone: last.phone,
        email: last.email,
        channel: classifyChannel(last.partner),
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
      if (!p) { p = { name: name, newClients: 0, churnedClients: 0, pendingClients: 0, baseAtStart: 0, baseAtEnd: 0 }; byPartner.set(name, p); }
      return p;
    }
    model.clients.forEach(function (c) {
      if (c.phys) return;
      var name = c.partner || "—";
      if (inRange(c.appearance, periodStart, periodEnd)) bucket(name).newClients++;
      if (c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd) && clientChurnStatus(c, asOf) === "churned") {
        bucket(name).churnedClients++;
      }
      // "0-30 дней" (Дима, 2026-08-20) -- клиент уже не продлился, но ещё в грейс-периоде,
      // подтверждённым оттоком НЕ считается (churnStatusFromEnd отдаёт "pending" ровно для
      // этого окна). Отдельная метрика от churnedClients -- одно и то же currentEnd не
      // может одновременно попасть в оба счётчика (статусы взаимоисключающие).
      if (c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd) && clientChurnStatus(c, asOf) === "pending") {
        bucket(name).pendingClients++;
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
      rows.push({ name: p.name, newClients: p.newClients, churnedClients: p.churnedClients, pendingClients: p.pendingClients, baseAtStart: p.baseAtStart, baseAtEnd: p.baseAtEnd, retention: retention });
    });
    return rows;
  }

  // То же самое, но по кассам (РНМ) вместо клиентов (ИНН) — для борда "Партнёр: новые/
  // отток/% эффективности" (сместили фокус с клиентов на кассы 2026-08-06).
  // Drill-down для "Топ оттока по партнёрам" (Дима, 2026-08-20): клик по партнёру -> кассы
  // ЕГО клиентов с датой окончания в конкретном месяце (обычно текущем). year/month -- как
  // у Date (month 0-11). Партнёр кассы = партнёр её клиента-владельца (c.partner), та же
  // логика, что и в computePartnerFlow/computePartners.
  function computePartnerKassasInMonth(model, partnerName, year, month) {
    var out = [];
    model.clients.forEach(function (c) {
      if ((c.partner || "—") !== partnerName) return;
      c.kassas.forEach(function (k) {
        if (!k.overallEnd) return;
        if (k.overallEnd.getFullYear() === year && k.overallEnd.getMonth() === month) {
          out.push({ rnm: k.rnm, inn: c.key, org: c.org, tariff: k.tariff, overallEnd: k.overallEnd });
        }
      });
    });
    return out;
  }

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

  // Плоский список клиентов в грейсе 0-30 дней (уже не продлились, но подтверждённым
  // оттоком ещё не считаются) за период, по ВСЕМ партнёрам без ограничения -- для кнопки
  // "скачать разбивку" на "Топ оттока по партнёрам" (в отличие от основной таблицы борда,
  // где топ-100). Та же логика pending, что и computePartnerFlow (числа должны сходиться).
  function computePendingClientsList(model, periodStart, periodEnd, asOf) {
    asOf = asOf || periodEnd;
    var out = [];
    model.clients.forEach(function (c) {
      if (c.phys) return;
      if (c.currentEnd && inRange(c.currentEnd, periodStart, periodEnd) && clientChurnStatus(c, asOf) === "pending") {
        out.push({ partner: c.partner || "—", key: c.key, org: c.org || "" });
      }
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

  // Все реальные значения "Центр продаж", встречающиеся в данных (кассы + резерв) --
  // источник для UI-фильтра "по ЦП" на бордах каналов (Дима+Оксана, 2026-09-02): канал
  // Ларисы состоит из прямых продаж (Партнёр совпадает с её офисом, точный список
  // LARISA_PARTNERS) И "партнёров ОП" -- агентов, у которых ЦП совпадает с её офисом, но
  // Партнёр другой (непрямые продажи). Чтобы отделить одних от других в UI, нужен прямой
  // доступ к значениям salesCenter, не только partner.
  function allSalesCentersSorted(model) {
    var set = new Set();
    model.kassas.forEach(function (k) { if (k.salesCenter) set.add(k.salesCenter); });
    model.reserveRows.forEach(function (r) { if (r.salesCenter) set.add(r.salesCenter); });
    var arr = Array.from(set);
    arr.sort();
    return arr;
  }

  // Все РАЗНЫЕ значения "Партнёр", у которых есть хотя бы одна касса или резервная строка с
  // ЦП из centersSet -- кандидаты для массового назначения канала по ЦП. НЕ фильтруется по
  // активности (в отличие от computePartners) -- цель списка -- классификация партнёра, не
  // расчёт текущей выручки; давно неактивный партнёр всё равно должен попасть в правильный
  // канал ДО того, как у него появится новое продление, иначе оно улетит в catch-all.
  function partnersBySalesCenters(model, centersSet) {
    var names = new Set();
    model.kassas.forEach(function (k) {
      if (k.salesCenter && centersSet.has(k.salesCenter)) names.add(k.partner || "—");
    });
    model.reserveRows.forEach(function (r) {
      if (r.salesCenter && centersSet.has(r.salesCenter)) names.add(r.partner || "—");
    });
    return Array.from(names).sort();
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
      if (!partnerChannel.has(pn)) partnerChannel.set(pn, classifyChannel(r.partner));
    });
    return computePartners(model, asOf, opts).map(function (p) {
      return { name: p.name, channel: partnerChannel.get(p.name) || classifyChannel(p.name), clients: p.clients, kassas: p.kassas, reserve: p.reserve };
    });
  }

  function computeChannels(model, asOf) {
    var out = { "Ольга Зибер": 0, "Лариса Пенигина": 0, "Партнёры": 0 };
    model.clients.forEach(function (c) {
      if (c.phys || clientLapsedAt(c, asOf)) return;
      var ch = classifyChannel(c.kassas[c.kassas.length - 1].partner);
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

  // Каналы продаж — калькулятор выручки (B5). Партнёр -- партнёр КЛИЕНТА-владельца
  // (c.partner), та же логика, что в computePartners (см. её комментарий) -- не
  // собственное поле кассы. computeChannelForecastKassas -- весь потенциал периода
  // (кассы канала, у которых дата окончания попадает в период), БЕЗ вычета уже
  // случившегося оттока -- % оттока закладывает сам пользователь как ручную поправку.
  // Возвращает массив (не просто count) -- виджету нужна разбивка по тарифам.
  function computeChannelForecastKassas(model, partnerSet, periodStart, periodEnd) {
    var out = [];
    model.clients.forEach(function (c) {
      if (!partnerSet.has(c.partner || "—")) return;
      c.kassas.forEach(function (k) {
        if (inRange(k.overallEnd, periodStart, periodEnd)) out.push({ rnm: k.rnm, tariff: k.tariff, overallEnd: k.overallEnd, clientKey: c.key });
      });
    });
    return out;
  }


  // ---------- «Календарь продлений» + «Переток тарифов» (2026-08-31, ТЗ tmp/plans/2026-08-31-renewal-calendar-tz.md) ----------
  //
  // Тарифные срезы календаря — изначально были ограничены 13/15/36 мес (короткие тарифы
  // считались нерепрезентативными). Дима отменил это ограничение 2026-09-01: список
  // тарифов теперь ДИНАМИЧЕСКИЙ, считается из реальных данных выгрузки (allTariffsSorted),
  // общий для Календаря и для "Переток → по месяцам" — держать два списка вручную в
  // синхроне было бы источником рассинхрона (см. HISTORY.md).
  var CALENDAR_FORECAST_MONTHS = 36; // перекрывает самый длинный обычный тариф

  // Все РЕАЛЬНО встречающиеся тарифы (по кодам "Зарегистрировано"), по убыванию
  // длительности: 36, 15, 13, ..., 1 (Дима: "чёткий список — 36, потом 15, потом 13, так
  // далее до первого месяца"). Считается один раз на рендер и передаётся в
  // computeRenewalCalendar/computeTariffTransitionsMonthly через opts.tariffs, чтобы не
  // пересчитывать по 5 раз за один рендер борда.
  function allTariffsSorted(model) {
    var set = new Set();
    model.kassas.forEach(function (k) {
      k.codes.forEach(function (c) {
        var t = parseTariffMonths(c.tariff);
        if (t != null) set.add(t);
      });
    });
    var arr = Array.from(set);
    arr.sort(function (a, b) { return b - a; });
    return arr;
  }

  // Один код кассы -> до 3 "событий" в его жизни (см. ТЗ §1.1):
  // - "new" -- ТОЛЬКО у самого первого кода кассы (дата прихода, ось = created/activated,
  //   НЕ связана с истечением чего-либо -- отдельная метрика, тот же паттерн, что вкладки
  //   Новые/Отток в "Прирост базы").
  // - "renewedFirst"/"renewedRepeat" -- у ВСЕХ кодов, кроме последнего: раз есть следующий
  //   код в цепочке, это заведомо продление, без грейса/статуса. i===0 -- первое продление
  //   кассы вообще, i>0 -- повторное.
  // - у ПОСЛЕДНЕГО кода -- "forecast" (конец в будущем), либо "churn"/"pending" через ту же
  //   churnStatusFromEnd/kassaLapsedAt, что и everywhere в проекте (30/31 день). "safe"
  //   структурно недостижим тут (последний код кассы не может быть покрыт ничем ПОСЛЕ
  //   своего конца -- иначе он не был бы последним), но на случай неучтённого края данных
  //   трактуем его как повторное продление, не роняем событие молча.
  function collectKassaEvents(k, asOf) {
    var events = [];
    var codes = k.codes;
    if (!codes.length) return events;
    events.push({ type: "new", tariff: parseTariffMonths(codes[0].tariff), tariffLabel: codes[0].tariff, date: k.appearance });
    for (var i = 0; i < codes.length - 1; i++) {
      var end = individualEnd(codes[i]);
      if (!end) continue;
      events.push({
        type: i === 0 ? "renewedFirst" : "renewedRepeat",
        tariff: parseTariffMonths(codes[i].tariff), tariffLabel: codes[i].tariff, date: end,
      });
    }
    // ПОСЛЕДНИЙ код -- дата берётся из k.overallEnd ("Общая дата окончания"), НЕ
    // individualEnd(last). Это тот же самый источник, что kassaChurnStatus/kassaDeadline/
    // computeChurnGradient используют ВЕЗДЕ в проекте для "когда заканчивается покрытие
    // этой кассы прямо сейчас" -- individualEnd(last) читает "Дата окончания" КОНКРЕТНОГО
    // кода, которая на 12 из 25800 касс реальной выгрузки (2026-09-01) заметно отличается
    // от overallEnd (разъезжается на месяцы вперёд) -- Дима поймал по расхождению чисел
    // между Календарём и "Прирост базы" (тот всегда считает по overallEnd). Для НЕ-последних
    // кодов individualEnd(codes[i]) остаётся верным источником -- там это дата, когда
    // конкретно ЭТОТ код закончился и потребовал продления, overallEnd тут ни при чём.
    var last = codes[codes.length - 1];
    var lastEnd = k.overallEnd || individualEnd(last);
    if (lastEnd) {
      var lastTariff = parseTariffMonths(last.tariff);
      if (lastEnd > asOf) {
        events.push({ type: "forecast", tariff: lastTariff, tariffLabel: last.tariff, date: lastEnd });
      } else {
        var status = churnStatusFromEnd(lastEnd, asOf, function (d) { return kassaLapsedAt(k, d); });
        var type = status === "churned" ? "churn" : status === "pending" ? "pending" : "renewedRepeat";
        events.push({ type: type, tariff: lastTariff, tariffLabel: last.tariff, date: lastEnd });
      }
    }
    return events;
  }

  // Клиент -- НЕ то же самое, что "продублировать логику кассы с дедупом по (тип,тариф,
  // месяц)": отток/грейс должны отражать судьбу КЛИЕНТА ЦЕЛИКОМ, не отдельной его кассы
  // (Дима, 2026-09-02: "может быть несколько касс, по одной грейс/неопределённость, по
  // другим всё хорошо -- учитывать это в статистике было бы ошибкой"). Поэтому:
  // - "новые" -- по самой ранней кассе клиента (её первый код), однозначно.
  // - "продлилось" (впервые/повторно) -- по-прежнему по КАЖДОЙ кассе клиента, дедуп по
  //   (тип,тариф,месяц) -- это реальные, НЕпротиворечивые события конкретной кассы.
  // - "отток"/"прогноз" -- на уровне ВСЕГО клиента: clientChurnStatus/client.currentEnd,
  //   та же формула клиентского оттока, что и everywhere в проекте (отток клиента = отток
  //   ВСЕХ его касс), НЕ по отдельной кассе.
  // - "грейс" -- НЕ считается для клиента вообще: если clientChurnStatus вернул "pending",
  //   событие просто не создаётся (грейса у клиента как понятия нет -- см. обоснование
  //   Димы выше).
  function collectClientEvents(c, asOf) {
    var events = [];
    if (c.phys || !c.kassas.length) return events;

    var earliest = c.kassas.reduce(function (a, b) { return b.appearance < a.appearance ? b : a; });
    var firstCode = earliest.codes[0];
    events.push({ type: "new", tariff: parseTariffMonths(firstCode.tariff), tariffLabel: firstCode.tariff, date: c.appearance });

    var seen = new Set();
    c.kassas.forEach(function (k) {
      collectKassaEvents(k, asOf).forEach(function (ev) {
        if (ev.type !== "renewedFirst" && ev.type !== "renewedRepeat") return;
        var key = ev.type + "|" + ev.tariff + "|" + (ev.date ? ev.date.getFullYear() + "-" + ev.date.getMonth() : "no-date");
        if (seen.has(key)) return;
        seen.add(key);
        events.push(ev);
      });
    });

    if (c.currentEnd) {
      var endKassa = c.kassas.filter(function (k) { return k.overallEnd && k.overallEnd.getTime() === c.currentEnd.getTime(); })[0];
      var last = endKassa ? endKassa.codes[endKassa.codes.length - 1] : null;
      var tariff = last ? parseTariffMonths(last.tariff) : null;
      if (tariff != null) {
        if (c.currentEnd > asOf) {
          events.push({ type: "forecast", tariff: tariff, tariffLabel: last.tariff, date: c.currentEnd });
        } else {
          var status = clientChurnStatus(c, asOf);
          if (status === "churned") events.push({ type: "churn", tariff: tariff, tariffLabel: last.tariff, date: c.currentEnd });
          // status === "pending" -- грейса у клиента нет, событие не создаём
        }
      }
    }
    return events;
  }

  // С самой ранней даты в файле (появление кассы/резерва) до +forecastMonths от asOf.
  function calendarMonthRange(model, asOf, forecastMonths) {
    var minDate = null;
    model.kassas.forEach(function (k) { if (k.appearance && (!minDate || k.appearance < minDate)) minDate = k.appearance; });
    model.reserveRows.forEach(function (r) { if (r.created instanceof Date && (!minDate || r.created < minDate)) minDate = r.created; });
    if (!minDate) minDate = asOf;
    var start = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    var end = addMonths(new Date(asOf.getFullYear(), asOf.getMonth(), 1), forecastMonths || 0);
    return buildMonthRange(start, end);
  }

  function emptyCalendarCounts() { return { new: 0, renewedFirst: 0, renewedRepeat: 0, churn: 0, pending: 0, forecast: 0 }; }

  function makeCalendarBuckets(months, tariffs) {
    var b = {};
    tariffs.concat(["total"]).forEach(function (t) {
      b[t] = months.map(function () { return emptyCalendarCounts(); });
    });
    return b;
  }

  function addEventToBuckets(buckets, months, ev) {
    if (!buckets[ev.tariff]) return; // защита -- тариф события не попал в переданный tariffs (не должно случаться)
    var idx = monthIndexOf(months, ev.date);
    if (idx < 0) return;
    buckets[ev.tariff][idx][ev.type] += 1;
    buckets.total[idx][ev.type] += 1;
  }

  // opts: { unit: "kassa"|"client" (default kassa), forecastMonths, tariffs (иначе
  // allTariffsSorted(model)), onlyActive }. Юнит "клиент" -- события собираются со ВСЕХ
  // касс клиента, но дедуплицируются по (тип, тариф, месяц) -- 2 кассы одного клиента,
  // продлившиеся в один месяц на один тариф, считаются ОДНИМ клиентским событием, не двумя
  // (иначе тумблер РНМ/ИНН ничего бы не менял).
  // onlyActive (Дима, 2026-09-01) -- считать только касс/клиентов, кто ЖИВ СЕЙЧАС (as-of),
  // применяется ко ВСЕЙ истории (не только к текущему месяцу) -- та же семантика, что уже
  // на "Перетоке": "продлилось в январе 2020" под onlyActive покажет только тех, кто из
  // этой когорты дожил до сегодня.
  function computeRenewalCalendar(model, asOf, opts) {
    opts = opts || {};
    var forecastMonths = opts.forecastMonths || CALENDAR_FORECAST_MONTHS;
    var unit = opts.unit === "client" ? "client" : "kassa";
    var tariffs = opts.tariffs || allTariffsSorted(model);
    var onlyActive = !!opts.onlyActive;
    var months = calendarMonthRange(model, asOf, forecastMonths);
    var buckets = makeCalendarBuckets(months, tariffs);

    // onlyActive гейтит ТОЛЬКО "новые"/"продлилось" -- "выживаемость" осмысленна именно
    // там. Отток/грейс/прогноз НЕ гейтятся: касса/клиент в оттоке или грейсе по
    // определению "не жива(а) сейчас" (kassaLapsedAt/clientLapsedAt = true) -- фильтр по
    // "жива сейчас" тогда выкидывал бы СОБСТВЕННОЕ событие оттока целиком, и отток/грейс
    // под "только действующие" обнулялся бы структурно, а не потому что их правда нет
    // (Дима, 2026-09-02: "почему в перетоке отсутствует грейс период при переключении на
    // действующих" / "формулы должны быть аналогичные Приросту базы" -- у того тоже нет
    // такого фильтра на отток, значит и здесь он не должен ничего фильтровать).
    function isSurvivalGated(type) { return type === "new" || type === "renewedFirst" || type === "renewedRepeat"; }

    if (unit === "kassa") {
      model.kassas.forEach(function (k) {
        var alive = !kassaLapsedAt(k, asOf);
        collectKassaEvents(k, asOf).forEach(function (ev) {
          if (onlyActive && !alive && isSurvivalGated(ev.type)) return;
          addEventToBuckets(buckets, months, ev);
        });
      });
    } else {
      model.clients.forEach(function (c) {
        if (c.phys) return;
        var alive = !clientLapsedAt(c, asOf);
        collectClientEvents(c, asOf).forEach(function (ev) {
          if (onlyActive && !alive && isSurvivalGated(ev.type)) return;
          addEventToBuckets(buckets, months, ev);
        });
      });
    }
    return { months: months, buckets: buckets, unit: unit, tariffs: tariffs };
  }

  // Раскрытие по клику на сегмент "Календаря продлений" -- список клиентов/касс за
  // конкретный (месяц, тариф, тип события). tariffMonths -- число (13/15/36), не строка.
  function renewalCalendarDrill(model, asOf, monthDate, tariffMonths, type, unit, onlyActive) {
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var out = [];

    // Клиент + отток/прогноз -- на уровне ЦЕЛОГО клиента (clientChurnStatus/currentEnd),
    // та же формула, что теперь строит buckets (см. collectClientEvents) -- НЕ по кассам.
    // Грейса у клиента нет вообще (Дима, 2026-09-02) -- список всегда пуст.
    if (unit === "client" && (type === "churn" || type === "forecast")) {
      model.clients.forEach(function (c) {
        if (c.phys || !c.currentEnd) return;
        if (c.currentEnd.getFullYear() !== y || c.currentEnd.getMonth() !== m) return;
        var isForecast = c.currentEnd > asOf;
        if (type === "forecast" && !isForecast) return;
        if (type === "churn" && (isForecast || clientChurnStatus(c, asOf) !== "churned")) return;
        var endKassa = c.kassas.filter(function (k) { return k.overallEnd && k.overallEnd.getTime() === c.currentEnd.getTime(); })[0];
        var last = endKassa ? endKassa.codes[endKassa.codes.length - 1] : null;
        if (!last || parseTariffMonths(last.tariff) !== tariffMonths) return;
        out.push({
          inn: c.key, org: c.org, rnm: null, activeKassas: activeKassaCountOf(c, asOf),
          tariff: last.tariff, end: c.currentEnd, partnerInn: c.partnerInn, partner: c.partner,
        });
      });
      return out;
    }
    if (unit === "client" && type === "pending") return out; // грейса у клиента нет

    // onlyActive гейтит только "новые"/"продлилось" (см. комментарий в computeRenewalCalendar
    // выше -- отток/грейс/прогноз не фильтруются, у кассы/клиента в них "жива(а) сейчас"
    // тавтологически false).
    var survivalGated = onlyActive && (type === "new" || type === "renewedFirst" || type === "renewedRepeat");
    var seenClients = new Set();
    model.kassas.forEach(function (k) {
      if (survivalGated && unit !== "client" && kassaLapsedAt(k, asOf)) return;
      var events = collectKassaEvents(k, asOf);
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.tariff !== tariffMonths || ev.type !== type) continue;
        if (!ev.date || ev.date.getFullYear() !== y || ev.date.getMonth() !== m) continue;
        var client = k.clientKey ? model.clients.get(k.clientKey) : null;
        if (unit === "client") {
          if (!client || seenClients.has(client.key)) break;
          if (survivalGated && clientLapsedAt(client, asOf)) break;
          seenClients.add(client.key);
          out.push({
            inn: client.key, org: client.org, rnm: null,
            activeKassas: activeKassaCountOf(client, asOf),
            tariff: ev.tariffLabel, end: ev.date,
            partnerInn: client.partnerInn, partner: client.partner,
          });
        } else {
          out.push({
            inn: k.clientKey || "—", org: client ? client.org : null, rnm: k.rnm,
            tariff: ev.tariffLabel, end: ev.date,
            partnerInn: k.partnerInn, partner: k.partner,
          });
        }
        break; // у одной кассы не может быть двух событий одного типа/тарифа в одном месяце
      }
    });
    return out;
  }

  // ---------- переток тарифов (Борд 2) ----------
  //
  // Переход = смена тарифа между ДВУМЯ ПОСЛЕДОВАТЕЛЬНЫМИ кодами ОДНОЙ КАССЫ, по хронологии
  // активации. Разрыв (грейс/отток+возврат) не выделяется отдельно -- любой переход
  // считается одинаково (согласовано с Димой, фаза 2).
  //
  // Юнит "клиент" -- НЕ мердж кодов разных касс клиента в одну искусственную цепочку
  // (пробовали, сломалось: у клиента с несколькими параллельными кассами это создаёт
  // переходы МЕЖДУ НЕСВЯЗАННЫМИ кодами разных касс просто по совпадению соседства по
  // дате -- на реальном файле давало числа в разы больше кассового юнита, что физически
  // невозможно, поймано сверкой 2026-08-31). Вместо этого: переход всегда считается на
  // уровне СВОЕЙ кассы (как и в юните "касса"), а на юнит "клиент" переходим ДЕДУПОМ --
  // если у клиента 2 кассы дали одинаковый переход (тариф X -> тариф Y) в одном месяце,
  // это ОДНО клиентское событие, не два (тот же принцип, что уже в computeRenewalCalendar).
  function kassaTransitionEvents(k) {
    var events = [];
    var codes = k.codes;
    for (var i = 0; i < codes.length - 1; i++) {
      var fromT = parseTariffMonths(codes[i].tariff);
      var toT = parseTariffMonths(codes[i + 1].tariff);
      if (fromT == null || toT == null) continue;
      events.push({ from: fromT, to: toT, fromLabel: codes[i].tariff, toLabel: codes[i + 1].tariff, end: individualEnd(codes[i]) });
    }
    return events;
  }

  // Все реальные тарифы выгрузки участвуют (не только 13/15/36) -- переток НЕ ограничен
  // календарными тарифами, короткие тарифы нужны как точки назначения.
  // onlyActive (Дима, 2026-09-01) -- считать переходы ТОЛЬКО у касс/клиентов, кто СЕЙЧАС
  // (asOf) жив: kassaLapsedAt/clientLapsedAt на момент asOf. Не путать с грейсом/pending у
  // конкретного КОДА (см. tariffConversionFate ниже) -- тут про "жив ли владелец целиком
  // прямо сейчас", применяется и к агрегату, и к помесячной разбивке, и к drill.
  function computeTariffTransitions(model, unit, asOf, onlyActive) {
    var agg = new Map(); // "from|to" -> count
    function bump(fromT, toT) {
      var key = fromT + "|" + toT;
      agg.set(key, (agg.get(key) || 0) + 1);
    }
    if (unit === "client") {
      model.clients.forEach(function (c) {
        if (c.phys) return;
        if (onlyActive && clientLapsedAt(c, asOf)) return;
        var seen = new Set();
        c.kassas.forEach(function (k) {
          kassaTransitionEvents(k).forEach(function (ev) {
            // Дедуп-ключ ОБЯЗАН включать месяц, не только (from,to) -- иначе клиент с
            // ПОВТОРЯЮЩИМСЯ переходом (например 13->13 каждый год подряд с 2017-го) считался
            // бы 1 раз за ВЕСЬ период вместо каждого фактического повторения: агрегат тогда
            // расходится с суммой помесячной разбивки (`computeTariffTransitionsMonthly`,
            // та дедуплицирует по (from,to,месяц) правильно) и выглядит так, будто ранних лет
            // почти нет данных -- один в целом произвольный (по порядку перебора касс) экземпляр
            // "съедал" все остальные (найдено Димой, 2026-09-01: "нет информации с 2017 года").
            var end = ev.end;
            var monthKey = end ? end.getFullYear() + "-" + end.getMonth() : "no-date";
            var key = ev.from + "|" + ev.to + "|" + monthKey;
            if (seen.has(key)) return;
            seen.add(key);
            bump(ev.from, ev.to);
          });
        });
      });
    } else {
      model.kassas.forEach(function (k) {
        if (onlyActive && kassaLapsedAt(k, asOf)) return;
        kassaTransitionEvents(k).forEach(function (ev) { bump(ev.from, ev.to); });
      });
    }
    var rows = [];
    agg.forEach(function (count, key) {
      var parts = key.split("|");
      rows.push({ from: parseInt(parts[0], 10), to: parseInt(parts[1], 10), count: count });
    });
    return rows;
  }

  // Разбивка перетока по месяцам -- источник из tariffs (по умолчанию allTariffsSorted,
  // синхронно с Бордом 1), назначение -- любой тариф. Месяц -- дата окончания ИСХОДНОГО кода (та же
  // ось, что и когорта "должны продлиться" в Борде 1 -- сумма столбца тут = "продлилось"
  // там). Диапазон месяцев -- ТОТ ЖЕ горизонт, что у календаря (не обрезан по asOf), хотя
  // переход по смыслу "уже случился" (codes[i+1] существует) -- на реальных данных дата
  // ОКОНЧАНИЯ исходного кода иногда оказывается позже asOf (нашли на выгрузке 2026-08-31:
  // тариф 13 мес, начатый в марте, официально кончается в мае следующего года, хотя
  // следующий код на кассе появился почти сразу — аномалия исходных данных, не баг). Без
  // запаса такие события тихо терялись (idx=-1) -- проект держит "событие = месяц ДАТЫ
  // ОКОНЧАНИЯ" как сквозной инвариант (см. HISTORY.md), подрезать его для этого виджета
  // нельзя -- расширяем диапазон, а не меняем ось.
  function computeTariffTransitionsMonthly(model, asOf, unit, onlyActive, tariffs) {
    tariffs = tariffs || allTariffsSorted(model);
    var months = calendarMonthRange(model, asOf, CALENDAR_FORECAST_MONTHS);
    var bySource = {};
    tariffs.forEach(function (t) { bySource[t] = months.map(function () { return {}; }); });
    function bump(fromT, toT, idx) {
      if (!bySource[fromT] || idx < 0) return;
      var bucket = bySource[fromT][idx];
      bucket[toT] = (bucket[toT] || 0) + 1;
    }
    if (unit === "client") {
      model.clients.forEach(function (c) {
        if (c.phys) return;
        if (onlyActive && clientLapsedAt(c, asOf)) return;
        var seen = new Set();
        c.kassas.forEach(function (k) {
          kassaTransitionEvents(k).forEach(function (ev) {
            var idx = monthIndexOf(months, ev.end);
            var key = ev.from + "|" + ev.to + "|" + idx;
            if (seen.has(key)) return;
            seen.add(key);
            bump(ev.from, ev.to, idx);
          });
        });
      });
    } else {
      model.kassas.forEach(function (k) {
        if (onlyActive && kassaLapsedAt(k, asOf)) return;
        kassaTransitionEvents(k).forEach(function (ev) { bump(ev.from, ev.to, monthIndexOf(months, ev.end)); });
      });
    }
    return { months: months, bySource: bySource };
  }

  // Раскрытие по клику на полосу Sankey (monthDate=null -- вся история) или сегмент
  // месячного столбца (monthDate задан). Юнит "клиент" -- 1 строка на клиента (дедуп, тот
  // же критерий, что и в агрегатах выше), не по строке на каждую кассу.
  function tariffTransitionDrill(model, asOf, unit, fromT, toT, monthDate, onlyActive) {
    var out = [];
    function matches(ev) {
      if (ev.from !== fromT || ev.to !== toT) return false;
      if (!monthDate) return true;
      return ev.end && ev.end.getFullYear() === monthDate.getFullYear() && ev.end.getMonth() === monthDate.getMonth();
    }
    if (unit === "client") {
      model.clients.forEach(function (c) {
        if (c.phys) return;
        if (onlyActive && clientLapsedAt(c, asOf)) return;
        var hit = null;
        for (var i = 0; i < c.kassas.length && !hit; i++) {
          var evs = kassaTransitionEvents(c.kassas[i]);
          for (var j = 0; j < evs.length; j++) { if (matches(evs[j])) { hit = evs[j]; break; } }
        }
        if (!hit) return;
        out.push({
          inn: c.key, org: c.org, rnm: null, activeKassas: activeKassaCountOf(c, asOf),
          tariffFrom: hit.fromLabel, tariffTo: hit.toLabel, end: hit.end,
          partnerInn: c.partnerInn, partner: c.partner,
        });
      });
    } else {
      model.kassas.forEach(function (k) {
        if (onlyActive && kassaLapsedAt(k, asOf)) return;
        var evs = kassaTransitionEvents(k);
        for (var i = 0; i < evs.length; i++) {
          if (!matches(evs[i])) continue;
          var client = k.clientKey ? model.clients.get(k.clientKey) : null;
          out.push({
            inn: k.clientKey || "—", org: client ? client.org : null, rnm: k.rnm,
            tariffFrom: evs[i].fromLabel, tariffTo: evs[i].toLabel, end: evs[i].end,
            partnerInn: k.partnerInn, partner: k.partner,
          });
        }
      });
    }
    return out;
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
    clientLapsedAt: clientLapsedAt,
    clientsOverdue: clientsOverdue,
    clientsOverdueInRange: clientsOverdueInRange,
    computeReturnedClients: computeReturnedClients,
    clientReturnInfo: clientReturnInfo,
    kassaReturnInfo: kassaReturnInfo,
    computePartnerFlow: computePartnerFlow,
    computePartnerFlowKassas: computePartnerFlowKassas,
    computePendingClientsList: computePendingClientsList,
    computePartnerKassasInMonth: computePartnerKassasInMonth,
    monthResolved: monthResolved,
    computeRevokedInPeriod: computeRevokedInPeriod,
    computeReserveShare: computeReserveShare,
    computeChannelForecastKassas: computeChannelForecastKassas,
    computeRenewalCalendar: computeRenewalCalendar,
    renewalCalendarDrill: renewalCalendarDrill,
    computeTariffTransitions: computeTariffTransitions,
    computeTariffTransitionsMonthly: computeTariffTransitionsMonthly,
    tariffTransitionDrill: tariffTransitionDrill,
    allTariffsSorted: allTariffsSorted,
    allSalesCentersSorted: allSalesCentersSorted,
    partnersBySalesCenters: partnersBySalesCenters,
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
