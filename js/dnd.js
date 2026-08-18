/*
 * Библиотека виджетов -> холст: GridStack.js (миграция 2026-08-17). Раньше был самописный
 * free-pixel движок с коллизиями через глобальный перебор всего холста -- отсюда "улёт"
 * карточек при столкновении (findBestFreeSpot, история решений сохранена в SKILL.md этого
 * скилла). GridStack работает в единицах ячеек сетки (12 колонок), коллизии решает сам
 * через локальную гравитацию вверх (float:false) -- телепортироваться физически некуда.
 * Зависит от window.OFDWidgets (js/widgets.js), window.OFDState (app.js), глобального
 * GridStack (js/vendor/gridstack-all.js, подключён в index.html до этого файла).
 */
(function (root) {
  "use strict";

  var canvas = document.getElementById("canvas");
  var emptyState = document.getElementById("emptyState");
  var placed = []; // [{instanceId, widgetId}] -- порядок не важен, просто реестр текущих карточек

  var grid = GridStack.init({
    column: 12, cellHeight: 60, margin: 8, float: false, animate: true,
    resizable: { handles: "se" },
    draggable: { handle: ".widget-head" },
    // Без acceptWidgets GridStack явно выключает своё droppable-поведение
    // (_setupAcceptWidget() зовёт droppable(el,"destroy") при его отсутствии) -- сетка
    // тащить-то тащит (setupDragIn работает независимо от этой опции), но никогда не
    // принимает дроп: перетаскивание из библиотеки визуально ничего не делало.
    // Строка-селектор, не true -- дефолт true проверяет класс .grid-stack-item, а у наших
    // карточек библиотеки класс .lib-item (проверено по исходнику gridstack-all.js).
    acceptWidgets: ".lib-item",
  }, canvas);

  // Дефолтные размеры по типу виджета (в ячейках) -- узкие одиночные карточки-цифры
  // остаются компактными, широкие (графики/таблицы/раскрывающиеся списки) -- w:8 из 12
  // (эквивалент бывшего .span-2 740px), таблицам чуть больше высоты, чем графикам.
  function defaultSizeFor(def) {
    if (!def.span) return { w: 3, h: 3, minW: 2, minH: 2 };
    var isTable = (def.type || "").indexOf("таблица") !== -1 || (def.type || "").indexOf("раскрывается") !== -1;
    return { w: 8, h: isTable ? 8 : 6, minW: 4, minH: 3 };
  }

  function toggleEmpty() {
    emptyState.style.display = placed.length === 0 ? "flex" : "none";
  }

  // Один виджет с плохими данными/крайним случаем не должен рушить остальные. Раньше
  // def.render() вызывался без защиты и в addWidget(), и в rerenderAll() -- если ОДИН
  // виджет бросал исключение при смене периода, весь forEach в rerenderAll() обрывался, и
  // ВСЕ виджеты ПОСЛЕ сломавшегося в списке `placed` оставались со старым (не обновлённым)
  // содержимым -- симптом "борд не отображается после смены диапазона, помогает только
  // удалить и перетащить заново" (Дима, 2026-08-18). Единая точка защиты -- любой сбой
  // рендера превращается в понятный плейсхолдер с кнопкой "⟳ обновить" вместо тихого
  // застревания на старых данных, и не мешает соседним виджетам обновиться.
  function safeRenderBody(def, model, ctx) {
    try {
      return def.render(model, ctx);
    } catch (e) {
      console.error('Ошибка рендера виджета «' + def.title + '»:', e);
      var box = document.createElement("div");
      var msg = document.createElement("div");
      msg.style.cssText = "color:var(--crit);font-size:12.5px;margin-bottom:8px";
      msg.textContent = "⚠ Не удалось отобразить: " + (e && e.message ? e.message : String(e));
      var hint = document.createElement("div");
      hint.style.cssText = "font-size:11.5px;color:var(--muted)";
      hint.textContent = "Нажми «⟳» в шапке карточки, чтобы попробовать снова.";
      box.appendChild(msg);
      box.appendChild(hint);
      return box;
    }
  }

  function renderInstance(widgetId) {
    var def = root.OFDWidgets.WIDGETS[widgetId];
    if (!def) return null;
    var state = root.OFDState;
    if (!state || !state.model) return null;
    var body = safeRenderBody(def, state.model, state.ctx);
    var node = root.OFDWidgets.widgetShell(widgetId, def.title, def.type, def.scope, body, def.exportable ? '<button class="export-btn">Экспорт CSV / Excel</button>' : "");
    if (def.exportable) {
      var btn = node.querySelector(".export-btn");
      btn.addEventListener("click", function () {
        var bodyEl = node.querySelector(".widget-body").firstElementChild;
        var rows = bodyEl && bodyEl._getExportRows ? bodyEl._getExportRows() : null;
        if (rows && root.OFDExport) root.OFDExport.downloadCSV(def.title, rows);
      });
    }
    return node;
  }

  // GridStack требует РЕАЛЬНЫЙ .grid-stack-item-content как потомка для resizeToContent()
  // (ищет его через querySelector внутри item -- сам не создаёт: если передать голый узел
  // напрямую, он просто станет .grid-stack-item БЕЗ обёртки, и resizeToContent молча ничего
  // не сделает -- проверено чтением исходника gridstack-all.js и разовым скриптом). Строим
  // обёртку сами.
  function buildGridItem(widgetNode) {
    var contentWrap = document.createElement("div");
    contentWrap.className = "grid-stack-item-content";
    contentWrap.appendChild(widgetNode);
    var outer = document.createElement("div");
    outer.appendChild(contentWrap);
    return outer;
  }

  // Крестик "убрать виджет" -- переехал сюда из widgetShell (нужен доступ к grid для
  // grid.removeWidget()) -- node.remove() оставил бы пустой .grid-stack-item в
  // GridStack-engine навсегда (призрачная ячейка, участвует и в гравитации, и в сохранении).
  function wireRemove(widgetNode) {
    var btn = widgetNode.querySelector(".remove-btn");
    btn.addEventListener("click", function () {
      var itemEl = widgetNode.closest(".grid-stack-item");
      if (!itemEl) return;
      var instanceId = itemEl.dataset.instanceId;
      grid.removeWidget(itemEl);
      placed = placed.filter(function (p) { return p.instanceId !== instanceId; });
      toggleEmpty();
    });
  }

  // Пересобирает ТОЛЬКО .widget-body одной карточки — общий путь для rerenderAll() (все
  // карточки разом) и ручной кнопки "⟳" на конкретной (см. Дима, 2026-08-18 — просил
  // кнопку рефреша борда как раз для случаев, когда что-то отобразилось не так).
  function renderWidgetBody(widgetNode, widgetId) {
    var def = root.OFDWidgets.WIDGETS[widgetId];
    if (!def) return;
    var state = root.OFDState;
    if (!state || !state.model) return;
    var bodyEl = widgetNode.querySelector(".widget-body");
    if (!bodyEl) return;
    var fresh = safeRenderBody(def, state.model, state.ctx);
    // БАГ (найден Димой 2026-08-18): многие def.render() возвращают ГОТОВУЮ HTML-СТРОКУ,
    // не DOM Node (statBlock() и всё, что его использует -- карточки b1-active и т.п.).
    // createTextNode() вставлял такую строку как ЭКРАНИРОВАННЫЙ ТЕКСТ, не как разметку --
    // на экране буквально показывался HTML-код вместо карточки, при КАЖДОМ rerenderAll
    // (смена периода/as-of), не только иногда. Тихий баг, без исключения -- поэтому не
    // поймался ни одним прошлым тестом (те ловили только exceptions). Фикс -- та же логика,
    // что и в widgetShell()/renderInstance(): строка идёт через innerHTML (разметка), не
    // createTextNode (текст). Обёртка в <div> сохраняет инвариант ".widget-body содержит
    // ровно один корневой узел", на который где-то могли опираться firstElementChild-обращения.
    if (fresh instanceof Node) {
      bodyEl.innerHTML = "";
      bodyEl.appendChild(fresh);
    } else {
      bodyEl.innerHTML = "<div>" + String(fresh) + "</div>";
    }
  }

  // Кнопка "⟳" в шапке — принудительный ручной рефреш конкретной карточки в любой момент,
  // не только при ошибке (пользователь сам решает, когда что-то выглядит не так).
  function wireRefresh(widgetNode, widgetId) {
    var btn = widgetNode.querySelector(".refresh-widget-btn");
    btn.addEventListener("click", function () {
      renderWidgetBody(widgetNode, widgetId);
    });
  }

  function addWidget(widgetId, x, y, w, h) {
    if (!root.OFDState || !root.OFDState.model) return;
    var def = root.OFDWidgets.WIDGETS[widgetId];
    if (!def) return;
    var widgetNode = renderInstance(widgetId);
    if (!widgetNode) return;
    var size = defaultSizeFor(def);
    var gridItem = buildGridItem(widgetNode);
    var opts = {
      w: w || size.w, h: h || size.h, minW: size.minW, minH: size.minH,
      autoPosition: x == null || y == null,
    };
    if (x != null) opts.x = x;
    if (y != null) opts.y = y;
    var itemEl = grid.addWidget(gridItem, opts);
    var instanceId = "w" + Math.random().toString(36).slice(2, 9);
    itemEl.dataset.instanceId = instanceId;
    wireRemove(widgetNode);
    wireRefresh(widgetNode, widgetId);
    placed.push({ instanceId: instanceId, widgetId: widgetId });
    toggleEmpty();
  }

  // Смена периода/as-of -- подменяем ТОЛЬКО .widget-body (не весь .grid-stack-item-content,
  // не сам .widget) -- .widget-head остаётся тем же DOM-узлом, на котором DDDraggable
  // резолвил dragEl при инициализации карточки (резолвится один раз в конструкторе,
  // повторной инициализации в публичном API нет -- подмена всего контента убила бы drag
  // после первой же смены фильтра). Подмена через innerHTML, не replaceWith -- иначе плодим
  // утечку слушателей на выброшенных узлах при каждой смене периода. Экспорт-кнопка не
  // требует перепривязки -- резолвит .widget-body в момент клика, замыкание переживает
  // подмену innerHTML.
  function rerenderAll() {
    placed.forEach(function (p) {
      var itemEl = canvas.querySelector('[data-instance-id="' + p.instanceId + '"]');
      if (!itemEl) return;
      // renderWidgetBody сама оборачивает def.render() в safeRenderBody -- сбой ОДНОГО
      // виджета тут не мешает forEach дойти до остальных (Дима, 2026-08-18, см. safeRenderBody).
      renderWidgetBody(itemEl, p.widgetId);
    });
  }

  // Вместо точечных resizeToContent-вызовов в каждом из 8+ виджетов с раскрытием/
  // переключателями вида/% по отдельности -- один делегированный обработчик кликов на весь
  // холст: любой клик внутри карточки может поменять высоту контента (раскрытие строки,
  // тумблер, кнопка "обновить график") -- пересчитываем без разбора, откуда именно клик.
  // resizeToContent -- дешёвая операция (getBoundingClientRect), лишние вызовы не создают
  // проблем. Debounce 50мс -- не пересчитывать на каждый клик из быстрой серии (например
  // сортировка таблицы по нескольким колонкам подряд).
  var resizeDebounce = null;
  canvas.addEventListener("click", function (e) {
    var itemEl = e.target.closest && e.target.closest(".grid-stack-item");
    if (!itemEl) return;
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(function () {
      grid.resizeToContent(itemEl);
    }, 50);
  });

  // Авто-рост карточки (sizeToContent) и ручной ресайз за уголок физически несовместимы в
  // GridStack: после resizestop библиотека сама пересчитывает высоту по контенту и затирает
  // то, что юзер только что задал руками. Тронул руками -> авто-рост выключается для этой
  // карточки навсегда (решение Димы: интуитивно, взял контроль руками -- система больше не лезет).
  grid.on("resizestop", function (event, el) {
    if (el && el.gridstackNode) el.gridstackNode.sizeToContent = false;
  });

  // Перетаскивание из библиотеки (левый сайдбар) -- GridStack.setupDragIn кладёт на дроп
  // КЛОН исходного .lib-item (не готовый виджет, см. проверку по исходнику gridstack-all.js:
  // _gsEventHandler.dropped вызывается с (event, previousWidget, newWidget), newWidget.el --
  // это склонированный .lib-item, уже получивший класс .grid-stack-item и gs-x/gs-y/gs-w/gs-h
  // от движка). Забираем widgetId из data-атрибута клона, убираем клон, добавляем
  // настоящий виджет через addWidget с уже вычисленными GridStack координатами.
  GridStack.setupDragIn(".lib-item", { appendTo: "body", helper: "clone" });
  grid.on("dropped", function (event, previousWidget, newWidget) {
    if (!newWidget || !newWidget.el) return;
    var widgetId = newWidget.el.dataset.widget;
    grid.removeWidget(newWidget.el);
    if (widgetId) addWidget(widgetId, newWidget.x, newWidget.y, newWidget.w, newWidget.h);
  });

  // ---------- сохранение/восстановление раскладки между сессиями ----------
  //
  // v2 -- координаты в ЯЧЕЙКАХ сетки (GridStack), не px. v1 (старый pixel-формат) --
  // сохраняется нетронутым, не удаляется, конвертируется ОДИН РАЗ (см. loadSavedLayout) --
  // старая раскладка Димы (кнопка "Сохранить расположение", 12.08) не пропадает молча.
  var LAYOUT_KEY_V2 = "ofd-canvas-layout-v2";
  var LAYOUT_KEY_V1 = "ofd-canvas-layout-v1";

  function saveLayout() {
    var data = {
      version: 2,
      widgets: placed.map(function (p) {
        var itemEl = canvas.querySelector('[data-instance-id="' + p.instanceId + '"]');
        var node = itemEl && itemEl.gridstackNode;
        return {
          widgetId: p.widgetId,
          x: node ? node.x : 0, y: node ? node.y : 0,
          w: node ? node.w : null, h: node ? node.h : null,
        };
      }),
    };
    try {
      localStorage.setItem(LAYOUT_KEY_V2, JSON.stringify(data));
      return true;
    } catch (e) {
      return false; // приватный режим браузера и т.п. -- localStorage может быть недоступен
    }
  }

  // Конвертер v1 (px) -> v2 (ячейки). float:false сам доуплотнит результат в валидную
  // раскладку. width/height в v1 могут быть null (виджет никогда не ресайзился руками,
  // старый dnd.js писал именно null, не 0) -- без guard'а round(null/col) даёт NaN, поэтому
  // явный фолбэк на дефолт по типу виджета (тот же, что использует addWidget для новых карточек).
  function convertV1ToV2(v1Data) {
    var col = (canvas.clientWidth || 1200) / 12;
    var cellHeight = 60;
    return {
      version: 2,
      widgets: v1Data.widgets.map(function (w) {
        var def = root.OFDWidgets.WIDGETS[w.widgetId];
        var fallback = def ? defaultSizeFor(def) : { w: 3, h: 3 };
        return {
          widgetId: w.widgetId,
          x: Math.round((w.x || 0) / col),
          y: Math.round((w.y || 0) / cellHeight),
          w: w.width ? Math.max(1, Math.round(w.width / col)) : fallback.w,
          h: w.height ? Math.max(1, Math.round(w.height / cellHeight)) : fallback.h,
        };
      }),
    };
  }

  // Возвращает {restored, converted} -- ВСЕГДА объект (не boolean), вызывающий код (app.js)
  // проверяет .restored (добавлять ли 5 дефолтных виджетов) и .converted (показать ли баннер
  // "раскладка перенесена на новую сетку"). Конвертер v1->v2 запускается ОДИН РАЗ (пока v2
  // отсутствует в localStorage) -- дальше читается только v2, v1 не трогается и не удаляется.
  function loadSavedLayout() {
    if (!root.OFDState || !root.OFDState.model) return { restored: false, converted: false };
    var raw;
    try { raw = localStorage.getItem(LAYOUT_KEY_V2); } catch (e) { return { restored: false, converted: false }; }
    var data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch (e) { data = null; }
    }
    var usedConverter = false;
    if (!data) {
      var rawV1;
      try { rawV1 = localStorage.getItem(LAYOUT_KEY_V1); } catch (e) { rawV1 = null; }
      if (rawV1) {
        var v1Data = null;
        try { v1Data = JSON.parse(rawV1); } catch (e) { v1Data = null; }
        if (v1Data && Array.isArray(v1Data.widgets) && v1Data.widgets.length) {
          data = convertV1ToV2(v1Data);
          usedConverter = true;
          try { localStorage.setItem(LAYOUT_KEY_V2, JSON.stringify(data)); } catch (e) { /* приватный режим и т.п. -- не критично, просто не закешируется */ }
        }
      }
    }
    if (!data || !Array.isArray(data.widgets) || !data.widgets.length) return { restored: false, converted: false };
    var restored = false;
    data.widgets.forEach(function (w) {
      if (w && root.OFDWidgets.WIDGETS[w.widgetId]) {
        addWidget(w.widgetId, w.x || 0, w.y || 0, w.w, w.h);
        restored = true;
      }
    });
    if (restored) toggleEmpty();
    return { restored: restored, converted: usedConverter };
  }

  root.OFDCanvas = { addWidget: addWidget, rerenderAll: rerenderAll, saveLayout: saveLayout, loadSavedLayout: loadSavedLayout };
})(typeof window !== "undefined" ? window : globalThis);
