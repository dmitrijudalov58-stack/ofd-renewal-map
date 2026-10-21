// B10: расширяемый jsdom-харнесс на синтетических данных обеих схем.
// Запуск: TZ=Europe/Moscow node test/b10-widgets.test.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const { JSDOM } = require("jsdom");
const { makeV2, makeV1 } = require("./fixtures/b10-fixture.js");
const IDS = ["summary", "segments", "portraits", "okved", "form", "bizage", "tariffs", "life", "top", "regions", "return", "model"].map((s) => "b10-" + s);

async function loadPage(data) {
  const errs = [];
  const dom = await JSDOM.fromFile(path.join(__dirname, "../index.html"), {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    beforeParse(w) {
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.addEventListener("error", (e) => errs.push(e.message));
      // jsdom не реализует object URLs. revoke вызывается виджетом отложенно,
      // поэтому базовые заглушки живут до w.close(), вне captureCsv().
      w.URL.createObjectURL = () => "blob:jsdom";
      w.URL.revokeObjectURL = () => {};
    },
  });
  const w = dom.window, d = w.document;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("index.html: load timeout")), 10000);
      const loaded = () => { clearTimeout(timeout); setTimeout(resolve, 300); };
      if (d.readyState === "complete") loaded();
      else w.addEventListener("load", loaded, { once: true });
    });
    w.OFDPortrait.load(data);
  } catch (e) { w.close(); throw e; }
  const W = w.OFDWidgets.WIDGETS;
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const set = (el, value) => {
    el.value = String(value);
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const render = (id) => {
    const el = W[id].render(null, null, "t_" + id);
    d.body.appendChild(el);
    return el;
  };
  // Синхронный callback, например () => click(widget.querySelector('.pt-btn')).
  // Все подмены восстанавливаются и при исключении. Результат — последний CSV.
  const captureCsv = (fn) => {
    const Blob = w.Blob, create = w.URL.createObjectURL, revoke = w.URL.revokeObjectURL;
    const proto = w.HTMLAnchorElement.prototype, anchorClick = proto.click;
    const blobs = new WeakMap(), urls = new Map();
    let captured = { name: null, text: null };
    try {
      w.Blob = function (parts, options) {
        const blob = new Blob(parts, options);
        blobs.set(blob, parts.join(""));
        return blob;
      };
      w.URL.createObjectURL = (blob) => {
        const url = "blob:b10-test-" + urls.size;
        urls.set(url, blobs.get(blob));
        return url;
      };
      w.URL.revokeObjectURL = () => {};
      proto.click = function () { captured = { name: this.download, text: urls.get(this.href) }; };
      fn();
      return captured;
    } finally {
      w.Blob = Blob; w.URL.createObjectURL = create; w.URL.revokeObjectURL = revoke; proto.click = anchorClick;
    }
  };
  // Закрывать страницу после проверок через w.close(): это отменяет её таймеры.
  return { w, d, W, errs, click, set, render, captureCsv };
}

let total = 0, fail = 0;
const ok = (cond, msg) => { total++; if (!cond) fail++; console.log((cond ? "✓ " : "✗ ") + msg); };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (_) { return false; } };
const segOf = (n) => n >= 10 ? "A" : n >= 6 ? "B" : n >= 2 ? "C" : "D";

