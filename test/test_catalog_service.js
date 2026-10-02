import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogService, CATALOG_CACHE_TTL_MS } from "../src/services/catalog.service.js";
import { categoryFixture, productFixture, memoryCatalog, testId } from "./helpers/catalog-fixtures.js";

test("categorías activas en orden, administración incluye inactivas, políticas por ID", async () => {
  const first = categoryFixture({ order: 1 });
  const second = categoryFixture({ order: 2 });
  const inactive = categoryFixture({ active: false, order: 0 });
  const policies = [{ id: "test-b", title: testId(), text: testId() }, { id: "test-a", title: testId(), text: testId() }];
  const { service } = memoryCatalog({ categories: [second, inactive, first], policies });
  assert.deepEqual((await service.getCategories()).map(category => category.id), [first.id, second.id]);
  assert.equal((await service.listCategories()).length, 3);
  assert.equal((await service.getCategory(inactive.id)).active, false);
  assert.equal(await service.getCategory(testId()), null);
  assert.deepEqual((await service.listPolicies()).map(policy => policy.id), ["test-a", "test-b"]);
  assert.equal((await service.getPolicy("test-b")).title, policies[0].title);
  assert.equal(await service.getPolicy(testId()), null);
});

test("detalle conserva datos completos y variantes activas agotadas, sin mutar caché", async () => {
  const category = categoryFixture();
  const product = productFixture(category.id, { description: testId(), attributes: { "test-key": testId() } });
  product.variants[0].stock = 0;
  product.variants.push({ ...product.variants[0], id: testId(), sku: testId(), options: { "test-axis": testId() }, active: false });
  const { service } = memoryCatalog({ categories: [category], products: [product] });
  const detail = await service.getProduct(product.id);
  assert.equal(detail.description, product.description);
  assert.deepEqual(detail.attributes, product.attributes);
  assert.equal(detail.variants.length, 1);
  assert.equal(detail.variants[0].stock, 0);
  assert.equal(detail.priceFrom, 1);
  detail.variants[0].stock = 99;
  assert.equal((await service.getProduct(product.id)).variants[0].stock, 0);
  const result = await service.searchProducts();
  result[0].variants[0].options["test-axis"] = testId();
  assert.deepEqual((await service.getProduct(product.id)).variants[0].options, product.variants[0].options);
  assert.equal(await service.getProduct(testId()), null);
});

test("no expone productos viejos, inactivos, sin variantes activas o de categoría inactiva", async () => {
  const category = categoryFixture();
  const disabled = categoryFixture({ active: false });
  const products = [
    productFixture(category.id, { schemaVersion: 1 }),
    productFixture(category.id, { active: false }),
    productFixture(category.id, { variants: [] }),
    productFixture(disabled.id), productFixture(testId()),
  ];
  const { service } = memoryCatalog({ categories: [category, disabled], products });
  for (const product of products) assert.equal(await service.getProduct(product.id), null);
  assert.deepEqual(await service.searchProducts(), []);
});

test("caché de cinco minutos y lecturas concurrentes comparten una carga", async () => {
  let currentTime = 0;
  const category = categoryFixture();
  const catalog = memoryCatalog({ categories: [category] }, { now: () => currentTime });
  await Promise.all([catalog.service.getCategories(), catalog.service.getCategories(), catalog.service.listPolicies()]);
  assert.equal(catalog.reads(), 1);
  category.name = testId();
  currentTime = CATALOG_CACHE_TTL_MS - 1;
  assert.notEqual((await catalog.service.getCategories())[0].name, category.name);
  assert.equal(catalog.reads(), 1);
  currentTime = CATALOG_CACHE_TTL_MS;
  assert.equal((await catalog.service.getCategories())[0].name, category.name);
  assert.equal(catalog.reads(), 2);
  catalog.service.invalidateCache();
  await catalog.service.getCategories();
  assert.equal(catalog.reads(), 3);
});

test("invalidar durante una carga descarta el resultado anterior y vuelve a leer", async () => {
  const oldCategory = categoryFixture();
  const freshCategory = { ...oldCategory, name: testId() };
  let resolveFirst;
  let reads = 0;
  const repository = { readCatalog() {
    reads++;
    if (reads === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return Promise.resolve({ categories: [freshCategory], products: [], policies: [] });
  } };
  const service = createCatalogService({ repository });
  const firstRead = service.getCategories();
  service.invalidateCache();
  assert.equal((await service.getCategories())[0].name, freshCategory.name);
  resolveFirst({ categories: [oldCategory], products: [], policies: [] });
  assert.equal((await firstRead)[0].name, freshCategory.name);
  assert.equal((await service.getCategories())[0].name, freshCategory.name);
  assert.equal(reads, 2);
});

test("escrituras exitosas invalidan caché; escrituras fallidas no la invalidan", async () => {
  const catalog = memoryCatalog();
  let writes = 0;
  for (const method of ["createCategory", "updateCategory", "deactivateCategory", "createPolicy", "updatePolicy", "deletePolicy"]) {
    catalog.repository[method] = async () => { writes++; return null; };
  }
  await catalog.service.getCategories();
  for (const method of ["createCategory", "updateCategory", "deactivateCategory", "createPolicy", "updatePolicy", "deletePolicy"]) {
    await catalog.service[method](testId(), {});
    await catalog.service.getCategories();
  }
  assert.equal(writes, 6);
  assert.equal(catalog.reads(), 7);
  catalog.repository.createCategory = async () => { throw new Error("test-failure"); };
  await assert.rejects(catalog.service.createCategory({}));
  await catalog.service.getCategories();
  assert.equal(catalog.reads(), 7);
});

test("fallos de lectura no quedan cacheados", async () => {
  let reads = 0;
  const service = createCatalogService({ repository: { async readCatalog() {
    if (++reads === 1) throw new Error("test-read-failure");
    return { categories: [], products: [], policies: [] };
  } } });
  await assert.rejects(service.getCategories());
  assert.deepEqual(await service.getCategories(), []);
  assert.equal(reads, 2);
});
