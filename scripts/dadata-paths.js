/*
 * Пути DaData-обогащения -- в одном месте, чтобы скрипт обогащения и сторож
 * (dadata-watchdog.js) не разошлись. Переопределяются env-переменными -- только для тестов.
 */
"use strict";
const os = require("os");
const path = require("path");

const CONFIG_DIR = process.env.DADATA_CONFIG_DIR || path.join(os.homedir(), ".config", "dadata");

module.exports = {
  CONFIG_DIR: CONFIG_DIR,
  KEY_FILE: path.join(CONFIG_DIR, "key"),
  SOURCE_POINTER: path.join(CONFIG_DIR, "source-file.txt"),
  STATE_FILE: path.join(CONFIG_DIR, "daily-state.json"),
  LOG_FILE: path.join(CONFIG_DIR, "enrich.log"),
  // Итог последнего ЗАВЕРШЁННОГО прогона (сколько осталось в очереди) -- читает сторож.
  STATUS_FILE: path.join(CONFIG_DIR, "status.json"),
  // На рабочем столе, НЕ в репозитории (Дима, 2026-09-18) -- один физический файл,
  // готов для drag-and-drop в браузер.
  CACHE_FILE: process.env.DADATA_CACHE_FILE || path.join(os.homedir(), "Desktop", "dadata-cache.json"),
};
