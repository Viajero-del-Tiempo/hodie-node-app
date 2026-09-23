const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Configura la ubicación de la caché de Puppeteer dentro del directorio del proyecto.
  // En plataformas como Render.com, ~/.cache se descarta entre la fase de build y runtime.
  // Al ubicarlo dentro del proyecto (.cache/puppeteer), el binario persiste en producción.
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || join(__dirname, '.cache', 'puppeteer'),
};
