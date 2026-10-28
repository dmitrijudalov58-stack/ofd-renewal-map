// Тест генератора .xlsx (js/export.js). Реальный файл выгрузки не нужен.
// 1) Регрессия: одно-листовые выгрузки (прозвон 1С, отдел продаж) побайтно такие же, как до
//    добавления многолистового режима (хеши сняты с кода ДО рефакторинга, 2026-10-28).
// 2) Новое: spec.sheets -- несколько видимых листов в одном файле.
const crypto = require("crypto");
const XLSX = require("xlsx");
const { buildXlsx } = require("../js/export.js");

let failed = 0;
function check(name, ok, extra) {
  console.log(name + ":", ok ? "OK" : "FAIL", ok || extra === undefined ? "" : extra);
  if (!ok) failed++;
}
const sha = (bytes) => crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

// --- 1) регрессия одно-листового режима ---
const plainSpec = {
  sheetName: "Лист",
  headers: ["Имя", "ИНН", "Число"],
  rows: [["Альфа", "0123456789", 5], ["Бета & <Ко>", "7700000001", 12.5], ["Гамма", null, 0]],
  colWidths: [20, 14, 8],
  textCols: [1],
};
const listSpec = {
  sheetName: "Прозвон",
  headers: ["Клиент", "Статус"],
  rows: [["ООО «Х»", "Звонили"], ["ИП Y", ""]],
  colWidths: [24, 14],
  listColumn: { index: 1, options: ["Звонили", "Не дозвонились"], sheetName: "Списки" },
};
// sha256 байтов .xlsx, снятый с кода ДО добавления многолистового режима
const PRE_REFACTOR_HASHES = {
  plain: "c8b509f1960209aeb0bd13599ed099dc34e0c83b4fc992fb26d2b7cd68babd8a",
  list: "10f45a1853bc0d8cc061a2bca2c75d0b392efd6d31198ca56d8b4400fc3f1dc3",
};
if (process.argv.includes("--print-hashes")) {
  console.log(JSON.stringify({ plain: sha(buildXlsx(plainSpec)), list: sha(buildXlsx(listSpec)) }));
  process.exit(0);
}
check("регрессия: одно-листовой xlsx без изменений", sha(buildXlsx(plainSpec)) === PRE_REFACTOR_HASHES.plain, sha(buildXlsx(plainSpec)));
check("регрессия: xlsx с выпадающим списком без изменений", sha(buildXlsx(listSpec)) === PRE_REFACTOR_HASHES.list, sha(buildXlsx(listSpec)));

// --- 2) многолистовой режим ---
const multi = buildXlsx({
  sheets: [
    {
      sheetName: "Детализация",
      headers: ["ЦП", "ИНН партнёра", "PIN"],
      rows: [["Уфа", "0700000010", 30], ["Омск", "7700000032", 4]],
      colWidths: [20, 14, 8],
      textCols: [1],
    },
    {
      sheetName: "Сводка по партнёрам",
      headers: ["ЦП", "Партнёр", "Куплено"],
      rows: [["Уфа", "ООО «Ромашка»", 100]],
      colWidths: [20, 24, 10],
    },
  ],
});
const wb = XLSX.read(Buffer.from(multi), { type: "buffer" });
check("многолистовой: два листа с нужными именами", JSON.stringify(wb.SheetNames) === JSON.stringify(["Детализация", "Сводка по партнёрам"]), JSON.stringify(wb.SheetNames));
const s1 = XLSX.utils.sheet_to_json(wb.Sheets["Детализация"], { header: 1, raw: true });
const s2 = XLSX.utils.sheet_to_json(wb.Sheets["Сводка по партнёрам"], { header: 1, raw: true });
check("многолистовой: лист 1 — шапка и строки", JSON.stringify(s1) === JSON.stringify([["ЦП", "ИНН партнёра", "PIN"], ["Уфа", "0700000010", 30], ["Омск", "7700000032", 4]]), JSON.stringify(s1));
check("многолистовой: ИНН остался текстом с ведущим нулём", s1[1][1] === "0700000010" && typeof s1[1][1] === "string");
check("многолистовой: лист 2 — шапка и строки", JSON.stringify(s2) === JSON.stringify([["ЦП", "Партнёр", "Куплено"], ["Уфа", "ООО «Ромашка»", 100]]), JSON.stringify(s2));
check("многолистовой: оба листа видимые (не hidden)", wb.Workbook.Sheets.every((s) => !s.Hidden), JSON.stringify(wb.Workbook.Sheets));
check("многолистовой: автофильтр на каждом листе", wb.Sheets["Детализация"]["!autofilter"].ref === "A1:C3" && wb.Sheets["Сводка по партнёрам"]["!autofilter"].ref === "A1:C2",
  JSON.stringify([wb.Sheets["Детализация"]["!autofilter"], wb.Sheets["Сводка по партнёрам"]["!autofilter"]]));

// пустой лист не должен ломать книгу
const emptyOk = (() => {
  try {
    const b = XLSX.read(Buffer.from(buildXlsx({ sheets: [
      { sheetName: "Пусто", headers: ["А", "Б"], rows: [], colWidths: [10, 10] },
      { sheetName: "Есть", headers: ["А"], rows: [["x"]], colWidths: [10] },
    ] })), { type: "buffer" });
    return b.SheetNames.length === 2;
  } catch (e) { return false; }
})();
check("многолистовой: пустой лист допустим", emptyOk);

if (failed) { console.error("FAIL: export-xlsx.test.js, провалов:", failed); process.exitCode = 1; }
else console.log("export-xlsx.test.js: всё OK");
