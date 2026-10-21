// Тест B10 «Портрет клиента»: рендер 13 виджетов на реальном portrait-data.json, сверка чисел и интерактива.
// Запуск (файл схемы 2):  PORTRAIT_TEST_FILE=/путь/portrait-data.json node test/portrait-smoke.js
// Запуск (старый файл без meta.schema): PORTRAIT_SMOKE_MODE=old PORTRAIT_TEST_FILE=/путь/portrait-data.json node test/portrait-smoke.js
// В режиме old новые блоки должны показывать плашку «Пересоберите portrait-data.json», а не падать.
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const file = process.env.PORTRAIT_TEST_FILE;
if (!file) { console.error("нужен PORTRAIT_TEST_FILE"); process.exit(2); }
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const OLD = process.env.PORTRAIT_SMOKE_MODE === "old";
let fail = 0; const ok = (c, m) => { if (!c) fail++; console.log((c ? "✓ " : "✗ ") + m); };
const errs = [];
JSDOM.fromFile(path.join(__dirname, "../index.html"), { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
  beforeParse(w) { w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; w.addEventListener("error", (e) => errs.push(e.message)); } })
.then((dom) => new Promise((r) => dom.window.addEventListener("load", () => setTimeout(() => r(dom), 300))))
.then((dom) => {
  const w = dom.window, d = w.document, W = w.OFDWidgets.WIDGETS;
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ids = ["summary", "segments", "portraits", "okved", "form", "ip", "bizage", "tariffs", "life", "top", "regions", "return", "model"].map((x) => "b10-" + x);
  ok(OLD ? !(data.meta && data.meta.schema >= 2) : data.meta && data.meta.schema >= 2, "режим " + (OLD ? "old: файл без схемы 2" : "new: файл схемы 2"));
  ok(ids.every((id) => W[id] && W[id].title && W[id].render), "13 виджетов зарегистрированы");
  ok(ids.every((id) => d.querySelector('.lib-item[data-widget="' + id + '"]')), "13 пунктов в библиотеке (группа B10)");
  const PLATE = "Пересоберите portrait-data.json";
  // до загрузки файла: подсказка, без ошибок
  const pre = W["b10-summary"].render(null, null, "t0"); ok(/Файл не загружен/.test(pre.textContent), "до загрузки файла показана подсказка");
  w.OFDPortrait.load(data);
  const R = {}; ids.forEach((id) => { try { R[id] = W[id].render(null, null, "t_" + id); d.body.appendChild(R[id]); } catch (e) { ok(false, id + " упал: " + e.message); } });
  ok(Object.keys(R).length === 13, "все 13 виджетов отрисованы без исключений");
  const txt = (id) => R[id].textContent.replace(/\s+/g, " ");
  const n = (x) => Math.round(x).toLocaleString("ru-RU").replace(/\s/g, " ");
  ok(txt("b10-summary").includes(n(data.tot.clients)) && txt("b10-summary").includes(n(data.tot.liq)), "сводка: клиентов " + n(data.tot.clients) + ", ликвидировано " + n(data.tot.liq));
  ok(["A", "B", "C", "D"].every((k) => txt("b10-segments").includes(n(data.seg[k].clients))), "сегменты: размеры A/B/C/D");
  ok(R["b10-portraits"].querySelectorAll(".pt-card").length === 4, "портреты: 4 карточки");
  const t36 = [...R["b10-portraits"].querySelectorAll(".pt-t36")];
  if (OLD) ok(t36.length === 4 && t36.every((b) => b.textContent.includes(PLATE) && !b.querySelector("[data-metric]")), "портреты (old): в блоке «Тариф 36 мес.» плашка вместо цифр");
  else {
    ok(t36.length === 4 && t36.every((b) => b.querySelectorAll("[data-metric]").length === 3 && !b.querySelector(".pt-card")), "портреты: в каждой из 4 карточек блок «Тариф 36 мес.» из трёх показателей");
    ok(txt("b10-portraits").includes(n(data.t36.C.clients36)) && txt("b10-portraits").includes(n(data.t36.C.M - data.t36.C.K)), "портреты: сегмент C — клиентов на 36 мес. и точка роста из данных");
  }
  // захват CSV через Blob
  const grab = (btn) => {
    let text = null; const origBlob = w.Blob; w.Blob = function (parts) { text = parts.join(""); return new origBlob(parts); };
    w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
    try { click(btn); } finally { w.Blob = origBlob; }
    return text;
  };
  // ОКВЭД: суммы строк = размеры сегментов (100% учёта)
  if (OLD) ok(R["b10-okved"].textContent.includes(PLATE) && !R["b10-okved"].querySelector(".pt-card"), "ОКВЭД (old): плашка вместо таблиц");
  else {
    const okSums = () => [...R["b10-okved"].querySelectorAll(".pt-grid2 > .pt-card")].map((c) => [...c.querySelectorAll("tbody tr")].reduce((s, tr) => s + Number(tr.children[2].textContent.replace(/\s| /g, "")), 0));
    ok(okSums().join() === ["A", "B", "C", "D"].map((k) => data.seg[k].clients).join(), "ОКВЭД: строки сходятся с сегментами " + okSums().join("/"));
    click(R["b10-okved"].querySelector('.pt-tabs button[data-v="grp"]'));
    ok(/\d{2}\.\d{2}/.test(R["b10-okved"].querySelector(".pt-grid2 tbody tr td:nth-child(2)").textContent), "ОКВЭД: переключатель «Полный код» показывает коды вида 47.11");
    const setRange = (side, v) => { const e = R["b10-okved"].querySelector('[data-range="' + side + '"]'); e.value = v; e.dispatchEvent(new w.Event("input", { bubbles: true })); };
    const inRange = data.act.rows.filter((r) => r[6] >= 2 && r[6] <= 5).length;
    setRange("from", "2"); setRange("to", "5");
    const sums = okSums();
    ok(sums[0] === 0 && sums[1] === 0 && sums[3] === 0 && sums[2] === inRange && R["b10-okved"].textContent.replace(/\s+/g, " ").includes("В выборке: " + n(inRange) + " клиентов"), "ОКВЭД: касс 2–5 → только сегмент C, клиентов " + inRange);
    const okvedCsv = grab(R["b10-okved"].querySelector('[data-csv="okved"]')).replace(/^﻿/, "").split("\r\n");
    ok(okvedCsv.length === inRange + 1 && okvedCsv[0].split(";").length === 13, "ОКВЭД: CSV " + (okvedCsv.length - 1) + " строк = выборка, 13 колонок");
    setRange("from", ""); setRange("to", "");
    ok(okSums().join() === ["A", "B", "C", "D"].map((k) => data.seg[k].clients).join(), "ОКВЭД: после очистки диапазона суммы вернулись");
  }
  ok(R["b10-tariffs"].querySelectorAll(".pt-tag").length >= 6, "тарифы: все 6 сроков в таблице");
  // портрет ИП
  if (OLD) ok(R["b10-ip"].textContent.includes(PLATE) && !R["b10-ip"].querySelector(".pt-card"), "ИП (old): плашка");
  else {
    const tiles = [...R["b10-ip"].querySelectorAll(".pt-tiles .pt-tv")].map((e) => e.textContent.replace(/\s+/g, " "));
    ok(tiles.join("|") === [data.ip.clients, data.ip.kassas, data.ip.liq].map(n).join("|"), "ИП: плитки клиентов/касс/ликвидированных = данные (" + tiles.join(" / ") + ")");
    const ipRows = [...R["b10-ip"].querySelectorAll(".pt-ip-grid .pt-table tbody tr")].reduce((s, tr) => s + Number(tr.children[2].textContent.replace(/\s| /g, "")), 0);
    ok(ipRows === data.ip.clients, "ИП: Σ строк видов деятельности = клиентов ИП " + n(ipRows));
    ok(R["b10-ip"].querySelectorAll(".pt-ip-share").length === 4 && R["b10-ip"].querySelectorAll("[data-metric]").length === 3, "ИП: 4 доли внутри сегментов и блок тарифа из 3 показателей");
  }
  // срок жизни клиента
  if (OLD) ok(R["b10-life"].textContent.includes(PLATE) && !R["b10-life"].querySelector(".pt-card"), "срок жизни (old): плашка");
  else {
    ok(R["b10-life"].querySelectorAll(".pt-card").length === 4, "срок жизни: по умолчанию 4 карточки сегментов");
    click([...R["b10-life"].querySelectorAll(".pt-tabs button")].find((b) => b.textContent === "По каналам продаж"));
    const labels = [...R["b10-life"].querySelectorAll(".pt-life-label")].map((e) => e.textContent);
    ok(R["b10-life"].querySelectorAll(".pt-card").length === 5 && labels.join("|") === w.OFDMetrics.CHANNELS.join("|") && labels.join("|") === data.lifeC.chan.map((c) => c.label).join("|"), "срок жизни: 5 каналов в порядке M.CHANNELS (" + labels.join(", ") + ")");
    ok(txt("b10-life").includes("не совпадают") && txt("b10-life").includes("включая ушедших"), "срок жизни: сноска про отличие от «Каналов продаж»");
    click([...R["b10-life"].querySelectorAll(".pt-tabs button")].find((b) => b.textContent.startsWith("По сегментам")));
    ok(R["b10-life"].querySelectorAll(".pt-card").length === 4 && !txt("b10-life").includes("не совпадают"), "срок жизни: возврат на вкладку сегментов");
  }
  click(R["b10-top"].querySelector('.pt-tabs button[data-v="C"]')); ok(R["b10-top"].querySelectorAll("tbody tr").length === 10, "топ-клиенты: переключение сегмента, 10 строк");
  // регионы
  const rt = R["b10-regions"].querySelector("table"); const rrows = () => [...rt.querySelectorAll("tbody tr:not(.pt-tot)")];
  const sumCol = (i) => rrows().reduce((s, tr) => s + (Number(tr.children[i].textContent.replace(/\s| /g, "").replace(/·.*/, "")) || 0), 0);
  ok(rrows().length >= 85, "регионы: строк " + rrows().length);
  const marketSum = Object.values(data.reg).reduce((s, r) => s + r.market, 0);
  ok(sumCol(2) === marketSum, "регионы: рынок ФНС " + n(marketSum) + " (в таблице " + n(sumCol(2)) + ")");
  ok(sumCol(5) === data.tot.clients, "регионы: клиентов сейчас " + n(data.tot.clients));
  ok(rt.querySelector("thead tr").lastElementChild.textContent.startsWith("Ликвидировано"), "регионы: «Ликвидировано» крайний правый столбец");
  const aliveCol = [...rt.querySelectorAll("th")].findIndex((x) => x.textContent.startsWith("Отвалились")); click(rt.querySelectorAll("th")[aliveCol]);
  const aliveVals = rrows().map((tr) => Number(tr.children[aliveCol].textContent.replace(/\s| /g, "").replace(/·.*/, "")) || 0);
  ok(aliveVals.length > 1 && aliveVals.every((v, i, a) => i === 0 || v <= a[i - 1]) && aliveVals[0] > aliveVals[aliveVals.length - 1], "регионы: сортировка по «Отвалились…» — значения не возрастают (макс. " + aliveVals[0] + ")");
  const sel = R["b10-regions"].querySelector("select"); sel.value = "A"; sel.dispatchEvent(new w.Event("change"));
  ok(sumCol(5) === data.seg.A.clients, "регионы: фильтр сегмента A = " + data.seg.A.clients);
  // кого вернуть
  const rtn = R["b10-return"], rtab = rtn.querySelector("table"), heads = () => [...rtab.querySelectorAll("thead th")];
  const prs = () => {
    const col = heads().findIndex((th) => th.textContent.startsWith("Шанс вернуться"));
    return [...rtab.querySelectorAll("tbody tr")].map((tr) => parseFloat(tr.children[col].textContent.replace(",", ".")));
  };
  const kpiCount = () => Number([...rtn.querySelectorAll(".pt-tile")].find((t) => t.querySelector(".pt-tl").textContent === "В текущей выборке").querySelector(".pt-tv").textContent.replace(/\s| /g, ""));
  const fsel = (f) => rtn.querySelector('select[data-f="' + f + '"]'); const set = (f, v) => { fsel(f).value = v; fsel(f).dispatchEvent(new w.Event("change", { bubbles: true })); };
  const finput = (f, v) => { const e = rtn.querySelector('input[data-f="' + f + '"]'); e.value = v; e.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const cols = (re) => heads().findIndex((th) => re.test(th.textContent));
  ok(rtab.querySelectorAll("tbody tr").length === 50, "возврат: 50 строк на экране");
  if (OLD) {
    ok(!rtn.querySelector('[data-f="width"]') && !fsel("window") && !rtn.querySelector('[data-now="true"]'), "возврат (old): нет поля окна, фильтра окна и открытых окон");
    ok([...rtab.querySelectorAll("tbody tr")].every((tr) => [cols(/Код закончился/), cols(/Последний тариф/), cols(/Окно звонка/)].every((i) => tr.children[i].textContent === "—")), "возврат (old): новые колонки показывают «—»");
    ok(heads()[cols(/^Касс/)].textContent.startsWith("Касс") && !heads()[cols(/^Касс/)].textContent.includes("18"), "возврат (old): колонка называется «Касс» без обещания про 18 мес.");
    ok(prs().every((v, i, a) => i === 0 || v <= a[i - 1]), "возврат (old): по умолчанию шанс по убыванию, топ " + prs()[0] + "%");
  } else {
    ok(rtab.querySelector("th.sorted").textContent.startsWith("Окно звонка"), "возврат: стартовая сортировка по окну звонка");
    const flags = [...rtab.querySelectorAll("tbody tr")].map((tr) => tr.dataset.now), firstFalse = flags.indexOf("false");
    ok(firstFalse < 0 || flags.indexOf("true", firstFalse) < 0, "возврат: «Звонить сейчас» идут первыми, затем будущие окна");
    click(heads().find((th) => th.textContent.startsWith("Шанс вернуться")));
    ok(prs().every((v, i, a) => i === 0 || v <= a[i - 1]), "возврат: после клика шанс по убыванию, топ " + prs()[0] + "%");
  }
  ok(rtn.textContent.replace(/\s/g, " ").includes(n(data.cand.stats.alive)), "возврат: живых отвалившихся " + n(data.cand.stats.alive));
  const kassOf = (r) => r[13] ?? r[4];
  set("seg", "A"); ok(/в текущей выборке/i.test(rtn.textContent) && kpiCount() === data.cand.rows.filter((r) => kassOf(r) >= 10).length, "возврат: сегмент A = " + data.cand.rows.filter((r) => kassOf(r) >= 10).length);
  set("min", "30"); ok(prs().every((v) => v >= 30), "возврат: порог 30% применён"); set("seg", "all"); set("min", "0");
  if (!OLD) {
    const U = w.OFDPortraitUtil, expNow = data.cand.rows.filter((r) => { const cw = U.callWindow(r[11], r[12], data.meta.asOf, 30); return cw && cw.now; }).length;
    set("window", "now");
    ok(kpiCount() === expNow && [...rtab.querySelectorAll("tbody tr")].every((tr) => tr.dataset.now === "true"), "возврат: окно «Звонить сейчас» → " + expNow + " клиентов");
    set("window", "all");
    const expRange = data.cand.rows.filter((r) => kassOf(r) >= 2 && kassOf(r) <= 5).length;
    finput("kassFrom", "2"); finput("kassTo", "5");
    ok(kpiCount() === expRange, "возврат: касс 2–5 по «касс за 18 мес. до ухода» → " + expRange + " клиентов");
    finput("kassFrom", ""); finput("kassTo", "");
    ok(kpiCount() === data.cand.rows.length, "возврат: после очистки диапазона вся выборка " + n(data.cand.rows.length));
  }
  // CSV: захват через Blob
  const csv = grab(rtn.querySelector('[data-csv="return"]'));
  const lines = csv.replace(/^﻿/, "").split("\r\n"); ok(lines.length === data.cand.rows.length + 1, "CSV: строк " + (lines.length - 1) + " = кандидатов");
  ok(lines[0].includes('"Телефон"') && lines[0].includes('"Email"'), "CSV: колонки Телефон и Email");
  ok(lines[0].split(";").length === 16 && ["Код закончился", "Последний тариф, мес.", "Окно с", "Окно по", "Касс за 18 мес. до ухода"].every((h, i) => lines[0].split(";")[11 + i] === '"' + h + '"'), "CSV: 16 колонок, пять новых в конце в нужном порядке");
  const tail5 = lines.slice(1).filter((l) => /;"";"";"";"";""$/.test(l)).length;
  ok(OLD ? tail5 === lines.length - 1 : !lines.slice(1).some((l) => /;""$/.test(l)) && tail5 === 0, OLD ? "CSV (old): пять новых полей пусты у всех" : "CSV: у всех кандидатов заполнена «Касс за 18 мес. до ухода»");
  const withPh = lines.slice(1).filter((l) => !/^[^;]*;[^;]*;"";/.test(l)).length; const expPh = data.cand.rows.filter((r) => r[9]).length;
  ok(withPh === expPh, "CSV: телефон у " + n(withPh) + " из " + n(lines.length - 1) + " (в данных " + n(expPh) + ")");
  ok(/^"="\d+""?/.test(lines[1]) || lines[1].startsWith('"=""') || lines[1].startsWith('"="'), "CSV: ИНН защищён от потери нуля");
  ok(R["b10-model"].textContent.includes("AUC") && R["b10-model"].querySelectorAll(".pt-cal tbody tr").length >= 17, "модель: AUC, калибровка и таблица по времени с ухода");
  ok(!/горяч/i.test(Object.values(R).map((x) => x.textContent).join(" ")), "«горячие» в виджетах нет");
  // удаление: onRemove чистит подписку
  ok(typeof W["b10-return"].onRemove === "function", "onRemove определён");
  ok(errs.length === 0, "JS-ошибок нет " + JSON.stringify(errs));
  console.log(fail ? "FAIL " + fail : "ALL OK"); process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
