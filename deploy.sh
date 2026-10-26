#!/bin/bash
set -e
cd ~/hodie-node-app
npm ci
npx puppeteer browsers install chrome
grep -q "cleanMediaOptions" node_modules/whatsapp-web.js/src/util/Injected/Utils.js \
  || { echo "❌ El parche de whatsapp-web.js NO se aplicó. Abortando."; exit 1; }
deploy_started_at=$(node -p 'Date.now()')
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
pm2 logs hodie-backend --lines 15 --nostream
node scripts/wait-whatsapp-ready.js --since "$deploy_started_at"
