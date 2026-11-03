/* Фоновая сборка Excel: строки приходят небольшими порциями, UI не клонирует весь отчёт разом. */
importScripts("export.js");

var config = null;
var rows = [];
self.onmessage = function (event) {
  try {
    var message = event.data;
    if (message.type === "start") {
      config = message.spec;
      rows = [];
    } else if (message.type === "rows" && config && Array.isArray(message.rows)) {
      for (var i = 0; i < message.rows.length; i++) rows.push(message.rows[i]);
    } else if (message.type === "finish" && config) {
      var bytes = self.OFDExport.buildXlsx({ ...config, rows: rows });
      self.postMessage({ bytes: bytes.buffer }, [bytes.buffer]);
      config = null;
      rows = [];
    } else {
      throw new Error("Некорректные данные для экспорта Excel");
    }
  } catch (error) {
    self.postMessage({ error: error && error.message ? error.message : "Не удалось собрать Excel" });
  }
};
