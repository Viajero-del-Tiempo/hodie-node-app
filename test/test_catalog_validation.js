import test from "node:test";
import assert from "node:assert/strict";
import { validateCategory, validatePolicy, validateProductModel, validateProductForSave } from "../src/validators/catalog.validator.js";
import { createCatalogRepository } from "../src/services/catalog.repository.js";
import { categoryFixture, newProductInput, testId } from "./helpers/catalog-fixtures.js";

const validInput = () => newProductInput(testId());
const invalid = (input, field, options) => assert.throws(() => validateProductModel(input, options), error => error.status === 400 && error.field === field);

test("normaliza modelo y calcula campos del servidor, ignorando campos manipulados", () => {
  const input = validInput();
  input.name = ` ${input.name} `;
  input.tags = [" TEST-AA "];
  input.priceFrom = -1;
  input.skus = [testId()];
  input.createdAt = "test-client";
  input.unrecognized = true;
  input.variants.push({ ...input.variants[0], sku: testId(), options: { "test-axis": testId() }, price: 3 });
  input.variants.push({ ...input.variants[0], sku: testId(), options: { "test-axis": testId() }, price: 2, active: false });
  const product = validateProductModel(input, { generateVariantId: testId });
  assert.equal(product.name, input.name.trim());
  assert.deepEqual(product.tags, ["test-aa"]);
  assert.equal(product.schemaVersion, 2);
  assert.equal(product.priceFrom, 1);
  assert.deepEqual(product.skus, input.variants.map(variant => variant.sku));
  assert.equal(new Set(product.variants.map(variant => variant.id)).size, 3);
  assert.equal(Object.hasOwn(product, "id"), false);
  assert.equal(Object.hasOwn(product, "createdAt"), false);
  assert.equal(Object.hasOwn(product, "unrecognized"), false);
  input.variants.forEach(variant => { variant.active = false; });
  assert.equal(validateProductModel(input).priceFrom, null);
});

test("nombre, versión, arrays, objetos y booleanos inválidos", () => {
  for (const name of [undefined, " ", "x", "x".repeat(81), 1]) invalid({ ...validInput(), name }, "name");
  for (const length of [2, 80]) assert.equal(validateProductModel({ ...validInput(), name: "x".repeat(length) }).name.length, length);
  invalid({ ...validInput(), schemaVersion: 1 }, "schemaVersion");
  invalid({ ...validInput(), variants: [] }, "variants");
  invalid({ ...validInput(), variants: {} }, "variants");
  invalid({ ...validInput(), optionNames: undefined }, "optionNames");
  invalid({ ...validInput(), attributes: [] }, "attributes");
  invalid({ ...validInput(), attributes: null }, "attributes");
  invalid({ ...validInput(), active: "true" }, "active");
  invalid({ ...validInput(), customization: [] }, "customization");
  invalid({ ...validInput(), customization: null }, "customization");
  invalid({ ...validInput(), categoryId: "a/b" }, "categoryId");
});

test("precios y stock aceptan solo enteros seguros dentro de límites", () => {
  for (const [key, values] of [["price", [0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]], ["stock", [-1, 0.5, "0", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]]]) {
    for (const value of values) {
      const input = validInput();
      input.variants[0][key] = value;
      invalid(input, `variants[0].${key}`);
    }
  }
  const input = validInput();
  input.variants[0].stock = 0;
  assert.equal(validateProductModel(input).variants[0].stock, 0);
});

test("ejes y combinaciones de opciones coherentes, independientemente del orden de claves", () => {
  invalid({ ...validInput(), optionNames: ["test-axis", "test-axis"] }, "optionNames");
  for (const options of [{}, { "test-axis": testId(), extra: testId() }, [], { "test-axis": " " }]) {
    const input = validInput();
    input.variants[0].options = options;
    invalid(input, Array.isArray(options) || !Object.hasOwn(options, "test-axis") || Object.keys(options).length !== 1 ? "variants[0].options" : "variants[0].options.test-axis");
  }
  const input = validInput();
  const a = testId();
  const b = testId();
  input.optionNames = ["test-a", "test-b"];
  input.variants[0].options = { "test-a": a, "test-b": b };
  input.variants.push({ ...input.variants[0], sku: testId(), options: { "test-b": b, "test-a": a } });
  invalid(input, "variants[1].options");
  const single = validInput();
  single.optionNames = [];
  single.variants[0].options = {};
  assert.deepEqual(validateProductModel(single).variants[0].options, {});
});

