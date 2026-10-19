// Регистрация service worker для установки BI OFD как приложения (PWA).
// Отдельным файлом, потому что CSP страницы (script-src 'self') запрещает inline-скрипты.
(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function (err) {
      console.warn("PWA: service worker не зарегистрирован:", err);
    });
  });
})();
