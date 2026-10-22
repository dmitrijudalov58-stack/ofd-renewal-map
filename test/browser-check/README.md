# Проверки раскладки в реальном браузере

jsdom не считает раскладку и не умеет drag GridStack, поэтому авто-высота карточек и перетаскивание
раздела проверяются в настоящем Chromium. Данные синтетические, ПДн нет.

```bash
# 1. данные: выгрузка ОФД (3 тыс. строк) и портрет (фикстура тестов B10)
node test/browser-check/make-sample.js /tmp/bc/sample.xlsx
node -e 'require("fs").writeFileSync("/tmp/bc/portrait.json", JSON.stringify(require("./test/fixtures/b10-fixture.js").makeV2()))'

# 2. сайт локально и страница с данными (browse = ~/.claude/skills/gstack/browse/dist/browse)
python3 -m http.server 8765 --bind 127.0.0.1 &
browse viewport 1600x1000; browse goto http://127.0.0.1:8765/index.html
browse upload '#fileInput' /tmp/bc/sample.xlsx; browse upload '#portraitFileInput' /tmp/bc/portrait.json

# 3. проверки. `browse js` не ждёт async: результат кладём в window.__r и читаем отдельным вызовом
browse js "window.__r=null; ($(cat test/browser-check/grid-fit.js)).then(r=>window.__r=r); 1"; sleep 5; browse js 'window.__r'
browse js 'window.__gid="b10"; 1'    # раздел для group-drop.js: b1..b7, b9, b10
browse js "window.__r=null; ($(cat test/browser-check/group-drop.js)).then(r=>window.__r=r); 1"; sleep 8; browse js 'window.__r'
```

`pass: true` в обоих. Менять `styles.css` без смены `?v=` в `index.html` нельзя: браузер отдаст старый файл из кэша.
Ловят регресс «борд оттягивается вниз» (карточка не сжимается) и «таблица B9 зажата на 250px».
