import { createHash } from "node:crypto";
import { CatalogError } from "../validators/catalog.validator.js";

const labels = {
  name: "nombre", slug: "slug", description: "descripción", categoryId: "categoría",
  tags: "etiquetas", active: "estado del producto", attributes: "atributos",
  optionNames: "ejes de opciones", variants: "datos de variantes",
  customization: "personalización", packagingOptions: "empaques",
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const variantLabels = { sku: "SKU", price: "precio", options: "opciones", active: "estado", imageUrls: "imágenes" };
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value ?? null))).digest("hex");
const variantHashes = variant => Object.fromEntries(Object.keys(variantLabels).map(field => [field, digest(variant[field])]));
function hashes(product) {
  return Object.fromEntries(Object.keys(labels).map(field => {
    // Stock se compara aparte, sin confundir un descuento con cambio de opciones.
    const value = field === "variants"
      ? (product.variants ?? []).map(({ stock: _stock, ...variant }) => variant)
      : product[field] ?? null;
    return [field, digest(value)];
  }));
}
const documentTime = snapshot => snapshot.updateTime.seconds + ":" + snapshot.updateTime.nanoseconds;

export function productVersion(snapshot) {
  const product = snapshot.data();
  return Buffer.from(JSON.stringify({
    id: snapshot.id, time: documentTime(snapshot), hashes: hashes(product),
    stocks: (product.variants ?? []).map(variant => ({ id: variant.id, stock: variant.stock, price: variant.price, fields: variantHashes(variant) })),
  })).toString("base64url");
}

export function assertProductVersion(snapshot, version) {
  let previous;
  try {
    if (typeof version !== "string" || !version || version.length > 500000
        || !/^[A-Za-z0-9_-]+$/.test(version)) throw new Error();
    previous = JSON.parse(Buffer.from(version, "base64url").toString("utf8"));
    if (previous.id !== snapshot.id || typeof previous.time !== "string" || !/^\d+:\d+$/.test(previous.time)
        || !previous.hashes || typeof previous.hashes !== "object" || Array.isArray(previous.hashes)
        || Object.keys(labels).some(field => typeof previous.hashes[field] !== "string")
        || !Array.isArray(previous.stocks) || previous.stocks.some(item => !item || typeof item.id !== "string" || !Number.isSafeInteger(item.stock) || !item.fields || Object.keys(variantLabels).some(field => typeof item.fields[field] !== "string"))) throw new Error();
  } catch {
    throw new CatalogError("version", "Se requiere la versión válida con la que se abrió el producto");
  }
  // La precondición es el updateTime del documento, no updatedAt del cliente.
  if (previous.time === documentTime(snapshot)) return;
  const current = snapshot.data();
  const currentHashes = hashes(current);
  const changes = [];
  const descriptions = [];
  for (const [field, label] of Object.entries(labels)) {
    if (field === "variants") continue;
    if (previous.hashes[field] !== currentHashes[field]) {
      changes.push({ field });
      descriptions.push("cambió " + label);
    }
  }
  if (JSON.stringify(previous.stocks.map(item => item.id)) !== JSON.stringify((current.variants ?? []).map(variant => variant.id))) {
    changes.push({ field: "variants" });
    descriptions.push("cambió la lista o el orden de variantes");
  }
  for (const [index, variant] of (current.variants ?? []).entries()) {
    const old = previous.stocks.find(item => item.id === variant.id);
    if (old) {
      const fields = variantHashes(variant);
      for (const [field, label] of Object.entries(variantLabels)) {
        if (old.fields[field] !== fields[field]) {
          changes.push({ field: "variants[" + index + "]." + field, variantId: variant.id, sku: variant.sku,
            ...(field === "price" && Number.isSafeInteger(old.price) ? { previous: old.price, current: variant.price } : {}) });
          descriptions.push("cambió " + label + " de la variante SKU " + variant.sku);
        }
      }
    }
    if (old && Number.isSafeInteger(old.stock) && old.stock !== variant.stock) {
      changes.push({ field: "variants[" + index + "].stock", variantId: variant.id,
        sku: variant.sku, previous: old.stock, current: variant.stock });
      descriptions.push("el stock del SKU " + variant.sku + " pasó de " + old.stock + " a " + variant.stock);
    }
  }
  const detail = descriptions.length ? descriptions.join("; ") : "cambió la versión del documento";
  const error = new CatalogError("version", "El producto cambió desde que lo abriste: " + detail
    + ". Tu borrador no se guardó. Recargá el producto para revisar los cambios.", 409);
  error.code = "CATALOG_VERSION_CONFLICT";
  error.changes = changes;
  throw error;
}
