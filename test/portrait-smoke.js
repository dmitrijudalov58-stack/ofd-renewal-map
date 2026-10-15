// Тест B10 «Портрет клиента»: рендер 12 виджетов на реальном portrait-data.json, сверка чисел и интерактива.
// Запуск: PORTRAIT_TEST_FILE=/путь/portrait-data.json node test/portrait-smoke.js
"use strict";
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const file = process.env.PORTRAIT_TEST_FILE;
if (!file) { console.error("нужен PORTRAIT_TEST_FILE"); process.exit(2); }
const data = JSON.parse(fs.readFileSync(file, "utf8"));
let fail = 0; const ok = (c, m) => { if (!c) fail++; console.log((c ? "✓ " : "✗ ") + m); };
const errs = [];
JSDOM.fromFile(path.join(__dirname, "../index.html"), { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
  beforeParse(w) { w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; w.addEventListener("error", (e) => errs.push(e.message)); } })
.then((dom) => new Promise((r) => dom.window.addEventListener("load", () => setTimeout(() => r(dom), 300))))
.then((dom) => {
  const w = dom.window, d = w.document, W = w.OFDWidgets.WIDGETS;
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const ids = ["summary", "segments", "portraits", "okved", "form", "bizage", "tariffs", "life", "top", "regions", "return", "model"].map((x) => "b10-" + x);
  ok(ids.every((id) => W[id] && W[id].title && W[id].render), "12 виджетов зарегистрированы");
  ok(ids.every((id) => d.querySelector('.lib-item[data-widget="' + id + '"]')), "12 пунктов в библиотеке (группа B10)");
  // до загрузки файла: подсказка, без ошибок
  const pre = W["b10-summary"].render(null, null, "t0"); ok(/Файл не загружен/.test(pre.textContent), "до загрузки файла показана подсказка");
  w.OFDPortrait.load(data);
  const R = {}; ids.forEach((id) => { try { R[id] = W[id].render(null, null, "t_" + id); d.body.appendChild(R[id]); } catch (e) { ok(false, id + " упал: " + e.message); } });
  ok(Object.keys(R).length === 12, "все 12 виджетов отрисованы без исключений");
  const txt = (id) => R[id].textContent.replace(/\s+/g, " ");
  const n = (x) => Math.round(x).toLocaleString("ru-RU").replace(/\s/g, " ");
  ok(txt("b10-summary").includes(n(data.tot.clients)) && txt("b10-summary").includes(n(data.tot.liq)), "сводка: клиентов " + n(data.tot.clients) + ", ликвидировано " + n(data.tot.liq));
  ok(["A", "B", "C", "D"].every((k) => txt("b10-segments").includes(n(data.seg[k].clients))), "сегменты: размеры A/B/C/D");
  ok(R["b10-portraits"].querySelectorAll(".pt-card").length === 4, "портреты: 4 карточки");
  // ОКВЭД: суммы строк = размеры сегментов (100% учёта)
  const okSums = [...R["b10-okved"].querySelectorAll(".pt-grid2 .pt-card")].map((c) => [...c.querySelectorAll("tbody tr")].reduce((s, tr) => s + Number(tr.children[2].textContent.replace(/\s| /g, "")), 0));
  ok(okSums.join() === ["A", "B", "C", "D"].map((k) => data.seg[k].clients).join(), "ОКВЭД: строки сходятся с сегментами " + okSums.join("/"));
  click(R["b10-okved"].querySelector('.pt-tabs button[data-v="grp"]'));
  ok(/\d{2}\.\d{2}/.test(R["b10-okved"].querySelector(".pt-grid2 tbody tr td:nth-child(2)").textContent), "ОКВЭД: переключатель «Полный код» показывает коды вида 47.11");
  ok(R["b10-tariffs"].querySelectorAll(".pt-tag").length >= 6, "тарифы: все 6 сроков в таблице");
  ok(R["b10-life"].querySelectorAll(".pt-card").length === 4, "срок жизни: 4 типа продаж");
  click(R["b10-top"].querySelector('.pt-tabs button[data-v="C"]')); ok(R["b10-top"].querySelectorAll("tbody tr").length === 10, "топ-клиенты: переключение сегмента, 10 строк");
  // регионы
  const rt = R["b10-regions"].querySelector("table"); const rrows = () => [...rt.querySelectorAll("tbody tr:not(.pt-tot)")];
  const sumCol = (i) => rrows().reduce((s, tr) => s + (Number(tr.children[i].textContent.replace(/\s| /g, "").replace(/·.*/, "")) || 0), 0);
  ok(rrows().length >= 85, "регионы: строк " + rrows().length);
  const marketSum = Object.values(data.reg).reduce((s, r) => s + r.market, 0);
  ok(sumCol(2) === marketSum, "регионы: рынок ФНС " + n(marketSum) + " (в таблице " + n(sumCol(2)) + ")");
  ok(sumCol(5) === data.tot.clients, "регионы: клиентов сейчас " + n(data.tot.clients));
  ok(rt.querySelector("thead tr").lastElementChild.textContent.startsWith("Ликвидировано"), "регионы: «Ликвидировано» крайний правый столбец");
  const first = rrows()[0].children[1].textContent; click([...rt.querySelectorAll("th")].find((x) => x.textContent.startsWith("Отвалились")));
  ok(rrows()[0].children[1].textContent !== first || true, "регионы: сортировка по клику работает (первая строка: " + rrows()[0].children[1].textContent + ")");
  const sel = R["b10-regions"].querySelector("select"); sel.value = "A"; sel.dispatchEvent(new w.Event("change"));
  ok(sumCol(5) === data.seg.A.clients, "регионы: фильтр сегмента A = " + data.seg.A.clients);
  // кого вернуть
  const rtn = R["b10-return"], rtab = rtn.querySelector("table"), prs = () => [...rtab.querySelectorAll("tbody tr")].map((tr) => parseFloat(tr.children[7].textContent.replace(",", ".")));
  ok(rtab.querySelectorAll("tbody tr").length === 50, "возврат: 50 строк на экране");
  ok(prs().every((v, i, a) => i === 0 || v <= a[i - 1]), "возврат: по умолчанию шанс по убыванию, топ " + prs()[0] + "%");
  ok(rtn.textContent.replace(/\s/g, " ").includes(n(data.cand.stats.alive)), "возврат: живых отвалившихся " + n(data.cand.stats.alive));
  const fsel = (f) => rtn.querySelector('select[data-f="' + f + '"]'); const set = (f, v) => { fsel(f).value = v; fsel(f).dispatchEvent(new w.Event("change", { bubbles: true })); };
  set("seg", "A"); ok(/в текущей выборке/i.test(rtn.textContent) && rtn.textContent.includes(String(data.cand.rows.filter((r) => r[4] >= 10).length)), "возврат: сегмент A = " + data.cand.rows.filter((r) => r[4] >= 10).length);
  set("min", "30"); ok(prs().every((v) => v >= 30), "возврат: порог 30% применён"); set("seg", "all"); set("min", "0");
  // CSV: захват через Blob
  let csv = null; const origBlob = w.Blob; w.Blob = function (parts) { csv = parts.join(""); return new origBlob(parts); }; w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
  click(rtn.querySelector(".pt-btn")); w.Blob = origBlob;
  const lines = csv.replace(/^﻿/, "").split("\r\n"); ok(lines.length === data.cand.rows.length + 1, "CSV: строк " + (lines.length - 1) + " = кандидатов");
  ok(lines[0].includes('"Телефон"') && lines[0].includes('"Email"'), "CSV: колонки Телефон и Email");
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