test("una variante creada nunca se elimina ni cambia de ID; puede desactivarse y reordenarse", () => {
  const input = validInput();
  input.variants.push({ ...input.variants[0], sku: testId(), options: { "test-axis": testId() } });
  const existing = { id: testId(), ...validateProductModel(input) };
  const updated = structuredClone(existing);
  updated.variants.reverse();
  updated.variants[0].active = false;
  assert.deepEqual(validateProductModel(updated, { existingProduct: existing }).variants.map(variant => variant.id), updated.variants.map(variant => variant.id));
  updated.variants.pop();
  invalid(updated, "variants", { existingProduct: existing });
  const changed = structuredClone(existing);
  changed.variants[0].id = testId();
  invalid(changed, "variants[0].id", { existingProduct: existing });
  const recreated = structuredClone(existing);
  delete recreated.variants[0].id;
  invalid(recreated, "variants", { existingProduct: existing });
  const duplicate = structuredClone(existing);
  duplicate.variants[1].id = duplicate.variants[0].id;
  invalid(duplicate, "variants[1].id", { existingProduct: existing });
  const clientId = validInput();
  clientId.variants[0].id = testId();
  invalid(clientId, "variants[0].id");
  const added = structuredClone(existing);
  added.variants.push({ ...input.variants[0], sku: testId(), options: { "test-axis": testId() } });
  assert.equal(validateProductModel(added, { existingProduct: existing }).variants.length, 3);
});

test("SKU obligatorio y sin duplicados locales, incluso con variantes inactivas", () => {
  const input = validInput();
  input.variants[0].sku = " ";
  invalid(input, "variants[0].sku");
  const duplicate = validInput();
  duplicate.variants.push({ ...duplicate.variants[0], options: { "test-axis": testId() }, active: false });
  invalid(duplicate, "variants[1].sku");
});

test("empaques libres con tipos únicos, nombres y precios válidos", () => {
  const input = validInput();
  const packaging = { type: testId(), name: testId(), price: 0 };
  input.packagingOptions = [packaging];
  assert.deepEqual(validateProductModel(input).packagingOptions, [packaging]);
  for (const [key, values] of [["type", [" ", 1]], ["name", [" ", 1]], ["price", [-1, 0.5, "0", NaN]]]) {
    for (const value of values) invalid({ ...input, packagingOptions: [{ ...packaging, [key]: value }] }, `packagingOptions[0].${key}`);
  }
  invalid({ ...input, packagingOptions: [packaging, { ...packaging }] }, "packagingOptions[1].type");
});

test("etiquetas y límites de personalización", () => {
  const input = validInput();
  for (const maxChars of [1, 500]) {
    const result = validateProductModel({ ...input, customization: { allowed: true, allowsText: true, maxChars } });
    assert.equal(result.customization.maxChars, maxChars);
  }
  for (const maxChars of [undefined, 0, 501, 1.5, "20"]) invalid({ ...input, customization: { allowsText: true, maxChars } }, "customization.maxChars");
  assert.equal(Object.hasOwn(validateProductModel({ ...input, customization: { allowsText: false, maxChars: 0 } }).customization, "maxChars"), false);
  invalid({ ...input, tags: Array(21).fill("test-aa") }, "tags");
  assert.equal(validateProductModel({ ...input, tags: Array(20).fill("test-aa") }).tags.length, 20);
  for (const tag of ["x", "x".repeat(31), 1]) invalid({ ...input, tags: [tag] }, "tags[0]");
  for (const length of [2, 30]) assert.equal(validateProductModel({ ...input, tags: ["X".repeat(length)] }).tags[0], "x".repeat(length));
});

