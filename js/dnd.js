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

  canvas.addEventListener("dragover", function (e) { e.preventDefault(); canvas.classList.add("drag-over"); });
  canvas.addEventListener("dragleave", function () { canvas.classList.remove("drag-over"); });
  canvas.addEventListener("drop", function (e) {
    e.preventDefault();
    canvas.classList.remove("drag-over");
    var id = e.dataTransfer.getData("text/plain");
    addWidget(id);
  });

  root.OFDCanvas = { addWidget: addWidget, rerenderAll: rerenderAll };
})(typeof window !== "undefined" ? window : globalThis);
