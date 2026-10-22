// Проверка авто-высоты карточек в РЕАЛЬНОМ браузере (jsdom не считает раскладку, поэтому в npm test этого нет).
// Запуск: поднять сайт локально (python3 -m http.server 8765), открыть index.html, загрузить любую
// выгрузку ОФД, затем выполнить этот файл в странице:
//   ~/.claude/skills/gstack/browse/dist/browse js "$(cat test/browser-check/grid-fit.js)"
// Печатает JSON {pass, checks[]}; pass=false -> регресс бага "борд оттягивается вниз" (Дима, 2026-10-22).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SLACK_MAX = 70; // ячейка 60px + поля 8px: больше одного шага округления вверх быть не должно
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const itemOf = (id) => document.querySelector('.grid-stack-item [data-widget-id="' + id + '"]').closest(".grid-stack-item");
  const slackOf = (it) => it.getBoundingClientRect().height - it.querySelector(".widget").getBoundingClientRect().height - 8;
  const clippedOf = (it) => { const w = it.querySelector(".widget"); return w.scrollHeight - w.clientHeight; };

  await sleep(500);
  const items = Array.from(document.querySelectorAll(".grid-stack-item"));
  check("на холсте есть карточки", items.length > 0, items.length);
  const bad = items.filter((it) => slackOf(it) > SLACK_MAX || clippedOf(it) > 0)
    .map((it) => it.querySelector(".widget").dataset.widgetId + " slack=" + Math.round(slackOf(it)) + " clip=" + clippedOf(it));
  check("все карточки по содержимому: нет обрезки и пустоты больше шага сетки", bad.length === 0, bad.join("; "));

  // Храповик: контент вырос и вернулся -- карточка обязана вырасти и сжаться обратно.
  const id = items[0].querySelector(".widget").dataset.widgetId;
  const it = itemOf(id), body = it.querySelector(".widget-body");
  const h0 = it.gridstackNode.h;
  const spacer = document.createElement("div");
  spacer.style.height = "600px";
  body.appendChild(spacer); await sleep(400);
  const h1 = it.gridstackNode.h;
  check("карточка растёт вместе с контентом", h1 > h0, h0 + " -> " + h1);
  spacer.remove(); await sleep(400);
  const h2 = it.gridstackNode.h;
  check("карточка СЖИМАЕТСЯ обратно при уменьшении контента (баг: оставалась растянутой)", h2 === h0, h1 + " -> " + h2 + ", было " + h0);

  // Ручной режим: авто-подгонка выключена, "⟳" возвращает авто-высоту.
  it.classList.add("gs-manual");
  body.appendChild(spacer); await sleep(400);
  check("в ручном режиме авто-подгонка не трогает карточку", it.gridstackNode.h === h0, "h=" + it.gridstackNode.h);
  spacer.remove();
  it.querySelector(".refresh-widget-btn").click(); await sleep(400);
  check("«⟳» снимает ручной режим", !it.classList.contains("gs-manual"), "");

  return JSON.stringify({ pass: checks.every((c) => c.ok), checks }, null, 1);
})()
