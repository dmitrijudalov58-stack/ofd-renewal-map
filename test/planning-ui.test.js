"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { JSDOM } = require("jsdom");

async function page() {
  const dom = await JSDOM.fromFile(path.join(__dirname, "..", "index.html"), {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true,
    url: "file://" + path.join(__dirname, "..", "index.html"),
    beforeParse(win) {
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      const store = Object.create(null);
      Object.defineProperty(win, "localStorage", { configurable: true, value: {
        getItem(key) { return store[key] || null; },
        setItem(key, value) { store[key] = String(value); },
        removeItem(key) { delete store[key]; },
      } });
    },
  });
  const win = dom.window;
  if (win.document.readyState !== "complete") await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
  return { dom, win };
}
function fixture(win) {
  const end = new win.Date(2027, 5, 15);
  const code = { pin: "TEST", tariff: "12 месяцев", activated: new win.Date(2026, 0, 1), endDate: end };
  const kassa = { rnm: "RNM", clientKey: "7700000001", org: "Клиент", channel: "Партнёры", partner: "Партнёр", codes: [code], intervals: [{ start: code.activated, end }] };
  const client = { key: kassa.clientKey, org: kassa.org, phys: false, kassas: [kassa] };
  return { kassas: new win.Map([[kassa.rnm, kassa]]), clients: new win.Map([[client.key, client]]) };
}
function render(win, id, instance) {
  const model = fixture(win);
  const ctx = { asOf: new win.Date(2026, 10, 3), M: win.OFDMetrics };
  const result = win.OFDWidgets.WIDGETS[id].render(model, ctx, instance);
  win.document.body.appendChild(result);
  return result;
}
function change(win, node, value) {
  node.value = value;
  node.dispatchEvent(new win.Event("change", { bubbles: true }));
}

test("summary directs the user to the 1C upload and missing parameters without fake zeros", async () => {
  const { dom, win } = await page();
  try {
    const summary = render(win, "pl-summary", "summary-test");
    assert.ok(summary.querySelector(".pl-load-1c"), "actionable 1C upload control");
    assert.ok(summary.querySelector(".pl-open-params"), "actionable missing parameters control");
    assert.doesNotMatch(summary.textContent, /Продление Обмена с 1С[^]*?База:\s*0\s*касс 1С/);
  } finally { dom.window.close(); }
});

test("money and percent inputs reject invalid values and recalculate on valid change", async () => {
  const { dom, win } = await page();
  try {
    const board = render(win, "pl-params", "params-test");
    const priceRow = [...board.querySelectorAll("tr[data-key]")].find((r) => r.getAttribute("data-key") === "c|ofd|Партнёры|12");
    assert.ok(priceRow, "price parameter available");
    const money = priceRow.querySelector(".pl-in");
    assert.equal(money.type, "number");
    change(win, money, "-100");
    assert.equal(win.OFDPlanning.loadParams().checks["c|ofd|Партнёры|12"], undefined);
    assert.ok(priceRow.querySelector(".pl-error"), "invalid price is explained");
    change(win, money, "1200.50");
    assert.equal(win.OFDPlanning.loadParams().checks["c|ofd|Партнёры|12"], 1200.5);
    assert.match(board.textContent, /пересчитан/i);
    const probRow = [...board.querySelectorAll("tr[data-key]")].find((r) => r.getAttribute("data-key") === "ofd|12|first");
    assert.ok(probRow);
    change(win, probRow.querySelector(".pl-in"), "110");
    assert.equal(win.OFDPlanning.loadParams().probManual["ofd|12|first"], undefined);
    change(win, probRow.querySelector(".pl-in"), "0");
    assert.equal(win.OFDPlanning.loadParams().probManual["ofd|12|first"], 0);
  } finally { dom.window.close(); }
});

test("renewal group remains expanded after editing a valid month, invalid month is rejected", async () => {
  const { dom, win } = await page();
  try {
    const board = render(win, "pl-ofd", "ofd-test");
    assert.equal(board.querySelector(".pl-ch").tagName, "SELECT");
    const disclosure = board.querySelector(".pl-expand");
    assert.ok(disclosure, "keyboard-accessible group disclosure");
    disclosure.click();
    const month = board.querySelector(".pl-month");
    assert.ok(month);
    change(win, month, "2028-02");
    assert.equal(win.OFDPlanning.loadParams().events["ofd|RNM"], undefined);
    assert.ok(board.querySelector(".pl-error"), "invalid month is explained");
    change(win, month, "2027-07");
    assert.equal(win.OFDPlanning.loadParams().events["ofd|RNM"].month, "2027-07");
    assert.ok(board.querySelector(".pl-drill .pl-month"), "group stays open after recalculation");
  } finally { dom.window.close(); }
});

test("old saved month appears as unassigned in both board filter and Excel", async () => {
  const { dom, win } = await page();
  try {
    win.localStorage.setItem("ofd.planning.v1", JSON.stringify({
      year: 2027, events: { "ofd|RNM": { month: "2028-02" } },
    }));
    const board = render(win, "pl-ofd", "stale-month-test");
    const months = [...board.querySelectorAll(".pl-mf option")].map((option) => option.value);
    assert.ok(months.includes("не назначен"), "out-of-year month is counted as unassigned");
    assert.ok(!months.includes("2028-02"), "unexportable month is not a filter option");
    change(win, board.querySelector(".pl-mf"), "не назначен");
    assert.match(board.textContent, /1 из 1 строк/, "filtered board shows the same row as the workbook");
  } finally { dom.window.close(); }
});

test("file names remain text in the status banner", async () => {
  const { dom, win } = await page();
  try {
    const input = win.document.getElementById("fileInput");
    const name = '<img src=x onerror=alert(1)>.xlsx';
    Object.defineProperty(input, "files", { configurable: true, value: [new win.File(["invalid"], name)] });
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    const banner = win.document.getElementById("statsBanner");
    for (let n = 0; n < 100 && !banner.textContent.includes(name); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(banner.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(banner.querySelector("img"), null);
  } finally { dom.window.close(); }
});

test("all eight boards render and offer retro filters", async () => {
  const { dom, win } = await page();
  try {
    const ids = ["pl-summary", "pl-ofd", "pl-1c", "pl-upsell", "pl-retro", "pl-months", "pl-channels", "pl-params"];
    ids.forEach((id) => {
      const board = render(win, id, `all-${id}`);
      assert.ok(board.textContent.length > 20, `${id} has content`);
    });
    const months = win.document.querySelector('[data-pl-id="all-pl-months"]');
    assert.ok(months.querySelector('.pl-cell[data-pl-target="pl-ofd"][data-pl-month="2027-06"]'));
    const retro = win.document.querySelector('[data-pl-id="all-pl-retro"]');
    assert.ok(retro.querySelector('.pl-retro-tariff'), "retro can be filtered by tariff");
    assert.ok(retro.querySelector('.pl-retro-cycle'), "retro can be filtered by first/repeat cycle");
  } finally { dom.window.close(); }
});
