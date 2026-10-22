// Синтетический xlsx формата выгрузки ОФД (29 колонок) для воспроизведения UI-багов. Без реальных данных.
"use strict";
const XLSX = require("xlsx");
const H = ["Перезакреп", "Тип", "PIN код", "Дата создания", "Статус", "Срок действия тарифа", "ИНН", "Промокод", "Тип активации", "Дата активации",
  "Дата окончания", "Общая дата окончания", "РНМ ККТ", "Организация", "ИНН организации", "КПП организации", "Номер телефона", "Email", "Комментарий", "Партнер",
  "ИНН партнера", "КПП партнера", "Центр продаж", "Тип продаж", "РРЦ", "Партнер", "ЦП", "1C", "КА"];
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const TARIFFS = ["3 мес.", "12 мес.", "13 мес.", "15 мес.", "36 мес."];
const MONTHS = { "3 мес.": 3, "12 мес.": 12, "13 мес.": 13, "15 мес.": 15, "36 мес.": 36 };
const PARTNERS = [["ООО Альфа", "7700000001"], ["ООО Бета", "7700000002"], ["ИП Гамма", "7700000003"]];
const rows = [H];
const addM = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const ASOF = new Date("2026-10-19");
for (let c = 0; c < 600; c++) {
  const inn = String(7700100000 + c);
  const ip = rnd() < 0.4;
  const kassas = 1 + Math.floor(rnd() * (rnd() < 0.1 ? 12 : 3));
  const start0 = new Date(2020 + Math.floor(rnd() * 6), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27));
  const [pn, pi] = pick(PARTNERS);
  for (let k = 0; k < kassas; k++) {
    const rnm = String(1000000000 + c * 20 + k).padStart(20, "0");
    let s = new Date(start0.getTime() + k * 86400000 * 20);
    const codes = 1 + Math.floor(rnd() * 4);
    for (let q = 0; q < codes && s < ASOF; q++) {
      const t = pick(TARIFFS), e = addM(s, MONTHS[t]);
      rows.push(["", "Новый", "PIN" + c + "-" + k + "-" + q, s, "Зарегистрировано", t, ip ? inn : "", "", "Партнёр", s, e, e, rnm,
        ip ? "ИП Тестов " + c : "ООО Тест " + c, ip ? "" : inn, "", "+7900" + String(1000000 + c).slice(-7), "t" + c + "@example.test", "", pn, pi, "", "ЦП1", pick(["Прямые", "Партнёры", "Онлайн"]),
        "", pn, "", "", ""]);
      s = new Date(e.getTime() + 86400000 * Math.floor(rnd() * 60));
    }
  }
}
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Лист1");
const out = process.argv[2];
XLSX.writeFile(wb, out, { cellDates: true });
console.log("rows", rows.length - 1, "->", out);
