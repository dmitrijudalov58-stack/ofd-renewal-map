/*
 * Библиотека виджетов -> холст: drag-and-drop, удаление, пересчёт при смене периода/as-of.
 * Зависит от window.OFDWidgets (js/widgets.js) и глобального window.OFDState (задаётся в app.js).
 */
(function (root) {
  "use strict";

  var canvas = document.getElementById("canvas");
  var emptyState = document.getElementById("emptyState");
  var placed = []; // [{instanceId, widgetId, node}]

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
    node.querySelector(".remove-btn").addEventListener("click", function () {
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
      fresh.querySelector(".remove-btn").addEventListener("click", function () {
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
