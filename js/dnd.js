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
  var MANUAL_CLASS = "gs-manual"; // карточка, высоту которой задал руками (ресайз за уголок)
  var FULL_WIDTH = 12; // колонок на всю ширину холста (column: 12 ниже)

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
    // def.defaultH -- стартовая высота, если типовых 8 ячеек мало (B9 «Прирост базы»: шапка,
    // плашка грейса и подпись съедают ~350px, на таблицу при h:8 оставалось 0 строк).
    return { w: 8, h: def.defaultH || (isTable ? 8 : 6), minW: 4, minH: 3 };
  }

  function toggleEmpty() {
    emptyState.style.display = placed.length === 0 ? "flex" : "none";
  }

  // ---------- высота карточки = высота содержимого (решение Димы, 2026-10-22) ----------
  // БАГ (Дима, 2026-10-22): клик по борду растил КАРТОЧКУ, а не полезную площадь, и назад она
  // не сжималась. Причина: у .widget был min-height:100%, а GridStack.resizeToContent() берёт
  // высоту виджета как "нужную" -- она не могла быть меньше текущей высоты карточки, поэтому
  // карточка только росла (раскрыл строку, закрыл -- пустота внизу остаётся навсегда), а
  // округление вверх до целой ячейки добавляло ещё 60-90px. Теперь .widget имеет естественную
  // высоту (min-height убран), а подгонку делает ResizeObserver: он ловит ЛЮБОЕ изменение
  // содержимого (клик, фильтр, смена периода, подгрузка шрифта, перенос строк при смене
  // ширины), а не только клик. Ручной ресайз за уголок ставит MANUAL_CLASS -- высоту держит
  // рука, авто-подгонка для этой карточки выключена (кнопка "⟳" возвращает авто-высоту).
  var fitQueue = new Set();
  var isFitScheduled = false;

  function runFit() {
    isFitScheduled = false;
    var items = Array.from(fitQueue);
    fitQueue.clear();
    items.forEach(function (itemEl) {
      if (itemEl.isConnected && !itemEl.classList.contains(MANUAL_CLASS)) grid.resizeToContent(itemEl);
    });
  }

  // Склейка в один кадр: за один клик ResizeObserver может сработать несколько раз.
  function scheduleFit(itemEl) {
    fitQueue.add(itemEl);
    if (isFitScheduled) return;
    isFitScheduled = true;
    // rAF нет в окружениях без отрисовки (jsdom в тестах) -- там подгонка всё равно ничего не меряет
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(runFit);
    else setTimeout(runFit, 0);
  }

  var fitObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(function (entries) {
      entries.forEach(function (entry) {
        var itemEl = entry.target.closest(".grid-stack-item");
        if (itemEl) scheduleFit(itemEl);
      });
    })
    : null;

  function watchFit(itemEl, widgetNode) {
    if (fitObserver) fitObserver.observe(widgetNode); // первое срабатывание при observe() даёт стартовую подгонку
    else scheduleFit(itemEl);
  }

  // Один виджет с плохими данными/крайним случаем не должен рушить остальные. Раньше
  // def.render() вызывался без защиты и в addWidget(), и в rerenderAll() -- если ОДИН
  // виджет бросал исключение при смене периода, весь forEach в rerenderAll() обрывался, и
  // ВСЕ виджеты ПОСЛЕ сломавшегося в списке `placed` оставались со старым (не обновлённым)
  // содержимым -- симптом "борд не отображается после смены диапазона, помогает только
  // удалить и перетащить заново" (Дима, 2026-08-18). Единая точка защиты -- любой сбой
  // рендера превращается в понятный плейсхолдер с кнопкой "⟳ обновить" вместо тихого
  // застревания на старых данных, и не мешает соседним виджетам обновиться.
  // instanceId — стабильный на время жизни ЭТОГО размещения виджета на холсте (генерится в
  // addWidget ДО первого рендера, переживает rerenderAll/"⟳", НЕ переживает перезагрузку
  // страницы — на loadSavedLayout генерится заново). Нужен виджетам с собственным
  // module-level состоянием на инстанс (2026-08-20: кастомный борд "Новый канал" в B5 —
  // у каждого своё имя канала). def.getPersistState(instanceId)/def.applyPersistState —
  // опциональная пара хуков для персистентности ЭТОГО состояния через saveLayout/
  // loadSavedLayout (см. ниже) — у остальных 30+ виджетов не определены, не влияет на них.
  function safeRenderBody(def, model, ctx, instanceId) {
    try {
      return def.render(model, ctx, instanceId);
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

  function renderInstance(widgetId, instanceId) {
    var def = root.OFDWidgets.WIDGETS[widgetId];
    if (!def) return null;
    var state = root.OFDState;
    if (!state || !state.model) return null;
    var body = safeRenderBody(def, state.model, state.ctx, instanceId);
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
      // Lifecycle-хук для виджетов со своим module-level состоянием по instanceId (2026-08-20:
      // кастомный канал в B5 освобождает своих партнёров и чистит своё имя при удалении).
      var widgetId = widgetNode.dataset.widgetId;
      var def = widgetId ? root.OFDWidgets.WIDGETS[widgetId] : null;
      if (def && typeof def.onRemove === "function") def.onRemove(instanceId);
      if (fitObserver) fitObserver.unobserve(widgetNode);
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
    var itemEl = widgetNode.closest(".grid-stack-item");
    var instanceId = itemEl ? itemEl.dataset.instanceId : null;
    var fresh = safeRenderBody(def, state.model, state.ctx, instanceId);
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
      // "⟳" заодно возвращает карточке авто-высоту по содержимому (после ручного ресайза).
      var itemEl = widgetNode.closest(".grid-stack-item");
      if (!itemEl) return;
      itemEl.classList.remove(MANUAL_CLASS);
      scheduleFit(itemEl);
    });
  }

  function addWidget(widgetId, x, y, w, h, customState, isManual) {
    if (!root.OFDState || !root.OFDState.model) return;
    var def = root.OFDWidgets.WIDGETS[widgetId];
    if (!def) return;
    // instanceId генерится ДО первого рендера -- виджетам со своим per-instance state
    // (см. def.applyPersistState ниже) он нужен уже на первом def.render().
    var instanceId = "w" + Math.random().toString(36).slice(2, 9);
    if (customState !== undefined && typeof def.applyPersistState === "function") {
      def.applyPersistState(instanceId, customState);
    }
    var widgetNode = renderInstance(widgetId, instanceId);
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
    itemEl.dataset.instanceId = instanceId;
    if (isManual) itemEl.classList.add(MANUAL_CLASS);
    wireRemove(widgetNode);
    wireRefresh(widgetNode, widgetId);
    watchFit(itemEl, widgetNode);
    placed.push({ instanceId: instanceId, widgetId: widgetId });
    toggleEmpty();
  }

  // Целый раздел библиотеки одним перетаскиванием (Дима, 2026-10-22): все борды раздела в том
  // порядке, в каком они идут в библиотеке, друг под другом на всю ширину холста. Стартовая
  // высота -- плейсхолдер по типу виджета, сразу после добавления её заменяет авто-высота
  // (watchFit), нижние карточки GridStack сам сдвигает по мере роста верхних.
  function groupWidgetIds(groupId) {
    var groupEl = Array.from(document.querySelectorAll("details.board-group")).find(function (d) {
      return d.dataset.group === groupId;
    });
    if (!groupEl) return [];
    return Array.from(groupEl.querySelectorAll(".lib-item[data-widget]"))
      // data-skip-group: шаблоны (напр. "Новый канал" в B5) создают новую сущность, в отчёт раздела не входят
      .filter(function (item) { return !item.hasAttribute("data-skip-group"); })
      .map(function (item) { return item.dataset.widget; });
  }

  function addGroup(groupId, startY) {
    var y = startY || 0;
    groupWidgetIds(groupId).forEach(function (widgetId) {
      var def = root.OFDWidgets.WIDGETS[widgetId];
      if (!def) return;
      var h = defaultSizeFor(def).h;
      addWidget(widgetId, 0, y, FULL_WIDTH, h);
      y += h;
    });
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

  // Авто-высота и ручной ресайз за уголок физически несовместимы: подгонка по контенту затёрла
  // бы то, что юзер только что задал руками. Тронул руками -> авто-высота выключается для этой
  // карточки (решение Димы: взял контроль руками -- система больше не лезет). Метим на
  // resizestart, а не resizestop: пока тянут, ResizeObserver не должен успеть "поправить" высоту.
  // Тянули только ширину (высота после ресайза та же) -- ручной режим не нужен, возвращаем авто.
  grid.on("resizestart", function (event, el) {
    if (!el || !el.gridstackNode) return;
    el.dataset.resizeStartH = el.gridstackNode.h;
    el.dataset.resizeWasManual = el.classList.contains(MANUAL_CLASS) ? "1" : "";
    el.classList.add(MANUAL_CLASS);
  });
  grid.on("resizestop", function (event, el) {
    if (!el || !el.gridstackNode) return;
    var isHeightChanged = el.gridstackNode.h !== Number(el.dataset.resizeStartH);
    var wasManual = el.dataset.resizeWasManual === "1";
    delete el.dataset.resizeStartH;
    delete el.dataset.resizeWasManual;
    if (isHeightChanged || wasManual) return;
    el.classList.remove(MANUAL_CLASS);
    scheduleFit(el);
  });

  // Перетаскивание из библиотеки (левый сайдбар) -- GridStack.setupDragIn кладёт на дроп
  // КЛОН исходного .lib-item (не готовый виджет, см. проверку по исходнику gridstack-all.js:
  // _gsEventHandler.dropped вызывается с (event, previousWidget, newWidget), newWidget.el --
  // это склонированный .lib-item, уже получивший класс .grid-stack-item и gs-x/gs-y/gs-w/gs-h
  // от движка). Забираем widgetId из data-атрибута клона, убираем клон, добавляем
  // настоящий виджет через addWidget с уже вычисленными GridStack координатами.
  GridStack.setupDragIn(".lib-item", { appendTo: "body", helper: "clone" });
  // Клон может быть ручкой целого раздела (data-group, см. заголовки в index.html) -- тогда
  // вместо одного борда добавляем весь раздел, начиная с точки дропа.
  grid.on("dropped", function (event, previousWidget, newWidget) {
    if (!newWidget || !newWidget.el) return;
    var widgetId = newWidget.el.dataset.widget;
    var groupId = newWidget.el.dataset.group;
    var drop = { x: newWidget.x, y: newWidget.y };
    grid.removeWidget(newWidget.el);
    if (groupId) addGroup(groupId, drop.y);
    // Размер -- по умолчанию для типа виджета (defaultSizeFor), а не размер клона из библиотеки:
    // клон узкий (4 колонки), и при авто-высоте таблица в 4 колонки вытягивалась бы в длинную полоску.
    else if (widgetId) addWidget(widgetId, drop.x, drop.y);
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
        var entry = {
          widgetId: p.widgetId,
          x: node ? node.x : 0, y: node ? node.y : 0,
          w: node ? node.w : null, h: node ? node.h : null,
        };
        // manual: высоту задали руками -- при загрузке авто-подгонка её не трогает. У остальных
        // поля нет (старые сохранения читаются как авто-высота).
        if (itemEl && itemEl.classList.contains(MANUAL_CLASS)) entry.manual = 1;
        // Опциональное per-instance состояние (имя кастомного канала и т.п.) -- у
        // подавляющего большинства виджетов хука нет, entry.custom просто не появляется.
        var def = root.OFDWidgets.WIDGETS[p.widgetId];
        if (def && typeof def.getPersistState === "function") {
          entry.custom = def.getPersistState(p.instanceId);
        }
        return entry;
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
        addWidget(w.widgetId, w.x || 0, w.y || 0, w.w, w.h, w.custom, w.manual === 1);
        restored = true;
      }
    });
    if (restored) toggleEmpty();
    return { restored: restored, converted: usedConverter };
  }

  root.OFDCanvas = { addWidget: addWidget, rerenderAll: rerenderAll, saveLayout: saveLayout, loadSavedLayout: loadSavedLayout };
})(typeof window !== "undefined" ? window : globalThis);
