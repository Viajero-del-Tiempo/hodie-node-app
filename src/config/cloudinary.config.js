/**
 * Configuración de Cloudinary para almacenamiento seguro de imágenes de personalización.
 * Las credenciales deben definirse estrictamente en variables de entorno sin fallbacks hardcodeados.
 */
export const CLOUDINARY_CONFIG = Object.freeze({
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
  apiKey: process.env.CLOUDINARY_API_KEY || "",
  apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  catalogFolder: process.env.CLOUDINARY_CATALOG_FOLDER || "hodie-tienda/catalog",
  folder: process.env.CLOUDINARY_FOLDER || "hodie-tienda/customizations",
});
