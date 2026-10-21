#!/usr/bin/env node
/*
 * Сборка portrait-data.json для раздела B10 «Портрет клиента».
 *
 *   node --max-old-space-size=8192 scripts/build-portrait-data.js [--xlsx <выгрузка.xlsx>] [--out <portrait-data.json>]
 *
 * Берёт выгрузку ОФД (по умолчанию из ~/.config/dadata/source-file.txt), DaData-кэш и сырой
 * ответ DaData (dadata-raw.ndjson в корне репо), справочник ОКВЭД-2, рынок ФНС по регионам,
 * считает все срезы раздела и вероятность возврата отвалившихся (python-модель).
 * В файле есть телефоны и email отвалившихся (для CSV продаж): файл личный, на сайт не кладём,
 * в BI он загружается кнопкой «Портрет» в шапке.
 * Формулы клиента/кассы/оттока берутся из js/metrics.js без изменений.
 * Схема 2: t36, lifeC, ip, act и cand[11..13]; --active-contacts включает контакты act.
 * Только для тестов: DADATA_RAW_FILE и PORTRAIT_SMOKE_STOP=before-model.
 */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const XLSX = require(path.join(ROOT, "node_modules/xlsx"));
const Parser = require(path.join(ROOT, "js/parser.js")), M = require(path.join(ROOT, "js/metrics.js"));
const P = require("./dadata-paths.js");
const X = require("./portrait-extra.js");
const DAY = 86400000, MO = 30.4375 * DAY, YEAR_MS = 31557600000;

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function fail(msg) { console.error("ОШИБКА: " + msg); process.exit(1); }

const xlsxPath = arg("--xlsx") || (fs.existsSync(P.SOURCE_POINTER) ? fs.readFileSync(P.SOURCE_POINTER, "utf8").trim() : null);
if (!xlsxPath || !fs.existsSync(xlsxPath)) fail("не найдена выгрузка ОФД (--xlsx или " + P.SOURCE_POINTER + ")");
const outPath = arg("--out") || path.join(os.homedir(), "Downloads", "portrait-data.json");
const rawPath = process.env.DADATA_RAW_FILE || path.join(ROOT, "dadata-raw.ndjson");
const withContacts = process.argv.includes("--active-contacts");
console.log("контакты действующих: " + (withContacts ? "включены" : "выключены"));
if (!fs.existsSync(P.CACHE_FILE)) fail("нет DaData-кэша " + P.CACHE_FILE);
if (!fs.existsSync(rawPath)) fail("нет " + rawPath);

// as-of = дата в имени выгрузки («…-12.10.2026.xlsx»), иначе сегодня
const dm = /-(\d{2})\.(\d{2})\.(\d{4})\.xlsx$/i.exec(xlsxPath);
const asOf = dm ? new Date(`${dm[3]}-${dm[2]}-${dm[1]}T12:00:00`) : new Date();
const iso = (d) => d.toISOString().slice(0, 10);

const okved = JSON.parse(fs.readFileSync(path.join(__dirname, "data/okved2-min.json"), "utf8"));
const cache = JSON.parse(fs.readFileSync(P.CACHE_FILE, "utf8"));

// ---------- рынок ФНС: последний опубликованный месяц (или кэш в scripts/data)
async function loadFns() {
  const tryMonth = async (y, m) => {
    const f = path.join(__dirname, `data/fns-count-by-regions-${y}-${m}.json`);
    if (fs.existsSync(f)) return { y, m, data: JSON.parse(fs.readFileSync(f, "utf8")) };
    try {
      const r = await fetch(`https://geochecki-vpd.nalog.gov.ru/api/api/v1/kkt/count-by-regions/${y}-${m}`);
      if (!r.ok) return null;
      const data = await r.json();
      if (!data || !Array.isArray(data.items)) return null;
      fs.writeFileSync(f, JSON.stringify(data));
      return { y, m, data };
    } catch (e) { return null; }
  };
  let y = asOf.getFullYear(), m = asOf.getMonth(); // месяц до текущего (0-based = предыдущий в 1-based)
  if (m === 0) { y--; m = 12; }
  for (let i = 0; i < 4; i++) {
    const got = await tryMonth(y, m);
    if (got) return got;
    m--; if (m === 0) { y--; m = 12; }
  }
  return null;
}

