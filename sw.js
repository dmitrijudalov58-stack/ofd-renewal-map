/*
 * Service worker BI OFD -- нужен браузеру только как условие установки сайта
 * приложением (PWA). Ничего не кэширует и ничего не подменяет: данные, XLSX,
 * /api/* и /version.json всегда идут в сеть, как до PWA.
 *
 * fetch-обработчик есть, но event.respondWith() в нём НЕ вызывается. Запрос
 * уходит в сеть штатно, и браузер сам показывает окно Basic Auth (из service
 * worker окно логина показать нельзя). Если когда-нибудь понадобится офлайн --
 * это отдельная задача, кэшировать данные клиентов нельзя.
 */
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function () {
  // Намеренно пусто: см. комментарий в шапке файла.
});
