#!/bin/bash
# Честный статус релиза: что в рабочем дереве, что в git, что в cloudflare/public и что видно на проде.
# Запуск из любого места: bash scripts/release-check.sh
# Код выхода: 0 -- все локальные проверки сошлись; 1 -- есть расхождение (деплой/коммит/push не доделан).
# ВАЖНО: скрипт не подменяет проверку на боевом сайте. Прод закрыт паролем (Basic Auth), без пароля Димы
# содержимое не видно, и тогда в итоге стоит НА ПРОДЕ НЕ ПРОВЕРЕНО. Пароль скрипту передаёт только Дима:
#   OFD_BASIC_AUTH='логин:пароль' bash scripts/release-check.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC="$REPO_ROOT/cloudflare/public"
PROD_URL="${OFD_PROD_URL:-https://ofd-gate.dmitrijudalov58.workers.dev}"
# То, что cloudflare/deploy.sh кладёт на сайт. Менять вместе с deploy.sh.
RELEASE_PATHS=(index.html css js docs manifest.webmanifest sw.js icons)

cd "$REPO_ROOT" || exit 1
problems=0
fail() { echo "  ✗ $1"; problems=$((problems + 1)); }
ok() { echo "  ✓ $1"; }

echo "== 1. Синтаксис js (кроме vendor)"
syntax_bad=0
for f in js/*.js sw.js; do
  [ -f "$f" ] || continue
  if ! node --check "$f" 2>/dev/null; then fail "ошибка синтаксиса: $f"; syntax_bad=1; fi
done
# worker.js -- ES-модуль (export default): node --check читает .js как CommonJS, поэтому проверяем копию .mjs
mjs_tmp="$(mktemp -d)/worker.mjs"
cp cloudflare/worker.js "$mjs_tmp"
if ! node --check "$mjs_tmp" 2>/dev/null; then fail "ошибка синтаксиса: cloudflare/worker.js"; syntax_bad=1; fi
rm -rf "$(dirname "$mjs_tmp")"
[ "$syntax_bad" -eq 0 ] && ok "node --check прошёл"

echo "== 2. Файлы сайта: изменено и не закоммичено"
dirty="$(git status --porcelain -- "${RELEASE_PATHS[@]}")"
if [ -n "$dirty" ]; then
  fail "не закоммичено (на проде этого нет и не будет, пока не закоммичено и не задеплоено):"
  echo "$dirty" | sed 's/^/      /'
else
  ok "изменений в файлах сайта нет"
fi

echo "== 3. Коммиты не отправлены в origin/main"
if git fetch --quiet origin 2>/dev/null; then
  ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")"
  if [ "$ahead" = "0" ]; then ok "push сделан (HEAD = origin/main)"; else fail "не отправлено коммитов: $ahead"; fi
else
  fail "git fetch не отработал (нет сети?), push проверить не удалось"
fi

echo "== 4. cloudflare/public совпадает с исходниками"
if [ ! -d "$PUBLIC" ]; then
  fail "cloudflare/public отсутствует (deploy.sh не запускался)"
else
  public_bad=0
  for p in "${RELEASE_PATHS[@]}"; do
    if [ ! -e "$PUBLIC/$p" ]; then fail "в public нет: $p"; public_bad=1; continue; fi
    if ! diff -rq "$REPO_ROOT/$p" "$PUBLIC/$p" >/dev/null 2>&1; then
      fail "public расходится с исходником: $p"; public_bad=1
    fi
  done
  [ "$public_bad" -eq 0 ] && ok "public = исходники"
fi

echo "== 5. Деплой не старше последнего изменения"
build="$(sed -n 's/.*"build":"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p' "$PUBLIC/version.json" 2>/dev/null)"
last_commit_ts="$(git log -1 --format=%ct -- "${RELEASE_PATHS[@]}" 2>/dev/null)"
if [ -z "$build" ] || [ -z "$last_commit_ts" ]; then
  fail "не удалось прочитать build из public/version.json или время коммита"
elif [ "$build" -lt "$last_commit_ts" ]; then
  fail "сборка public ($build) старше последнего коммита файлов сайта ($last_commit_ts): нужен deploy.sh"
else
  ok "build $build не старше последнего коммита ($last_commit_ts); это локальная копия, не доказательство деплоя на Cloudflare"
fi

echo "== 6. Боевой сайт: $PROD_URL"
prod_state="unchecked"
if [ -n "${OFD_BASIC_AUTH:-}" ]; then
  prod_json="$(curl -s --max-time 20 -u "$OFD_BASIC_AUTH" "$PROD_URL/version.json" 2>/dev/null)"
  prod_build="$(echo "$prod_json" | sed -n 's/.*"build":"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p')"
  if [ -z "$prod_build" ]; then
    echo "  ? прод не вернул version.json (неверный пароль или сайт недоступен)"
  elif [ "$prod_build" = "$build" ]; then
    ok "на проде build $prod_build = build в public"; prod_state="match"
  else
    fail "на проде build $prod_build, в public $build: выкачено не то"; prod_state="mismatch"
  fi
else
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PROD_URL/version.json" 2>/dev/null)"
  echo "  ? прод закрыт паролем (HTTP $code): содержимое не видно, проверить без входа Димы нельзя"
fi

echo
if [ "$problems" -gt 0 ]; then
  echo "ИТОГ: НЕ ГОТОВО. Расхождений: $problems. Слово «готово» писать нельзя."
  exit 1
fi
if [ "$prod_state" = "match" ]; then
  echo "ИТОГ: локально всё сходится, версия на проде = версия в public. Остаётся пройти сценарий Димы в браузере на проде."
else
  echo "ИТОГ: локально всё сходится, НА ПРОДЕ НЕ ПРОВЕРЕНО. Статус максимум «ВЫКАЧЕНО, НА ПРОДЕ НЕ ПРОВЕРЕНО», не «готово»."
fi
exit 0
