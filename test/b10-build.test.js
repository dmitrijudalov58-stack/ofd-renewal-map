// Синтетические тесты сборки B10. Запуск: TZ=Europe/Moscow node test/b10-build.test.js
"use strict";
const { t36, ipAgg, lifeClients, lastContact, activeList, candExtra } = require("../scripts/portrait-extra.js");
const M = require("../js/metrics.js");
const { t36Stats } = require("../js/portrait-util.js");
const XLSX = require("xlsx");

let n = 0, fail = 0;
function ok(cond, msg) {
  n++;
  if (!cond) fail++;
  console.log((cond ? "✓ " : "✗ ") + msg);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const snapshot = (act) => JSON.stringify(act.map((a) => ({ inn: a.inn, n: a.n, tariffs: a.ak.map((k) => k.tariff) })));
function client(inn, count, count36, rest = "1 месяц") {
  return { inn, c: {}, n: count, ak: Array.from({ length: count }, (_, i) => ({ tariff: i < count36 ? "36 месяцев" : rest })) };
}
function mkRow(overrides = {}) {
  const row = {
    pin: "9999-PIN-1", rnm: "9999-RNM-1", innOrg: "9999000001", innPhys: null,
    org: "Вымышленный клиент 9999", status: "Зарегистрировано", tariff: "12 месяцев",
    created: "2025-01-01T00:00:00", activated: "2025-01-01T00:00:00",
    endDate: "2027-01-01T00:00:00", overallEnd: "2027-01-01T00:00:00",
    partner: "Вымышленный партнёр 9999", partnerInn: "9999000099", salesCenter: "Вымышленный ЦП 9999",
    activationType: "", salesType: null, phone: null, email: null, ...overrides
  };
  for (const field of ["created", "activated", "endDate", "overallEnd"]) {
    if (typeof row[field] === "string") row[field] = new Date(row[field]);
  }
  return row;
}
function context(meta, okved, names) {
  return {
    seg: (count) => count >= 10 ? "A" : count >= 6 ? "B" : count >= 2 ? "C" : "D",
    formOf: (inn) => meta[inn][0], alive: (inn) => meta[inn][1],
    grpOf: (inn) => meta[inn][2], clsOf: (inn) => meta[inn][3],
    rcOf: (inn) => meta[inn][4], regName: (rc) => names[rc] || null,
    bizB: (inn) => meta[inn][5], okved
  };
}
function invariants(s, label) {
  ok(s.K <= s.M && s.M <= s.kassas, label + ": K ≤ M ≤ kassas");
  ok(s.clients36 <= s.clients && s.clients36 <= s.K, label + ": clients36 ≤ clients и K");
}

// S2: t36/ipAgg
{
  const act = [
    client("a1", 10, 2), client("a2", 12, 0, "13 месяцев"), client("a3", 11, 11),
    client("b1", 6, 1), client("b2", 9, 0, ""), client("b3", 7, 3), client("b4", 8, 0, null),
    client("c1", 2, 1, null), client("c2", 5, 0, "13 месяцев"), client("c3", 3, 2), client("c4", 4, 4),
    client("d1", 1, 1), client("d2", 1, 0, ""), client("d3", 1, 0, null), client("d4", 1, 1), client("d5", 1, 0)
  ];
  // Поля: форма, статус, группа, раздел, регион, возраст.
  const meta = {
    a1: ["ИП", 1, "47.11", "47", "77", "<1 г"], a2: ["ЮЛ", 1, "47.11", "47", "77", "<1 г"],
    a3: ["ИП", 0, "47.11", "47", "78", "1–3 г"], b1: ["ИП", 1, "56.10", "56", "77", "3–7 г"],
    b2: ["ИП", 2, "00.00", "old", "16", "7+ лет"], b3: ["ЮЛ", 1, null, null, "16", null],
    b4: [null, 1, null, null, "16", null], c1: ["ИП", 1, null, null, "78", null],
    c2: ["ИП", 3, "56.10", "56", "16", "<1 г"], c3: ["ЮЛ", 0, "10.10", "10", "77", "7+ лет"],
    c4: ["ИП", 0, "10.10", "10", "29", "7+ лет"], d1: ["ИП", 1, "10.10", "10", "29", "1–3 г"],
    d2: ["ИП", 2, "99.99", "99", "76", "3–7 г"], d3: ["ЮЛ", 1, null, null, "77", null],
    d4: ["ИП", 3, "00.00", "old", "71", null], d5: ["ИП", 0, null, null, "00", null]
  };
  const ctx = context(meta, { "47.11": "Торговля", "56.10": "Питание", "10.10": "Производство" },
    { "77": "Москва", "78": "Санкт-Петербург", "16": "Казань", "29": "Архангельск", "76": "Ярославль", "71": "Тула" });
  const before = snapshot(act), result = t36(act, ctx);
  // Вручную: A: K=2+11, касс=10+12+11, M=10+11; B: K=1+3, касс=6+9+7+8, M=6+7.
  // C: K=1+2+4, касс=2+5+3+4, M=2+3+4; D: K=1+1, касс=5, M=1+1.
  const expected = {
    A: { K: 13, kassas: 33, clients: 3, clients36: 2, M: 21 },
    B: { K: 4, kassas: 30, clients: 4, clients36: 2, M: 13 },
    C: { K: 7, kassas: 14, clients: 4, clients36: 3, M: 9 },
    D: { K: 2, kassas: 5, clients: 5, clients36: 2, M: 2 }
  };
  ok(same(Object.keys(result), ["A", "B", "C", "D"]), "все четыре сегмента");
  for (const seg of Object.keys(expected)) {
    for (const field of Object.keys(expected[seg])) ok(result[seg][field] === expected[seg][field], seg + ": " + field);
    invariants(result[seg], seg);
  }
  ok(result.D.K === result.D.clients36 && result.D.K === result.D.M, "D: K = clients36 = M");
  ok(same(t36Stats(result.A), { kassas: 13 / 33, clients: 2 / 3, coverage: 13 / 21, numerator: 13, growth: 8 }), "прямой вход t36Stats");

  const ip = ipAgg(act, ctx);
  ok(ip.clients === 11 && ip.kassas === 51, "ИП: 11 клиентов, 51 касса; ЮЛ и неизвестная форма исключены");
  ok(ip.liq === 4, "ИП: только статус 1 считается ликвидацией");
  // ИП: K=13+1+5+2=21, M=21+6+6+2=35, клиентов с 36 мес.=2+1+2+2=7.
  ok(same(ip.t36, { K: 21, kassas: 51, clients: 11, clients36: 7, M: 35 }), "ИП: все пять тарифных сумм");
  invariants(ip.t36, "ИП");
  ok(same(ip.grp, [["10.10", "Производство", 2, 1], ["47.11", "Торговля", 2, 1], ["56.10", "Питание", 2, 1], ["99.99", null, 1, 0]]), "ИП: группы, имена, ликвидация и порядок при равенстве");
  ok(ip.grp.length <= 10, "ИП: не более 10 групп");
  ok(ip.old === 2 && ip.noOkved === 2, "ИП: старых кодов 2, без ОКВЭД 2");
  ok(same(ip.region, [["Архангельск", 2], ["Казань", 2], ["Москва", 2], ["Санкт-Петербург", 2], ["Тула", 1]]), "ИП: регионы по численности и алфавиту, пустой регион пропущен");
  ok(ip.region.length <= 5, "ИП: не более 5 регионов");
  ok(same(ip.bizAge, [["<1 г", 2, 1], ["1–3 г", 2, 1], ["3–7 г", 2, 1], ["7+ лет", 2, 0]]), "ИП: четыре возрастные полосы, порядок и ликвидация");
  ok(snapshot(act) === before, "исходные ИНН, n и тарифы не изменены");

  const zero = { K: 0, kassas: 0, clients: 0, clients36: 0, M: 0 };
  const subsets = [[], act.filter((a) => a.n === 1), act.filter((a) => a.inn === "a2")];
  for (const [i, subset] of subsets.entries()) {
    const saved = snapshot(subset), s = t36(subset, ctx), p = ipAgg(subset, ctx);
    for (const seg of Object.keys(s)) invariants(s[seg], "набор " + i + "/" + seg);
    invariants(p.t36, "набор " + i + "/ИП");
    ok(s.D.K === s.D.clients36 && s.D.K === s.D.M, "набор " + i + ": равенства D");
    ok(snapshot(subset) === saved, "набор " + i + ": без мутаций");
  }
  ok(Object.values(t36([], ctx)).every((s) => same(s, zero)), "пустой вход: все сегменты нулевые");
  ok(same(t36([act[11]], ctx).A, zero), "непустой вход: пустой сегмент нулевой");
  const emptyIP = { clients: 0, kassas: 0, liq: 0, t36: zero, grp: [], old: 0, noOkved: 0, region: [],
    bizAge: [["<1 г", 0, 0], ["1–3 г", 0, 0], ["3–7 г", 0, 0], ["7+ лет", 0, 0]] };
  ok(same(ipAgg([], ctx), emptyIP), "пустой вход: полный нулевой агрегат ИП");
  ok(same(ipAgg([act[1], act[6]], ctx), emptyIP), "вход без ИП: полный нулевой агрегат");

  const manyMeta = {}, names = {}, codes = [], many = [];
  for (let i = 12; i >= 1; i--) {
    const code = String(i).padStart(2, "0") + ".01", inn = "top" + i;
    codes.unshift(code);
    names[i] = "Регион " + String(i).padStart(2, "0");
    manyMeta[inn] = ["ИП", 0, code, code.slice(0, 2), i, null];
    many.push(client(inn, 1, 0, "13 месяцев"));
  }
  const manyBefore = snapshot(many), topCtx = context(manyMeta, {}, names);
  const top = ipAgg(many, topCtx);
  ok(top.grp.length === 10 && same(top.grp.map((r) => r[0]), codes.slice(0, 10)), "12 групп: ровно первые 10 по коду");
  ok(top.region.length === 5 && same(top.region.map((r) => r[0]), [names[1], names[2], names[3], names[4], names[5]]), "12 регионов: ровно первые 5 по имени");
  ok(same(ipAgg(many.slice().reverse(), topCtx), top), "топы не зависят от порядка входа");
  ok(top.t36.K === 0 && top.t36.M === 0 && top.t36.clients36 === 0, "13 месяцев не учитываются как 36");
  invariants(top.t36, "12 ИП без 36 мес.");
  ok(snapshot(many) === manyBefore, "топы: исходный вход не изменён");
}

// S3: lifeClients
{
  const asOf = new Date("2026-10-21T12:00:00");
  const corp = { partner: 'ООО "АТОЛ" (ОФД)' };
  const olya = { partner: 'АО "Калуга Астрал" (ЛК ОФД)' };
  const office = "Вымышленный офис 9999 в г. Омск";
  const direct = { partner: office, salesCenter: office + " ЦП" };
  const op = { partner: "Вымышленный агент 9999", salesCenter: office + " ЦП" };
  const rows = [];
  function put(inn, count, channel, dates) {
    for (let i = 0; i < count; i++) {
      const id = rows.length + 1;
      rows.push(mkRow({ innOrg: inn, rnm: "9999-RNM-" + id, pin: "9999-PIN-" + id, ...channel, ...dates }));
    }
  }
  // Две действующие из десяти касс: сегмент C, а не A по всей истории.
  put("9999000001", 2, corp, {});
  put("9999000001", 8, corp, { endDate: "2025-06-01T00:00:00" });
  // Три кассы ушли более 18 месяцев назад: здесь всё равно сегмент C.
  put("9999000002", 3, olya, { activated: "2024-01-01T00:00:00", endDate: "2025-01-01T00:00:00" });
  put("9999000003", 1, direct, { activated: "2026-02-01T00:00:00" });
  put("9999000003", 5, direct, { activated: "2026-02-01T00:00:00", endDate: "2026-03-01T00:00:00" });
  // Обратный порядок касс; разрыв в 2021 году входит в срок.
  put("9999000004", 1, op, { activated: "2022-01-01T00:00:00", endDate: "2022-12-31T00:00:00" });
  put("9999000004", 1, op, { activated: "2020-01-01T00:00:00", endDate: "2020-12-31T00:00:00" });
  // Последняя в массиве касса относится к партнёрам, хотя появилась раньше корпоративной.
  put("9999000005", 1, corp, { activated: "2028-01-01T00:00:00", endDate: "2029-01-01T00:00:00" });
  put("9999000005", 1, {}, { activated: "2026-01-01T00:00:00" });
  put("9999000006", 1, {}, { activated: "2028-01-01T00:00:00", endDate: "2029-01-01T00:00:00" });
  // individualEnd не может восстановить конец без endDate и числового тарифа.
  put("9999000007", 1, {}, { endDate: null, overallEnd: null, tariff: null });
  put("9999000008", 1, {}, { endDate: "2025-01-01T00:00:00" });
  put("9999000009", 1, {}, { activated: asOf });
  const meta = {
    "9999000001": ["ИП", 1], "9999000002": ["ЮЛ", 1], "9999000003": ["ИП", 0],
    "9999000004": [null, 2], "9999000005": ["ИП", 3], "9999000006": ["ИП", 1],
    "9999000007": ["ИП", 1], "9999000008": ["ЮЛ", 1], "9999000009": ["ЮЛ", 1]
  };
  const ctx = context(meta, {}, {}), model = M.buildModel(rows);
  const modelSnapshot = (m) => JSON.stringify(m, (key, value) => value instanceof Map ? [...value] : value);
  const before = modelSnapshot(model), result = lifeClients(model, asOf, ctx);
  const one = (inn) => lifeClients({ clients: new Map([[inn, model.clients.get(inn)]]) }, asOf, ctx);
  const daysSince = (start) => (asOf - new Date(start)) / 86400000;
  const months = (days) => +(days / 30.4375).toFixed(1);
  const activeDays = daysSince("2025-01-01T00:00:00"), singleDays = daysSince("2026-02-01T00:00:00");
  const clippedDays = daysSince("2026-01-01T00:00:00");

  ok(one("9999000001").seg.C.clients === 1 && one("9999000001").seg.A.clients === 0, "S3: две действующие из десяти касс → C");
  ok(one("9999000002").seg.C.clients === 1, "S3: три давно ушедшие кассы → C по всей истории");
  ok(one("9999000003").seg.D.clients === 1 && one("9999000003").seg.B.clients === 0, "S3: одна действующая из шести касс → D");
  ok(same(one("9999000004").seg.C, { clients: 1, days: 1095, months: months(1095), liq: 0 }), "S3: два интервала дают span 1095 дней, включая перерыв");
  ok(one("9999000005").seg.D.days === Math.round(clippedDays), "S3: будущий конец обрезан до asOf, отдельный будущий интервал отброшен");
  ok(one("9999000005").seg.D.months === months(clippedDays), "S3: месяцы рассчитаны по точному сроку с долей дня");
  for (const inn of ["9999000006", "9999000007", "9999000008", "9999000009"]) {
    ok(Object.values(one(inn).seg).every((s) => s.clients === 0), "S3: нет положительного конечного покрытия у " + inn);
  }
  ok(result.chan.length === 5 && same(result.chan.map((r) => r.label), M.CHANNELS), "S3: ровно пять каналов в фиксированном порядке");
  for (const [i, inn] of ["9999000001", "9999000002", "9999000003", "9999000004", "9999000005"].entries()) {
    ok(M.clientChannel(model.clients.get(inn)) === M.CHANNELS[i] && result.chan[i].clients === 1, "S3: классификация и один клиент канала «" + M.CHANNELS[i] + "»");
  }
  ok(model.clients.get("9999000005").kassas[0].channel === "Корп" && one("9999000005").chan[4].clients === 1, "S3: канал по последней кассе массива, независимо от даты появления");
  const cMean = (activeDays + 366 + 1095) / 3, dMean = (singleDays + clippedDays) / 2;
  ok(same(result.seg.C, { clients: 3, days: Math.round(cMean), months: months(cMean), liq: 2 }), "S3: C — среднее по клиентам, округление и две ликвидации");
  ok(same(result.seg.D, { clients: 2, days: Math.round(dMean), months: months(dMean), liq: 0 }), "S3: D — среднее по клиентам; статусы 0 и 3 не ликвидация");
  const baseCount = Object.values(result.seg).reduce((sum, s) => sum + s.clients, 0);
  ok(baseCount === 5 && result.chan.reduce((sum, ch) => sum + ch.clients, 0) === baseCount, "S3: сегменты = каналы = пять клиентов базы");
  const expectedMonths = [activeDays, 366, singleDays, 1095, clippedDays].map(months);
  ok(same(result.chan.map((ch) => ch.months), expectedMonths), "S3: срок в месяцах во всех пяти каналах");
  ok(same(result.chan.map((ch) => ch.liq), [1, 1, 0, 0, 0]), "S3: ликвидации по каналам, статус 2 не ликвидация");
  ok(same(result.ip, { clients: 3, months: months((activeDays + singleDays + clippedDays) / 3), liq: 1 }), "S3: ИП — только форма ИП в базе, средний срок и ликвидации");
  const activeByChannel = M.computeChannels5(model, asOf).byChannel;
  for (const ch of M.CHANNELS) {
    ok(result.chanActive[ch] === activeByChannel[ch], "S3: chanActive совпадает с computeChannels5 — «" + ch + "»");
  }
  ok(same(result.chanActive, activeByChannel), "S3: chanActive совпадает целиком, включая набор ключей");
  const open = model.clients.get("9999000007");
  ok(M.isKassaAlive(open.kassas[0], asOf, true) && M.clientCoverage(open).length === 0, "S3: модель допускает действующую кассу без конечного покрытия");
  ok(one("9999000007").chanActive["Партнёры"] === 1 && one("9999000007").ip.clients === 0, "S3: открытый интервал входит в chanActive, но не в базу срока");
  ok(result.chanActive["Партнёры"] === 3, "S3: действующие партнёры включают открытый интервал и начало ровно в asOf");
  const zeroSeg = { clients: 0, days: 0, months: 0, liq: 0 }, zero = { clients: 0, months: 0, liq: 0 };
  ok(same(result.seg.A, zeroSeg) && same(result.seg.B, zeroSeg), "S3: пустые A и B содержат все нули");
  const empty = lifeClients(M.buildModel([]), asOf, ctx);
  ok(Object.values(empty.seg).every((s) => same(s, zeroSeg)), "S3: пустая модель — нулевые сегменты");
  ok(same(empty.chan, M.CHANNELS.map((label) => ({ label, ...zero }))), "S3: пустая модель — все пять нулевых каналов");
  ok(same(empty.ip, zero) && Object.values(empty.chanActive).every((v) => v === 0), "S3: пустая модель — ИП и действующие каналы нулевые");
  ok(same(one("9999000002").ip, zero), "S3: группа без ИП — все нули, включая months");

  const edgeModel = M.buildModel([
    mkRow({ innOrg: "9999000010", activated: null }),
    mkRow({ innOrg: "9999000011", rnm: "9999-RNM-2", endDate: "2024-01-01T00:00:00" })
  ]);
  const edge = lifeClients(edgeModel, asOf, ctx);
  ok(Object.values(edge.seg).every((s) => same(s, zeroSeg)), "S3: отсутствующее начало и отрицательный срок исключены");
  // phys появляется только в legacy-модели из резервной строки без зарегистрированной кассы.
  const physModel = M.buildModel([mkRow({ status: "Новый", innOrg: null, innPhys: "9999000012", rnm: null })], { strict: false });
  ok(physModel.clients.get("9999000012").phys && same(lifeClients(physModel, asOf, ctx), empty), "S3: phys исключён из всех агрегатов");
  // buildModel выдаёт только пять каналов; имитируем внешний неизвестный канал на отдельной модели.
  const unknownModel = M.buildModel([mkRow()]);
  unknownModel.clients.get("9999000001").kassas[0].channel = "Неизвестный канал 9999";
  const unknownBefore = modelSnapshot(unknownModel), unknown = lifeClients(unknownModel, asOf, ctx);
  ok(unknown.chan.length === 5 && unknown.chan[4].clients === 1 && unknown.chan[0].clients === 0, "S3: неизвестный канал срока отнесён к партнёрам");
  ok(unknown.chanActive["Неизвестный канал 9999"] === 1 && same(unknown.chanActive, M.computeChannels5(unknownModel, asOf).byChannel), "S3: chanActive сохраняет неизвестный ключ как computeChannels5");
  ok(modelSnapshot(model) === before && modelSnapshot(unknownModel) === unknownBefore, "S3: модель целиком, кассы, интервалы и их порядок не изменены");
  ok(model.clients.size === 9 && model.kassas.size === rows.length && model.clients.get("9999000001").kassas.length === 10, "S3: число клиентов и касс сохранено");
}

// S4: activeList / candExtra / lastContact
{
  const modelSnapshot = (m) => JSON.stringify(m, (key, value) => value instanceof Map ? [...value] : value);
  function modelOf(rows) {
    return M.buildModel(rows.map((row, i) => mkRow({ rnm: "9999-S4-RNM-" + i, pin: "9999-S4-PIN-" + i, ...row })));
  }
  const contactModel = modelOf([
    { activated: "2025-06-01T14:25:00", phone: "", email: "fresh@example.invalid" },
    { activated: "2025-01-01T00:00:00", phone: "+7-000-000-00-01", email: "old@example.invalid" },
    { activated: null, phone: "+7-000-000-00-99", email: "undated@example.invalid" }
  ]);
  const contactClient = contactModel.clients.get("9999000001"), contactBefore = modelSnapshot(contactModel);
  ok(same(lastContact(contactClient), { ph: "+7-000-000-00-01", em: "fresh@example.invalid" }), "S4: телефон из раннего кода, email из самого свежего");
  ok(same(lastContact(modelOf([{}]).clients.get("9999000001")), { ph: "", em: "" }), "S4: нет контактов → пустые строки");
  ok(same(lastContact({ kassas: [] }), { ph: "", em: "" }), "S4: нет касс → пустые контакты");
  ok(same(lastContact({ kassas: [{ codes: contactClient.kassas.map((k) => k.codes[0]) }] }), lastContact(contactClient)), "S4: поиск контактов внутри одной кассы");
  ok(modelSnapshot(contactModel) === contactBefore, "S4: поиск контактов не меняет модель и порядок кодов");

  const asOf = new Date("2026-01-01T12:00:00");
  const model = modelOf([
    { tariff: "13 месяцев", phone: "+7-000-000-00-01" },
    { tariff: "36 месяцев", activated: "2025-06-01T14:25:00", email: "fresh@example.invalid" },
    { tariff: "99 месяцев", activated: "2024-01-01T00:00:00", endDate: "2024-03-01T00:00:00" },
    { tariff: "120 месяцев", activated: "2028-01-01T00:00:00", endDate: "2029-01-01T00:00:00" },
    { innOrg: "9999000002", tariff: "Без срока" },
    { innOrg: "9999000003", tariff: null },
    { innOrg: "9999000004", tariff: "1 месяц" }
  ]);
  const meta = {
    "9999000001": ["ИП", 1, "47.11", "47", "77"],
    "9999000002": ["ЮЛ", 2, "00.00", "old", "78"],
    "9999000003": [null, 3, null, null, "77"],
    "9999000004": ["ЮЛ", 0, "47.11", "47", "78"]
  };
  const ctx = { ...context(meta, { "47.11": "Торговля", "47": "Раздел торговли" },{ "77": "Москва", "78": "Санкт-Петербург" }),
    asOf, orgOf: (inn, c) => c.kassas[0].org + " " + inn,
    kppOf: () => "999901001", bizYears: (inn) => inn === "9999000001" ? 7.34 : null };
  const act = [...model.clients].map(([inn, c]) => {
    const ak = c.kassas.filter((k) => M.isKassaAlive(k, asOf, true));
    return { inn, c, ak, n: ak.length };
  });
  const before = modelSnapshot(model), actBefore = JSON.stringify(act);
  const result = activeList(act, ctx, false), full = activeList(act, ctx, true);
  const [ip, corp, unknown, other] = result.rows;
  ok(same(result.cols, ["name", "inn", "kpp", "form", "reg", "grp", "kassas", "tenure", "bizAge10", "maxTariff", "phone", "email", "liq"]), "S4: точный порядок 13 колонок");
  ok(result.rows.length === act.length && result.rows.every((r) => r.length === 13), "S4: число строк = act.length, каждая содержит 13 элементов");
  ok(same(result.rows.map((r) => r[1]), act.map((a) => a.inn)), "S4: порядок клиентов сохранён");
  ok(ip[0] === ctx.orgOf(act[0].inn, act[0].c), "S4: наименование из orgOf с клиентом");
  ok(result.contacts === false && result.rows.every((r) => r[10] === "" && r[11] === ""), "S4: без флага все контакты пусты");
  ok(full.contacts === true && full.rows[0][10] === "+7-000-000-00-01" && full.rows[0][11] === "fresh@example.invalid", "S4: с флагом заполнены оба контакта");
  ok(full.rows.every((r) => r.length === 13) && full.rows[1][10] === "" && full.rows[1][11] === "", "S4: с флагом сохраняется схема и пустые контакты");
  ok(ip[2] === "" && ip[3] === 0, "S4: ИП — форма 0 и пустой КПП даже при значении в ctx");
  ok(corp[2] === "999901001" && corp[3] === 1, "S4: ЮЛ — форма 1 и КПП");
  ok(unknown[3] === -1, "S4: неизвестная форма → −1");
  ok(same(result.grps[unknown[5]], ["", "", ""]), "S4: без ОКВЭД — три пустые строки");
  ok(same(result.grps[corp[5]], ["00.00", "", "old"]), "S4: код вне справочника сохраняет cls old");
  ok(same(result.grps[ip[5]], ["47.11", "Торговля", "47"]), "S4: группа с названием и буквальным cls");
  ok(ip[5] === other[5] && result.grps.length === 3, "S4: справочник групп без дубликатов");
  ok(same(result.regs, [["77", "Москва"], ["78", "Санкт-Петербург"]]), "S4: регионы без дубликатов в порядке первого появления");
  ok(ip[4] === unknown[4] && corp[4] === other[4], "S4: индексы повторяющихся регионов совпадают");
  ok(same(result.rows.map((r) => r[6]), act.map((a) => a.n)) && ip[6] === 2, "S4: kassas = n действующих касс");
  ok(ip[9] === 36, "S4: максимум тарифа только действующих касс, без 99 и 120 месяцев");
  ok(corp[9] === -1 && unknown[9] === -1, "S4: нечисловые и отсутствующие тарифы → −1");
  ok(other[9] === 1, "S4: тариф одной действующей кассы");
  // 60 дней старого покрытия + 365,5 дней текущего; перекрытия и перерыв не суммируются.
  ok(ip[7] === Math.round((60 + 365.5) / 30.4375), "S4: tenure — сумма объединённого покрытия с обрезкой asOf и без будущего");
  ok(ip[8] === 73 && corp[8] === -1, "S4: возраст 7,34 → 73; null → −1");
  ok(same(result.rows.map((r) => r[12]), [1, 0, 0, 0]), "S4: только alive === 1 даёт liq = 1");
  ok(same(result.secs, [["47", "Раздел торговли"]]), "S4: secs — только реальные разделы с названием из справочника, без old и пустого");
  ok(same(activeList([], ctx, false), { cols: result.cols, regs: [], grps: [], secs: [], contacts: false, rows: [] }), "S4: пустой список действующих");
  ok(modelSnapshot(model) === before && JSON.stringify(act) === actBefore, "S4: activeList не меняет модель, act и порядок массивов");
  const emptyCoverage = { inn: "9999000003", c: { kassas: [{ intervals: [], codes: [] }] }, ak: [], n: 0 };
  ok(activeList([emptyCoverage], ctx, false).rows[0][7] === 0, "S4: нет конечного покрытия → tenure 0");

  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([[45688]]);
  ws.A1.z = "dd.mm.yyyy";
  XLSX.utils.book_append_sheet(wb, ws, "dates");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const sheetDate = XLSX.read(buf, { cellDates: true }).Sheets.dates.A1.v;
  const sheetModel = modelOf([{ endDate: sheetDate, overallEnd: sheetDate, tariff: "13 месяцев" },
    { endDate: sheetDate, overallEnd: sheetDate, tariff: "36 месяцев" }]);
  const sheetClient = sheetModel.clients.get("9999000001");
  ok(sheetDate instanceof Date && sheetClient.currentEnd === sheetDate, "S4: XLSX-цикл даёт Date для overallEnd/currentEnd модели");
  ok(candExtra(sheetClient)[0] === "2025-01-31", "S4: конец из XLSX под Москвой → 2025-01-31");
  ok(candExtra(sheetClient)[1] === 36, "S4: один конец двух касс — максимум из 13 и 36 месяцев");

  function gone(rows) {
    const c = modelOf(rows.map((row) => ({ activated: "2023-01-01T00:00:00",
      endDate: "2026-01-31T00:00:00", overallEnd: "2026-01-31T00:00:00", ...row }))).clients.get("9999000001");
    return { inn: c.key, c, n: c.kassas.length };
  }
  const three = gone([{}, {}, {}]);
  ok(candExtra(three.c)[2] === 3, "S4: три кассы одновременно в последние 18 месяцев → 3");
  const two = gone([{}, {}, { endDate: "2024-05-31T00:00:00", overallEnd: "2024-05-31T00:00:00" }]);
  const twoBefore = JSON.stringify(two), twoExtra = candExtra(two.c);
  ok(twoExtra[2] === 2, "S4: третья касса закончилась за 20 месяцев до ухода → 2");
  const r4 = two.n;
  ok(r4 === 3 && twoExtra[2] === 2 && r4 !== twoExtra[2], "S4: r4 хранит все 3 кассы, kass18 — только 2");
  ok(same(twoExtra, ["2026-01-31", 12, 2]), "S4 (11): L = конец последнего интервала — прежний candExtra(item.c) из buildModel");
  ok(JSON.stringify(two) === twoBefore, "S4: candExtra не меняет исходный элемент chu и его модель");
  const replacement = gone([
    { endDate: "2025-08-31T00:00:00", overallEnd: "2025-08-31T00:00:00" },
    { activated: "2025-08-31T14:25:00" }
  ]);
  ok(candExtra(replacement.c)[2] === 1, "S4: смена касс в один день за 5 месяцев до ухода → 1, не 2");
  ok(candExtra(gone([{}]).c)[2] === 1, "S4: одна касса → 1");
  ok(candExtra(gone([{ tariff: "Без срока" }]).c)[1] === null, "S4: последний тариф без числа → null");
  const earlierTariff = gone([{ tariff: "Без срока" }, { tariff: "36 месяцев", overallEnd: "2026-01-30T00:00:00" }]);
  ok(candExtra(earlierTariff.c)[1] === null, "S4: числовой тариф кассы с другим концом не подходит");
  const differentTimes = gone([{ tariff: "13 месяцев", overallEnd: "2026-01-31T01:00:00" }, { tariff: "36 месяцев" }]);
  ok(candExtra(differentTimes.c)[1] === 36, "S4: последний тариф сравнивает сутки, а не точное время");
  const lateStart = gone([{}, { activated: "2026-01-30T14:25:00" }]);
  ok(candExtra(lateStart.c)[2] === 2, "S4: активация 14:25 остаётся в своих сутках и даёт максимум 2");
  const overlap = gone([{}, { rnm: "9999-S4-RNM-0", activated: "2025-01-01T00:00:00" }]);
  ok(candExtra(overlap.c)[2] === 1, "S4: перекрывающиеся коды одной кассы считаются один раз");
  const afterWindow = gone([{}, { activated: "2026-02-01T00:00:00", endDate: "2026-03-01T00:00:00" }]);
  ok(candExtra(afterWindow.c)[2] === 1, "S4: начало после D не входит в моменты проверки");
  const onEnd = gone([{}, { activated: "2026-01-31T14:25:00" }]);
  ok(candExtra(onEnd.c)[2] === 1, "S4: начало в D при конце в D не создаёт покрытие");
  const onWindow = gone([{}, { endDate: "2024-07-31T00:00:00", overallEnd: "2024-07-31T00:00:00" },
    { activated: "2024-07-31T14:25:00" }]);
  ok(candExtra(onWindow.c)[2] === 2, "S4: W0 включено, конец в W0 исключён, начало в W0 включено");
  const clamped = gone([{ activated: "2024-09-29T00:00:00", endDate: "2024-10-01T00:00:00", overallEnd: "2026-03-31T00:00:00" }]);
  ok(candExtra(clamped.c)[2] === 1, "S4: окно от 31 марта за 18 месяцев начинается 30 сентября");
  for (const intervals of [[], [{ start: null, end: new Date("2026-01-31T00:00:00") }],
    [{ start: new Date("2025-01-01T00:00:00"), end: null }]]) {
    const c = { currentEnd: new Date("2026-01-31T00:00:00"), kassas: [{ intervals }] };
    ok(candExtra(c)[2] === null, "S4: нет полных интервалов → kass18 null");
  }
  const outside = gone([{ endDate: "2024-01-01T00:00:00" }]);
  ok(candExtra(outside.c)[2] === 1, "S4: нулевое покрытие основного окна → запасной якорь даёт 1");
  const anomalousOne = gone([{ activated: "2018-04-26T00:00:00", endDate: "2019-06-10T00:00:00",
    overallEnd: "2024-06-14T00:00:00" }]);
  const anomalousOneExtra = candExtra(anomalousOne.c);
  ok(anomalousOneExtra[2] === 1, "S4 (9): L на пять лет позже K — одна касса по запасному якорю");
  ok(anomalousOneExtra[0] === "2024-06-14", "S4 (9): запасной якорь не меняет дату ухода по L");
  ok(anomalousOneExtra[1] === 12, "S4 (9): запасной якорь не меняет последний тариф по L");
  const anomalousTwo = gone([
    { activated: "2020-01-10T00:00:00", endDate: "2021-03-01T00:00:00", overallEnd: "2024-01-31T00:00:00" },
    { activated: "2020-06-01T00:00:00", endDate: "2021-05-20T00:00:00", overallEnd: "2024-01-31T00:00:00" }
  ]);
  ok(candExtra(anomalousTwo.c)[2] === 2, "S4 (10): якорь 2021-05-20 даёт две одновременно действовавшие кассы");
  const noEnd = { currentEnd: new Date("2024-06-14T00:00:00"),
    kassas: [{ intervals: [{ start: new Date("2018-04-26T00:00:00"), end: null }] }] };
  ok(same(candExtra(noEnd), ["2024-06-14", null, null]), "S4 (12): без интервалов с end — kass18 null, дата ухода по currentEnd");
  const noMatch = { currentEnd: new Date("2026-01-31T00:00:00"), kassas: [] };
  ok(same(candExtra(noMatch), ["2026-01-31", null, null]), "S4: нет подходящих касс → тариф и kass18 null");
  for (const currentEnd of [undefined, null, "2026-01-31", new Date(NaN)]) {
    ok(same(candExtra({ currentEnd, kassas: [] }), [null, null, null]), "S4: нет корректного currentEnd → три null: " + String(currentEnd));
  }
}

console.log((fail ? "FAIL " + fail : "OK " + n) + "/" + n); if (fail) process.exit(1);
