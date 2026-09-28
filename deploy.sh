#!/bin/bash
set -e
cd ~/hodie-node-app
npm ci
npx puppeteer browsers install chrome
grep -q "cleanMediaOptions" node_modules/whatsapp-web.js/src/util/Injected/Utils.js \
  || { echo "❌ El parche de whatsapp-web.js NO se aplicó. Abortando."; exit 1; }
pm2 restart hodie-backend
pm2 logs hodie-backend --lines 15 --nostream
