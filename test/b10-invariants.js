// Реальные данные только в памяти; вывод содержит агрегаты, без ПДн.
// TZ=Europe/Moscow PORTRAIT_TEST_FILE=... OFD_TEST_FILE=... node --max-old-space-size=8192 test/b10-invariants.js
"use strict";
const fs = require("fs"), path = require("path");
const { performance } = require("perf_hooks");
const { JSDOM, VirtualConsole } = require("jsdom");
const XLSX = require("xlsx");
const Parser = require("../js/parser.js"), M = require("../js/metrics.js");
const file = process.env.PORTRAIT_TEST_FILE, xlsxFile = process.env.OFD_TEST_FILE;
if (!file || !xlsxFile) {
  console.error("Нужны обе переменные: PORTRAIT_TEST_FILE (JSON схемы 2) и OFD_TEST_FILE (исходная XLSX).");
  process.exit(2);
}
const KEYS = ["A", "B", "C", "D"];
let total = 0, failed = 0, stage = "чтение JSON";
const ok = (condition, message) => {
  total++;
  if (!condition) failed++;
  console.log((condition ? "✓ " : "✗ ") + message);
};
const finish = () => {
  console.log(failed ? `FAIL ${failed}/${total}` : `OK ${total}/${total}`);
  process.exitCode = failed ? 1 : 0;
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const segOf = (n) => n >= 10 ? "A" : n >= 6 ? "B" : n >= 2 ? "C" : n === 1 ? "D" : null;
const validISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;

function checkTop(actual, counts, label) {
  const ranked = [...counts.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const expected = ranked.slice(0, 10);
  const got = actual.map((r) => [r[0], r[2], r[3]]);
  // Каждый код уникален; его оба счётчика сверяются со ВСЕМ пересчётом.
  // Равный размер на границе топ-10 допускает другой код только из той же ничьей.
  const valid = got.length === expected.length && new Set(got.map((r) => r[0])).size === got.length &&
    got.every((r, i) => equal(r, counts.get(r[0])) && r[1] === expected[i][1]) &&
    ranked.filter((r) => expected.length && r[1] > expected[expected.length - 1][1])
      .every((r) => got.some((g) => equal(g, r)));
  ok(valid, label + ": код, клиенты и ликвидированные совпадают с act.rows");
  if (valid && !equal(got, expected)) {
    console.log("  " + label + ": иной порядок/состав хвоста при равной численности; счётчики сверены по кодам.");
  }
}

async function checkPerformance(raw) {
  stage = "jsdom: загрузка реального index.html";
  let dom, errors = 0;
  const vc = new VirtualConsole();
  // Не пересылаем сообщения страницы: исключение может содержать ПДн.
  vc.on("jsdomError", () => errors++);
  vc.on("error", () => errors++);
  try {
    dom = await JSDOM.fromFile(path.join(__dirname, "../index.html"), {
      runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        w.URL.createObjectURL = () => "blob:jsdom";
        w.URL.revokeObjectURL = () => {};
        w.addEventListener("error", () => errors++);
      },
    });
    const w = dom.window, d = w.document;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("load timeout")), 10000);
      const loaded = () => { clearTimeout(timeout); setTimeout(resolve, 300); };
      if (d.readyState === "complete") loaded();
      else w.addEventListener("load", loaded, { once: true });
    });
    stage = "jsdom: JSON.parse, load и рендер";
    const widgets = w.OFDWidgets.WIDGETS, rendered = {}, skipped = [];
    const start = performance.now();
    const data = JSON.parse(raw);
    w.OFDPortrait.load(data);
    for (const id of ["b10-portraits", "b10-okved", "b10-life", "b10-ip", "b10-return"]) {
      if (!widgets[id] || !d.querySelector(`.lib-item[data-widget="${id}"]`)) { skipped.push(id); continue; }
      rendered[id] = widgets[id].render(null, null, "invariant_" + id);
      d.body.appendChild(rendered[id]);
    }
    const elapsed = performance.now() - start;
    for (const id of skipped) console.log(id + ": пропущено — виджета ещё нет в странице");
    ok(Object.values(rendered).every((el) => el.isConnected && el.textContent.trim()),
      "jsdom: отрисовано виджетов " + Object.keys(rendered).length);
    ok(elapsed <= 2000, `JSON.parse + OFDPortrait.load + рендер: ${elapsed.toFixed(1)} мс ≤ 2000 мс`);
    const root = rendered["b10-okved"];
    const from = root && root.querySelector('[data-range="from"]'), to = root && root.querySelector('[data-range="to"]');
    if (!from || !to) console.log("b10-okved, фильтр касс 2–5: пропущено: контролов ещё нет");
    else {
      stage = "jsdom: фильтр касс 2–5";
      const changed = performance.now();
      for (const [side, value] of [["from", "2"], ["to", "5"]]) {
        const input = root.querySelector('[data-range="' + side + '"]');
        input.value = value;
        input.dispatchEvent(new w.Event("input", { bubbles: true }));
        input.dispatchEvent(new w.Event("change", { bubbles: true }));
      }
      // Дать отработать также отложенному обработчику; время ожидания входит в замер.
      await new Promise((resolve) => w.setTimeout(resolve, 0));
      const elapsedFilter = performance.now() - changed;
      ok(elapsedFilter <= 300, `b10-okved, фильтр касс 2–5: ${elapsedFilter.toFixed(1)} мс ≤ 300 мс`);
      const inRange = data.act.rows.filter((r) => r[6] >= 2 && r[6] <= 5).length;
      const cardsSum = [...root.querySelectorAll(".pt-grid2 > .pt-card")].map((card) => [...card.querySelectorAll("tbody tr")].reduce((sum, tr) => sum + Number(tr.children[2].textContent.replace(/\s/g, "")), 0));
      ok(cardsSum[0] === 0 && cardsSum[1] === 0 && cardsSum[3] === 0 && cardsSum[2] === inRange, `b10-okved, касс 2–5: Σ карточки C=${cardsSum[2]}, act.rows с 2–5 кассами=${inRange}, A/B/D пусты`);
    }
    ok(errors === 0, "jsdom: ошибок страницы " + errors);
  } finally { if (dom) dom.window.close(); }
}

