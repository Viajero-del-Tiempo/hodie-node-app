import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
    async findSkuConflict(sku, excludedId) {
      return data.products.find(product => product.id !== excludedId && (product.sku === sku || product.skus?.includes(sku)))?.id ?? null;
    },
  };
  return { data, repository, reads: () => reads, service: createCatalogService({ repository, ...options }) };
}

// El caso solicitado obtiene los nombres del ejemplo documentado, no del código.
export function documentedSearchExample() {
  const spec = readFileSync(new URL("../../docs/SPEC-catalogo.md", import.meta.url), "utf8");
  const block = spec.match(/### products\s+```js\s+([\s\S]*?)```/u)?.[1];
  const productName = block?.match(/name:\s*"([^"]+)"/u)?.[1];
  const option = block?.match(/options:\s*\{\s*([^:\s]+):\s*"([^"]+)"/u);
  const tags = block?.match(/tags:\s*\[([^\]]*)\]/u)?.[1].match(/"[^"]+"/gu)?.map(value => JSON.parse(value));
  if (!productName || !option || !tags?.length) throw new Error("Falta el ejemplo documental para la consulta parcial");
  const recipient = tags.at(-1).split(/\s+/u).at(-1);
  const query = `${productName.split(/\s+/u)[0].toLowerCase()} ${option[2].toLowerCase()} para ${recipient}`;
  return { productName, optionName: option[1], optionValue: option[2], recipient, query };
}
