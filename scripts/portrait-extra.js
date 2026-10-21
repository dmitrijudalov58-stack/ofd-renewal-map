"use strict";
const M = require("../js/metrics.js");
const U = require("../js/portrait-util.js");
const { tariffMonths } = U;

const empty36 = () => ({ K: 0, kassas: 0, clients: 0, clients36: 0, M: 0 });
function add36(out, a) {
  const K = a.ak.filter((k) => tariffMonths(k.tariff) === 36).length;
  out.clients++;
  out.kassas += a.n;
  out.K += K;
  if (K) { out.clients36++; out.M += a.n; }
}

function t36(act, ctx) {
  const out = { A: empty36(), B: empty36(), C: empty36(), D: empty36() };
  act.forEach((a) => add36(out[ctx.seg(a.n)], a));
  return out;
}

function ipAgg(act, ctx) {
  const ages = ["<1 г", "1–3 г", "3–7 г", "7+ лет"];
  const groups = new Map(), regions = new Map();
  const bizAge = ages.map((label) => [label, 0, 0]);
  const out = { clients: 0, kassas: 0, liq: 0, t36: empty36(),
    grp: [], old: 0, noOkved: 0, region: [], bizAge };
  act.forEach((a) => {
    const inn = a.inn;
    if (ctx.formOf(inn) !== "ИП") return;
    const liq = ctx.alive(inn) === 1 ? 1 : 0;
    out.clients++;
    out.kassas += a.n;
    out.liq += liq;
    add36(out.t36, a);

    const cls = ctx.clsOf(inn);
    if (cls === "old") out.old++;
    else if (cls === null) out.noOkved++;
    else {
      const code = ctx.grpOf(inn);
      const row = groups.get(code) || [code, ctx.okved[code] || null, 0, 0];
      row[2]++; row[3] += liq;
      groups.set(code, row);
    }
    const name = ctx.regName(ctx.rcOf(inn));
    if (name != null) regions.set(name, (regions.get(name) || 0) + 1);
    const age = ages.indexOf(ctx.bizB(inn));
    if (age !== -1) { bizAge[age][1]++; bizAge[age][2] += liq; }
  });
  // При равенстве численности порядок задаёт код или имя.
  out.grp = [...groups.values()].sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0])).slice(0, 10);
  out.region = [...regions].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru")).slice(0, 5);
  return out;
}

function lifeClients(model, asOf, ctx) {
  const empty = () => ({ clients: 0, days: 0, liq: 0 });
  const seg = { A: empty(), B: empty(), C: empty(), D: empty() };
  const channels = new Map(M.CHANNELS.map((ch) => [ch, empty()]));
  const chanActive = {}, ip = empty();
  M.CHANNELS.forEach((ch) => { chanActive[ch] = 0; });
  const add = (out, days, liq) => { out.clients++; out.days += days; out.liq += liq; };
  const mean = (out) => out.clients ? out.days / out.clients : 0;
  const summary = (out) => ({ clients: out.clients, months: +(mean(out) / 30.4375).toFixed(1), liq: out.liq });

  model.clients.forEach((c, inn) => {
    if (c.phys) return;
    const ch = M.clientChannel(c);
    // База действующих каналов не зависит от наличия конечных интервалов.
    if (!M.clientLapsedAt(c, asOf)) chanActive[ch] = (chanActive[ch] || 0) + 1;
    const coverage = M.clientCoverage(c)
      .filter((iv) => iv.start && iv.end && iv.start < asOf)
      .map((iv) => ({ start: iv.start, end: iv.end > asOf ? asOf : iv.end }))
      .sort((a, b) => a.start - b.start);
    if (!coverage.length) return;
    // Span включает перерывы между интервалами покрытия.
    const days = (coverage[coverage.length - 1].end - coverage[0].start) / 86400000;
    if (days <= 0) return;
    const active = c.kassas.filter((k) => M.isKassaAlive(k, asOf, true)).length;
    const liq = ctx.alive(inn) === 1 ? 1 : 0;
    add(seg[ctx.seg(active || c.kassas.length)], days, liq);
    add(channels.get(M.CHANNELS.includes(ch) ? ch : "Партнёры"), days, liq);
    if (ctx.formOf(inn) === "ИП") add(ip, days, liq);
  });
  Object.keys(seg).forEach((key) => {
    const out = seg[key];
    seg[key] = { clients: out.clients, days: Math.round(mean(out)), months: summary(out).months, liq: out.liq };
  });
  return { seg, chan: M.CHANNELS.map((label) => ({ label, ...summary(channels.get(label)) })), chanActive, ip: summary(ip) };
}