async function main() {
  const raw = fs.readFileSync(file, "utf8"), data = JSON.parse(raw);
  ok(data.meta.schema === 2, "meta.schema = 2");
  const rows = data.act.rows;
  const sumSeg = KEYS.reduce((s, k) => s + data.seg[k].clients, 0);
  ok(sumSeg === data.tot.clients && sumSeg === rows.length,
    `Σ seg.clients=${sumSeg}, tot.clients=${data.tot.clients}, act.rows=${rows.length}`);
  const ipSum = (index) => KEYS.reduce((sum, k) => sum + data.seg[k].form
    .filter((r) => r[0] === "ИП").reduce((s, r) => s + r[index], 0), 0);
  ok(data.ip.clients === ipSum(1), `ip.clients=${data.ip.clients}, Σ ИП=${ipSum(1)}`);
  ok(data.ip.liq === ipSum(2), `ip.liq=${data.ip.liq}, Σ ликвидированных ИП=${ipSum(2)}`);
  // «Срок жизни» считается по ВСЕМ клиентам (действующие и ушедшие), поэтому ИП там больше, чем действующих ИП.
  ok(data.lifeC.ip.clients >= data.ip.clients,
    `lifeC.ip.clients=${data.lifeC.ip.clients} (все ИП) ≥ ip.clients=${data.ip.clients} (действующие ИП), разница=${data.lifeC.ip.clients - data.ip.clients}`);
  for (const [key, s] of [...KEYS.filter((k) => k !== "D").map((k) => [k, data.t36[k]]), ["ИП", data.ip.t36]]) {
    ok([s.K, s.M, s.kassas].every((n) => Number.isInteger(n) && n >= 0) && s.K <= s.M && s.M <= s.kassas,
      `t36 ${key}: K=${s.K} ≤ M=${s.M} ≤ kassas=${s.kassas}`);
  }
  const d = data.t36.D;
  ok(Number.isInteger(d.K) && d.K >= 0 && d.K === d.clients36 && d.K === d.M,
    `t36 D: K=${d.K}, clients36=${d.clients36}, M=${d.M}`);
  const groups = Object.fromEntries(KEYS.map((k) => [k, { clients: 0, cls: new Map(), grp: new Map() }]));
  let invalidRows = 0;
  for (const r of rows) {
    const key = Number.isInteger(r[6]) && segOf(r[6]), g = data.act.grps[r[5]];
    if (!key || !g) { invalidRows++; continue; }
    groups[key].clients++;
    if (!g[2] || g[2] === "old") continue;
    for (const [kind, code] of [["cls", g[2]], ["grp", g[0]]]) {
      const map = groups[key][kind], entry = map.get(code) || [code, 0, 0];
      entry[1]++; entry[2] += r[12] === 1 ? 1 : 0;
      map.set(code, entry);
    }
  }
  ok(invalidRows === 0, "act: строк с неверным числом касс/индексом группы " + invalidRows);
  for (const k of KEYS) {
    ok(groups[k].clients === data.seg[k].clients,
      `сегмент ${k} по r[6]: ${groups[k].clients}, в seg: ${data.seg[k].clients}`);
    for (const kind of ["cls", "grp"]) checkTop(data.okved[k][kind], groups[k][kind], `okved.${k}.${kind}`);
  }
  const lifeSeg = KEYS.reduce((s, k) => s + data.lifeC.seg[k].clients, 0);
  const lifeChan = data.lifeC.chan.reduce((s, r) => s + r.clients, 0);
  ok(lifeSeg === lifeChan, `срок жизни: Σ сегментов=${lifeSeg}, Σ каналов=${lifeChan}, разница=${lifeSeg - lifeChan}`);
  ok(lifeSeg >= data.tot.clients && lifeChan >= data.tot.clients,
    `срок жизни: обе базы ≥ tot.clients=${data.tot.clients}`);
  ok(!data.act.contacts || rows.some((r) => typeof r[10] === "string" && r[10].trim()),
    "act.contacts === true ⇒ есть непустой телефон");
  const sections = new Map(data.act.secs);
  const used = [...new Set(data.act.grps.map((g) => g[2]).filter((c) => c && c !== "old"))];
  const missing = used.filter((c) => typeof sections.get(c) !== "string" || !sections.get(c).trim());
  ok(missing.length === 0, "act.secs: разделов без непустого названия " + missing.length);
  const cand = data.cand.rows, tariffs = new Map();
  let badDate = 0, badTariff = 0, badKass = 0;
  for (const r of cand) {
    if (!validISO(r[11])) badDate++;
    if (!Number.isInteger(r[12]) || r[12] <= 0) badTariff++;
    else tariffs.set(r[12], (tariffs.get(r[12]) || 0) + 1);
    if (!Number.isInteger(r[13]) || r[13] < 1 || r[13] > r[4]) badKass++;
  }
  console.log("cand.rows: " + cand.length);
  console.log("Распределение тарифов (мес.: строк): " + [...tariffs].sort((a, b) => a[0] - b[0]).map(([n, count]) => `${n}: ${count}`).join(", "));
  ok(badDate === 0, "cand: неверных/null дат " + badDate);
  ok(badTariff === 0, "cand: неверных/null тарифов " + badTariff + " (допускается любое целое > 0)");
  ok(badKass === 0, "cand: нарушений 1 ≤ kass18 ≤ kassasAll или null: " + badKass);
  const bytes = fs.statSync(file).size;
  ok(bytes <= 25 * 1048576, `размер файла: ${bytes} Б (${(bytes / 1048576).toFixed(2)} МБ) ≤ 25 МБ`);
  // До тяжёлой модели XLSX, чтобы её аллокации не влияли на замер браузера.
  await checkPerformance(raw);
  stage = "чтение XLSX и построение модели каналов";
  const dm = /-(\d{2})\.(\d{2})\.(\d{4})\.xlsx$/i.exec(xlsxFile);
  const asOf = dm ? new Date(`${dm[3]}-${dm[2]}-${dm[1]}T12:00:00`) : new Date();
  console.log("as-of каналов: " + (dm ? `${dm[3]}-${dm[2]}-${dm[1]} 12:00:00 (местное время)` : "текущее время, как fallback сборщика"));
  const workbook = XLSX.readFile(xlsxFile, { cellDates: true });
  const parsed = Parser.parseWorkbook(XLSX, workbook);
  ok(parsed.headerIssues.length === 0, "XLSX: несовпадений заголовков " + parsed.headerIssues.length);
  const expected = M.computeChannels5(M.buildModel(parsed.rows), asOf).byChannel;
  for (const channel of M.CHANNELS) {
    ok(data.lifeC.chanActive[channel] === expected[channel],
      `chanActive ${channel}: файл=${data.lifeC.chanActive[channel]}, BI=${expected[channel]}`);
  }
}

main().catch(() => ok(false, "Ошибка этапа «" + stage + "»; содержимое исключения скрыто для защиты ПДн.")).finally(finish);
