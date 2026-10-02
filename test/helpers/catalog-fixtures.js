import { randomUUID } from "node:crypto";
import { createCatalogService } from "../../src/services/catalog.service.js";

export const testId = () => `test-${randomUUID()}`;

export function categoryFixture(overrides = {}) {
  const id = testId();
  return { id, name: id, description: "", active: true, order: 0, ...overrides };
}

export function productFixture(categoryId, overrides = {}) {
  const id = testId();
  return {
    id, schemaVersion: 2, name: id, slug: id, description: "", categoryId,
    tags: [], active: true, attributes: {}, optionNames: ["test-axis"],
    variants: [{ id: testId(), sku: testId(), options: { "test-axis": testId() }, price: 1, stock: 1, active: true, imageUrls: [] }],
    customization: { allowed: false, allowsText: false, allowsImage: false, notes: "" },
    packagingOptions: [], ...overrides,
  };
}

export function newProductInput(categoryId, overrides = {}) {
  const product = productFixture(categoryId, overrides);
  return { ...product, variants: product.variants.map(({ id: _id, ...variant }) => variant) };
}

export function memoryCatalog({ categories = [], products = [], policies = [] } = {}, options = {}) {
  const data = { categories, products, policies };
  let reads = 0;
  const repository = {
    async readCatalog() { reads++; return structuredClone(data); },
    async getCategory(id) { return data.categories.find(category => category.id === id) ?? null; },
    async getProduct(id) { return data.products.find(product => product.id === id) ?? null; },
    async findSkuConflict(sku, excludedId) {
      return data.products.find(product => product.id !== excludedId && (product.sku === sku || product.skus?.includes(sku)))?.id ?? null;
    },
  };
  return { data, repository, reads: () => reads, service: createCatalogService({ repository, ...options }) };
}

// Datos ficticios de test, independientes de los documentos del proyecto.
export function syntheticSearchExample() {
  return {
    productName: "Producto Alfa",
    optionName: "color",
    optionValue: "Negro",
    recipient: "papá",
    query: "producto alfa negro para papá",
  };
}