test("categorías y políticas tienen IDs estables y campos tipados", () => {
  const category = categoryFixture();
  assert.equal(validateCategory({ name: testId() }, { existing: category }).id, category.id);
  assert.throws(() => validateCategory({ id: testId() }, { existing: category }), error => error.field === "id");
  for (const order of [-1, 1.5, "1", null]) assert.throws(() => validateCategory({ ...category, order }), error => error.field === "order");
  assert.throws(() => validateCategory({ ...category, active: 1 }), error => error.field === "active");
  assert.throws(() => validateCategory({ ...category, name: " " }), error => error.field === "name");
  const policy = { id: testId(), title: testId(), text: testId() };
  assert.deepEqual(validatePolicy({ text: `${policy.text}-updated`, updatedAt: "test-client" }, { existing: policy }), { ...policy, text: `${policy.text}-updated` });
  assert.throws(() => validatePolicy({ id: testId() }, { existing: policy }), error => error.field === "id");
  assert.throws(() => validatePolicy({ ...policy, text: " " }), error => error.field === "text");
});

test("categoría existente/activa y SKU global se consultan fuera de la caché", async () => {
  const input = validInput();
  const calls = [];
  const repository = {
    async getCategory(id) { calls.push(["category", id]); return { id, active: true }; },
    async findSlugConflict(slug, excludedId) { calls.push(["slug", slug, excludedId]); return null; },
    async findSkuConflict(sku, excludedId) { calls.push(["sku", sku, excludedId]); return null; },
  };
  const product = await validateProductForSave(input, { repository });
  assert.equal(product.skus[0], input.variants[0].sku);
  assert.deepEqual(calls, [["category", input.categoryId], ["slug", product.slug, undefined], ["sku", input.variants[0].sku, undefined]]);
  await assert.rejects(validateProductForSave(input, { repository: { ...repository, getCategory: async () => null } }), error => error.field === "categoryId");
  await assert.rejects(validateProductForSave(input, { repository: { ...repository, getCategory: async () => ({ active: false }) } }), error => error.field === "categoryId");
  await assert.rejects(validateProductForSave(input, { repository: { ...repository, findSkuConflict: async () => testId() } }), error => error.field === "variants[0].sku");
  await assert.rejects(validateProductForSave(input, { repository: { ...repository, findSlugConflict: async () => testId() } }), error => error.field === "slug");
});

test("slug único usa consulta indexada limitada y excluye el propio producto", async () => {
  const own = testId();
  const other = testId();
  const requested = testId();
  let records = [{ id: own }, { id: other }];
  const calls = [];
  const db = { collection(name) {
    assert.equal(name, "products");
    return { where(field, operator, value) {
      calls.push([field, operator, value]);
      return { limit(limit) {
        assert.equal(limit, 2);
        return { async get() { return { docs: records }; } };
      } };
    } };
  } };
  const repository = createCatalogRepository(db, { timestampNow: () => null });
  assert.equal(await repository.findSlugConflict(requested, own), other);
  records = [{ id: own }];
  assert.equal(await repository.findSlugConflict(requested, own), null);
  assert.deepEqual(calls, [["slug", "==", requested], ["slug", "==", requested]]);
});

test("SKU global usa consultas indexadas y limitadas, sin leer todos los productos", async () => {
  const own = testId();
  const other = testId();
  const sku = testId();
  const queries = [];
  const db = {
    collection(collection) {
      assert.equal(collection, "products");
      return {
        where(field, operator, value) {
          queries.push([field, operator, value]);
          return { limit(limit) {
            assert.equal(limit, 2);
            return { async get() { return { docs: field === "skus" ? [{ id: own }, { id: other }] : [] }; } };
          } };
        },
      };
    },
  };
  const repository = createCatalogRepository(db, { timestampNow: () => null });
  assert.equal(await repository.findSkuConflict(sku, own), other);
  assert.deepEqual(queries, [["skus", "array-contains", sku], ["sku", "==", sku]]);
});
