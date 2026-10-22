// Проверка перетаскивания ЦЕЛОГО раздела библиотеки на холст в РЕАЛЬНОМ браузере (jsdom не умеет
// раскладку и drag GridStack). Запуск как у grid-fit.js: открыть index.html, загрузить выгрузку ОФД,
// затем выполнить файл в странице; нужный раздел задаётся переменной window.__gid (по умолчанию b10):
//   browse js 'window.__gid="b10"; 1'; browse js "$(cat test/browser-check/group-drop.js)"
// Печатает JSON {pass, checks[]}. Цепочка mousedown/mousemove/mouseenter/mouseup -- то, чего ждёт
// GridStack при drag-in (один mousemove, как у "быстрого" drag из автоматизации, его не запускает).
(async () => {
  const gid = window.__gid || "b10";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  const groupEl = Array.from(document.querySelectorAll("details.board-group")).find((d) => d.dataset.group === gid);
  const expected = Array.from(groupEl.querySelectorAll(".lib-item[data-widget]"))
    .filter((i) => !i.hasAttribute("data-skip-group")).map((i) => i.dataset.widget);
  const before = document.querySelectorAll(".grid-stack-item").length;
  const preexisting = new Set(Array.from(document.querySelectorAll(".grid-stack-item")).map((i) => i.gridstackNode));

  document.querySelectorAll("details.board-group[open]").forEach((d) => { d.open = false; });
  window.scrollTo(0, 0); await sleep(200);
  const handle = groupEl.querySelector(".lib-group");
  check("у заголовка раздела есть ручка .lib-group", !!handle, gid);
  const canvas = document.getElementById("canvas");
  const hr = handle.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
  const start = { x: hr.x + 20, y: hr.y + hr.height / 2 };
  const drop = { x: cr.x + 300, y: Math.min(cr.y + 500, innerHeight - 50) };
  const fire = (type, el, pt, bubbles = true) => el.dispatchEvent(new MouseEvent(type, { bubbles, cancelable: true, view: window, clientX: pt.x, clientY: pt.y, button: 0, buttons: type === "mouseup" ? 0 : 1 }));
  fire("mousedown", handle, start);
  for (let i = 1; i <= 25; i++) {
    const pt = { x: start.x + (drop.x - start.x) * i / 25, y: start.y + (drop.y - start.y) * i / 25 };
    fire("mousemove", document.elementFromPoint(pt.x, pt.y) || document.body, pt);
    if (i === 20) fire("mouseenter", canvas, pt, false);
    await sleep(30);
  }
  fire("mousemove", canvas, drop); await sleep(100);
  fire("mouseup", canvas, drop); await sleep(2500);

  const added = Array.from(document.querySelectorAll(".grid-stack-item")).filter((i) => !preexisting.has(i.gridstackNode));
  check("добавлено столько бордов, сколько в разделе", added.length === expected.length, added.length + " из " + expected.length);
  const byY = added.slice().sort((a, b) => a.gridstackNode.y - b.gridstackNode.y).map((i) => i.querySelector(".widget").dataset.widgetId);
  check("порядок сверху вниз = порядок в библиотеке", JSON.stringify(byY) === JSON.stringify(expected), byY.join(","));
  check("все на всю ширину (12 колонок, x=0)", added.every((i) => i.gridstackNode.w === 12 && i.gridstackNode.x === 0), "");
  const ys = added.map((i) => i.gridstackNode.y).sort((a, b) => a - b);
  check("борды не наложены друг на друга", ys.every((y, k) => k === 0 || y > ys[k - 1]), ys.join(","));
  const clipped = added.filter((i) => { const w = i.querySelector(".widget"); return w.scrollHeight - w.clientHeight > 0; })
    .map((i) => i.querySelector(".widget").dataset.widgetId);
  check("ни один борд не обрезан", clipped.length === 0, clipped.join(","));
  // B9 «Прирост базы»: таблица обязана расти с числом строк до потолка 560px, а не быть зажатой на min-height 250px
  const squeezed = added.flatMap((i) => Array.from(i.querySelectorAll(".ch-tablebox .table-scroll")))
    .filter((ts) => ts.scrollHeight - ts.clientHeight > 1 && ts.clientHeight < 555).length;
  check("таблицы B9 видны целиком либо упёрлись в потолок (не зажаты)", squeezed === 0, squeezed);
  check("панель раздела не раскрылась от перетаскивания", !groupEl.open, "");
  check("прежние карточки на месте (не потеряны)", document.querySelectorAll(".grid-stack-item").length === before + expected.length, "");

  return JSON.stringify({ pass: checks.every((c) => c.ok), checks }, null, 1);
})()
