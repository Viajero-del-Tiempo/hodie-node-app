import { randomUUID } from "node:crypto";
import { normalizeSearchText } from "../utils/catalog-search.util.js";

export class CatalogError extends Error {
  constructor(field, message, status = 400) {
    super(message);
    this.name = "CatalogError";
    this.field = field;
    this.status = status;
  }
}

function fail(field, message) {
  throw new CatalogError(field, `${field}: ${message}`);
}

export function assertObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(field, "debe ser un objeto");
  }
}

function text(value, field, { min = 1, max = Infinity, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") fail(field, "debe ser texto");
  const result = value.trim().normalize("NFC");
  const length = [...result].length;
  if (length < min || length > max) fail(field, `longitud inválida (mínimo ${min}${Number.isFinite(max) ? `, máximo ${max}` : ""})`);
  return result;
}

function bool(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(field, "debe ser booleano");
  return value;
}

function integer(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(field, `debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function array(value, field, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Array.isArray(value)) fail(field, "debe ser un arreglo");
  return value;
}

export function validateDocumentId(value, field = "id") {
  const result = text(value, field);
  if (value !== result || result.includes("/") || result === "." || result === "..") fail(field, "ID de documento inválido");
  return result;
}

function slug(value, field) {
  const result = text(value, field);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)) fail(field, "debe ser un slug en minúsculas");
  return result;
}

function stableId(input, existing) {
  if (existing && input.id !== undefined && input.id !== existing.id) fail("id", "no puede cambiar");
  return slug(existing?.id ?? input.id, "id");
}

export function validateCategory(input, { existing = null } = {}) {
  assertObject(input, "body");
  const merged = { ...existing, ...input };
  return {
    id: stableId(input, existing),
    name: text(merged.name, "name"),
    description: text(merged.description, "description", { min: 0, fallback: "" }),
    active: bool(merged.active, "active", true),
    order: integer(merged.order === undefined ? 0 : merged.order, "order"),
  };
}

export function validatePolicy(input, { existing = null } = {}) {
  assertObject(input, "body");
  const merged = { ...existing, ...input };
  return {
    id: stableId(input, existing),
    title: text(merged.title, "title"),
    text: text(merged.text, "text"),
  };
}

function stringMap(value, field) {
  assertObject(value, field);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    text(key, `${field}.key`);
    return [key, text(item, `${field}.${key}`)];
  }));
}

export function calculatePriceFrom(variants) {
  const active = variants.filter(variant => variant.active === true);
  return active.length ? Math.min(...active.map(variant => variant.price)) : null;
}

// Devuelve únicamente campos del modelo: id/timestamps del producto son del servidor.
// El caller recibe un documento completo; no es un PATCH de producto.
export function validateProductModel(input, { existingProduct = null, generateVariantId = randomUUID } = {}) {
  assertObject(input, "body");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 2) fail("schemaVersion", "debe ser 2");
  const name = text(input.name, "name", { min: 2, max: 80 });
  const productSlug = slug(input.slug ?? normalizeSearchText(name).replace(/ /gu, "-").replace(/ñ/gu, "n"), "slug");
  const optionNames = array(input.optionNames, "optionNames").map((item, index) => text(item, `optionNames[${index}]`));
  if (new Set(optionNames).size !== optionNames.length) fail("optionNames", "no admite ejes repetidos");
  const previousIds = new Set((existingProduct?.variants ?? []).map(variant => variant.id));
  const ids = new Set();
  const skus = new Set();
  const combinations = new Set();
  const rawVariants = array(input.variants, "variants");
  if (!rawVariants.length) fail("variants", "requiere al menos una variante");
  const variants = rawVariants.map((variant, index) => {
    const field = `variants[${index}]`;
    assertObject(variant, field);
    let id;
    if (variant.id === undefined) {
      id = validateDocumentId(generateVariantId(), `${field}.id`);
    } else {
      id = validateDocumentId(variant.id, `${field}.id`);
      if (!previousIds.has(id)) fail(`${field}.id`, "solo el servidor asigna IDs a variantes nuevas");
    }
    if (ids.has(id)) fail(`${field}.id`, "ID repetido");
    ids.add(id);
    const options = stringMap(variant.options, `${field}.options`);
    if (Object.keys(options).length !== optionNames.length || optionNames.some(key => !Object.hasOwn(options, key))) {
      fail(`${field}.options`, "sus claves deben coincidir con optionNames");
    }
    const combination = JSON.stringify([...optionNames].sort().map(key => options[key]));
    if (combinations.has(combination)) fail(`${field}.options`, "combinación repetida");
    combinations.add(combination);
    const sku = text(variant.sku, `${field}.sku`);
    if (skus.has(sku)) fail(`${field}.sku`, "SKU repetido dentro del producto");
    skus.add(sku);
    return {
      id, sku, options,
      price: integer(variant.price, `${field}.price`, 1),
      stock: integer(variant.stock, `${field}.stock`),
      active: bool(variant.active, `${field}.active`, true),
      imageUrls: array(variant.imageUrls, `${field}.imageUrls`, []).map((url, imageIndex) => text(url, `${field}.imageUrls[${imageIndex}]`)),
    };
  });
  if ([...previousIds].some(id => !ids.has(id))) fail("variants", "una variante creada nunca se elimina; debe desactivarse con active: false");
  const tags = array(input.tags, "tags", []);
  if (tags.length > 20) fail("tags", "admite hasta 20 etiquetas");
  const normalizedTags = tags.map((tag, index) => text(tag, `tags[${index}]`, { min: 2, max: 30 }).toLowerCase());
  const packagingTypes = new Set();
  const packagingOptions = array(input.packagingOptions, "packagingOptions", []).map((packaging, index) => {
    const field = `packagingOptions[${index}]`;
    assertObject(packaging, field);
    const type = text(packaging.type, `${field}.type`);
    if (packagingTypes.has(type)) fail(`${field}.type`, "tipo repetido dentro del producto");
    packagingTypes.add(type);
    return {
      type, name: text(packaging.name, `${field}.name`),
      price: integer(packaging.price, `${field}.price`),
      ...(packaging.imageUrl === undefined ? {} : { imageUrl: text(packaging.imageUrl, `${field}.imageUrl`, { min: 0 }) }),
    };
  });
  const customization = input.customization === undefined ? {} : input.customization;
  assertObject(customization, "customization");
  const allowsText = bool(customization.allowsText, "customization.allowsText", false);
  return {
    schemaVersion: 2, name, slug: productSlug,
    description: text(input.description, "description", { min: 0, fallback: "" }),
    categoryId: slug(input.categoryId, "categoryId"),
    tags: normalizedTags,
    active: bool(input.active, "active", true),
    attributes: stringMap(input.attributes === undefined ? {} : input.attributes, "attributes"),
    optionNames, variants, skus: [...skus], priceFrom: calculatePriceFrom(variants),
    customization: {
      allowed: bool(customization.allowed, "customization.allowed", false),
      allowsText,
      ...(allowsText ? { maxChars: integer(customization.maxChars, "customization.maxChars", 1, 500) } : {}),
      allowsImage: bool(customization.allowsImage, "customization.allowsImage", false),
      notes: text(customization.notes, "customization.notes", { min: 0, fallback: "" }),
    },
    packagingOptions,
  };
}

// La consulta indexada comprueba conflictos, pero no reserva el SKU para un guardado.
export async function validateProductForSave(input, { repository, existingProduct = null, generateVariantId } = {}) {
  const product = validateProductModel(input, { existingProduct, generateVariantId });
  const category = await repository.getCategory(product.categoryId);
  if (!category || category.active !== true) fail("categoryId", "debe existir y estar activa");
  const conflicts = await Promise.all(product.variants.map(variant => repository.findSkuConflict(variant.sku, existingProduct?.id)));
  const conflictIndex = conflicts.findIndex(Boolean);
  if (conflictIndex !== -1) fail(`variants[${conflictIndex}].sku`, "ya existe en otro producto del catálogo");
  return product;
}
