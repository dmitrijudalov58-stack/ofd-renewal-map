#!/usr/bin/env node
/*
 * Ежедневное обогащение базы ОФД отраслью/регионом через DaData (find-party по ИНН).
 * Отдельный офлайн-скрипт (НЕ часть браузерного бандла) -- API-ключ на фронте светить
 * нельзя (CSP + приватность), см. tmp/plans/2026-09-17-portret-1c-plan.md, фаза 1.
 *
 * Источник списка ИНН -- ~/.config/dadata/source-file.txt (путь к текущей выгрузке ОФД,
 * Дима присылает новый файл примерно раз в неделю, путь обновляется вручную при получении).
 * Приоритет (Дима, 2026-09-17): сначала клиенты с хотя бы одной ДЕЙСТВУЮЩЕЙ сейчас кассой,
 * потом вся остальная история. Уже обогащённые (есть в dadata-cache.json) -- пропускаются,
 * так прогресс копится день за днём без повторной оплаты запросов.
 *
 * Бюджет -- 9500 запросов/сутки (запас от бесплатного лимита DaData 10 000/сутки),
 * счётчик в ~/.config/dadata/daily-state.json, переживает несколько запусков в один день
 * (launchd: по расписанию + догоняющий запуск при пробуждении, см. LaunchAgent plist).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const Parser = require("../js/parser.js");
const Metrics = require("../js/metrics.js");

const CONFIG_DIR = path.join(os.homedir(), ".config", "dadata");
const KEY_FILE = path.join(CONFIG_DIR, "key");
const SOURCE_POINTER = path.join(CONFIG_DIR, "source-file.txt");
const STATE_FILE = path.join(CONFIG_DIR, "daily-state.json");
const LOG_FILE = path.join(CONFIG_DIR, "enrich.log");
const CACHE_FILE = path.join(__dirname, "..", "dadata-cache.json");
// Полный сырой ответ DaData на каждый ИНН -- Дима, 2026-09-17: "меня интересует вся
// возможная информация... не только я грил, все данные и строки". НЕ в dadata-cache.json
// (тот грузит браузер как файл -- полный ответ на 185к клиентов ~900МБ, браузер такое не
// потянет). NDJSON, дописывается построчно -- не нужно перечитывать/переписывать весь файл
// на каждый чекпоинт, как с JSON-объектом (за сотни МБ это было бы всё медленнее и медленнее).
const RAW_FILE = path.join(__dirname, "..", "dadata-raw.ndjson");

const DAILY_LIMIT = 9500;
const REQUEST_DELAY_MS = 200; // ~5 запросов/сек -- запас от возможного троттлинга DaData
const STARTUP_DELAY_MS = 150 * 1000; // "через 2-3 минуты после включения" (Дима, 2026-09-17)
const FLUSH_EVERY = 200; // периодический сброс кэша на диск -- не терять прогресс при обрыве

function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* не критично */ }
}

function readKey() {
  const key = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (!key) throw new Error("Файл ключа пуст: " + KEY_FILE);
  return key;
}

function readSourcePath() {
  const p = fs.readFileSync(SOURCE_POINTER, "utf8").trim();
  if (!p) throw new Error("Пустой указатель файла-источника: " + SOURCE_POINTER);
  return p;
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (e) { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
}

function loadDailyState() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s.date === today) return s;
  } catch (e) { /* нет файла или битый -- начинаем заново */ }
  return { date: today, used: 0 };
}
function saveDailyState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// Очередь ИНН: сначала клиенты с действующей сейчас кассой (strict:true -- дефолт
// инструмента, та же граница "действующий", что и везде в metrics.js), потом остальные.
function buildQueue(model, asOf) {
  const activeInns = [];
  const restInns = [];
  model.clients.forEach(function (c, inn) {
    const hasActive = c.kassas.some(function (k) { return Metrics.isKassaAlive(k, asOf, true); });
    (hasActive ? activeInns : restInns).push(inn);
  });
  return activeInns.concat(restInns);
}

function findParty(inn, apiKey) {
  return fetch("https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Token " + apiKey,
    },
    body: JSON.stringify({ query: inn }),
  }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

