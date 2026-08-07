/*
 * Библиотека виджетов -> холст: drag-and-drop, удаление, пересчёт при смене периода/as-of.
 * Зависит от window.OFDWidgets (js/widgets.js) и глобального window.OFDState (задаётся в app.js).
 */
(function (root) {
  "use strict";

  var canvas = document.getElementById("canvas");
  var emptyState = document.getElementById("emptyState");
  var placed = []; // [{instanceId, widgetId, node}]
  var sizes = {}; // instanceId -> {width, height}px, ручной ресайз (.widget{resize:both}) переживает rerenderAll
  var draggingNode = null; // перетаскиваемая карточка при реордере (не при добавлении из библиотеки)

  // .widget пересоздаётся целиком на каждый rerenderAll (смена периода/as-of) — без этого
  // ручной ресайз (перетаскивание уголка) слетал бы при каждом клике по фильтру периода.
  function watchSize(node, instanceId) {
    if (typeof ResizeObserver === "undefined") return null;
    var ro = new ResizeObserver(function (entries) {
      var box = entries[0].contentRect;
      sizes[instanceId] = { width: Math.round(node.offsetWidth), height: Math.round(node.offsetHeight) };
    });
    ro.observe(node);
    return ro;
  }
  function applySavedSize(node, instanceId) {
    var s = sizes[instanceId];
    if (s) { node.style.width = s.width + "px"; node.style.height = s.height + "px"; }
  }

  function toggleEmpty() {
    emptyState.style.display = placed.length === 0 ? "flex" : "none";
  }

  // Перетаскивание за грип (⋮⋮ в шапке, cursor:grab уже был в CSS, но не был подключён к
  // реальному drag -- п. "перетаскивание бордов как удобно", 2026-08-07). draggable=true
  // включаем только на mousedown ГРИПА, не на всей карточке -- иначе случайный drag с
  // кнопки/фильтра/таблицы внутри виджета ломал бы клики и мешал ресайзу за угол.
  function makeWidgetDraggable(node) {
    var grip = node.querySelector(".grip");
    if (!grip) return;
    grip.addEventListener("mousedown", function () { node.draggable = true; });
    grip.addEventListener("mouseup", function () { node.draggable = false; });
    node.addEventListener("dragstart", function (e) {
      draggingNode = node;
      node.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", ""); // пусто -- реордер отличаем по draggingNode, не по содержимому
    });
    node.addEventListener("dragend", function () {
      node.draggable = false;
      node.classList.remove("dragging");
      draggingNode = null;
      syncPlacedOrder();
    });
  }

  // Ближайшая по курсору карточка (кроме перетаскиваемой) -- вставляем перед ней, если
  // курсор левее её центра, иначе после. Простая эвклидова эвристика, для flex-wrap сетки
  // виджетов работает предсказуемо и без рывков.
  function findDropTarget(x, y) {
    var els = Array.from(canvas.querySelectorAll(".widget")).filter(function (el) { return el !== draggingNode; });
    var closest = null, closestDist = Infinity, before = true;
    els.forEach(function (el) {
      var box = el.getBoundingClientRect();
      var cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      var dist = Math.hypot(x - cx, y - cy);
      if (dist < closestDist) { closestDist = dist; closest = el; before = x < cx; }
    });
    return closest ? { el: closest, before: before } : null;
  }

  // После реордера синхронизируем `placed` с реальным DOM-порядком -- на будущее, чтобы
  // код, читающий `placed` последовательно, не разошёлся с тем, что видно на экране
  // (сейчас на это ничего не завязано, rerenderAll меняет узлы in-place через replaceWith,
  // но держать массив в согласии дешевле, чем потом искать баг из-за рассинхрона).
  function syncPlacedOrder() {
    var byId = {};
    placed.forEach(function (p) { byId[p.instanceId] = p; });
    var next = [];
    canvas.querySelectorAll(".widget").forEach(function (node) {
      var p = byId[node.dataset.instanceId];
      if (p) next.push(p);
    });
    placed = next;
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

  function addWidget(widgetId) {
    if (!root.OFDState || !root.OFDState.model) return;
    var node = renderInstance(widgetId);
    if (!node) return;
    var instanceId = "w" + Math.random().toString(36).slice(2, 9);
    node.dataset.instanceId = instanceId;
    var ro = watchSize(node, instanceId);
    makeWidgetDraggable(node);
    node.querySelector(".remove-btn").addEventListener("click", function () {
      if (ro) ro.disconnect();
      delete sizes[instanceId];
      placed = placed.filter(function (p) { return p.instanceId !== instanceId; });
      toggleEmpty();
    }, { once: false });
    canvas.appendChild(node);
    placed.push({ instanceId: instanceId, widgetId: widgetId });
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
      var ro = watchSize(fresh, p.instanceId);
      makeWidgetDraggable(fresh);
      fresh.querySelector(".remove-btn").addEventListener("click", function () {
        if (ro) ro.disconnect();
        delete sizes[p.instanceId];
        placed = placed.filter(function (x) { return x.instanceId !== p.instanceId; });
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
  }

  document.querySelectorAll(".lib-item").forEach(function (item) {
    item.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", item.dataset.widget);
    });
  });

  canvas.addEventListener("dragover", function (e) {
    e.preventDefault();
    if (draggingNode) {
      // реордер уже размещённой карточки -- двигаем DOM-узел вслед за курсором прямо
      // во время dragover (стандартный паттерн live-reorder), рамку "drag-over" на весь
      // холст не показываем, это визуально другое действие (добавление из библиотеки)
      var target = findDropTarget(e.clientX, e.clientY);
      if (target) canvas.insertBefore(draggingNode, target.before ? target.el : target.el.nextSibling);
      return;
    }
    canvas.classList.add("drag-over");
  });
  canvas.addEventListener("dragleave", function () { if (!draggingNode) canvas.classList.remove("drag-over"); });
  canvas.addEventListener("drop", function (e) {
    e.preventDefault();
    canvas.classList.remove("drag-over");
    if (draggingNode) return; // позиция уже применена в dragover, dragend доделает уборку
    var id = e.dataTransfer.getData("text/plain");
    if (id) addWidget(id);
  });

  root.OFDCanvas = { addWidget: addWidget, rerenderAll: rerenderAll };
})(typeof window !== "undefined" ? window : globalThis);