function lastContact(c) {
  const codes = c.kassas.flatMap((k) => k.codes).filter((x) => x.activated)
    .sort((a, b) => b.activated - a.activated);
  let ph = "", em = "";
  for (const x of codes) {
    if (!ph && x.phone) ph = x.phone;
    if (!em && x.email) em = x.email;
    if (ph && em) break;
  }
  return { ph, em };
}

function activeList(act, ctx, withContacts) {
  const cols = ["name", "inn", "kpp", "form", "reg", "grp", "kassas", "tenure", "bizAge10", "maxTariff", "phone", "email", "liq"];
  const regs = [], grps = [], regIdx = new Map(), grpIdx = new Map();
  const rows = act.map((a) => {
    const inn = a.inn, form = ctx.formOf(inn), rc = ctx.rcOf(inn), code = ctx.grpOf(inn) || "";
    if (!regIdx.has(rc)) { regIdx.set(rc, regs.length); regs.push([rc, ctx.regName(rc)]); }
    if (!grpIdx.has(code)) {
      grpIdx.set(code, grps.length);
      grps.push([code, ctx.okved[code] || "", code ? ctx.clsOf(inn) : ""]);
    }
    let days = 0, maxTariff = -1;
    M.clientCoverage(a.c).forEach((iv) => {
      if (iv.start && iv.end) days += Math.max(0, (Math.min(+iv.end, +ctx.asOf) - iv.start) / 86400000);
    });
    a.ak.forEach((k) => {
      const months = tariffMonths(k.tariff);
      if (Number.isFinite(months)) maxTariff = Math.max(maxTariff, months);
    });
    const age = ctx.bizYears(inn), contact = withContacts === true ? lastContact(a.c) : { ph: "", em: "" };
    return [ctx.orgOf(inn, a.c), inn, form === "ЮЛ" ? ctx.kppOf(inn) : "", form === "ИП" ? 0 : form === "ЮЛ" ? 1 : -1,
      regIdx.get(rc), grpIdx.get(code), a.n, Math.round(days / 30.4375), age == null ? -1 : Math.round(age * 10),
      maxTariff, contact.ph, contact.em, ctx.alive(inn) === 1 ? 1 : 0];
  });
  // Названия разделов ОКВЭД (2 знака) для режима «Раздел» и фильтра «Вид деятельности»; «old» и «» не разделы.
  const secs = [...new Set(grps.map((g) => g[2]))].filter((c) => c && c !== "old").sort()
    .map((c) => [c, ctx.okved[c] || ""]);
  return { cols, regs, grps, secs, contacts: withContacts, rows };
}

function candExtra(c) {
  const endedISO = U.dayISO(c.currentEnd);
  if (!endedISO) return [null, null, null];
  let lastTariffMonths = null;
  const kassas = c.kassas.map((k) => {
    if (U.dayISO(k.overallEnd) === endedISO) {
      const months = tariffMonths(k.tariff);
      if (Number.isFinite(months)) lastTariffMonths = lastTariffMonths === null ? months : Math.max(lastTariffMonths, months);
    }
    return k.intervals.map((iv) => ({ start: U.localDayISO(iv.start), end: U.dayISO(iv.end) }))
      .filter((iv) => iv.start && iv.end);
  });
  function maxOnBalance(kassas, anchorISO) {
    const W0 = U.iso(U.addMonthsClamp(U.parseISO(anchorISO), -18)), points = new Set([W0]);
    kassas.forEach((intervals) => intervals.forEach((iv) => {
      if (iv.start >= W0 && iv.start <= anchorISO) points.add(iv.start);
    }));
    let max = 0;
    // Одна касса считается один раз; сутки окончания уже не входят в покрытие.
    points.forEach((t) => {
      const count = kassas.filter((intervals) => intervals.some((iv) => iv.start <= t && t < iv.end)).length;
      max = Math.max(max, count);
    });
    return max;
  }
  let kass18 = maxOnBalance(kassas, endedISO);
  if (kass18 === 0) {
    const lastEnd = kassas.reduce((latest, intervals) => intervals.reduce((end, iv) => iv.end > end ? iv.end : end, latest), "");
    // Общая дата окончания (L) бывает намного позже конца кодов (K), оставляя окно пустым.
    // Тогда считаем от фактического конца последнего покрытия, сохраняя дату ухода по L.
    if (lastEnd) kass18 = maxOnBalance(kassas, lastEnd);
  }
  return [endedISO, lastTariffMonths, kass18 || null];
}

module.exports = { t36, ipAgg, lifeClients, lastContact, activeList, candExtra };