function extractFields(resp) {
  const s = resp && resp.suggestions && resp.suggestions[0];
  if (!s || !s.data) return null;
  const d = s.data;
  return {
    org: (d.name && (d.name.short || d.name.full)) || null,
    okved: d.okved || null,
    region: (d.address && d.address.data && d.address.data.region_with_type) || null,
    status: (d.state && d.state.status) || null,
    // ФИО руководителя -- "точки соприкосновения" в скоринге (2026-09-17, решение после
    // ревью): если у кандидата ТОТ ЖЕ директор, что у уже купившего 1С клиента -- решение
    // по факту принимает один человек. Публичные данные ЕГРЮЛ, но это ФИО физлица
    // (152-ФЗ) -- см. пометку юриста в разговоре, прежде чем расширять использование этого
    // поля за пределы текстовой пометки продавцу. Записи, обогащённые ДО этого поля
    // (первая партия, 9500 ИНН 2026-09-17), его не содержат -- не переобогащаем задним
    // числом ради одного поля (тратить дневной бюджет), просто постепенно заполнится.
    director: (d.management && d.management.name) || null,
  };
}

function appendRaw(inn, resp) {
  fs.appendFileSync(RAW_FILE, JSON.stringify({ inn: inn, fetchedAt: new Date().toISOString(), response: resp }) + "\n");
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // DADATA_SKIP_DELAY -- только для ручного тестирования (node scripts/dadata-enrich.js),
  // launchd-запуск этот env var не ставит, реальная 2.5-минутная задержка остаётся.
  const startupDelay = process.env.DADATA_SKIP_DELAY ? 0 : STARTUP_DELAY_MS;
  log("старт, задержка " + (startupDelay / 1000) + " сек перед началом (даём сети подняться после включения/пробуждения)");
  await sleep(startupDelay);

  const apiKey = readKey();
  const sourcePath = readSourcePath();
  const stat = fs.statSync(sourcePath);
  log("источник: " + sourcePath + " (изменён " + stat.mtime.toISOString().slice(0, 10) + ")");

  const wb = XLSX.readFile(sourcePath, { cellDates: true });
  const { rows, headerIssues } = Parser.parseWorkbook(XLSX, wb);
  if (headerIssues.length) log("ВНИМАНИЕ headerIssues: " + JSON.stringify(headerIssues));
  const model = Metrics.buildModel(rows);
  log("клиентов в выгрузке: " + model.clients.size);

  const asOf = new Date();
  const queue = buildQueue(model, asOf);
  const cache = loadCache();
  const state = loadDailyState();
  const budgetLeft = DAILY_LIMIT - state.used;
  log("бюджет на сегодня остаток: " + budgetLeft + " (уже использовано сегодня: " + state.used + ")");

  const pending = queue.filter(function (inn) { return !cache[inn]; });

  let done = 0, errors = 0;
  // DADATA_TEST_LIMIT -- только для ручного тестирования (перекрывает дневной бюджет
  // маленьким числом, чтобы не тратить сразу тысячи реальных запросов на проверку).
  const testLimit = process.env.DADATA_TEST_LIMIT ? parseInt(process.env.DADATA_TEST_LIMIT, 10) : null;
  const cap = testLimit != null ? Math.min(testLimit, budgetLeft) : budgetLeft;
  const toProcess = pending.slice(0, Math.max(0, cap));
  log("нужно обогатить всего (без кэша): " + pending.length + ", сегодня попробуем: " + toProcess.length + (testLimit != null ? " (тестовый лимит)" : ""));
  for (const inn of toProcess) {
    try {
      const resp = await findParty(inn, apiKey);
      appendRaw(inn, resp);
      const fields = extractFields(resp);
      cache[inn] = Object.assign({ enrichedAt: new Date().toISOString() }, fields || { notFound: true });
      done++;
    } catch (e) {
      errors++;
      log("ошибка по ИНН " + inn + ": " + e.message);
    }
    state.used++;
    if (done % FLUSH_EVERY === 0) { saveCache(cache); saveDailyState(state); }
    await sleep(REQUEST_DELAY_MS);
  }
  saveCache(cache);
  saveDailyState(state);
  log("готово: обработано " + done + ", ошибок " + errors + ", осталось в очереди на завтра: " + (pending.length - toProcess.length));
}

main().catch(function (e) {
  log("КРИТИЧЕСКАЯ ОШИБКА: " + (e && e.stack || e));
  process.exit(1);
});
