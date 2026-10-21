"use strict";

// Только синтетика. PRNG пересоздаётся на каждый вызов; системные часы не используются.
function seeded(seed) {
  let state = seed >>> 0;
  return (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * max);
  };
}
const segment = (n) => n >= 10 ? "A" : n >= 6 ? "B" : n >= 2 ? "C" : "D";
const sum = (rows, col) => rows.reduce((n, r) => n + r[col], 0);
const phone = (n) => {
  const s = String(n).padStart(7, "0");
  return "+7 (000) " + s.slice(0, 3) + "-" + s.slice(3, 5) + "-" + s.slice(5);
};
const inn = (n, form) => "9999" + String(n).padStart(form === 0 ? 8 : 6, "0");

function makeV2() {
  const rand = seeded(0xb106a), keys = ["A", "B", "C", "D"];
  const ages = ["<1 г", "1–3 г", "3–7 г", "7+ лет"];
  const channels = ["Корп", "Ольга Зибер", "Пенигина — прямые", "Пенигина — ОП", "Партнёры"];
  const tariffs = ["1 месяц", "3 месяца", "6 месяцев", "13 месяцев", "15 месяцев", "36 месяцев"];
  const grps = [
    ["47.11", "Тестовая розничная торговля", "47"],
    ["47.19", "Тестовые магазины", "47"],
    ["56.10", "Тестовые кафе", "56"],
    ["56.29", "Тестовое питание", "56"],
    ["62.01", "Тестовая разработка ПО", "62"],
    ["62.02", "Тестовые ИТ-услуги", "62"],
    ["49.41", "Тестовые перевозки", "49"],
    ["49.42", "Тестовые переезды", "49"],
    ["10.71", "Тестовая пекарня", "10"],
    ["96.02", "Тестовые бытовые услуги", "96"],
    ["", "", ""],
    ["52.11", "Тестовый старый код", "old"],
  ];
  const regs = Array.from({ length: 90 }, (_, i) => [String(i + 1).padStart(2, "0"), "Тестовый регион " + (i + 1)]);
  // Фиксированные числа служат независимыми ожиданиями для будущих тестов t36.
  const t36 = {
    A: { K: 18, kassas: 60, clients: 5, clients36: 2, M: 21 },
    B: { K: 20, kassas: 90, clients: 12, clients36: 4, M: 30 },
    C: { K: 17, kassas: 180, clients: 60, clients36: 10, M: 28 },
    D: { K: 30, kassas: 120, clients: 120, clients36: 30, M: 30 },
  };
  // Количество 36-месячных касс у первых клиентов каждого сегмента.
  const k36 = { A: [10, 8], B: [4, 5, 5, 6], C: [1, 1, 2, 2, 2, 3, 1, 1, 2, 2], D: Array(30).fill(1) };
  const data = {
    meta: { schema: 2, asOf: "2026-10-21", exportFile: "synthetic-b10.xlsx", fnsMonth: "2026-08", fnsAlignedTo: "2026-08-31" },
    tot: {}, seg: {}, okved: {}, okvedCheck: {}, tariff: { all: {}, seg: {} }, top: {}, life: [], reg: {},
    cand: {}, model: {}, t36, lifeC: {}, ip: {},
    act: {
      cols: ["name", "inn", "kpp", "form", "reg", "grp", "kassas", "tenure", "bizAge10", "maxTariff", "phone", "email", "liq"],
      regs: regs.slice(0, 6).map((r) => r.slice()), grps,
      secs: ["10", "47", "49", "56", "62", "96"].map((c) => [c, "Тестовая отрасль " + c]), contacts: true, rows: [],
    },
  };
  const bySeg = {};
  for (const k of keys) {
    bySeg[k] = [];
    data.tariff.seg[k] = Object.fromEntries(tariffs.map((t) => [t, 0]));
    for (let i = 0; i < t36[k].clients; i++) {
      const n = data.act.rows.length, form = n % 3 === 0 ? 0 : n === 196 ? -1 : 1;
      const kassas = k === "A" ? 10 + i : k === "B" ? 6 + i % 4 : k === "C" ? [2, 2, 3, 3, 3, 5][i % 6] : 1;
      const K = k36[k][i] || 0, tariffIdx = rand(5);
      const row = [form === 0 ? "ИП Тестов Т.Т. " + (n + 1) : "Тестовая компания " + (n + 1),
        inn(1000 + n, form), form === 1 ? "999901001" : "", form,
        k === "C" && i < 12 ? 0 : Math.floor(n / 3) % 6, Math.floor(n / 3) % grps.length,
        kassas, 6 + rand(90), n % 17 === 0 ? -1 : [5, 20, 50, 100][n % 4],
        K ? 36 : [1, 3, 6, 13, 15][tariffIdx], n % 7 ? phone(n + 1) : "",
        n % 5 ? "active" + (n + 1) + "@example.invalid" : "", n % 19 === 0 ? 1 : 0];
      data.act.rows.push(row); bySeg[k].push(row);
      data.tariff.seg[k]["36 месяцев"] += K;
      data.tariff.seg[k][tariffs[tariffIdx]] += kassas - K;
    }
  }

  const ageOf = (r) => r[8] < 0 ? null : ages[r[8] < 10 ? 0 : r[8] < 30 ? 1 : r[8] < 70 ? 2 : 3];
  function tally(rows, get, label) {
    const buckets = new Map();
    for (const r of rows) {
      const code = get(r);
      if (code === null) continue;
      const x = buckets.get(code) || [code, label(code), 0, 0];
      x[2]++; x[3] += r[12]; buckets.set(code, x);
    }
    return [...buckets.values()].sort((a, b) => b[2] - a[2] || String(a[0]).localeCompare(String(b[0]), "ru"));
  }
  const grpLabel = (code) => grps.find((g) => g[0] === code)[1];
  const clsLabel = (code) => "Тестовая отрасль " + code;
  for (const k of keys) {
    const rows = bySeg[k], dead = rows.filter((r) => r[12]);
    data.seg[k] = {
      clients: rows.length, kassas: sum(rows, 6), liq: dead.length, liqKassas: sum(dead, 6),
      form: tally(rows, (r) => r[3] < 0 ? null : r[3] === 0 ? "ИП" : "ЮЛ", (x) => x).map((x) => [x[0], x[2], x[3]]),
      region: tally(rows, (r) => regs[r[4]][1], (x) => x).map((x) => [x[0], x[2], x[3]]),
      bizAge: tally(rows, ageOf, (x) => x).map((x) => [x[0], x[2], x[3]]),
    };
    const valid = rows.filter((r) => !["", "old"].includes(grps[r[5]][2]));
    data.okved[k] = {
      clients: rows.length, noOkved: rows.filter((r) => grps[r[5]][2] === "").length,
      old: rows.filter((r) => grps[r[5]][2] === "old").length,
      oldLiq: dead.filter((r) => grps[r[5]][2] === "old").length,
      cls: tally(valid, (r) => grps[r[5]][2], clsLabel).slice(0, 10),
      grp: tally(valid, (r) => grps[r[5]][0], grpLabel).slice(0, 10),
    };
    const sorted = rows.slice().sort((a, b) => b[6] - a[6] || b[7] - a[7]);
    // В A всего 5 клиентов: повторяем их для заданных 10 строк тестового top.A.
    data.top[k] = Array.from({ length: 10 }, (_, i) => {
      const r = sorted[i % sorted.length], g = grps[r[5]];
      return { org: r[0], okved: g[0], okvedLabel: g[1], region: regs[r[4]][1], kassas: r[6], since: "2020-01-15", st: r[12] };
    });
  }
  const active = data.act.rows, dead = active.filter((r) => r[12]);
  data.tot = { clients: active.length, kassas: sum(active, 6), liq: dead.length, risk: 3, nodata: 2, liqKassas: sum(dead, 6) };
  data.okvedCheck = { total: active.length, noOkved: keys.reduce((n, k) => n + data.okved[k].noOkved, 0), unresolvedGroup: keys.reduce((n, k) => n + data.okved[k].old, 0) };
  data.tariff.all = Object.fromEntries(tariffs.map((t) => [t, keys.reduce((n, k) => n + data.tariff.seg[k][t], 0)]));
  data.life = ["1C", "КА", "Обособки", "Прямые"].map((type, i) => {
    const rows = active.filter((_, n) => n % 4 === i), kassas = sum(rows, 6);
    const months = rows.reduce((n, r) => n + r[7] * r[6], 0) / kassas;
    return { type, days: Math.round(months * 30.4375), months: +months.toFixed(1), kassas, liqKassas: sum(rows.filter((r) => r[12]), 6) };
  });
  for (const [code, name] of regs) {
    data.reg[code] = { name, market: 1000 + rand(9000), cur: {}, aug: {} };
    for (const k of keys) {
      const rows = bySeg[k].filter((r) => regs[r[4]][0] === code), liq = rows.filter((r) => r[12]);
      data.reg[code].cur[k] = [rows.length, sum(rows, 6), liq.length, sum(liq, 6)];
      data.reg[code].aug[k] = [rows.length, sum(rows, 6)];
    }
  }

  const ipRows = active.filter((r) => r[3] === 0), validIP = ipRows.filter((r) => !["", "old"].includes(grps[r[5]][2]));
  data.ip = {
    clients: ipRows.length, kassas: sum(ipRows, 6), liq: sum(ipRows, 12),
    t36: { K: 29, kassas: 143, clients: 66, clients36: 15, M: 34 },
    grp: tally(validIP, (r) => grps[r[5]][0], grpLabel).slice(0, 10),
    old: ipRows.filter((r) => grps[r[5]][2] === "old").length,
    noOkved: ipRows.filter((r) => grps[r[5]][2] === "").length,
    region: tally(ipRows, (r) => regs[r[4]][1], (x) => x).slice(0, 5).map((x) => [x[0], x[2]]),
    bizAge: ages.map((a) => { const rows = ipRows.filter((r) => ageOf(r) === a); return [a, rows.length, sum(rows, 12)]; }),
  };

  const secs = [...new Set(grps.map((g) => g[2]))].map((c) => [c || "?", c === "old" ? "Тестовый старый код" : c ? clsLabel(c) : "ОКВЭД не указан"]);
  const candidates = Array.from({ length: 70 }, (_, i) => {
    const form = i % 3 === 0 ? 0 : 1, kassas = 1 + rand(16);
    return [form === 0 ? "ИП Тестов Т.Т. кандидат " + (i + 1) : "Тестовая компания кандидат " + (i + 1),
      i % 6, i % secs.length, form, kassas, 3 + rand(90), 2 + rand(36), 10 + rand(790), inn(2000 + i, form),
      i % 4 ? phone(2000 + i) : "", i % 5 ? "candidate" + i + "@example.invalid" : "",
      "2025-" + String(1 + i % 12).padStart(2, "0") + "-15", [1, 3, 6, 13, 15, 36][i % 6], 1 + rand(kassas)];
  });
  // Стабильные ИНН и поля — публичные точки опоры для S8–S10.
  const named = [
    ["9999000001", 5, "2025-01-31", 13, 3],
    ["9999000002", 1, null, null, null],
    ["9999000003", 2, "2026-09-15", 1, 2],
    ["9999000004", 12, "2025-06-30", 13, 7],
    ["9999000005", 3, "2025-07-31", 13, 2],
  ];
  named.forEach(([id, kassas, ended, months, kass18], i) => candidates.push([
    "Тестовая компания сценарий " + (i + 1), i % 6, i % secs.length, 1, kassas, 24 + i, i === 2 ? 1 : 12,
    700 - i * 10, id, phone(3000 + i), "scenario" + (i + 1) + "@example.invalid", ended, months, kass18,
  ]));
  data.cand = { secs, regs: regs.slice(0, 6).map((r) => r.slice()), rows: candidates, stats: { churned: 90, alive: 75, liq: 8, proc: 4, nodata: 3 } };

  // Клиентская жизнь включает текущих и ушедших; сегмент ушедших — по r[4].
  const lives = active.map((r, i) => ({ seg: segment(r[6]), months: r[7], liq: r[12], ip: r[3] === 0, ch: i % 5 }))
    .concat(candidates.map((r, i) => ({ seg: segment(r[4]), months: r[5], liq: 0, ip: r[3] === 0, ch: i % 5 })));
  const lifeSummary = (rows) => ({ clients: rows.length, months: rows.length ? +(rows.reduce((n, r) => n + r.months, 0) / rows.length).toFixed(1) : 0, liq: rows.reduce((n, r) => n + r.liq, 0) });
  data.lifeC = {
    seg: Object.fromEntries(keys.map((k) => {
      const rows = lives.filter((r) => r.seg === k), s = lifeSummary(rows);
      return [k, { ...s, days: Math.round(rows.reduce((n, r) => n + r.months, 0) / rows.length * 30.4375) }];
    })),
    chan: channels.map((label, i) => ({ label, ...lifeSummary(lives.filter((r) => r.ch === i)) })),
    chanActive: Object.fromEntries(channels.map((c, i) => [c, active.filter((_, n) => n % 5 === i).length])),
    ip: lifeSummary(lives.filter((r) => r.ip)),
  };
  data.model = {
    imp: [["tsc", 100], ["chan", 70], ["reg2", 50], ["ok2", 40], ["ten", 30], ["bizage", 20], ["form", 10], ["hasEm", 5]],
    dec: Array.from({ length: 10 }, (_, i) => [i, (i + 1) / 20, (i + 1) / 22]),
    tsc: ["(1, 2]", "(2, 3]", "(3, 6]", "(6, 12]", "(12, 24]", "(24, 48]", "(48, 200]"].map((s, i) => [s, 10 + i, (7 - i) / 20]),
    top: { "0.1": [0.5, 0.3] }, allRows: 1000, testRows: 300, auc: 0.78, base: 0.2,
  };
  return data;
}

function makeV1() {
  const data = makeV2();
  delete data.meta.schema;
  for (const key of ["t36", "lifeC", "ip", "act"]) delete data[key];
  data.cand.rows = data.cand.rows.map((r) => r.slice(0, 11));
  return data;
}

module.exports = { makeV2, makeV1 };
