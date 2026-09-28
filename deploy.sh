#!/usr/bin/env bash
# ==============================================================================
# Deploy Script para VM de Producción - HoDie WhatsApp Integration Service
# ==============================================================================
set -o errexit

echo "📦 1. Instalando dependencias (ejecuta postinstall: patch-package)..."
npm install

echo "🌐 2. Asegurando instalación de navegador Chrome para Puppeteer..."
npx puppeteer browsers install chrome

echo "🔄 3. Reiniciando servicio en PM2..."
pm2 restart hodie-node-app || pm2 start server.js --name hodie-node-app

echo "✅ Deploy finalizado con éxito."
