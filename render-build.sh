#!/usr/bin/env bash
# exit on error
set -o errexit

echo "📦 Instalando dependencias..."
npm install

echo "🌐 Descargando Chrome para Puppeteer en .cache/puppeteer..."
npx puppeteer browsers install chrome

echo "✅ Build completado con éxito."
