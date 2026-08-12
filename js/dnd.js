/*
 * Библиотека виджетов -> холст: drag-and-drop, удаление, пересчёт при смене периода/as-of.
 * Свободное позиционирование (2026-08-11, по просьбе Димы) -- у каждой карточки свои
 * left/top в px относительно #canvas (position:relative), а не место в flex-потоке.
 * Коллизии не допускаются: если целевое место перекрывает другую карточку, точка сброса
 * "сползает" вниз до первого свободного места -- resolvePosition() ниже. Зелёный
 * .drop-preview показывает КУДА карточка реально сядет ещё до отпускания кнопки мыши.
 * Зависит от window.OFDWidgets (js/widgets.js) и глобального window.OFDState (app.js).
 */
(function (root) {
  "use strict";

  var canvas = document.getElementById("canvas");
  var emptyState = document.getElementById("emptyState");
  var placed = []; // [{instanceId, widgetId}]
  var sizes = {}; // instanceId -> {width, height}px, ручной ресайз (.widget{resize:both}) переживает rerenderAll
  var positions = {}; // instanceId -> {x, y}px внутри #canvas, переживает rerenderAll
  var previewEl = null;

  var GAP = 16; // минимальный зазор между карточками, чтобы не сидели впритык
  var LIB_DEFAULT_W = 360, LIB_DEFAULT_H = 200; // прикидка размера для превью при перетаскивании из библиотеки (реальный размер узнаём только после рендера на drop)
  var flowCursor = { x: 24, y: 24, rowH: 0 }; // курсор автораскладки для addWidget() БЕЗ явной точки (стартовые виджеты app.js) -- слева направо, перенос строки, как раньше flex-wrap

  // .widget пересоздаётся целиком на каждый rerenderAll (смена периода/as-of) — без этого
  // ручной ресайз (перетаскивание уголка) слетал бы при каждом клике по фильтру периода.
  function watchSize(node, instanceId) {
    if (typeof ResizeObserver === "undefined") return null;
    var ro = new ResizeObserver(function () {
      sizes[instanceId] = { width: Math.round(node.offsetWidth), height: Math.round(node.offsetHeight) };
      resolveAllOverlaps(instanceId); // сама эта карточка (выросла -- значит её и ресайзят) не двигается
      growCanvas();
    });
    ro.observe(node);
    return ro;
  }
  function applySavedSize(node, instanceId) {
    var s = sizes[instanceId];
    if (s) { node.style.width = s.width + "px"; node.style.height = s.height + "px"; }
  }
  function applyPosition(node, instanceId) {
    var p = positions[instanceId];
    if (p) { node.style.left = p.x + "px"; node.style.top = p.y + "px"; }
  }

  function toggleEmpty() {
    emptyState.style.display = placed.length === 0 ? "flex" : "none";
  }

  // Текущий прямоугольник карточки прямо из DOM (не из кэша positions/sizes -- те не
  // обновляются посреди активного жеста, а тут нужна live-истина для проверки коллизий).
  function liveRect(instanceId) {
    var node = canvas.querySelector('[data-instance-id="' + instanceId + '"]');
    if (!node) return null;
    return {
      x: parseFloat(node.style.left) || 0,
      y: parseFloat(node.style.top) || 0,
      w: node.offsetWidth,
      h: node.offsetHeight,
    };
  }

  function rectsOverlap(a, b) {
    return !(
      a.x + a.w + GAP <= b.x ||
      b.x + b.w + GAP <= a.x ||
      a.y + a.h + GAP <= b.y ||
      b.y + b.h + GAP <= a.y
    );
  }

  // Точка сброса (x,y) + размер карточки (w,h) -> ближайшее свободное место. Сдвигаем
  // ТОЛЬКО вниз (никогда вбок/вверх) при столкновении с чужой карточкой -- предсказуемо
  // и всегда сходится (высота холста не ограничена). excludeId -- сама перетаскиваемая
  // карточка, с собой не сталкивается.
  function resolvePosition(excludeId, x, y, w, h) {
    var maxX = Math.max(0, canvas.clientWidth - w);
    x = Math.min(Math.max(0, x), maxX);
    y = Math.max(0, y);
    var moved = true, guard = 0;
    while (moved && guard < 200) {
      moved = false;
      guard++;
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i];
        if (p.instanceId === excludeId) continue;
        var r = liveRect(p.instanceId);
        if (!r) continue;
        if (rectsOverlap({ x: x, y: y, w: w, h: h }, r)) {
          y = r.y + r.h + GAP;
          moved = true;
        }
      }
    }
    return { x: x, y: y };
  }

  // Для addWidget() БЕЗ явной точки сброса (стартовые виджеты, app.js вызывает
  // addWidget(id) пять раз подряд без dropX/dropY) -- слева направо по текущей строке,
  // перенос на новую, когда не влезает. Без этого все пять падали бы в одну (24,24) и
  // resolvePosition сталкивал бы их строго вниз одним столбцом (нашли 2026-08-11).
  // Только для АВТОМАТИЧЕСКОГО добавления -- перетаскивание из библиотеки/холста всегда
  // приходит с настоящими координатами курсора, эта функция их не касается.
  function nextDefaultPosition(w, h) {
    var maxX = canvas.clientWidth || 1200;
    if (flowCursor.x > 24 && flowCursor.x + w > maxX) {
      flowCursor.x = 24;
      flowCursor.y += flowCursor.rowH + GAP;
      flowCursor.rowH = 0;
    }
    var pos = { x: flowCursor.x, y: flowCursor.y };
    flowCursor.x += w + GAP;
    flowCursor.rowH = Math.max(flowCursor.rowH, h);
    return pos;
  }

  // Лучшее свободное место для карточки w×h -- САМОЕ ВЕРХНЕЕ (при равенстве -- самое
  // левое), не "первое, куда влезло, считая от текущей точки вниз". Нужно, чтобы
  // вытесненные карточки не расползались всё ниже и ниже с каждым столкновением (Дима,
  // 2026-08-12: "стремились вверх, не вниз"), а всегда оседали в наиболее компактном
  // месте. Кандидаты по Y -- 0 и низ+зазор каждой чужой карточки (только там может
  // начаться новая "полка"), кандидаты по X аналогично по правому краю. Перебор
  // Y×X по возрастанию, первый свободный -- и есть самый верхний-левый. excludeId --
  // сама искомая карточка, с собой не сталкивается.
  function findBestFreeSpot(excludeId, w, h) {
    var maxX = Math.max(0, canvas.clientWidth - w);
    var candidatesY = [0], candidatesX = [0];
    placed.forEach(function (p) {
      if (p.instanceId === excludeId) return;
      var r = liveRect(p.instanceId);
      if (!r) return;
      candidatesY.push(r.y + r.h + GAP);
      candidatesX.push(r.x + r.w + GAP);
    });
    candidatesY.sort(function (a, b) { return a - b; });
    candidatesX.sort(function (a, b) { return a - b; });

    for (var yi = 0; yi < candidatesY.length; yi++) {
      var y = candidatesY[yi];
      for (var xi = 0; xi < candidatesX.length; xi++) {
        var x = Math.min(candidatesX[xi], maxX);
        if (x < 0) continue;
        var candidate = { x: x, y: y, w: w, h: h };
        var free = true;
        for (var i = 0; i < placed.length; i++) {
          if (placed[i].instanceId === excludeId) continue;
          var r2 = liveRect(placed[i].instanceId);
          if (r2 && rectsOverlap(candidate, r2)) { free = false; break; }
        }
        if (free) return { x: x, y: y };
      }
    }
    // не должно случаться (холст растёт), но на всякий случай -- под самой нижней
    var maxBottom = 0;
    placed.forEach(function (p) {
      if (p.instanceId === excludeId) return;
      var r = liveRect(p.instanceId);
      if (r) maxBottom = Math.max(maxBottom, r.y + r.h);
    });
    return { x: 0, y: maxBottom + GAP };
  }

  // #canvas -- position:relative, абсолютные дети САМИ не растягивают его высоту.
  // Досчитываем min-height явно по нижней границе самой низкой карточки, иначе снизу
  // холста не окажется места для сброса (п.1 -- "не попал в рабочую область").
  function growCanvas() {
    canvas.style.minHeight = ""; // сброс к CSS-плинтусу (calc(100vh - 230px)) перед пересчётом
    var floor = canvas.offsetHeight;
    var maxBottom = 0;
    placed.forEach(function (p) {
      var r = liveRect(p.instanceId);
      if (r) maxBottom = Math.max(maxBottom, r.y + r.h);
    });
    var needed = maxBottom + 40;
    if (needed > floor) canvas.style.minHeight = needed + "px";
  }

  // Карточка может вырасти НЕ через перетаскивание -- ручной ресайз за уголок (.widget
  // {resize:both}) или раскрытие содержимого (клик по строке -> разбивка по кассам,
  // widgets.js). Оба случая шли через ResizeObserver, который раньше ТОЛЬКО пересчитывал
  // высоту холста, не проверяя, что выросшая карточка теперь наезжает на соседей --
  // отсюда наложение на скриншоте Димы 2026-08-11.
  //
  // actorId -- та карточка, которую СЕЙЧАС ресайзит/трогает пользователь: она НИКОГДА не
  // двигается сама, толкаем только соседей. Без этого правило "сдвигаем того, кто ниже"
  // иногда толкало САМУ actor-карточку (если у соседа индекс в placed[] оказывался
  // меньше -- решало по Y/индексу, а не по тому, кого реально ресайзят) -- ровно это
  // Дима поймал 2026-08-11: "двигается сам борд, который я ресайзю". Для пар БЕЗ actor'а
  // (косвенные столкновения по цепочке) остаётся прежнее правило -- сдвигаем того, кто
  // ниже, никогда вбок/вверх, гарантированно сходится.
  function resolveAllOverlaps(actorId) {
    var moved = true, guard = 0;
    while (moved && guard < 500) {
      moved = false;
      guard++;
      for (var i = 0; i < placed.length; i++) {
        for (var j = i + 1; j < placed.length; j++) {
          var idA = placed[i].instanceId, idB = placed[j].instanceId;
          var ra = liveRect(idA);
          var rb = liveRect(idB);
          if (!ra || !rb) continue;
          if (!rectsOverlap(ra, rb)) continue;
          var pushId;
          if (idA === actorId) pushId = idB;
          else if (idB === actorId) pushId = idA;
          else pushId = ra.y <= rb.y ? idB : idA; // без актёра -- та, что ниже, уступает место
          var pushRect = pushId === idA ? ra : rb;
          var node = canvas.querySelector('[data-instance-id="' + pushId + '"]');
          if (!node) continue;
          // самое верхнее-левое свободное место, не "съехать вниз от того, кто вытеснил" --
          // иначе карточки со временем расползаются всё ниже (Дима, 2026-08-12)
          var spot = findBestFreeSpot(pushId, pushRect.w, pushRect.h);
          node.style.left = spot.x + "px";
          node.style.top = spot.y + "px";
          positions[pushId] = spot;
          moved = true;
        }
      }
    }
  }

  function showPreview(x, y, w, h) {
    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.className = "drop-preview";
      canvas.appendChild(previewEl);
    }
    previewEl.style.left = x + "px";
    previewEl.style.top = y + "px";
    previewEl.style.width = w + "px";
    previewEl.style.height = h + "px";
  }
  function hidePreview() {
    if (previewEl) { previewEl.remove(); previewEl = null; }
  }

  function canvasPoint(e) {
    var box = canvas.getBoundingClientRect();
    return {
      x: e.clientX - box.left + canvas.scrollLeft,
      y: e.clientY - box.top + canvas.scrollTop,
    };
  }

  // Перетаскивание за грип (⋮⋮ в шапке) -- обычные mouse-события (mousedown/mousemove/
  // mouseup на document), НЕ нативный HTML5 draggable/dragstart. Причина смены (найдено
  // 2026-08-11): нативный drag ненадёжен для "живого" следования за курсором -- он не для
  // этого создавался, а для файлов/reorder-in-flow (чем и пользовались раньше). Плюс
  // синтетический DragEvent в тестах МОЖЕТ обмануть код, не пройдя реальную браузерную
  // детекцию жеста -- ровно так тест на прошлом заходе дал ложный "работает". Обычные
  // mouse-события лишены этой неопределённости и снимают обе проблемы разом.
  // mousedown ловим только на ГРИПЕ, не на всей карточке -- иначе случайный drag с
  // кнопки/фильтра/таблицы внутри виджета ломал бы клики и мешал ресайзу за угол.
  function makeWidgetDraggable(node) {
    var grip = node.querySelector(".grip");
    if (!grip) return;
    grip.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return; // только левая кнопка
      e.preventDefault(); // не даём тексту/иконке выделиться во время перетаскивания
      var instanceId = node.dataset.instanceId;
      var w = node.offsetWidth, h = node.offsetHeight;
      var startPt = canvasPoint(e);
      var offsetX = startPt.x - (parseFloat(node.style.left) || 0);
      var offsetY = startPt.y - (parseFloat(node.style.top) || 0);

      node.classList.add("dragging");
      canvas.classList.add("drag-over");
      node.style.zIndex = "10"; // поверх остальных карточек, пока держим её курсором

      function onMove(ev) {
        var pt = canvasPoint(ev);
        var maxX = Math.max(0, canvas.clientWidth - w);
        var x = Math.min(Math.max(0, pt.x - offsetX), maxX);
        var y = Math.max(0, pt.y - offsetY);
        node.style.left = x + "px"; // сама карточка следует за курсором вживую
        node.style.top = y + "px";
        var resolved = resolvePosition(instanceId, x, y, w, h); // а зелёный превью -- куда она реально сядет
        showPreview(resolved.x, resolved.y, w, h);
        growCanvas();
      }
      function onUp(ev) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        var pt = canvasPoint(ev);
        var maxX = Math.max(0, canvas.clientWidth - w);
        var x = Math.min(Math.max(0, pt.x - offsetX), maxX);
        var y = Math.max(0, pt.y - offsetY);
        var resolved = resolvePosition(instanceId, x, y, w, h);
        positions[instanceId] = resolved;
        applyPosition(node, instanceId);
        node.classList.remove("dragging");
        node.style.zIndex = "";
        canvas.classList.remove("drag-over");
        hidePreview();
        growCanvas();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function renderInstance(widgetId) {
    var def = root.OFDWidgets.WIDGETS[widgetId];
    if (!def) return null;
    var state = root.OFDState;
    if (!state || !state.model) return null;
    var body = def.render(state.model, state.ctx);
    var node = root.OFDWidgets.widgetShell(widgetId, def.title, def.type, def.scope, body, def.exportable ? '<button class="export-btn">Экспорт CSV / Excel</button>' : "", !!def.span);
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

  function addWidget(widgetId, dropX, dropY) {
    if (!root.OFDState || !root.OFDState.model) return;
    var node = renderInstance(widgetId);
    if (!node) return;
    var instanceId = "w" + Math.random().toString(36).slice(2, 9);
    node.dataset.instanceId = instanceId;
    node.style.left = "0px";
    node.style.top = "0px";
    canvas.appendChild(node); // сначала в DOM -- иначе offsetWidth/Height ниже вернут 0
    var w = node.offsetWidth, h = node.offsetHeight;
    var pos = dropX != null && dropY != null ? { x: dropX, y: dropY } : nextDefaultPosition(w, h);
    var resolved = resolvePosition(null, pos.x, pos.y, w, h);
    positions[instanceId] = resolved;
    applyPosition(node, instanceId);
    var ro = watchSize(node, instanceId);
    makeWidgetDraggable(node);
    node.querySelector(".remove-btn").addEventListener("click", function () {
      if (ro) ro.disconnect();
      delete sizes[instanceId];
      delete positions[instanceId];
      placed = placed.filter(function (p) { return p.instanceId !== instanceId; });
      growCanvas();
      toggleEmpty();
    }, { once: false });
    placed.push({ instanceId: instanceId, widgetId: widgetId });
    growCanvas();
    toggleEmpty();
  }

  function rerenderAll() {
    placed.forEach(function (p) {
      var oldNode = canvas.querySelector('[data-instance-id="' + p.instanceId + '"]');
      if (!oldNode) return;
      var fresh = renderInstance(p.widgetId);
      if (!fresh) return;
      fresh.dataset.instanceId = p.instanceId;
      applySavedSize(fresh, p.instanceId);
      applyPosition(fresh, p.instanceId);
      var ro = watchSize(fresh, p.instanceId);
      makeWidgetDraggable(fresh);
      fresh.querySelector(".remove-btn").addEventListener("click", function () {
        if (ro) ro.disconnect();
        delete sizes[p.instanceId];
        delete positions[p.instanceId];
        placed = placed.filter(function (x) { return x.instanceId !== p.instanceId; });
        growCanvas();
        toggleEmpty();
      });
      if (root.OFDExport) {
        var def = root.OFDWidgets.WIDGETS[p.widgetId];
        if (def && def.exportable) {
          var btn = fresh.querySelector(".export-btn");
          btn.addEventListener("click", function () {
            var bodyEl = fresh.querySelector(".widget-body").firstElementChild;
            var rows = bodyEl && bodyEl._getExportRows ? bodyEl._getExportRows() : null;
            if (rows) root.OFDExport.downloadCSV(def.title, rows);
          });
        }
      }
      oldNode.replaceWith(fresh);
    });
    resolveAllOverlaps();
    growCanvas();
  }

  document.querySelectorAll(".lib-item").forEach(function (item) {
    item.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", item.dataset.widget);
    });
  });

  // Ниже -- только добавление ИЗ БИБЛИОТЕКИ (перетаскивание уже размещённых карточек
  // теперь отдельная mouse-based механика в makeWidgetDraggable выше, HTML5 DnD её не
  // касается вообще).
  canvas.addEventListener("dragover", function (e) {
    e.preventDefault();
    canvas.classList.add("drag-over");
    var pt = canvasPoint(e);
    // реальный размер карточки узнаем только после рендера на drop, здесь только
    // прикидка для превью
    var resolved = resolvePosition(null, pt.x, pt.y, LIB_DEFAULT_W, LIB_DEFAULT_H);
    showPreview(resolved.x, resolved.y, LIB_DEFAULT_W, LIB_DEFAULT_H);
  });
  canvas.addEventListener("dragleave", function (e) {
    if (e.target !== canvas) return; // не реагируем на переход между дочерними элементами
    canvas.classList.remove("drag-over");
    hidePreview();
  });
  canvas.addEventListener("drop", function (e) {
    e.preventDefault();
    canvas.classList.remove("drag-over");
    var pt = canvasPoint(e);
    hidePreview();
    var id = e.dataTransfer.getData("text/plain");
    if (id) addWidget(id, pt.x, pt.y);
  });

  // ---------- сохранение/восстановление расположения между сессиями ----------
  //
  // Только локально (localStorage — тот же браузер, тот же принцип "ничего никуда не
  // уходит", что и у самого инструмента) — какие борды на холсте, где именно (x/y) и
  // какого размера (если ресайзил руками). При следующей загрузке файла раскладка
  // восстанавливается САМА, вместо дефолтных 5 стартовых виджетов (Дима, 2026-08-12).
  var LAYOUT_KEY = "ofd-canvas-layout-v1";

  function saveLayout() {
    var data = {
      version: 1,
      widgets: placed.map(function (p) {
        var pos = positions[p.instanceId] || { x: 24, y: 24 };
        var sz = sizes[p.instanceId];
        return { widgetId: p.widgetId, x: pos.x, y: pos.y, width: sz ? sz.width : null, height: sz ? sz.height : null };
      }),
    };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false; // приватный режим браузера и т.п. -- localStorage может быть недоступен
    }
  }

  // Восстановление в точности как сохранено -- БЕЗ resolvePosition/коллизий, раз раскладка
  // уже была валидна на момент сохранения. addWidget() тут не переиспользуем -- она мерит
  // ЖИВОЙ размер узла и прогоняет через resolvePosition, что могло бы сдвинуть карточки
  // с сохранённых координат, если текущий контент рендерится чуть иначе по высоте.
  function restoreWidgetAt(widgetId, x, y, width, height) {
    var node = renderInstance(widgetId);
    if (!node) return;
    var instanceId = "w" + Math.random().toString(36).slice(2, 9);
    node.dataset.instanceId = instanceId;
    if (width) node.style.width = width + "px";
    if (height) node.style.height = height + "px";
    node.style.left = x + "px";
    node.style.top = y + "px";
    canvas.appendChild(node);
    positions[instanceId] = { x: x, y: y };
    if (width && height) sizes[instanceId] = { width: width, height: height };
    var ro = watchSize(node, instanceId);
    makeWidgetDraggable(node);
    node.querySelector(".remove-btn").addEventListener("click", function () {
      if (ro) ro.disconnect();
      delete sizes[instanceId];
      delete positions[instanceId];
      placed = placed.filter(function (p) { return p.instanceId !== instanceId; });
      growCanvas();
      toggleEmpty();
    });
    placed.push({ instanceId: instanceId, widgetId: widgetId });
  }

  // true, если что-то реально восстановлено -- вызывающий код (app.js) тогда НЕ добавляет
  // дефолтные стартовые 5 виджетов поверх.
  function loadSavedLayout() {
    if (!root.OFDState || !root.OFDState.model) return false;
    var raw;
    try { raw = localStorage.getItem(LAYOUT_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !Array.isArray(data.widgets) || !data.widgets.length) return false;
    var restored = false;
    data.widgets.forEach(function (w) {
      if (w && root.OFDWidgets.WIDGETS[w.widgetId]) {
        restoreWidgetAt(w.widgetId, w.x || 0, w.y || 0, w.width, w.height);
        restored = true;
      }
    });
    if (restored) {
      resolveAllOverlaps(); // сохранённые размеры могли не совпасть с реальным рендером -- подстраховка
      growCanvas();
      toggleEmpty();
    }
    return restored;
  }

  root.OFDCanvas = { addWidget: addWidget, rerenderAll: rerenderAll, saveLayout: saveLayout, loadSavedLayout: loadSavedLayout };
})(typeof window !== "undefined" ? window : globalThis);
