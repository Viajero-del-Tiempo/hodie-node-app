import { createCatalogRepository } from "./catalog.repository.js";
import { CatalogError, assertObject, calculatePriceFrom, validateDocumentId, validateProductForSave } from "../validators/catalog.validator.js";
import { compareScores, compareText, getQueryTerms, normalizeSearchText, scoreProductVariant } from "../utils/catalog-search.util.js";

export const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  // Firestore Timestamp es inmutable y conserva sus métodos.
  return value;
}

function categoryOrder(left, right) {
  return (left.order ?? 0) - (right.order ?? 0)
    || compareText(normalizeSearchText(left.name), normalizeSearchText(right.name))
    || compareText(left.id, right.id);
}

function validateSearch(input) {
  assertObject(input, "search");
  const { query = "", categoryId, options = {}, onlyAvailable = false, limit = 5 } = input;
  if (typeof query !== "string") throw new CatalogError("query", "query debe ser texto");
  if (categoryId !== undefined) validateDocumentId(categoryId, "categoryId");
  assertObject(options, "options");
  if (Object.values(options).some(value => typeof value !== "string" || !value.trim())) {
    throw new CatalogError("options", "Los valores de options deben ser texto no vacío");
  }
  if (typeof onlyAvailable !== "boolean") throw new CatalogError("onlyAvailable", "onlyAvailable debe ser booleano");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CatalogError("limit", "limit debe ser un entero positivo");
  return { query, categoryId, options, onlyAvailable, limit };
}

