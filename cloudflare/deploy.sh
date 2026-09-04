#!/bin/bash
# Копирует свежие файлы сайта из корня репозитория в cloudflare/public/ и деплоит
# Worker на Cloudflare. cloudflare/public/ — не источник правды, а сборочная копия
# (в .gitignore), поэтому пересобирается перед каждым деплоем из корневых index.html/css/js/docs.
#
# Нужен CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID в окружении перед запуском.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$REPO_ROOT/cloudflare"

rm -rf "$CF_DIR/public"
mkdir -p "$CF_DIR/public"
cp "$REPO_ROOT/index.html" "$CF_DIR/public/"
cp -R "$REPO_ROOT/css" "$CF_DIR/public/"
cp -R "$REPO_ROOT/js" "$CF_DIR/public/"
cp -R "$REPO_ROOT/docs" "$CF_DIR/public/" 2>/dev/null || true

# version.json -- баннер "есть обновление" (Дима, 2026-09-04) сверяет build с этим файлом,
# перегенерируется на каждый деплой, чтобы клиент заметил разницу.
echo "{\"build\":\"$(date +%s)\"}" > "$CF_DIR/public/version.json"

cd "$CF_DIR"
npx wrangler deploy