(async () => {
  const t0 = Date.now();
  const fns = await loadFns();
  if (!fns) fail("не удалось получить данные ФНС (ни из сети, ни из scripts/data)");
  const fnsEnd = new Date(fns.y, fns.m, 0, 12, 0, 0); // последний день месяца ФНС, полдень по местному времени (как as-of)
  console.log("ФНС:", fns.y + "-" + fns.m, "· выгрузка:", path.basename(xlsxPath), "· as-of", iso(asOf));

  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const { rows } = Parser.parseWorkbook(XLSX, wb);
  const model = M.buildModel(rows);
  // сырые колонки: перезакреп(0), промокод(7), РРЦ(24) по PIN
  const extra = new Map();
  wb.SheetNames.forEach((n) => {
    const a = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true });
    for (let i = 1; i < a.length; i++) { const r = a[i]; if (r[2]) extra.set(String(r[2]).trim(), { relock: r[0] === "Да" ? 1 : 0, promo: r[7] ? 1 : 0, rrp: typeof r[24] === "number" ? r[24] : null }); }
  });
  console.log("модель:", model.clients.size, "клиентов", Math.round((Date.now() - t0) / 1000), "с");

  // ---------- сырой DaData: тип, статус, дата регистрации, регион
  const need = new Set(model.clients.keys());
  const raw = new Map();
  await new Promise((resolve) => {
    const rl = require("readline").createInterface({ input: fs.createReadStream(rawPath) });
    rl.on("line", (l) => {
      if (!l) return;
      const i = l.indexOf('"inn":"'); const inn = l.slice(i + 7, l.indexOf('"', i + 7)); if (!need.has(inn)) return;
      let o; try { o = JSON.parse(l); } catch (e) { return; }
      const s = o.response && o.response.suggestions && o.response.suggestions[0]; if (!s) return;
      const d = s.data, a = (d.address && d.address.data) || {};
      raw.set(inn, { type: d.type, st: d.state && d.state.status, reg: d.state && d.state.registration_date, kpp: d.kpp || "", rc: a.region_kladr_id ? String(a.region_kladr_id).slice(0, 2) : null });
    });
    rl.on("close", resolve);
  });
  console.log("DaData raw:", raw.size);

  // ---------- действующие / отвалившиеся
  const act = [], chu = [], a831 = new Map();
  model.clients.forEach((c, inn) => {
    if (c.phys) return;
    const ak = c.kassas.filter((k) => M.isKassaAlive(k, asOf, true));
    if (ak.length) act.push({ inn, c, ak, n: ak.length });
    else if (M.clientChurnStatus(c, asOf) === "churned") chu.push({ inn, c, n: c.kassas.length });
    const n8 = c.kassas.filter((k) => k.appearance <= fnsEnd && M.isKassaAlive(k, fnsEnd, true)).length;
    if (n8) a831.set(inn, n8);
  });
  const alive = (inn) => { const r = raw.get(inn); return !r || !r.st ? 3 : r.st === "ACTIVE" ? 0 : r.st === "LIQUIDATED" ? 1 : 2; };
  const seg = (n) => (n >= 10 ? "A" : n >= 6 ? "B" : n >= 2 ? "C" : "D");
  const SEG = ["A", "B", "C", "D"];
  const grpOf = (inn) => { const i = cache[inn]; if (!i || !i.okved) return null; const s = String(i.okved); return s.length >= 5 ? s.slice(0, 5) : s; };
  const clsOf = (inn) => { const g = grpOf(inn); if (!g) return null; return okved[g] ? g.slice(0, 2) : "old"; };
  const bizB = (inn) => { const r = raw.get(inn); if (!r || !r.reg) return null; const y = (asOf - new Date(r.reg)) / YEAR_MS; return y < 1 ? "<1 г" : y < 3 ? "1–3 г" : y < 7 ? "3–7 г" : "7+ лет"; };
  const formOf = (inn) => { const r = raw.get(inn); return r ? (r.type === "INDIVIDUAL" ? "ИП" : "ЮЛ") : null; };
  const topT = (m, n) => Object.entries(m).sort((x, y) => y[1][0] - x[1][0]).slice(0, n).map(([k, v]) => [k, v[0], v[1]]);

  const out = { meta: { schema: 2, asOf: iso(asOf), generatedAt: new Date().toISOString(), exportFile: path.basename(xlsxPath), fnsMonth: fns.y + "-" + String(fns.m).padStart(2, "0"), fnsAlignedTo: iso(fnsEnd) } };
  out.tot = { clients: act.length, kassas: act.reduce((s, a) => s + a.n, 0) };
  out.tot.liq = act.filter((a) => alive(a.inn) === 1).length; out.tot.risk = act.filter((a) => alive(a.inn) === 2).length; out.tot.nodata = act.filter((a) => alive(a.inn) === 3).length;
  out.tot.liqKassas = act.filter((a) => alive(a.inn) === 1).reduce((s, a) => s + a.n, 0);

  // ---------- сегменты
  const S = { A: [], B: [], C: [], D: [] }; act.forEach((a) => S[seg(a.n)].push(a));
  out.seg = {}; out.okved = {}; out.top = {};
  let noOkTot = 0, oldTot = 0;
  for (const k of SEG) {
    const L = S[k], o = { clients: L.length, kassas: L.reduce((s, a) => s + a.n, 0) };
    const isL = (a) => alive(a.inn) === 1;
    o.liq = L.filter(isL).length; o.liqKassas = L.filter(isL).reduce((s, a) => s + a.n, 0);
    const tab = (f) => { const m = {}; L.forEach((a) => { const v = f(a); if (v == null) return; (m[v] = m[v] || [0, 0])[0]++; if (isL(a)) m[v][1]++; }); return m; };
    o.form = topT(tab((a) => formOf(a.inn)), 2);
    o.region = topT(tab((a) => { const i = cache[a.inn]; return (i && i.region) || null; }), 10);
    o.bizAge = topT(tab((a) => bizB(a.inn)), 4);
    out.seg[k] = o;
    // ОКВЭД: раздел (2 знака) и полный код (5 знаков), 100% учёт
    const tabC = {}, tabG = {}, oo = { clients: L.length, noOkved: 0, old: 0, oldLiq: 0 };
    L.forEach((a) => {
      const c = clsOf(a.inn), g = grpOf(a.inn), dead = isL(a);
      if (!c) { oo.noOkved++; noOkTot++; return; }
      if (c === "old") { oo.old++; oldTot++; if (dead) oo.oldLiq++; return; }
      (tabC[c] = tabC[c] || [0, 0])[0]++; if (dead) tabC[c][1]++;
      (tabG[g] = tabG[g] || [0, 0])[0]++; if (dead) tabG[g][1]++;
    });
    const top10 = (t) => Object.entries(t).sort((x, y) => y[1][0] - x[1][0]).slice(0, 10).map(([c, v]) => [c, okved[c] || null, v[0], v[1]]);
    oo.cls = top10(tabC); oo.grp = top10(tabG); out.okved[k] = oo;
    out.top[k] = L.slice().sort((x, y) => y.n - x.n || x.c.appearance - y.c.appearance).slice(0, 10).map((a) => {
      const i = cache[a.inn] || {}; const c2 = i.okved ? String(i.okved).slice(0, 2) : null;
      return { org: i.org || a.c.kassas[0].org, kassas: a.n, region: i.region || null, okved: i.okved || null, okvedLabel: c2 ? okved[c2] || null : null, st: alive(a.inn), since: iso(a.c.appearance) };
    });
  }
  out.okvedCheck = { noOkved: noOkTot, unresolvedGroup: oldTot, total: act.length };

  // ---------- тарифы (срок кода, действующие кассы) и срок жизни по типу продаж
  out.tariff = { all: {}, seg: { A: {}, B: {}, C: {}, D: {} } };
  act.forEach((a) => { const sg = seg(a.n); a.ak.forEach((k) => { const t = k.tariff || "не указан"; out.tariff.all[t] = (out.tariff.all[t] || 0) + 1; out.tariff.seg[sg][t] = (out.tariff.seg[sg][t] || 0) + 1; }); });
  const life = (k) => { const iv = k.intervals.filter((i) => i.start && i.end).map((i) => [+i.start, Math.min(+i.end, +asOf)]).filter((i) => i[1] > i[0]).sort((a, b) => a[0] - b[0]); let t = 0, cs = null, ce = null; iv.forEach(([s, e]) => { if (cs === null) { cs = s; ce = e; } else if (s <= ce) ce = Math.max(ce, e); else { t += ce - cs; cs = s; ce = e; } }); if (cs !== null) t += ce - cs; return t / DAY; };
  const lf = {};
  act.forEach((a) => { const dead = alive(a.inn) === 1; a.ak.forEach((k) => { const st = (k.codes[0] && k.codes[0].salesType) || "∅"; const d = life(k); if (!(d > 0)) return; const x = (lf[st] = lf[st] || { n: 0, s: 0, liq: 0 }); x.n++; x.s += d; if (dead) x.liq++; }); });
  out.life = Object.entries(lf).map(([k, x]) => ({ type: k, kassas: x.n, days: Math.round(x.s / x.n), months: +(x.s / x.n / 30.4375).toFixed(1), liqKassas: x.liq }));

  // ---------- регионы: рынок ФНС + наши кассы
  const fnsMap = {};
  fns.data.items.forEach((x) => { const m = x.region.match(/^(\d+)-(.*)$/); fnsMap[m[1]] = { name: m[2], total: x.entrepreneur + x.legalEntity }; });
  const reg = {};
  const R0 = (c) => (reg[c] = reg[c] || { name: (fnsMap[c] && fnsMap[c].name) || "Не определён", market: fnsMap[c] ? fnsMap[c].total : 0, cur: { A: [0, 0, 0, 0], B: [0, 0, 0, 0], C: [0, 0, 0, 0], D: [0, 0, 0, 0] }, aug: { A: [0, 0], B: [0, 0], C: [0, 0], D: [0, 0] } });
  Object.keys(fnsMap).forEach(R0);
  const rcOf = (inn) => (raw.get(inn) && raw.get(inn).rc) || "00";
  act.forEach((a) => { const r = R0(rcOf(a.inn)), sg = seg(a.n), L = alive(a.inn) === 1; r.cur[sg][0]++; r.cur[sg][1] += a.n; if (L) { r.cur[sg][2]++; r.cur[sg][3] += a.n; } });
  a831.forEach((n8, inn) => { const r = R0(rcOf(inn)), sg = seg(n8); r.aug[sg][0]++; r.aug[sg][1] += n8; });
  out.reg = reg;

  // ---------- дополнительные агрегаты схемы 2 (после объявления reg и rcOf)
  const ctx = { seg, alive, formOf, grpOf, clsOf, bizB, okved, rcOf, asOf,
    regName: (rc) => (reg[rc] ? reg[rc].name : "Не определён"),
    orgOf: (inn, c) => (cache[inn] && cache[inn].org) || c.kassas[0].org || "—",
    kppOf: (inn) => (raw.get(inn) && raw.get(inn).kpp) || "",
    bizYears: (inn) => { const r = raw.get(inn); return r && r.reg ? (asOf - new Date(r.reg)) / YEAR_MS : null; } };
  out.t36 = X.t36(act, ctx);
  out.lifeC = X.lifeClients(model, asOf, ctx);
  out.ip = X.ipAgg(act, ctx);
  out.act = X.activeList(act, ctx, withContacts);

  // ---------- панель прошлых оттоков для модели и текущие кандидаты
  const mo = (s) => { const m = /(\d+)/.exec(s || ""); return m ? +m[1] : null; };
  const pc = {}, cc = {};
  model.clients.forEach((c) => { if (c.phys) return; const k = c.kassas[c.kassas.length - 1]; const p = (k && k.partner) || "-"; pc[p] = (pc[p] || 0) + 1; const z = (k && k.salesCenter) || "-"; cc[z] = (cc[z] || 0) + 1; });
  const topP = new Set(Object.entries(pc).sort((a, b) => b[1] - a[1]).slice(0, 40).map((x) => x[0])), topC = new Set(Object.entries(cc).sort((a, b) => b[1] - a[1]).slice(0, 15).map((x) => x[0]));
  const cl = [];
  model.clients.forEach((c, inn) => {
    if (c.phys) return; const r = raw.get(inn); if (!r || r.st !== "ACTIVE") return;
    const cov = M.clientCoverage(c).sort((a, b) => a.start - b.start); if (!cov.length) return;
    const codes = []; c.kassas.forEach((k) => k.codes.forEach((x) => { if (x.activated) codes.push({ x, k }); })); codes.sort((a, b) => a.x.activated - b.x.activated);
    cl.push({ inn, c, cov, codes, r });
  });
  const feat = (o, Sd) => {
    const { c, cov, codes, r, inn } = o; let n = 0; while (n < cov.length && cov[n].start <= Sd) n++; if (!n) return null;
    const last = cov[n - 1]; if (last.end >= Sd) return null; const E = last.end; const gd = (Sd - E) / DAY; if (gd < 31) return null;
    let ten = 0; for (let i = 0; i < n; i++) ten += (Math.min(cov[i].end, Sd) - cov[i].start) / MO;
    let kk = 0, kE = 0; c.kassas.forEach((k) => { if (k.appearance <= Sd) { kk++; if (k.intervals.some((iv) => iv.start <= E - DAY && iv.end && iv.end >= E - DAY)) kE++; } });
    let m = codes.length; while (m > 0 && codes[m - 1].x.activated > Sd) m--; if (!m) return null;
    const lc = codes[m - 1], ex = extra.get(lc.x.pin) || {}, kc = lc.k;
    let ph = null, em = null; for (let i = m - 1; i >= 0 && (!ph || !em); i--) { if (!ph && codes[i].x.phone) ph = codes[i].x.phone; if (!em && codes[i].x.email) em = codes[i].x.email; }
    const gapPrev = n >= 2 ? (cov[n - 1].start - cov[n - 2].end) / DAY : -1;
    return { tsc: +(gd / 30.4375).toFixed(2), ten: +ten.toFixed(1), nint: n, nkAll: kk, nkE: kE, tar: mo(lc.x.tariff) || 0, ncodes: m, stype: lc.x.salesType || "-", chan: kc.channel || "-",
      partner: topP.has(lc.x.partner) ? lc.x.partner : "other", center: topC.has(lc.x.salesCenter) ? lc.x.salesCenter : "other", form: inn.length === 12 ? "IP" : "UL", reg2: inn.slice(0, 2),
      ok2: cache[inn] && cache[inn].okved ? String(cache[inn].okved).slice(0, 2) : "?", bizage: r.reg ? +((Sd - r.reg) / YEAR_MS).toFixed(2) : -1, emon: E.getMonth() + 1,
      hasPh: ph ? 1 : 0, hasEm: em ? 1 : 0, rrp: ex.rrp == null ? -1 : ex.rrp, promo: ex.promo || 0, relock: ex.relock || 0, gapPrev: +gapPrev.toFixed(0), lastLen: +((last.end - last.start) / MO).toFixed(1),
      _ph: ph, _em: em, _n: n };
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-"));
  const cols = ["S", "inn", "y", "tsc", "ten", "nint", "nkAll", "nkE", "tar", "ncodes", "stype", "chan", "partner", "center", "form", "reg2", "ok2", "bizage", "emon", "hasPh", "hasEm", "rrp", "promo", "relock", "gapPrev", "lastLen"];
  const fd = fs.openSync(path.join(work, "panel.csv"), "w"); fs.writeSync(fd, cols.join(",") + "\n");
  let panelRows = 0, buf = [];
  const flush = () => { if (buf.length) { fs.writeSync(fd, buf.join("")); buf = []; } };
  for (let y = 2019; y <= asOf.getFullYear(); y++) for (let mth = 0; mth < 12; mth += 2) {
    const Sd = new Date(Date.UTC(y, mth, 1, 12)); if (+Sd + 365 * DAY > +asOf) continue;
    cl.forEach((o) => {
      const f = feat(o, Sd); if (!f) return;
      const yv = o.cov.length > f._n && o.cov[f._n].start <= +Sd + 365 * DAY ? 1 : 0; panelRows++;
      const v = { S: iso(Sd), inn: o.inn, y: yv, ...f };
      buf.push(cols.map((k) => String(v[k]).replace(/,/g, " ")).join(",") + "\n"); if (buf.length > 20000) flush();
    });
  }
  flush(); fs.closeSync(fd);
  const cur = [];
  cl.forEach((o) => { const f = feat(o, asOf); if (!f) return; const v = { S: "now", inn: o.inn, y: 0, ...f }; cur.push({ ...v, ph: f._ph, em: f._em }); });
  fs.writeFileSync(path.join(work, "current.json"), JSON.stringify({ cols, cur }));
  console.log("панель:", panelRows, "наблюдений · текущих живых отвалившихся:", cur.length, "· обучение…");
  const P1 = new Map();
  if (process.env.PORTRAIT_SMOKE_STOP === "before-model") {
    cur.forEach((z) => P1.set(z.inn, 0.5));
    out.model = {};
  } else {
    const py = cp.spawnSync("python3", [path.join(__dirname, "portrait-train.py"), work], { stdio: ["ignore", "inherit", "inherit"], maxBuffer: 1 << 28 });
    if (py.status !== 0) fail("python3 portrait-train.py завершился с ошибкой (нужны pandas, numpy, scikit-learn: pip install)");
    fs.readFileSync(path.join(work, "current_p.csv"), "utf8").trim().split("\n").slice(1).forEach((l) => { const [inn, p] = l.split(","); P1.set(inn, +p); });
    out.model = JSON.parse(fs.readFileSync(path.join(work, "model.json"), "utf8"));
  }
  const contact = new Map(cur.map((z) => [z.inn, z]));

  // ---------- отвалившиеся: кандидаты со скором и контактами
  const secs = [], secIdx = {}, regs = [], regIdx = {}, rowsC = [];
  let nAlive = 0, nLiq = 0, nProc = 0, nNo = 0;
  chu.forEach((a) => {
    const al = alive(a.inn); if (al === 1) nLiq++; else if (al === 2) nProc++; else if (al === 3) nNo++; else nAlive++;
    if (al !== 0) return;
    const rc = rcOf(a.inn); R0(rc);
    const cls = clsOf(a.inn) || "?"; if (!(cls in secIdx)) { secIdx[cls] = secs.length; secs.push([cls, cls === "old" ? "Старый код (ОКВЭД-1)" : cls === "?" ? "ОКВЭД не указан" : okved[cls] || ""]); }
    if (!(rc in regIdx)) { regIdx[rc] = regs.length; regs.push([rc, reg[rc].name]); }
    const covv = M.clientCoverage(a.c); let days = 0; covv.forEach((iv) => { if (iv.start && iv.end) days += Math.max(0, (+iv.end - +iv.start) / DAY); });
    const ten = Math.round(days / 30.4375), since = Math.max(0, Math.round((asOf - a.c.currentEnd) / DAY / 30.4375));
    const i = cache[a.inn] || {}, z = contact.get(a.inn), p = P1.get(a.inn);
    if (p === undefined) return; // нет признаков для модели (редкий случай): в список не берём
    rowsC.push([i.org || a.c.kassas[0].org || "—", regIdx[rc], secIdx[cls], formOf(a.inn) === "ИП" ? 0 : 1, a.n, ten, since, Math.round(p * 1000), a.inn, (z && z.ph) || "", (z && z.em) || "", ...X.candExtra(a.c)]);
  });
  out.cand = { secs, regs, rows: rowsC, stats: { churned: chu.length, alive: nAlive, liq: nLiq, proc: nProc, nodata: nNo } };
  out.reg = reg;
  fs.writeFileSync(outPath, JSON.stringify(out));
  fs.rmSync(work, { recursive: true, force: true });
  console.log("готово:", outPath, Math.round(fs.statSync(outPath).size / 1048576 * 10) / 10, "МБ ·", Math.round((Date.now() - t0) / 1000), "с · кандидатов", rowsC.length);
  const actRows = out.act.rows, pct = (i) => (actRows.length ? actRows.filter((r) => r[i]).length / actRows.length * 100 : 0).toFixed(1) + "%";
  console.log("act:", actRows.length, "· с телефоном:", pct(10), "· с email:", pct(11), "· с КПП:", pct(2));
  console.log("кандидаты без даты окончания:", rowsC.filter((r) => r[11] == null).length, "· без тарифа:", rowsC.filter((r) => r[12] == null).length, "· без kass18:", rowsC.filter((r) => r[13] == null).length);
  if (fs.statSync(outPath).size > 25 * 1048576) console.log("ПРЕДУПРЕЖДЕНИЕ: файл больше 25 МБ — рассмотреть отдельный файл клиентов");
})().catch((e) => { console.error(e); process.exit(1); });