async function main() {
  const pages = [];
  try {
    const v2 = makeV2(), v1 = makeV1(), keys = ["A", "B", "C", "D"];

    // S6a: существующие 12 виджетов работают на обеих схемах без красной фазы.
    const p2 = await loadPage(v2); pages.push(p2);
    const p1 = await loadPage(v1); pages.push(p1);
    const R2 = {}, R1 = {};
    for (const [label, page, rendered] of [["V2", p2, R2], ["V1", p1, R1]]) {
      ok(IDS.every((id) => page.W[id] && page.W[id].title && typeof page.W[id].render === "function"), label + ": 12 виджетов зарегистрированы");
      for (const id of IDS) {
        try {
          rendered[id] = page.render(id);
          ok(rendered[id].isConnected && rendered[id].textContent.length > 0, label + ": " + id + " отрисован");
        } catch (e) { ok(false, label + ": " + id + " упал: " + e.message); }
      }
    }

    // S6a: CSV перехватывается вместе с именем; подмены не текут между вызовами.
    for (const [label, page, rendered, data] of [["V2", p2, R2, v2], ["V1", p1, R1, v1]]) {
      const original = [page.w.Blob, page.w.URL.createObjectURL, page.w.URL.revokeObjectURL, page.w.HTMLAnchorElement.prototype.click];
      const csv = page.captureCsv(() => page.click(rendered["b10-return"].querySelector(".pt-btn")));
      ok(csv.name === "otvalivshiesya-shans-vernutsya.csv", label + ": CSV — имя из a.download");
      ok(typeof csv.text === "string" && csv.text.startsWith("\uFEFF"), label + ": CSV содержит BOM");
      ok(typeof csv.text === "string" && csv.text.replace(/^\uFEFF/, "").split("\r\n").length === data.cand.rows.length + 1, label + ": CSV содержит всех 75 кандидатов и заголовок");
      ok([page.w.Blob, page.w.URL.createObjectURL, page.w.URL.revokeObjectURL, page.w.HTMLAnchorElement.prototype.click].every((x, i) => x === original[i]), label + ": captureCsv восстановил API");
      const sentinel = new Error("capture callback"), caught = [];
      try { page.captureCsv(() => { throw sentinel; }); } catch (e) { caught.push(e); }
      ok(caught[0] === sentinel && page.w.Blob === original[0] && page.w.HTMLAnchorElement.prototype.click === original[3], label + ": captureCsv восстанавливает API при исключении");
    }
    // S6a: детерминизм, глубокая независимость вызовов и совместимость V1.
    const a = makeV2(), b = makeV2(), old = makeV1();
    ok(equal(a, b), "makeV2: повторные вызовы deep-equal");
    ok(equal(old, makeV1()), "makeV1: повторные вызовы deep-equal");
    const refs = new Set();
    const visit = (x, fn) => { if (x && typeof x === "object") { fn(x); Object.values(x).forEach((v) => visit(v, fn)); } };
    visit(a, (x) => refs.add(x));
    let shared = false;
    visit(b, (x) => { if (refs.has(x)) shared = true; });
    visit(old, (x) => { if (refs.has(x)) shared = true; });
    ok(!shared, "объекты и массивы разных вызовов не разделяют ссылки");
    a.meta.asOf = "2000-01-01"; a.act.rows[0][0] = "Изменено"; a.cand.rows[0][4] = 999; a.reg["01"].cur.A[0] = 999;
    ok(equal(b, v2), "мутация вложенных полей V2 не затрагивает другой объект");
    old.seg.A.form[0][1] = 999; old.cand.rows[0][0] = "Изменено";
    ok(equal(v1, makeV1()), "мутация V1 не затрагивает другой объект");
    ok(v2.meta.asOf === "2026-10-21" && v1.meta.asOf === "2026-10-21", "фиксированная дата asOf");
    ok(v2.meta.schema === 2 && !Object.hasOwn(v1.meta, "schema"), "маркер schema есть только в V2");
    ok(["t36", "lifeC", "ip", "act"].every((k) => Object.hasOwn(v2, k) && !Object.hasOwn(v1, k)), "новые разделы есть только в V2");
    const projected = makeV2(); delete projected.meta.schema;
    for (const k of ["t36", "lifeC", "ip", "act"]) delete projected[k];
    projected.cand.rows = projected.cand.rows.map((r) => r.slice(0, 11));
    ok(equal(projected, v1), "V1 сохраняет все старые данные V2 без изменений");
    const source = fs.readFileSync(path.join(__dirname, "fixtures/b10-fixture.js"), "utf8");
    ok(!/Math\s*\.\s*random/.test(source), "в исходнике фикстуры нет Math.random");

    // S6a: безопасная синтетика и размеры кортежей.
    const active = v2.act.rows, cand = v2.cand.rows;
    const identities = active.map((r) => [r[1], r[3]]).concat(cand.map((r) => [r[8], r[3]]));
    ok(identities.every(([id, form]) => (form === 0 ? /^9999\d{8}$/ : /^9999\d{6}$/).test(id)), "все ИНН начинаются с 9999: 12 цифр ИП, 10 ЮЛ");
    ok(new Set(identities.map(([id]) => id)).size === identities.length, "ИНН действующих и кандидатов уникальны");
    const contacts = active.map((r) => [r[10], r[11]]).concat(cand.map((r) => [r[9], r[10]]));
    ok(contacts.every(([ph, em]) => (!ph || /^\+7 \(000\) \d{3}-\d{2}-\d{2}$/.test(ph)) && (!em || /^[^@]+@example\.invalid$/.test(em))), "контакты используют только тестовые телефоны и example.invalid");
    ok(active.length === 197 && v2.tot.clients === 197, "act и tot: 197 действующих клиентов");
    ok(active.every((r) => r.length === 13) && v2.act.cols.length === 13, "act: 13 полей в каждой строке и cols");
    ok(cand.length === 75 && cand.every((r) => r.length === 14), "V2: 70 + 5 кандидатов по 14 полей");
    ok(v1.cand.rows.length === 75 && v1.cand.rows.every((r) => r.length === 11), "V1: 75 кандидатов по 11 полей");
    ok(equal(keys.map((k) => active.filter((r) => segOf(r[6]) === k).length), [5, 12, 60, 120]), "act: размеры сегментов A/B/C/D = 5/12/60/120");
    ok(active.reduce((n, r) => n + r[6], 0) === v2.tot.kassas && keys.every((k) => active.filter((r) => segOf(r[6]) === k).reduce((n, r) => n + r[6], 0) === v2.seg[k].kassas), "суммы касс act, seg и tot согласованы");
    ok(active.filter((r) => r[3] === 0).length >= 30 && active.filter((r) => r[12] === 1).length >= 8, "act: не менее 30 ИП и 8 ликвидированных");
    ok(v2.act.contacts === true && new Set(active.map((r) => r[4])).size >= 6, "act: контакты включены, не менее 6 регионов");
    ok(v2.act.regs.some((_, i) => active.filter((r) => r[4] === i && r[6] >= 2 && r[6] <= 5).length >= 10), "act: не менее 10 клиентов C в одном регионе");
    const usedGroups = [...new Set(active.map((r) => r[5]))].map((i) => v2.act.grps[i]);
    ok(usedGroups.filter((g) => g[2] && g[2] !== "old").length >= 8 && new Set(usedGroups.map((g) => g[2]).filter((c) => c && c !== "old")).size >= 4, "act: минимум 8 групп из 4 разделов ОКВЭД");
    ok(usedGroups.some((g) => equal(g, ["", "", ""])) && usedGroups.some((g) => g[2] === "old"), "act: представлены неуказанный и старый ОКВЭД");
    ok(active.every((r) => v2.act.regs[r[4]] && v2.act.grps[r[5]]) && cand.every((r) => v2.cand.regs[r[1]] && v2.cand.secs[r[2]]), "индексы регионов и отраслей разрешаются в справочниках");
    ok(Object.keys(v2.reg).length >= 90 && Object.values(v2.reg).every((r) => keys.every((k) => r.cur[k].length === 4 && r.aug[k].length === 2)), "reg: 90 регионов с cur[4] и aug[2]");
    ok(keys.every((k) => v2.top[k].length === 10) && v2.life.length === 4, "старые top: по 10 строк; life: 4 типа продаж");
    ok(keys.every((k) => Object.keys(v2.tariff.seg[k]).length === 6 && Object.hasOwn(v2.tariff.seg[k], "36 месяцев")), "тарифы: 6 сроков в каждом сегменте");

    // S6a: фиксированные t36 и агрегаты новой схемы.
    const valid36 = (t) => Number.isInteger(t.K) && t.K >= 0 && t.K <= t.M && t.M <= t.kassas && t.clients36 <= t.clients && t.clients36 <= t.K;
    for (const k of keys) {
      ok(valid36(v2.t36[k]) && v2.t36[k].kassas === v2.seg[k].kassas && v2.t36[k].clients === v2.seg[k].clients, "t36." + k + ": инварианты и размеры сегмента");
    }
    ok(v2.t36.D.K === v2.t36.D.clients36 && v2.t36.D.K === v2.t36.D.M, "t36.D: K = clients36 = M");
    ok(v2.t36.C.K === 17 && v2.t36.C.kassas === 180, "t36.C: ровно 17 из 180 касс");
    ok(valid36(v2.ip.t36) && v2.ip.t36.clients === v2.ip.clients && v2.ip.t36.kassas === v2.ip.kassas, "ip.t36: инварианты и размеры ИП");
    ok(v2.ip.clients === active.filter((r) => r[3] === 0).length && v2.ip.kassas === active.filter((r) => r[3] === 0).reduce((n, r) => n + r[6], 0), "ip: клиенты и кассы совпадают с act");
    ok(v2.ip.grp.length === 10 && v2.ip.region.length === 5 && equal(v2.ip.bizAge.map((r) => r[0]), ["<1 г", "1–3 г", "3–7 г", "7+ лет"]), "ip: 10 групп, 5 регионов, 4 возраста по порядку");
    ok(equal(v2.lifeC.chan.map((c) => c.label), ["Корп", "Ольга Зибер", "Пенигина — прямые", "Пенигина — ОП", "Партнёры"]) && Object.keys(v2.lifeC.chanActive).length === 5, "lifeC: 5 каналов в заданном порядке");
    ok(keys.reduce((n, k) => n + v2.lifeC.seg[k].clients, 0) === v2.lifeC.chan.reduce((n, c) => n + c.clients, 0) && Object.values(v2.lifeC.chanActive).reduce((n, c) => n + c, 0) === 197, "lifeC: суммы клиентов сегментов и каналов сходятся");

    // S6a: стабильные кандидаты для проверок окна звонка и kass18 следующих слайсов.
    const named = (id) => cand.filter((r) => r[8] === id);
    for (const id of ["9999000001", "9999000002", "9999000003", "9999000004", "9999000005"]) {
      ok(named(id).length === 1, "именованный кандидат " + id + " присутствует ровно один раз");
    }
    const row = (id) => named(id)[0];
    ok(equal([row("9999000001")[4], ...row("9999000001").slice(11)], [5, "2025-01-31", 13, 3]), "9999000001: 5 касс, дата 31.01.2025, тариф 13, kass18 = 3");
    ok(equal(row("9999000002").slice(11), [null, null, null]), "9999000002: дата, тариф и kass18 отсутствуют");
    ok(equal([row("9999000003")[4], ...row("9999000003").slice(11)], [2, "2026-09-15", 1, 2]), "9999000003: сценарий «Звонить сейчас»");
    ok(row("9999000004")[4] === 12 && row("9999000004")[13] === 7, "9999000004: 12 касс за историю, 7 перед уходом");
    ok(row("9999000005")[4] === 3 && row("9999000005")[13] === 2, "9999000005: 3 кассы за историю, 2 перед уходом");
    ok(cand.every((r) => r[11] === null || /^\d{4}-\d{2}-\d{2}$/.test(r[11])) && cand.every((r) => r[13] === null || Number.isInteger(r[13]) && r[13] >= 1), "даты кандидатов — ISO, kass18 — целое >= 1 или null");

    // S6b: Тариф 36 мес.
    // Ожидания считаем из исходных полей, без OFDPortraitUtil и функций виджета.
    const percent36 = (n, total) => total === 0 ? "—" : (n / total * 100).toFixed(1).replace(".", ",") + "%";
    const number36 = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    const metric36 = (card, name) => card.querySelector('.pt-t36 [data-metric="' + name + '"]');
    const value36 = (card, name) => metric36(card, name)?.querySelector(".pt-t36-value")?.textContent;
    const cards36 = [...R2["b10-portraits"].querySelectorAll(".pt-card")];
    ok(cards36.length === 4, "S6b V2: ровно 4 .pt-card");
    for (const [i, card] of cards36.entries()) {
      const k = keys[i], block = card.querySelector(".pt-t36");
      ok(card.querySelectorAll(".pt-t36").length === 1, "S6b V2 " + k + ": ровно один .pt-t36");
      ok(block?.querySelector(".pt-t36-title")?.textContent === "Тариф 36 мес.", "S6b V2 " + k + ": заголовок без метки «новое»");
      ok(equal([...card.querySelectorAll(".pt-t36 [data-metric]")].map((m) => m.dataset.metric), ["kassas", "clients", "coverage"]), "S6b V2 " + k + ": три метрики по порядку");
      ok(!!block && block.querySelectorAll(".pt-card").length === 0, "S6b V2 " + k + ": без вложенных .pt-card");
      ok((card.textContent.match(/Касс на тарифе 36 мес\./g) || []).length === 1 && metric36(card, "kassas")?.querySelector(".pt-t36-label")?.textContent === "Касс на тарифе 36 мес.", "S6b V2 " + k + ": старая строка заменена подписью метрики");
      ok(!card.textContent.includes("Пересоберите"), "S6b V2 " + k + ": без плашки пересборки");
      ok(block?.previousElementSibling?.classList.contains("pt-kvrow") && block.previousElementSibling.previousElementSibling?.textContent === "Бизнесу 7+ лет" && block.nextElementSibling?.classList.contains("pt-redline"), "S6b V2 " + k + ": блок после возраста, перед ликвидацией");
      if (k !== "D") {
        const growth = card.querySelectorAll(".pt-t36 [data-growth]");
        ok(growth.length === 1 && growth[0].dataset.growth === String(v2.t36[k].M - v2.t36[k].K), "S6b V2 " + k + ": data-growth = M − K");
        ok(growth[0]?.classList.contains("pt-grn") && growth[0].textContent === "точка роста: " + number36(v2.t36[k].M - v2.t36[k].K) + " касс вне 36 мес.", "S6b V2 " + k + ": зелёная строка точки роста");
      }
    }
    const C36 = cards36[2], c36 = v2.t36.C, D36 = cards36[3];
    ok(value36(C36, "kassas") === percent36(c36.K, c36.kassas), "S6b V2 C: доля касс K/kassas с запятой и одним знаком");
    ok(value36(C36, "clients") === number36(c36.clients36), "S6b V2 C: число клиентов clients36");
    ok(value36(C36, "coverage") === percent36(c36.K, c36.M), "S6b V2 C: охват K/M");
    ok(metric36(C36, "kassas")?.querySelector(".pt-sub2")?.textContent === number36(c36.K) + " из " + number36(c36.kassas) + " касс сегмента", "S6b V2 C: пояснение числа касс");
    ok(metric36(C36, "clients")?.querySelector(".pt-t36-label")?.textContent === "Клиентов на тарифе 36 мес." && metric36(C36, "clients")?.querySelector(".pt-sub2")?.textContent === percent36(c36.clients36, c36.clients) + " от " + number36(c36.clients) + " клиентов сегмента", "S6b V2 C: подпись и доля клиентов");
    ok(metric36(C36, "coverage")?.querySelector(".pt-t36-label")?.textContent === "Охват 36 мес. внутри этих клиентов" && metric36(C36, "coverage")?.querySelector(".pt-sub2")?.textContent === number36(c36.K) + " из " + number36(c36.M) + " касс этих клиентов", "S6b V2 C: подпись и пояснение охвата");
    const dCoverage36 = metric36(D36, "coverage")?.querySelector(".pt-t36-value");
    ok(value36(D36, "coverage") === "—", "S6b V2 D: охват — прочерк");
    ok(dCoverage36?.title === "у клиента одна касса, охват всегда 100%" && dCoverage36?.getAttribute("tabindex") === "0", "S6b V2 D: пояснение доступно с клавиатуры");
    ok(metric36(D36, "coverage")?.querySelector(".pt-sub2")?.textContent === "У клиента одна касса, охват всегда 100%", "S6b V2 D: пояснение под значением");
    ok(D36.querySelectorAll("[data-growth]").length === 0 && !D36.textContent.includes("точка роста"), "S6b V2 D: нет точки роста и data-growth");

    const oldCards36 = [...R1["b10-portraits"].querySelectorAll(".pt-card")];
    ok(oldCards36.length === 4, "S6b V1: ровно 4 карточки");
    for (const [i, card] of oldCards36.entries()) {
      ok(card.querySelectorAll(".pt-t36").length === 1 && card.querySelector(".pt-t36-title")?.textContent === "Тариф 36 мес.", "S6b V1 " + keys[i] + ": блок с заголовком");
      ok(card.querySelector(".pt-t36 .placeholder-body")?.textContent === "Пересоберите portrait-data.json: нужна версия 2 (scripts/build-portrait-data.js).", "S6b V1 " + keys[i] + ": плашка пересборки внутри блока");
      ok(card.querySelectorAll("[data-metric]").length === 0, "S6b V1 " + keys[i] + ": без метрик");
      ok(!!card.querySelector(".pt-kv") && !!card.querySelector(".pt-redline"), "S6b V1 " + keys[i] + ": отрасли и ликвидация сохранены");
    }
    ok(p1.errs.length === 0, "S6b V1: errs.length === 0");

    const fileTitle36 = p2.w.OFDPortrait.fileTitle;
    ok(typeof fileTitle36 === "function", "S6b: OFDPortrait.fileTitle экспортирована");
    const title36 = typeof fileTitle36 === "function" ? fileTitle36 : () => "";
    ok(title36("portrait-data.json", v2) === "portrait-data.json · данные на " + v2.meta.asOf + " · клиентов " + number36(v2.tot.clients) + " · схема 2", "S6b: подсказка V2 со схемой 2, без «без контактов»");
    const noContacts36 = makeV2(); noContacts36.act.contacts = false;
    ok(title36("portrait-data.json", noContacts36).endsWith("схема 2 · без контактов"), "S6b: подсказка V2 без контактов");
    ok(title36("portrait-data.json", v1).endsWith("старый формат — пересоберите"), "S6b: подсказка V1 предлагает пересобрать");
    const html36 = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    ok(html36.indexOf('src="js/portrait-util.js?v=1"') >= 0 && html36.indexOf('src="js/portrait-util.js?v=1"') < html36.indexOf('src="js/portrait.js'), "S6b: portrait-util подключён строго перед portrait.js");
    ok(html36.includes('src="js/portrait.js?v=3"'), "S6b/S10: portrait.js?v=3 (версия поднята в S10)");

    // Отдельные входы проверяют нулевые делители и разделитель тысяч U+00A0.
    const edge36 = makeV2();
    edge36.t36.C = { K: 1234, kassas: 10000, clients: 2000, clients36: 1234, M: 5678 };
    p2.w.OFDPortrait.load(edge36);
    const large36 = R2["b10-portraits"].querySelectorAll(".pt-card")[2];
    ok(value36(large36, "clients") === "1\u00a0234", "S6b: fmt разделяет тысячи неразрывным пробелом");
    ok(metric36(large36, "kassas")?.querySelector(".pt-sub2")?.textContent === "1\u00a0234 из 10\u00a0000 касс сегмента", "S6b: fmt в пояснении числа касс");
    ok(metric36(large36, "clients")?.querySelector(".pt-sub2")?.textContent === percent36(1234, 2000) + " от 2\u00a0000 клиентов сегмента", "S6b: fmt в пояснении клиентов");
    ok(metric36(large36, "coverage")?.querySelector(".pt-sub2")?.textContent === "1\u00a0234 из 5\u00a0678 касс этих клиентов", "S6b: fmt в пояснении охвата");
    edge36.t36.C = { K: 0, kassas: 0, clients: 0, clients36: 0, M: 0 };
    p2.w.OFDPortrait.load(edge36);
    const zero36 = R2["b10-portraits"].querySelectorAll(".pt-card")[2];
    ok(value36(zero36, "kassas") === "—", "S6b: нулевой делитель kassas → прочерк");
    ok(metric36(zero36, "clients")?.querySelector(".pt-sub2")?.textContent === "— от 0 клиентов сегмента", "S6b: нулевой делитель clients → прочерк");
    ok(value36(zero36, "coverage") === "—", "S6b: нулевой делитель M → прочерк");
    p2.w.OFDPortrait.load(v2);

    // S7: срок жизни клиента.
    // Ожидания независимы от OFDPortraitUtil и функций форматирования виджета.
    const life = R2["b10-life"], lifeOld = R1["b10-life"];
    const lifeNumber = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    const lifeMonths = (n) => n.toFixed(1).replace(".", ",");
    const lifeDuration = (n) => {
      const months = Math.floor(n);
      return Math.floor(months / 12) + " г. " + months % 12 + " мес.";
    };
    const lifeTermNote = "Срок = от начала первого кода до конца последнего (не позже as-of).";
    const lifeSegmentNote = lifeTermNote + " В базе все клиенты: действующие, ушедшие и ожидающие продления. Сегмент действующего клиента — по числу его действующих касс сейчас; ушедшего — по числу его касс за всю историю.";
    const lifeChannelNote = "Канал клиента определяется по последней кассе клиента в выгрузке — так же, как в виджете «Каналы продаж». Суммы по каналам здесь не совпадают с «Каналами продаж»: там считаются только действующие клиенты, здесь — все, включая ушедших.";
    const lifeNotes = () => [...life.querySelectorAll(".pt-note")].map((n) => n.textContent);
    const checkLifeCard = (card, x, label) => {
      ok(card?.querySelector(".pt-seg-n")?.textContent === lifeMonths(x.months) + " мес.", label + ": месяцы с запятой и одним знаком");
      ok(card?.querySelector(".pt-seg-n small")?.textContent === "мес.", label + ": единица измерения в small");
      ok(card?.querySelector(".pt-sub")?.textContent === lifeDuration(x.months) + " · " + lifeNumber(x.clients) + " клиентов", label + ": годы/месяцы и клиенты из lifeC");
      const percent = (x.liq / x.clients * 100).toFixed(1).replace(".", ",") + "%";
      ok(card?.querySelector(".pt-seg-liq .pt-liq")?.textContent === lifeNumber(x.liq) + " · " + percent && card?.querySelector(".pt-seg-liq .pt-sub")?.textContent === " ликвидировано", label + ": число и доля ликвидированных клиентов");
    };
    ok(p2.W["b10-life"].title === "Портрет: срок жизни клиента", "S7 V2: новый заголовок");
    const lifeTabs = [...life.querySelectorAll(".pt-tabs button")];
    ok(life.querySelectorAll(".pt-tabs").length === 1 && lifeTabs.length === 2, "S7 V2: две кнопки в .pt-tabs");
    ok(equal(lifeTabs.map((b) => b.textContent), ["По сегментам A/B/C/D", "По каналам продаж"]), "S7 V2: названия табов по порядку");
    ok(lifeTabs[0]?.classList.contains("on") && !lifeTabs[1]?.classList.contains("on"), "S7 V2: по умолчанию активны сегменты");
    const lifeSegCards = [...life.querySelectorAll(".pt-grid4 > .pt-card")];
    ok(lifeSegCards.length === 4 && life.querySelectorAll(".pt-card").length === 4, "S7 V2: ровно 4 карточки в .pt-grid4");
    const lifeColors = ["#2a52e0", "#7a5cf0", "#14a89a", "#e0963a"];
    const lifeRanges = ["10 и более касс", "6–9 касс", "2–5 касс", "1 касса"];
    keys.forEach((k, i) => {
      const card = lifeSegCards[i];
      ok(card?.querySelector(".pt-seg-top .pt-seg-k")?.textContent === k && card?.querySelector(".pt-seg-top .pt-pill")?.textContent === lifeRanges[i], "S7 V2 " + k + ": буква и диапазон сегмента");
      ok(card?.style.getPropertyValue("--c") === lifeColors[i], "S7 V2 " + k + ": цвет сегмента");
      checkLifeCard(card, v2.lifeC.seg[k], "S7 V2 " + k);
    });
    ok(equal(lifeNotes(), [lifeSegmentNote]), "S7 V2: полное примечание о сроке и сегментах");
    ok(!life.textContent.includes("Канал клиента") && !life.textContent.includes("не совпадают"), "S7 V2: в сегментах нет сноски про каналы");

    if (lifeTabs[1]) p2.click(lifeTabs[1]);
    ok(lifeTabs[1]?.classList.contains("on") && !lifeTabs[0]?.classList.contains("on"), "S7 V2: активен таб каналов после клика");
    const lifeChanCards = [...life.querySelectorAll(".pt-life-ch > .pt-card")];
    ok(lifeChanCards.length === 5 && life.querySelectorAll(".pt-card").length === 5, "S7 V2: ровно 5 карточек каналов");
    ok(equal([...life.querySelectorAll(".pt-life-label")].map((n) => n.textContent), ["Корп", "Ольга Зибер", "Пенигина — прямые", "Пенигина — ОП", "Партнёры"]), "S7 V2: подписи каналов в порядке файла");
    v2.lifeC.chan.forEach((x, i) => {
      const card = lifeChanCards[i];
      ok(card?.style.getPropertyValue("--c") === lifeColors[0], "S7 V2 канал " + i + ": цвет COL.A");
      checkLifeCard(card, x, "S7 V2 канал " + i);
    });
    ok(!/1[СC]|КА|Обособки/.test(life.textContent), "S7 V2: нет старых типов продаж");
    ok(lifeNotes().includes(lifeChannelNote) && life.textContent.includes("не совпадают") && life.textContent.includes("включая ушедших"), "S7 V2: обязательная сноска про каналы без изменений");
    ok(lifeNotes().includes(lifeTermNote) && !life.textContent.includes("Сегмент действующего клиента"), "S7 V2: в каналах только общее примечание про срок");
    if (lifeTabs[0]) p2.click(lifeTabs[0]);
    ok(lifeTabs[0]?.classList.contains("on") && !lifeTabs[1]?.classList.contains("on") && life.querySelectorAll(".pt-card").length === 4, "S7 V2: возврат на 4 карточки сегментов");
    ok(equal(lifeNotes(), [lifeSegmentNote]) && !life.textContent.includes("Канал клиента") && !life.textContent.includes("включая ушедших"), "S7 V2: сноска каналов исчезла после возврата");

    ok(lifeOld.querySelectorAll(".placeholder-body").length === 1 && lifeOld.textContent.includes("Пересоберите portrait-data.json"), "S7 V1: плашка пересборки");
    ok(lifeOld.children.length === 1 && lifeOld.querySelectorAll(".pt-card").length === 0, "S7 V1: только плашка, без карточек");
    ok(lifeOld.querySelectorAll(".pt-tabs").length === 0, "S7 V1: без табов");
    ok(p1.errs.length === 0, "S7 V1: errs.length === 0");
    ok(keys.reduce((n, k) => n + v2.lifeC.seg[k].clients, 0) === v2.lifeC.chan.reduce((n, x) => n + x.clients, 0), "S7: сумма клиентов по 4 сегментам = сумме по 5 каналам");

    // S10: Портрет ИП. Ожидания — из исходных полей, без утилит виджета.
    const ipItem = p2.d.querySelector('.lib-item[data-widget="b10-ip"]');
    const libLabel = (item) => [...(item?.childNodes || [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    ok(!!ipItem, "S10: пункт b10-ip в библиотеке");
    ok(ipItem?.previousElementSibling?.dataset.widget === "b10-form", "S10: b10-ip сразу после b10-form");
    ok(libLabel(ipItem) === "Портрет ИП" && ipItem?.querySelector(".lchip")?.textContent === "as-of", "S10: подпись и scope пункта ИП");
    ok(libLabel(p2.d.querySelector('.lib-item[data-widget="b10-life"]')) === "Срок жизни клиента", "S10: новая подпись b10-life");
    ok(p2.d.querySelectorAll('.lib-item[data-widget^="b10-"]').length === 13, "S10: 13 пунктов B10");
    ok(typeof p2.W["b10-ip"]?.render === "function", "S10: b10-ip зарегистрирован");
    ok(p2.W["b10-ip"]?.title === "Портрет: ИП" && p2.W["b10-ip"]?.type === "карточки + таблица" && p2.W["b10-ip"]?.defaultH === 12, "S10: метаданные виджета");
    // При отсутствующем виджете продолжаем проверки, чтобы красная фаза дала полный FAIL.
    const renderIP = (page) => page.W["b10-ip"] ? page.render("b10-ip") : page.d.createElement("div");
    const ipWidget = renderIP(p2), ip = v2.ip;
    const tilesIP = [...ipWidget.querySelectorAll(".pt-tiles .pt-tile")];
    ok(ipWidget.querySelector("p.pt-sub")?.textContent === "Единый портрет ИП по критериям ABCD-анализа · без собственной сегментации", "S10 V2: подпись единого портрета");
    ok(tilesIP.length === 3, "S10 V2: три плитки");
    ok(equal(tilesIP.map((t) => t.querySelector(".pt-tl")?.textContent), ["ИП всего · клиентов", "Касс", "Ликвидировано"]), "S10 V2: подписи плиток");
    ok(equal(tilesIP.map((t) => t.querySelector(".pt-tv")?.textContent), [ip.clients, ip.kassas, ip.liq].map(number36)), "S10 V2: значения плиток из ip");
    ok(tilesIP[0]?.classList.contains("blue") && tilesIP[2]?.classList.contains("red"), "S10 V2: цвета клиентов и ликвидации");
    ok(tilesIP[1]?.querySelector(".pt-ts")?.textContent === lifeMonths(ip.kassas / ip.clients) + " касс на клиента", "S10 V2: касс на клиента");
    ok(tilesIP[2]?.querySelector(".pt-ts")?.textContent === percent36(ip.liq, ip.clients) + " от всех ИП", "S10 V2: доля ликвидированных ИП");
    const ipRows = [...ipWidget.querySelectorAll(".pt-table tbody tr")];
    const ipRow = (label) => ipRows.find((tr) => tr.children[1]?.textContent === label);
    const rowCountIP = (tr) => Number(tr?.children[2]?.textContent.replace(/\s/g, ""));
    ok(ipRows.filter((tr) => tr.children[1]?.querySelector("b")).length === 10, "S10 V2: десять строк кодов ОКВЭД");
    ok(ip.grp.every((x, i) => ipRows[i]?.children[0]?.textContent === String(i + 1) && ipRows[i]?.children[1]?.textContent === x[0] + " " + x[1] && rowCountIP(ipRows[i]) === x[2]), "S10 V2: номера, коды, названия и числа отраслей");
    ok(ip.grp.every((x, i) => ipRows[i]?.children[3]?.textContent === percent36(x[2], ip.clients)), "S10 V2: доли отраслей от всех ИП");
    ok(ip.grp.every((x, i) => ipRows[i]?.querySelector(".pt-liq")?.textContent === number36(x[3]) + " · " + percent36(x[3], x[2])), "S10 V2: число и доля ликвидаций внутри отрасли");
    ok(rowCountIP(ipRow("Остальные виды деятельности")) === ip.clients - ip.grp.reduce((n, x) => n + x[2], 0) - ip.old - ip.noOkved, "S10 V2: остаток отраслей вычислен");
    ok(rowCountIP(ipRow("Старый код ОКВЭД-1")) === ip.old, "S10 V2: строка старого ОКВЭД");
    ok(rowCountIP(ipRow("ОКВЭД не указан в источнике")) === ip.noOkved, "S10 V2: строка без ОКВЭД");
    ok(ipRows.reduce((n, tr) => n + rowCountIP(tr), 0) === ip.clients, "S10 V2: сумма всех строк отраслей = ip.clients");
    ok(ipWidget.textContent.includes("Доля — от всех ИП. Красная метка — число и доля ликвидированных внутри вида деятельности."), "S10 V2: примечание отраслей");
    const sideIP = [...ipWidget.querySelectorAll(".pt-ip-side > .pt-card")];
    ok(equal(sideIP.map((c) => c.querySelector("h4")?.textContent), ["Срок жизни клиента", "Регионы · топ-5", "Возраст бизнеса"]), "S10 V2: три боковые карточки по порядку");
    checkLifeCard(sideIP[0], v2.lifeC.ip, "S10 V2 срок жизни ИП");
    const regionsIP = [...ipWidget.querySelectorAll(".pt-kv li")];
    ok(regionsIP.length === 5, "S10 V2: пять регионов в pt-kv");
    ok(ip.region.every((x, i) => regionsIP[i]?.querySelector("span")?.textContent === x[0] && regionsIP[i]?.querySelector("b")?.textContent === percent36(x[1], ip.clients)), "S10 V2: названия регионов и доли от всех ИП");
    const agesIP = [...ipWidget.querySelectorAll(".pt-stackb .pt-sb")];
    ok(agesIP.length === 4, "S10 V2: четыре сегмента возраста");
    ok(ip.bizAge.every((x, i) => agesIP[i]?.textContent === x[0] + " " + (x[1] / ip.clients * 100).toFixed(0) + "%" && Math.abs(parseFloat(agesIP[i]?.style.width) - x[1] / ip.clients * 100) < 0.01), "S10 V2: порядок и ширины возрастных групп");
    ok(equal(agesIP.map((a) => a.style.backgroundColor), ["rgb(217, 223, 245)", "rgb(157, 178, 242)", "rgb(95, 128, 230)", "rgb(42, 82, 224)"]), "S10 V2: цвета возрастных групп");
    ok(ip.bizAge.every((x) => sideIP[2]?.textContent.includes(x[0] + ": " + percent36(x[2], x[1]))), "S10 V2: доли ликвидированных по возрастам");
    const ipTariff = ipWidget.querySelector(".pt-ip-tariff");
    ok(ipTariff?.querySelector(".pt-t36-title")?.textContent === "Тариф 36 мес.", "S10 V2: заголовок тарифа");
    ok(equal([...(ipTariff?.querySelectorAll("[data-metric]") || [])].map((m) => m.dataset.metric), ["kassas", "clients", "coverage"]), "S10 V2: три метрики тарифа по порядку");
    ok(value36(ipWidget, "kassas") === percent36(ip.t36.K, ip.t36.kassas), "S10 V2: доля касс на 36 мес.");
    ok(value36(ipWidget, "clients") === number36(ip.t36.clients36), "S10 V2: клиентов на 36 мес.");
    ok(value36(ipWidget, "coverage") === percent36(ip.t36.K, ip.t36.M), "S10 V2: охват 36 мес.");
    ok(metric36(ipWidget, "coverage")?.querySelector("[data-growth]")?.dataset.growth === String(ip.t36.M - ip.t36.K), "S10 V2: точка роста = M − K");
    ok(metric36(ipWidget, "kassas")?.querySelector(".pt-sub2")?.textContent === number36(ip.t36.K) + " из " + number36(ip.t36.kassas) + " касс ИП", "S10 V2: подпись касс ИП");
    ok(metric36(ipWidget, "clients")?.querySelector(".pt-sub2")?.textContent === percent36(ip.t36.clients36, ip.t36.clients) + " от " + number36(ip.t36.clients) + " клиентов ИП", "S10 V2: подпись клиентов ИП");
    ok(!!ipTariff && !ipTariff.textContent.includes("сегмента"), "S10 V2: в тарифе нет слова «сегмента»");
    const sharesIP = [...ipWidget.querySelectorAll(".pt-ip-share")];
    ok(ipWidget.textContent.includes("Доля ИП внутри общих сегментов A/B/C/D") && sharesIP.length === 4, "S10 V2: четыре доли внутри общих сегментов");
    keys.forEach((k, i) => {
      const clients = v2.seg[k].clients, n = v2.seg[k].form.find((x) => x[0] === "ИП")[1], share = sharesIP[i];
      ok(share?.querySelector("b")?.textContent === k && share?.textContent === k + percent36(n, clients) + " · " + number36(n) + " из " + number36(clients), "S10 V2 " + k + ": доля ИП из seg.form");
      ok(share?.querySelector("b")?.style.color === ["rgb(42, 82, 224)", "rgb(122, 92, 240)", "rgb(20, 168, 154)", "rgb(224, 150, 58)"][i], "S10 V2 " + k + ": цвет буквы сегмента");
      ok(Math.abs(parseFloat(share?.querySelector(".pt-bar i")?.style.width) - n / clients * 100) < 0.01, "S10 V2 " + k + ": ширина полосы ИП");
    });
    ok(ipWidget.querySelectorAll(".pt-card .pt-card").length === 0, "S10 V2: нет вложенных карточек");
    ok(!/NaN|undefined/.test(ipWidget.textContent), "S10 V2: нет NaN/undefined");
    ok(!/МАКЕТ|вариант 1|новое/.test(ipWidget.textContent), "S10 V2: нет меток драфта");

    const zeroIP = makeV2(); zeroIP.ip.clients = 0;
    p2.w.OFDPortrait.load(zeroIP);
    const zeroIPWidget = renderIP(p2);
    ok(zeroIPWidget.querySelectorAll(".pt-tile").length === 3 && !/NaN|undefined/.test(zeroIPWidget.innerHTML), "S10 V2: ноль ИП рисуется без NaN и исключений");
    ok(zeroIPWidget.querySelectorAll(".pt-tile")[1]?.querySelector(".pt-ts")?.textContent === "— касс на клиента" && zeroIPWidget.querySelectorAll(".pt-tile")[2]?.querySelector(".pt-ts")?.textContent === "— от всех ИП", "S10 V2: нулевые делители → прочерки");
    const missingIP = makeV2(); delete missingIP.ip;
    p2.w.OFDPortrait.load(missingIP);
    const missingIPWidget = renderIP(p2);
    ok(missingIPWidget.children.length === 1 && missingIPWidget.firstElementChild?.classList.contains("placeholder-body") && missingIPWidget.textContent.includes("Пересоберите portrait-data.json"), "S10 V2 без ip: только плашка пересборки");
    p2.w.OFDPortrait.load(v2);
    const oldIPWidget = renderIP(p1);
    ok(oldIPWidget.children.length === 1 && oldIPWidget.firstElementChild?.classList.contains("placeholder-body"), "S10 V1: только плашка");
    ok(oldIPWidget.textContent.includes("Пересоберите portrait-data.json") && !oldIPWidget.querySelector(".pt-card, .pt-tile, .pt-table"), "S10 V1: текст пересборки без данных");
    ok(p1.errs.length === 0, "S10 V1: errs.length === 0");

    // S8: борд Кого вернуть — колонки и окно.
    const s8 = makeV2();
    s8.cand.rows = s8.cand.rows.filter((r) => /^999900000[1-5]$/.test(r[8])).concat(s8.cand.rows.slice(0, 8));
    p2.w.OFDPortrait.load(s8);
    const ret8 = p2.render("b10-return"), U8 = p2.w.OFDPortraitUtil;
    const headers8 = () => [...ret8.querySelectorAll("thead th")].map((th) => th.textContent.replace(/ [▲▼]$/, ""));
    const trs8 = (widget = ret8) => [...widget.querySelectorAll("tbody tr")];
    const inn8 = (tr) => tr.children[1].textContent.match(/ИНН (\d+)/)[1];
    const ids8 = () => trs8().map(inn8);
    const row8 = (id) => trs8().find((tr) => inn8(tr) === "999900000" + id);
    const cell8 = (id, col) => row8(id)?.children[col]?.textContent;
    const sort8 = (key) => { const th = ret8.querySelector('th[data-k="' + key + '"]'); if (th) p2.click(th); };
    const expectOrder8 = (key, dir, width = 30) => s8.cand.rows.slice().sort((a, b) => {
      const value = (r) => key === "window" ? U8.callWindow(r[11], r[12], s8.meta.asOf, width)?.start.getTime() ?? null
        : key === "kass" ? r[13] ?? r[4] : r[{ ended: 11, tariff: 12, p: 7 }[key]];
      const aVal = value(a), bVal = value(b);
      if (aVal == null || bVal == null) return aVal == null && bVal == null ? b[7] - a[7] : aVal == null ? 1 : -1;
      return dir * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0) || b[7] - a[7];
    }).map((r) => r[8]);
    ok(s8.cand.rows.length === 13 && trs8().length === 13, "S8: все 13 строк копии фикстуры на экране");
    ok(equal(headers8(), ["#", "Клиент", "Регион", "Отрасль", "Касс за 18 мес. до ухода", "Был с нами, мес.", "Код закончился", "Последний тариф", "Окно звонка", "Шанс вернуться"]), "S8: точный порядок десяти заголовков");
    ok(ret8.querySelector('th[data-k="kass"]')?.dataset.tip === "Максимум одновременно действующих касс клиента в любой момент за 18 месяцев до окончания его последнего кода", "S8: тултип заголовка касс");
    ok([...ret8.querySelectorAll("col")].reduce((n, col) => n + parseFloat(col.style.width), 0) === 100, "S8: сумма ширин колонок 100%");
    ok(cell8(1, 6) === "31.01.2025", "S8: …01 дата 31.01.2025");
    ok(cell8(1, 7) === "13 мес.", "S8: …01 последний тариф 13 мес.");
    ok(row8(1)?.children[8]?.querySelector("b")?.textContent === "через 131 дн.", "S8: …01 окно через 131 дн.");
    ok(row8(1)?.children[8]?.querySelector(".pt-sub2")?.textContent === "01.03.2027 — 31.03.2027", "S8: …01 даты окна при W=30");
    ok(cell8(1, 4) === "3" && cell8(4, 4) === "7", "S8: кассы …01 = 3, …04 = 7");
    for (const col of [6, 7, 8]) ok(cell8(2, col) === "—", "S8: …02 прочерк в колонке " + col);
    ok(cell8(2, 4) === "1", "S8: null kass18 использует максимум за историю");
    ok(row8(3)?.children[8]?.querySelector("b.pt-grn")?.textContent === "Звонить сейчас", "S8: …03 жирное зелёное «Звонить сейчас»");
    ok(row8(3)?.dataset.now === "true", "S8: …03 data-now=true");
    ok(row8(1)?.dataset.now === "false" && row8(2)?.dataset.now === "false", "S8: будущее и null data-now=false");
    const chanceTip8 = row8(1)?.querySelector(".pt-sc")?.dataset.tip || "";
    ok(chanceTip8.includes("Касс за 18 мес. до ухода: 3") && chanceTip8.includes("Всего касс за историю: 5"), "S8: тултип шанса содержит оба значения касс");
    ok(chanceTip8.includes("Ушёл 12 мес. назад"), "S8: время ухода остаётся в тултипе");
    ok(!row8(2)?.querySelector(".pt-sc")?.dataset.tip.includes("Всего касс за историю"), "S8: без kass18 тултип не дублирует кассы");
    ok(equal(ids8(), expectOrder8("window", 1)), "S8: стартовый порядок по началу окна и шансу при равенстве");
    ok(ids8().at(-1) === "9999000002", "S8: null окна последний по возрастанию");
    sort8("window");
    ok(equal(ids8(), expectOrder8("window", -1)), "S8: повторный клик окна — убывание");
    ok(ids8().at(-1) === "9999000002", "S8: null окна последний по убыванию");
    for (const [key, dir] of [["ended", 1], ["tariff", 1], ["kass", -1]]) {
      sort8(key);
      ok(equal(ids8(), expectOrder8(key, dir)), "S8: первый клик " + key + ", направление " + dir + ", null в конце, tie-break по шансу");
      sort8(key);
      ok(equal(ids8(), expectOrder8(key, -dir)), "S8: второй клик " + key + ", null в конце, tie-break по шансу");
    }
    sort8("p");
    ok(equal(ids8(), expectOrder8("p", -1)), "S8: первый клик шанса — убывание");
    const width8 = ret8.querySelector('input[data-f="width"]');
    const setWidth8 = (value) => { if (width8) p2.set(width8, value); };
    ok(width8?.value === "30" && width8.type === "number" && width8.min === "0" && width8.step === "1", "S8: поле W=30, целое ≥0");
    ok(width8?.closest(".pt-win")?.nextElementSibling?.classList.contains("pt-ctrls"), "S8: поле окна над фильтрами");
    setWidth8(60);
    ok(row8(1)?.children[8]?.querySelector("b")?.textContent === "через 101 дн.", "S8: W=60 → через 101 дн.");
    ok(row8(1)?.children[8]?.querySelector(".pt-sub2")?.textContent === "30.01.2027 — 31.03.2027", "S8: W=60 → даты окна");
    for (const value of ["abc", "", "-1", "1.5"]) {
      setWidth8(value);
      ok(row8(1)?.children[8]?.querySelector("b")?.textContent === "через 101 дн.", "S8: неверный W=" + JSON.stringify(value) + " игнорируется");
      if (value !== "abc") ok(width8?.value === value, "S8: неверный ввод не перезаписывается: " + JSON.stringify(value));
    }
    setWidth8(0);
    ok(row8(1)?.children[8]?.querySelector(".pt-sub2")?.textContent === "31.03.2027 — 31.03.2027", "S8: W=0 допустимо, окно в один день");
    setWidth8(60); sort8("window");
    ok(equal(ids8(), expectOrder8("window", 1, 60)), "S8: сортировка использует новое W");
    for (const [seg, id, present] of [["B", 4, true], ["A", 4, false], ["C", 1, true], ["B", 1, false]]) {
      p2.set(ret8.querySelector('[data-f="seg"]'), seg);
      ok(!!row8(id) === present, "S8: сегмент " + seg + ", …0" + id + (present ? " есть" : " отсутствует"));
    }
    ok(["reg", "sec", "seg", "min"].every((f) => ret8.querySelector('select[data-f="' + f + '"]')), "S8: прежние четыре фильтра сохранены");
    ok(ret8.querySelector(".pt-note:last-child")?.textContent.includes("Для тарифа 1 мес. при N ≥ 30 окно открыто всегда («Звонить сейчас»)."), "S8: примечание об окне месячного тарифа");
    ok(ret8.querySelector(".pt-note:last-child")?.textContent.includes("Касс — максимум одновременно действующих касс клиента за 18 месяцев до окончания его последнего кода."), "S8: примечание о кассах за 18 мес.");

    const oldRet8 = p1.render("b10-return");
    ok(!oldRet8.querySelector('[data-f="width"]'), "S8 V1: поле W скрыто");
    ok(!oldRet8.querySelector('[data-now="true"]'), "S8 V1: нет открытых окон");
    ok(oldRet8.querySelectorAll("thead th").length === 10 && oldRet8.querySelectorAll("thead th")[4]?.textContent === "Касс", "S8 V1: десять колонок, заголовок «Касс»");
    for (const col of [6, 7, 8]) ok(trs8(oldRet8).every((tr) => tr.children[col]?.textContent === "—"), "S8 V1: новая колонка " + col + " — прочерки");
    ok(equal(trs8(oldRet8).map(inn8), v1.cand.rows.slice().sort((a, b) => b[7] - a[7]).slice(0, 50).map((r) => r[8])), "S8 V1: стартовый порядок по шансу убывает");
    ok(trs8(oldRet8).every((tr) => Number(tr.children[4].textContent.replace(/\s/g, "")) === v1.cand.rows.find((r) => r[8] === inn8(tr))[4]), "S8 V1: кассы берутся из r[4]");
    ok(p1.errs.length === 0, "S8 V1: errs.length === 0");

    // Размер реального борда без реальных контактов; считаем вызовы чистой функции.
    const large8 = makeV2(), templates8 = large8.cand.rows;
    large8.cand.rows = Array.from({ length: 48000 }, (_, i) => {
      const r = templates8[i % templates8.length].slice(); r[8] = String(999910000000 + i); return r;
    });
    const perf8 = await loadPage(large8); pages.push(perf8);
    const util8 = perf8.w.OFDPortraitUtil, originalWindow8 = util8.callWindow;
    let calls8 = 0;
    util8.callWindow = (...args) => { calls8++; return originalWindow8(...args); };
    try {
      let start8 = perf8.w.performance.now();
      const bigRet8 = perf8.render("b10-return"), firstMs8 = perf8.w.performance.now() - start8;
      ok(firstMs8 <= 1500, "S8 perf: 48000 строк, первая отрисовка " + firstMs8.toFixed(1) + " мс ≤1500");
      ok(calls8 === 48000, "S8 cache: при первой отрисовке ровно 48000 расчётов окна");
      const bigWidth8 = bigRet8.querySelector('[data-f="width"]');
      start8 = perf8.w.performance.now();
      if (bigWidth8) perf8.set(bigWidth8, 60);
      const widthMs8 = perf8.w.performance.now() - start8;
      ok(widthMs8 <= 1500, "S8 perf: смена W " + widthMs8.toFixed(1) + " мс ≤1500");
      ok(calls8 === 96000, "S8 cache: смена W пересчитывает окна ровно один раз на строку");
      const cachedCalls8 = calls8;
      if (bigWidth8) perf8.set(bigWidth8, 60);
      ok(calls8 === cachedCalls8, "S8 cache: прежнее W не пересчитывает окна");
      start8 = perf8.w.performance.now();
      const bigSort8 = bigRet8.querySelector('th[data-k="window"]'); if (bigSort8) perf8.click(bigSort8);
      const sortMs8 = perf8.w.performance.now() - start8;
      ok(sortMs8 <= 500, "S8 perf: смена сортировки " + sortMs8.toFixed(1) + " мс ≤500");
      ok(calls8 === cachedCalls8, "S8 cache: сортировка не пересчитывает окна");
      perf8.set(bigRet8.querySelector('[data-f="seg"]'), "B");
      ok(calls8 === cachedCalls8, "S8 cache: фильтры не пересчитывают окна");
      ok(perf8.errs.length === 0, "S8 perf: нет ошибок JS");
    } finally { util8.callWindow = originalWindow8; }

    // S9: Кого вернуть — фильтры и CSV.
    const s9 = makeV2();
    s9.cand.rows = s9.cand.rows.filter((r) => /^999900000[1-5]$/.test(r[8])).concat(s9.cand.rows.slice(0, 8));
    // Разделители, кавычки и перенос строки проверяют настоящий разбор CSV.
    s9.cand.rows[0][0] = 'Тест, "клиент"; строка\r\nпродолжение';
    p2.w.OFDPortrait.load(s9);
    const ret9 = p2.render("b10-return"), U9 = p2.w.OFDPortraitUtil;
    const control9 = (f, widget = ret9) => widget.querySelector('[data-f="' + f + '"]');
    const set9 = (f, value, type = "change", widget = ret9, page = p2) => {
      const input = control9(f, widget);
      if (input) { input.value = String(value); input.dispatchEvent(new page.w.Event(type, { bubbles: true })); }
    };
    const ids9 = (widget = ret9) => [...widget.querySelectorAll("tbody tr")].map(inn8);
    const count9 = (widget = ret9) => Number([...widget.querySelectorAll(".pt-tile")].find((tile) => tile.querySelector(".pt-tl")?.textContent === "В текущей выборке")?.querySelector(".pt-tv")?.textContent.replace(/\s/g, ""));
    const has9 = (id, widget = ret9) => ids9(widget).includes("999900000" + id);
    const expected9 = (mode, width = 30) => s9.cand.rows.filter((r) => U9.windowMatch(U9.callWindow(r[11], r[12], s9.meta.asOf, width), mode, s9.meta.asOf));
    // CSV parser учитывает экранированные кавычки, ; и CRLF внутри полей.
    const parseCsv9 = (text) => {
      const result = [], row = []; let field = "", quoted = false;
      text = String(text || "").replace(/^\uFEFF/, "");
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
          if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
        } else if (!quoted && (ch === ";" || ch === "\r" && text[i + 1] === "\n")) {
          row.push(field); field = "";
          if (ch === "\r") { result.push(row.splice(0)); i++; }
        } else field += ch;
      }
      assert(!quoted, "CSV: незакрытая кавычка"); row.push(field); result.push(row);
      return result;
    };
    const download9 = (widget = ret9, page = p2) => page.captureCsv(() => {
      const button = widget.querySelector('[data-csv="return"]'); if (button) page.click(button);
    });
    const csvId9 = (r) => r[0].replace(/\D/g, "");
    const newHead9 = ["Код закончился", "Последний тариф, мес.", "Окно с", "Окно по", "Касс за 18 мес. до ухода"];
    ok(equal([...control9("window")?.options || []].map((o) => [o.value, o.textContent]), [["all", "Окно звонка: любое"], ["now", "Звонить сейчас"], ["30", "Ближайшие 30 дней"], ["90", "Ближайшие 90 дней"]]), "S9: точные варианты окна звонка");
    for (const f of ["kassFrom", "kassTo"]) {
      const input = control9(f);
      ok(input?.type === "number" && input.min === "1" && input.step === "1", "S9: " + f + " — целое число от 1");
      ok(input?.closest("label")?.textContent.includes(f === "kassFrom" ? "Касс от" : "до"), "S9: подпись " + f);
      ok(input?.closest("[data-tip]")?.dataset.tip === "Число касс клиента за 18 месяцев до окончания его последнего кода (для старого файла — максимум касс за историю)", "S9: подсказка " + f);
      ok(input?.getAttribute("aria-invalid") === "false", "S9: начальный aria-invalid=false " + f);
    }
    ok(ret9.querySelector('[data-role="range-hint"]')?.hidden === true, "S9: начальная подсказка диапазона скрыта");
    set9("window", "now");
    const now9 = s9.cand.rows.filter((r) => { const cw = U9.callWindow(r[11], r[12], s9.meta.asOf, 30); return cw && cw.now; });
    ok(now9.length > 0 && ids9().length === now9.length, "S9: сейчас — независимый подсчёт строк");
    ok([...ret9.querySelectorAll("tbody tr")].every((tr) => tr.dataset.now === "true"), "S9: сейчас — у каждой строки data-now=true");
    ok(!has9(2), "S9: строка без окна …02 скрыта");
    ok(count9() === now9.length, "S9: KPI учитывает фильтр сейчас");
    ok(parseCsv9(download9().text).length - 1 === count9(), "S9: CSV сейчас содержит столько же строк, сколько KPI");
    for (const mode of ["30", "90", "all"]) {
      set9("window", mode);
      ok(ids9().length === expected9(mode).length, "S9: окно " + mode + " — независимый подсчёт");
      ok(count9() === expected9(mode).length, "S9: KPI окна " + mode);
    }
    ok(has9(2) && ids9().length === 13, "S9: любое возвращает все 13 строк, включая null");
    set9("window", "90"); const beforeWidth9 = ids9().length;
    set9("width", "60");
    ok(ids9().length === expected9("90", 60).length && ids9().length > beforeWidth9, "S9: W=60 расширяет ближайшие 90 дней (5 → 6)");
    const widthCsv9 = parseCsv9(download9().text);
    ok(widthCsv9.slice(1).every((r) => { const cw = U9.callWindow(...s9.cand.rows.find((x) => x[8] === csvId9(r)).slice(11, 13), s9.meta.asOf, 60); return r[13] === U9.human(cw.start) && r[14] === U9.human(cw.next); }), "S9: CSV использует окна текущего W=60");
    set9("width", "30"); set9("window", "all");
    set9("kassFrom", "3", "input");
    ok(!has9(5) && has9(1), "S9: input от 3 исключает …05, оставляет …01 по kass18");
    set9("kassTo", "5", "input");
    ok(has9(1) && !has9(4), "S9: input от 3 до 5 оставляет …01, исключает …04");
    ok(ids9().length === s9.cand.rows.filter((r) => (r[13] ?? r[4]) >= 3 && (r[13] ?? r[4]) <= 5).length, "S9: диапазон 3–5 — независимый подсчёт");
    set9("kassTo", ""); set9("kassFrom", "6");
    ok(has9(4) && !has9(1), "S9: change от 6 оставляет …04, исключает …01");
    set9("kassFrom", "5"); set9("kassTo", "2");
    const hint9 = ret9.querySelector('[data-role="range-hint"]');
    ok(ids9().length === 0, "S9: ошибочный диапазон даёт 0 строк");
    ok(hint9?.hidden === false && hint9.textContent.trim().length > 0 && hint9.classList.contains("pt-note") && hint9.getAttribute("role") === "status", "S9: видимая подсказка ошибки с role=status");
    ok(["kassFrom", "kassTo"].every((f) => control9(f)?.getAttribute("aria-invalid") === "true"), "S9: ошибка — aria-invalid=true у обоих полей");
    ok(count9() === 0, "S9: ошибка — KPI 0");
    ok(parseCsv9(download9().text).length === 1, "S9: ошибка — CSV только заголовок");
    set9("kassTo", "7", "input");
    ok(hint9?.hidden === true && ids9().length > 0, "S9: исправление скрывает подсказку и возвращает строки");
    ok(["kassFrom", "kassTo"].every((f) => control9(f)?.getAttribute("aria-invalid") === "false"), "S9: исправление — aria-invalid=false");
    for (const invalid of ["0", "-1", "1.5"]) {
      set9("kassFrom", invalid, "input");
      ok(ids9().length === 0 && hint9?.hidden === false, "S9: неверное число касс " + invalid);
    }
    set9("kassFrom", "2"); set9("kassTo", "5"); set9("reg", "2"); set9("seg", "C"); set9("min", "30"); set9("window", "now");
    const combined9 = s9.cand.rows.filter((r) => {
      const kass = r[13] ?? r[4], cw = U9.callWindow(r[11], r[12], s9.meta.asOf, 30);
      return kass >= 2 && kass <= 5 && r[1] === 2 && segOf(kass) === "C" && r[7] >= 300 && U9.windowMatch(cw, "now", s9.meta.asOf);
    });
    ok(combined9.length > 0 && equal(ids9().slice().sort(), combined9.map((r) => r[8]).sort()), "S9: пять фильтров одновременно — независимые ИНН");
    ok(count9() === combined9.length && parseCsv9(download9().text).length === combined9.length + 1, "S9: комбинация согласована с KPI и CSV");
    set9("sec", s9.cand.rows[2][2]);
    ok(ids9().length === combined9.filter((r) => r[2] === s9.cand.rows[2][2]).length, "S9: отрасль также входит в общую выборку");
    for (const [f, value] of [["kassFrom", ""], ["kassTo", ""], ["reg", "all"], ["sec", "all"], ["seg", "all"], ["min", "0"], ["window", "all"]]) set9(f, value);
    const csv9 = download9(), parsed9 = parseCsv9(csv9.text);
    ok(csv9.name === "otvalivshiesya-shans-vernutsya.csv", "S9: прежнее имя CSV");
    ok(csv9.text?.startsWith("\uFEFF") && (csv9.text.match(/\uFEFF/g) || []).length === 1, "S9: ровно один BOM в начале");
    ok(parsed9.length === s9.cand.rows.length + 1 && parsed9.every((r) => r.length === 16), "S9: CSV — вся выборка, каждая строка 16 колонок");
    ok(parsed9[0][2] === "Телефон" && equal(parsed9[0].slice(11), newHead9), "S9: заголовок Телефон третий, точные новые пять заголовков");
    ok(equal(parsed9[0].slice(0, 11), ["ИНН", "Клиент", "Телефон", "Email", "Регион", "Отрасль (ОКВЭД)", "Форма", "Макс. касс", "Был с нами, мес.", "Ушёл, мес. назад", "Шанс вернуться за 12 мес., %"]), "S9: первые 11 заголовков сохранены");
    ok(equal(parsed9.find((r) => csvId9(r) === "9999000001")?.slice(11), ["31.01.2025", "13", "01.03.2027", "31.03.2027", "3"]), "S9: …01 точные пять значений CSV");
    ok(equal(parsed9.find((r) => csvId9(r) === "9999000002")?.slice(11), ["", "", "", "", ""]), "S9: …02 пять пустых полей без подстановки касс");
    ok(parsed9.find((r) => csvId9(r) === "9999000001")?.[1] === s9.cand.rows[0][0], "S9: CSV сохраняет запятую, кавычки, ; и CRLF");
    ok(equal(parsed9.slice(1).map(csvId9), ids9()), "S9: порядок CSV совпадает с экраном");
    p2.click(ret9.querySelector('th[data-k="kass"]'));
    ok(equal(parseCsv9(download9().text).slice(1).map(csvId9), ids9()), "S9: CSV учитывает смену сортировки");
    p2.w.OFDPortrait.load(v2); const fullRet9 = p2.render("b10-return");
    ok(ids9(fullRet9).length === 50 && parseCsv9(download9(fullRet9).text).length === v2.cand.rows.length + 1, "S9: CSV не ограничен первыми 50 строками");
    set9("kassFrom", "2", "change", fullRet9); set9("window", "90", "change", fullRet9);
    const fullCount9 = v2.cand.rows.filter((r) => (r[13] ?? r[4]) >= 2 && U9.windowMatch(U9.callWindow(r[11], r[12], v2.meta.asOf, 30), "90", v2.meta.asOf)).length;
    ok(count9(fullRet9) === fullCount9 && fullRet9.querySelector(".pt-note:last-child").textContent.startsWith(fullCount9 > 50 ? "Показаны первые 50 из " + fullCount9 : "Показаны все " + fullCount9), "S9: KPI и примечание учитывают все фильтры");
    const old9 = makeV1(); old9.cand.rows = old9.cand.rows.filter((r) => /^999900000[1-5]$/.test(r[8])).concat(old9.cand.rows.slice(0, 8));
    p1.w.OFDPortrait.load(old9); const oldRet9 = p1.render("b10-return");
    ok(!control9("window", oldRet9), "S9 V1: селект окна отсутствует");
    const oldCsv9 = parseCsv9(download9(oldRet9, p1).text);
    ok(oldCsv9.length === 14 && oldCsv9.every((r) => r.length === 16), "S9 V1: CSV 16 колонок");
    ok(oldCsv9.slice(1).every((r) => r.slice(11).every((v) => v === "")), "S9 V1: новые пять полей пустые");
    set9("kassFrom", "3", "input", oldRet9, p1);
    ok(has9(5, oldRet9) && has9(1, oldRet9), "S9 V1: от 3 берёт исторический максимум …05 и …01");
    set9("kassTo", "5", "change", oldRet9, p1);
    ok(equal(ids9(oldRet9).slice().sort(), old9.cand.rows.filter((r) => r[4] >= 3 && r[4] <= 5).map((r) => r[8]).sort()), "S9 V1: диапазон по r[4], независимый подсчёт");
    ok(p1.errs.length === 0 && p2.errs.length === 0, "S9: обе схемы без ошибок JS");

    // S11: топ-10 видов деятельности — пересчёт из act.rows, фильтры, сброс, CSV.
    const okv11 = makeV2(), act11 = okv11.act, rows11 = act11.rows, grps11 = act11.grps;
    p2.w.OFDPortrait.load(okv11);
    const okw11 = p2.render("b10-okved");
    const seg11 = (n) => n >= 10 ? "A" : n >= 6 ? "B" : n >= 2 ? "C" : "D";
    const num11 = (s) => Number(String(s).replace(/\s/g, ""));
    const cards11 = (widget = okw11) => [...widget.querySelectorAll(".pt-grid2 > .pt-card")];
    const sum11 = (card) => [...card.querySelectorAll("tbody tr")].reduce((s, tr) => s + num11(tr.children[2].textContent), 0);
    const count11 = (widget = okw11) => num11(widget.querySelector('[data-role="count"]').textContent.replace(/\D/g, ""));
    const sel11 = (name, widget = okw11) => widget.querySelector('[data-okved-filter="' + name + '"]');
    const range11 = (side, widget = okw11) => widget.querySelector('[data-range="' + side + '"]');
    const kind11 = (label) => { p2.click([...okw11.querySelectorAll(".pt-tabs button")].find((b) => b.textContent === label)); };
    const bySeg11 = (rows) => Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, rows.filter((r) => seg11(r[6]) === k)]));
    const top11 = (rows, kind) => {
      const m = new Map();
      rows.forEach((r) => { const g = grps11[r[5]], code = kind === "cls" ? g[2] : g[0]; if (g[2] === "" || g[2] === "old") return; m.set(code, (m.get(code) || 0) + 1); });
      return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
    };
    const tail11 = (card, label) => [...card.querySelectorAll("tbody tr")].find((tr) => tr.children[1].textContent.startsWith(label));
    const checkSums11 = (rows, label) => {
      const by = bySeg11(rows), cards = cards11();
      ok(cards.length === 4 && cards.every((c) => !c.querySelector(".pt-card")), label + ": 4 карточки без вложенных .pt-card");
      ok(["A", "B", "C", "D"].every((k, i) => by[k].length ? sum11(cards[i]) === by[k].length : cards[i].textContent.includes("Нет клиентов в выборке")), label + ": Σ строк карточки = клиентов сегмента (независимый подсчёт по act.rows)");
      ok(count11() === rows.length, label + ": счётчик «В выборке» = " + rows.length);
    };

    ok(equal(["A", "B", "C", "D"].map((k) => bySeg11(rows11)[k].length), ["A", "B", "C", "D"].map((k) => okv11.seg[k].clients)), "S11: фикстура согласована — сегменты act.rows = seg");
    checkSums11(rows11, "S11 без фильтров");
    ok(cards11().every((c) => c.querySelectorAll("tbody tr .pt-bar").length <= 10 && tail11(c, "Остальные виды деятельности")), "S11: ≤ 10 строк с полосой и строка «Остальные…» в каждой карточке");
    const by11 = bySeg11(rows11);
    ok(["A", "B", "C", "D"].every((k, i) => {
      const old = by11[k].filter((r) => grps11[r[5]][2] === "old").length, miss = by11[k].filter((r) => grps11[r[5]][2] === "").length;
      return (old > 0) === !!tail11(cards11()[i], "Старый код ОКВЭД-1") && (miss > 0) === !!tail11(cards11()[i], "ОКВЭД не указан") && (!old || num11(tail11(cards11()[i], "Старый код ОКВЭД-1").children[2].textContent) === old) && (!miss || num11(tail11(cards11()[i], "ОКВЭД не указан").children[2].textContent) === miss);
    }), "S11: строки «Старый код…» и «ОКВЭД не указан» есть ровно там, где они есть в данных, и с верными числами");
    const topC11 = top11(by11.C, "cls")[0], firstC11 = cards11()[2].querySelector("tbody tr");
    ok(firstC11.children[1].textContent === topC11[0] + " Тестовая отрасль " + topC11[0] && num11(firstC11.children[2].textContent) === topC11[1], "S11: первая строка сегмента C — раздел с названием из act.secs и верным числом");
    ok(tail11(cards11()[2], "Остальные виды деятельности") && num11(tail11(cards11()[2], "Остальные виды деятельности").children[2].textContent) === by11.C.length - top11(by11.C, "cls").slice(0, 10).reduce((s, x) => s + x[1], 0) - by11.C.filter((r) => ["old", ""].includes(grps11[r[5]][2])).length, "S11: «Остальные» = клиенты − топ-10 − old − без ОКВЭД");
    ok(/Из 197 клиентов:/.test(okw11.textContent) && /Справочник ОКВЭД-2/.test(okw11.textContent), "S11: сводная строка по выборке");

    kind11("Полный код");
    checkSums11(rows11, "S11 полный код");
    const topCg11 = top11(by11.C, "grp")[0], firstCg11 = cards11()[2].querySelector("tbody tr");
    ok(/^\d\d\.\d\d /.test(firstCg11.children[1].textContent) && firstCg11.children[1].textContent.startsWith(topCg11[0]) && num11(firstCg11.children[2].textContent) === topCg11[1], "S11: в режиме «Полный код» первая строка C — код вида деятельности и верное число");
    kind11("Раздел (2 знака)");

    ok(sel11("reg").options.length === 1 + act11.regs.length && equal([...sel11("reg").options].slice(1).map((o) => o.value).sort(), act11.regs.map((r) => r[0]).sort()), "S11: селект «Регион»: все регионы + коды act.regs");
    ok(equal([...sel11("sec").options].map((o) => o.value), ["all", ...act11.secs.map((s) => s[0])]) && sel11("sec").options[1].textContent === act11.secs[0][0] + " " + act11.secs[0][1], "S11: селект «Вид деятельности»: все + разделы act.secs в порядке данных");
    ok(range11("from").type === "number" && range11("from").min === "1" && range11("to").step === "1" && range11("from").getAttribute("aria-invalid") === "false", "S11: поля «Касс от/до» — целое от 1");

    p2.set(range11("from"), 2); p2.set(range11("to"), 5);
    checkSums11(rows11.filter((r) => r[6] >= 2 && r[6] <= 5), "S11 касс 2–5");
    ok(cards11().filter((c) => c.textContent.includes("Нет клиентов в выборке")).length === 3 && !cards11()[2].textContent.includes("Нет клиентов в выборке"), "S11: касс 2–5 — остался только сегмент C");
    p2.set(range11("from"), 10); p2.set(range11("to"), "");
    checkSums11(rows11.filter((r) => r[6] >= 10), "S11 касс от 10");
    ok(!cards11()[0].textContent.includes("Нет клиентов в выборке") && cards11().slice(1).every((c) => c.textContent.includes("Нет клиентов в выборке")), "S11: от 10 — только сегмент A");
    p2.set(range11("from"), ""); p2.set(range11("to"), "");

    p2.set(sel11("sec"), "47");
    const r47 = rows11.filter((r) => grps11[r[5]][2] === "47");
    checkSums11(r47, "S11 раздел 47");
    ok(!okw11.textContent.includes("Старый код ОКВЭД-1 (") && !okw11.textContent.includes("ОКВЭД не указан в источнике"), "S11: раздел 47 — нет строк old и «не указан»");
    kind11("Полный код");
    ok(cards11().every((c) => [...c.querySelectorAll("tbody tr .pt-bar")].every((bar) => /^47\.\d\d /.test(bar.closest("tr").children[1].textContent))), "S11: раздел 47 в режиме «Полный код» — только коды 47.xx");
    kind11("Раздел (2 знака)"); p2.set(sel11("sec"), "all");

    const regCode11 = act11.regs[1][0], regIdx11 = 1;
    p2.set(sel11("reg"), regCode11);
    checkSums11(rows11.filter((r) => r[4] === regIdx11), "S11 регион");
    p2.set(sel11("sec"), "56"); p2.set(range11("from"), 2);
    const combo11 = rows11.filter((r) => r[4] === regIdx11 && grps11[r[5]][2] === "56" && r[6] >= 2);
    checkSums11(combo11, "S11 регион + раздел + касс от 2");

    p2.set(range11("from"), 5); p2.set(range11("to"), 2);
    const hint11 = okw11.querySelector('[data-role="range-hint"]');
    ok(!hint11.hidden && hint11.textContent.length > 0 && range11("from").getAttribute("aria-invalid") === "true" && range11("to").getAttribute("aria-invalid") === "true", "S11: от > до — подсказка видна, aria-invalid у обоих полей");
    ok(count11() === 0 && cards11().every((c) => c.textContent.includes("Нет клиентов в выборке")), "S11: от > до — выборка пуста");
    const emptyCsv11 = p2.captureCsv(() => p2.click(okw11.querySelector('[data-csv="okved"]')));
    ok(parseCsv9(emptyCsv11.text).length === 1, "S11: от > до — CSV только заголовок");
    p2.set(range11("from"), 2); p2.set(range11("to"), 9);
    ok(hint11.hidden && range11("from").getAttribute("aria-invalid") === "false" && count11() === rows11.filter((r) => r[4] === regIdx11 && grps11[r[5]][2] === "56" && r[6] >= 2 && r[6] <= 9).length, "S11: исправленный диапазон скрывает подсказку и возвращает данные");

    kind11("Полный код");
    okw11.querySelector('[data-role="reset"]').dispatchEvent(new p2.w.MouseEvent("click", { bubbles: true }));
    ok(sel11("reg").value === "all" && sel11("sec").value === "all" && range11("from").value === "" && range11("to").value === "", "S11: «Сбросить» очищает селекты и поля");
    checkSums11(rows11, "S11 после сброса");
    ok(okw11.querySelector(".pt-tabs button.on")?.textContent === "Полный код", "S11: сброс не меняет режим «Раздел/Полный код»");
    kind11("Раздел (2 знака)");

    const csvAll11 = p2.captureCsv(() => p2.click(okw11.querySelector('[data-csv="okved"]'))), parsed11 = parseCsv9(csvAll11.text);
    ok(csvAll11.name === "vidy-deyatelnosti-2026-10-21.csv", "S11 CSV: имя файла с as-of");
    ok(csvAll11.text.startsWith("﻿") && csvAll11.text.indexOf("﻿", 1) === -1, "S11 CSV: ровно один BOM");
    ok(equal(parsed11[0], ["Сегмент", "Наименование", "ИНН", "КПП", "ИП/ЮЛ", "Регион", "Вид деятельности (ОКВЭД)", "Касс", "Месяцев в ОФД", "Возраст бизнеса", "Максимальный срок тарифа", "Телефон", "Email"]), "S11 CSV: 13 заголовков в точном порядке");
    ok(parsed11.length === rows11.length + 1 && parsed11.every((r) => r.length === 13), "S11 CSV: строк = выборка + 1, везде 13 колонок");
    ok(equal(parsed11.slice(1).map((r) => r[2]), rows11.map((r) => '="' + r[1] + '"')), "S11 CSV: ИНН как текст-формула (=«ИНН»), в порядке act.rows");
    const row0csv11 = parsed11[1], row0 = rows11[0];
    ok(row0csv11[0] === seg11(row0[6]) && row0csv11[1] === row0[0] && row0csv11[4] === "ИП" && row0csv11[7] === String(row0[6]) && row0csv11[8] === String(row0[7]), "S11 CSV: сегмент, имя, форма, кассы, месяцы первой строки");
    ok(row0csv11[9] === "" && row0csv11[10] === "36 мес.", "S11 CSV: bizAge10 = −1 → пусто, тариф 36 → «36 мес.»");
    const rowAge11 = rows11.findIndex((r) => r[8] >= 0 && r[9] >= 0);
    ok(parsed11[rowAge11 + 1][9] === (rows11[rowAge11][8] / 10).toFixed(1).replace(".", ",") + " г." && parsed11[rowAge11 + 1][10] === rows11[rowAge11][9] + " мес.", "S11 CSV: возраст ×10 → «N,N г.», тариф → «N мес.»");
    ok(parsed11.slice(1).every((r, i) => r[4] === (rows11[i][3] === 0 ? "ИП" : rows11[i][3] === 1 ? "ЮЛ" : "")), "S11 CSV: ИП/ЮЛ/пусто по act.rows");
    ok(parsed11.slice(1).every((r, i) => r[11] === rows11[i][10] && r[12] === rows11[i][11]), "S11 CSV: телефон и email из act.rows (act.contacts = true)");
    ok(parsed11.slice(1).every((r, i) => r[5] === act11.regs[rows11[i][4]][1] && r[6] === (grps11[rows11[i][5]][0] + " " + grps11[rows11[i][5]][1]).trim()), "S11 CSV: регион и «код название» вида деятельности");
    p2.set(range11("from"), 2); p2.set(range11("to"), 5);
    const csv25 = parseCsv9(p2.captureCsv(() => p2.click(okw11.querySelector('[data-csv="okved"]'))).text);
    ok(csv25.length - 1 === rows11.filter((r) => r[6] >= 2 && r[6] <= 5).length && csv25.slice(1).every((r) => r[0] === "C"), "S11 CSV: при касс 2–5 выгружены только клиенты сегмента C, число = выборке");
    ok(/КПП — из ЕГРЮЛ/.test(okw11.textContent) && !okw11.textContent.includes("не включены"), "S11: примечание про КПП и контакты (контакты включены)");

    const noContacts11 = makeV2(); noContacts11.act.contacts = false;
    p2.w.OFDPortrait.load(noContacts11);
    const okwNc11 = p2.render("b10-okved");
    ok(okwNc11.textContent.includes("Контакты в этот файл не включены"), "S11: act.contacts = false — примечание «не включены»");
    ok(parseCsv9(p2.captureCsv(() => p2.click(okwNc11.querySelector('[data-csv="okved"]'))).text)[0].length === 13, "S11: act.contacts = false — CSV по-прежнему 13 колонок");

    const okwOld11 = p1.render("b10-okved");
    ok(okwOld11.textContent.includes("Пересоберите portrait-data.json") && !okwOld11.querySelector(".pt-card, .pt-ctrls, .pt-tabs, [data-csv]"), "S11 V1: только плашка, без карточек и контролов");
    ok(p1.errs.length === 0 && p2.errs.length === 0, "S11: без ошибок JS");

    const large11 = makeV2(), tpl11 = large11.act.rows;
    large11.act.rows = Array.from({ length: 88000 }, (_, i) => { const r = tpl11[i % tpl11.length].slice(); r[1] = String(100000000000 + i); return r; });
    const perf11 = await loadPage(large11); pages.push(perf11);
    let t11 = perf11.w.performance.now();
    const bigOk11 = perf11.render("b10-okved"), firstMs11 = perf11.w.performance.now() - t11;
    ok(firstMs11 <= 1500, "S11 perf: 88 000 строк, первая отрисовка " + firstMs11.toFixed(1) + " мс ≤1500");
    t11 = perf11.w.performance.now();
    perf11.set(bigOk11.querySelector('[data-range="from"]'), 2); perf11.set(bigOk11.querySelector('[data-range="to"]'), 5);
    const filterMs11 = (perf11.w.performance.now() - t11) / 2;
    ok(filterMs11 <= 300, "S11 perf: перерисовка после смены фильтра " + filterMs11.toFixed(1) + " мс ≤300");
    ok(perf11.errs.length === 0, "S11 perf: без ошибок JS");

    // Ревью: неполный файл схемы 2 даёт плашки вместо TypeError; подписи старого файла без «18 мес.».
    const half12 = makeV2(); delete half12.act; delete half12.ip; delete half12.t36; delete half12.lifeC;
    p2.w.OFDPortrait.load(half12);
    const halfIds12 = ["b10-okved", "b10-ip", "b10-life", "b10-portraits", "b10-return"];
    const halfErr12 = []; const halfOut12 = halfIds12.map((id) => { try { return p2.render(id); } catch (e) { halfErr12.push(id + ": " + e.message); return null; } });
    ok(halfErr12.length === 0, "ревью: файл схемы 2 без act/ip — виджеты не падают " + JSON.stringify(halfErr12));
    ok(["b10-okved", "b10-ip", "b10-life"].every((id, i) => halfOut12[i] && halfOut12[i].textContent.includes("Пересоберите portrait-data.json")), "ревью: неполный файл — плашка «Пересоберите» в okved/ip/life");
    ok(p2.w.OFDPortrait.fileTitle("x.json", half12).endsWith("старый формат — пересоберите"), "ревью: неполный файл — подсказка кнопки «пересоберите»");
    p2.w.OFDPortrait.load(makeV2());
    const oldNote12 = p1.render("b10-return"), oldNoteText12 = [...oldNote12.querySelectorAll(".pt-note")].pop().textContent;
    ok(!oldNoteText12.includes("Окно звонка —") && !oldNoteText12.includes("18 месяцев"), "ревью: примечание старого файла не описывает окно и 18 мес.");
    ok(oldNoteText12.includes("Полный список с телефонами"), "ревью: примечание старого файла сохраняет основную часть");
    ok(p1.errs.length === 0 && p2.errs.length === 0, "ревью: без ошибок JS");

    // S6a: ошибки проверяются после всех блоков, включая будущие расширения.
    // Даём отложенному отзыву blob URL выполниться и попасть в errs при ошибке.
    await new Promise((resolve) => setTimeout(resolve, 550));
    ok(p2.errs.length === 0, "V2: window.error пуст " + JSON.stringify(p2.errs));
    ok(p1.errs.length === 0, "V1: window.error пуст " + JSON.stringify(p1.errs));
  } finally {
    pages.forEach((page) => page.w.close());
  }
}

module.exports = { loadPage };
if (require.main === module) {
  main().catch((e) => { ok(false, e.stack || String(e)); }).then(() => {
    console.log(fail ? "FAIL " + fail + "/" + total : "OK " + total + "/" + total);
    if (fail) process.exit(1);
  });
}
