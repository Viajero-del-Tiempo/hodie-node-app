import { CatalogError, assertObject } from "./catalog.validator.js";

export const MAX_CATALOG_IMAGE_BYTES = 10 * 1024 * 1024;
export function validateCatalogImage(input) {
  assertObject(input, "body");
  const { base64, mimetype } = input;
  if (typeof base64 !== "string" || !base64 || base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new CatalogError("base64", "La imagen debe contener base64 válido");
  }
  if (base64.length > Math.ceil(MAX_CATALOG_IMAGE_BYTES / 3) * 4) {
    throw new CatalogError("base64", "La imagen supera el máximo de 10 MB", 413);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new CatalogError("base64", "La imagen debe contener base64 válido");
  if (bytes.length > MAX_CATALOG_IMAGE_BYTES) throw new CatalogError("base64", "La imagen supera el máximo de 10 MB", 413);
  const mime = typeof mimetype === "string" ? mimetype.toLowerCase() : "";
  const signatures = {
    "image/png": buffer => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/jpeg": buffer => buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255,
    "image/webp": buffer => buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP",
  };
  const cleanMime = mime === "image/jpg" ? "image/jpeg" : mime;
  if (!signatures[cleanMime]) throw new CatalogError("mimetype", "Formatos admitidos: JPG, PNG y WEBP");
  if (!signatures[cleanMime](bytes)) throw new CatalogError("base64", "El contenido de la imagen no coincide con su formato");
  return { base64, mimetype: cleanMime, bytes };
}