export function createCatalogService({ repository, now = Date.now, cacheTtlMs = CATALOG_CACHE_TTL_MS }) {
  let generation = 0;
  let cached = null;
  let pending = null;

  function invalidateCache() {
    generation++;
    cached = null;
  }

  async function snapshot() {
    for (;;) {
      if (cached && now() < cached.expiresAt) return cached.data;
      if (!pending || pending.generation !== generation) {
        const readGeneration = generation;
        const promise = repository.readCatalog().then(data => {
          const detached = clone(data);
          if (readGeneration === generation) cached = { data: detached, expiresAt: now() + cacheTtlMs };
          return { data: detached, generation: readGeneration };
        }).finally(() => {
          if (pending?.promise === promise) pending = null;
        });
        pending = { promise, generation: readGeneration };
      }
      const result = await pending.promise;
      if (result.generation === generation) return result.data;
      // Una escritura durante la lectura obliga a volver a leer.
    }
  }

  async function write(method, ...args) {
    const result = await repository[method](...args);
    invalidateCache();
    return clone(result);
  }

  return {
    invalidateCache,
    // Lectura interna fresca: incluye documentos viejos/inactivos para validarlos
    // explícitamente y permite usar la misma transacción que el pedido.
    async getProductForPricing(id, options = {}) {
      return clone(await repository.getProduct(id, options));
    },
    async getCategoryForPricing(id) {
      return clone(await repository.getCategory(id));
    },
    setProductVariants: (transaction, id, variants) => repository.setProductVariants(transaction, id, variants),
    async getCategories() {
      return clone((await snapshot()).categories.filter(category => category.active === true).sort(categoryOrder));
    },
    async listCategories() {
      return clone([...(await snapshot()).categories].sort(categoryOrder));
    },
    async getCategory(id) {
      validateDocumentId(id);
      return clone((await snapshot()).categories.find(category => category.id === id) ?? null);
    },
    async listPolicies() {
      return clone([...(await snapshot()).policies].sort((left, right) => compareText(left.id, right.id)));
    },
    async getPolicy(id) {
      validateDocumentId(id);
      return clone((await snapshot()).policies.find(policy => policy.id === id) ?? null);
    },
    async getProduct(productId) {
      validateDocumentId(productId, "productId");
      const data = await snapshot();
      const product = data.products.find(item => item.id === productId && item.schemaVersion === 2 && item.active === true);
      if (!product || !data.categories.some(category => category.id === product.categoryId && category.active === true)) return null;
      const variants = (product.variants ?? []).filter(variant => variant.active === true);
      return variants.length ? clone({ ...product, variants, priceFrom: calculatePriceFrom(variants) }) : null;
    },
    async searchProducts(input = {}) {
      const { query, categoryId, options, onlyAvailable, limit } = validateSearch(input);
      const terms = getQueryTerms(query);
      const data = await snapshot();
      const categories = new Map(data.categories.filter(category => category.active === true).map(category => [category.id, category]));
      const results = [];
      for (const product of data.products) {
        const category = categories.get(product.categoryId);
        if (product.schemaVersion !== 2 || product.active !== true || !category || (categoryId !== undefined && product.categoryId !== categoryId)) continue;
        const activeVariants = (product.variants ?? []).filter(variant => variant.active === true);
        const variants = activeVariants.filter(variant => (!onlyAvailable || variant.stock > 0)
          && Object.entries(options).every(([key, value]) => Object.hasOwn(variant.options ?? {}, key)
            && normalizeSearchText(variant.options[key]) === normalizeSearchText(value)));
        if (!variants.length) continue;
        const matches = variants.map(variant => scoreProductVariant(product, category, variant, terms)).sort((left, right) => compareScores(left.score, right.score));
        const best = matches[0];
        if (terms.length && !best.matchedTerms.length) continue;
        results.push({
          score: best.score, categoryOrder: category.order ?? 0,
          value: {
            id: product.id, name: product.name, slug: product.slug,
            category: { id: category.id, name: category.name },
            priceFrom: calculatePriceFrom(activeVariants), matchedTerms: best.matchedTerms,
            variants: variants.map(variant => ({
              id: variant.id, sku: variant.sku, options: variant.options,
              price: variant.price, stock: variant.stock, available: variant.stock > 0,
              imageUrls: variant.imageUrls ?? [],
            })),
            customization: product.customization ?? { allowed: false, allowsText: false, allowsImage: false, notes: "" },
          },
        });
      }
      results.sort((left, right) => compareScores(left.score, right.score)
        || left.categoryOrder - right.categoryOrder
        || compareText(normalizeSearchText(left.value.name), normalizeSearchText(right.value.name))
        || compareText(left.value.id, right.value.id));
      return clone(results.slice(0, limit).map(result => result.value));
    },
    validateProduct: (input, options = {}) => validateProductForSave(input, { ...options, repository }),
    createCategory: input => write("createCategory", input),
    updateCategory: (id, input) => write("updateCategory", id, input),
    deactivateCategory: id => write("deactivateCategory", id),
    createPolicy: input => write("createPolicy", input),
    updatePolicy: (id, input) => write("updatePolicy", id, input),
    deletePolicy: id => write("deletePolicy", id),
  };
}

// Inicialización diferida: importar el servicio puro no carga credenciales ni WhatsApp.
let defaultService;
let initialization;
async function getDefaultService() {
  if (!initialization) {
    initialization = Promise.all([import("../config/firebase.js"), import("firebase-admin/firestore")])
      .then(([{ db }, { Timestamp }]) => {
        defaultService = createCatalogService({ repository: createCatalogRepository(db, { timestampNow: () => Timestamp.now() }) });
        return defaultService;
      }).catch(error => {
        initialization = null;
        throw error;
      });
  }
  return initialization;
}

export function invalidateCatalogCache() {
  defaultService?.invalidateCache();
}

export const getCategories = async () => (await getDefaultService()).getCategories();
export const getProduct = async productId => (await getDefaultService()).getProduct(productId);
export const searchProducts = async input => (await getDefaultService()).searchProducts(input);
export const catalogService = Object.fromEntries([
  "getProductForPricing", "getCategoryForPricing", "setProductVariants",
  "getCategories", "getProduct", "searchProducts", "listCategories", "getCategory", "listPolicies", "getPolicy",
  "validateProduct", "createCategory", "updateCategory", "deactivateCategory", "createPolicy", "updatePolicy", "deletePolicy",
].map(method => [method, async (...args) => (await getDefaultService())[method](...args)]));
