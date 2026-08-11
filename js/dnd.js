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
  var draggingNode = null; // перетаскиваемая карточка (уже размещённая, не из библиотеки)
  var dragOffset = { x: 0, y: 0 }; // курсор минус левый верхний угол карточки в момент mousedown на грипе
  var dragSize = { w: 0, h: 0 };
  var previewEl = null;

  var GAP = 16; // минимальный зазор между карточками, чтобы не сидели впритык
  var LIB_DEFAULT_W = 360, LIB_DEFAULT_H = 200; // прикидка размера для превью при перетаскивании из библиотеки (реальный размер узнаём только после рендера на drop)

  // .widget пересоздаётся целиком на каждый rerenderAll (смена периода/as-of) — без этого
  // ручной ресайз (перетаскивание уголка) слетал бы при каждом клике по фильтру периода.
  function watchSize(node, instanceId) {
    if (typeof ResizeObserver === "undefined") return null;
    var ro = new ResizeObserver(function () {
      sizes[instanceId] = { width: Math.round(node.offsetWidth), height: Math.round(node.offsetHeight) };
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

  // Перетаскивание за грип (⋮⋮ в шапке). draggable=true включаем только на mousedown
  // ГРИПА, не на всей карточке -- иначе случайный drag с кнопки/фильтра/таблицы внутри
  // виджета ломал бы клики и мешал ресайзу за угол.
  function makeWidgetDraggable(node) {
    var grip = node.querySelector(".grip");
    if (!grip) return;
    grip.addEventListener("mousedown", function (e) {
      node.draggable = true;
      var pt = canvasPoint(e);
      var nodeX = parseFloat(node.style.left) || 0;
      var nodeY = parseFloat(node.style.top) || 0;
      dragOffset.x = pt.x - nodeX;
      dragOffset.y = pt.y - nodeY;
    });
    grip.addEventListener("mouseup", function () { node.draggable = false; });
    node.addEventListener("dragstart", function (e) {
      draggingNode = node;
      dragSize = { w: node.offsetWidth, h: node.offsetHeight };
      node.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", ""); // пусто -- перемещение уже размещённой отличаем по draggingNode
    });
    node.addEventListener("dragend", function () {
      node.draggable = false;
      node.classList.remove("dragging");
      draggingNode = null;
      hidePreview();
      canvas.classList.remove("drag-over");
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
    var x = dropX != null ? dropX : 24;
    var y = dropY != null ? dropY : 24;
    var resolved = resolvePosition(null, x, y, w, h);
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
    growCanvas();
  }

  document.querySelectorAll(".lib-item").forEach(function (item) {
    item.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", item.dataset.widget);
    });
  });

  canvas.addEventListener("dragover", function (e) {
    e.preventDefault();
    canvas.classList.add("drag-over");
    var pt = canvasPoint(e);

    if (draggingNode) {
      var instanceId = draggingNode.dataset.instanceId;
      var rawX = pt.x - dragOffset.x, rawY = pt.y - dragOffset.y;
      var resolved = resolvePosition(instanceId, rawX, rawY, dragSize.w, dragSize.h);
      showPreview(resolved.x, resolved.y, dragSize.w, dragSize.h);
      return;
    }

    // перетаскивание из библиотеки -- реальный размер карточки узнаем только после
    // рендера на drop, здесь только прикидка для превью
    var resolved2 = resolvePosition(null, pt.x, pt.y, LIB_DEFAULT_W, LIB_DEFAULT_H);
    showPreview(resolved2.x, resolved2.y, LIB_DEFAULT_W, LIB_DEFAULT_H);
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

    if (draggingNode) {
      var instanceId = draggingNode.dataset.instanceId;
      var rawX = pt.x - dragOffset.x, rawY = pt.y - dragOffset.y;
      var resolved = resolvePosition(instanceId, rawX, rawY, dragSize.w, dragSize.h);
      positions[instanceId] = resolved;
      applyPosition(draggingNode, instanceId);
      growCanvas();
      return; // dragend доделает уборку классов
    }

    var id = e.dataTransfer.getData("text/plain");
    if (id) addWidget(id, pt.x, pt.y);
  });

  root.OFDCanvas = { addWidget: addWidget, rerenderAll: rerenderAll };
})(typeof window !== "undefined" ? window : globalThis);
