import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogService } from "../src/services/catalog.service.js";
import { createCatalogRepository } from "../src/services/catalog.repository.js";
import { newProductInput, testId } from "./helpers/catalog-fixtures.js";
import { openCatalogTestFirestore, createTestScope } from "./helpers/catalog-firestore.js";

test("integración Firestore: CRUD, referencias, SKU indexado e invalidación", async t => {
  const context = await openCatalogTestFirestore();
  const scope = createTestScope(context.db);
  const repository = createCatalogRepository(context.db, { timestampNow: () => context.Timestamp.now() });
  const service = createCatalogService({ repository });
  const categoryId = scope.id("category");
  const policyId = scope.id("policy");
  const productId = scope.id("product");
  const categoryRef = scope.track("categories", categoryId);
  const policyRef = scope.track("policies", policyId);
  const productRef = scope.track("products", productId);
  let product;
  try {
    await t.test("crea categoría, preserva ID y rechaza duplicados/campos inválidos", async () => {
      const category = await service.createCategory({ id: categoryId, name: scope.id("name"), order: 1 });
      assert.equal(category.active, true);
      assert.equal((await service.getCategory(categoryId)).id, categoryId);
      await assert.rejects(service.createCategory(category), error => error.status === 409);
      await assert.rejects(service.updateCategory(categoryId, { id: scope.id("changed-id") }), error => error.field === "id");
      await assert.rejects(service.updateCategory(categoryId, { order: "1" }), error => error.field === "order");
      const updated = await service.updateCategory(categoryId, { name: scope.id("updated-name"), order: 2 });
      assert.equal((await service.getCategory(categoryId)).name, updated.name);
      assert.equal((await categoryRef.get()).data().order, 2);
    });

    await t.test("validación produce skus; consultas detectan conflictos y excluyen el propio producto", async () => {
      const input = newProductInput(categoryId, { name: scope.id("product-name") });
      input.variants[0].sku = scope.id("sku");
      input.variants.push({ ...input.variants[0], sku: scope.id("inactive-sku"), options: { "test-axis": scope.id("second-option") }, active: false });
      let variantSequence = 0;
      const normalized = await service.validateProduct(input, { generateVariantId: () => scope.id(`variant-${++variantSequence}`) });
      product = { id: productId, ...normalized, createdAt: context.Timestamp.now(), updatedAt: context.Timestamp.now() };
      await productRef.set(product);
      assert.equal(await repository.findSkuConflict(product.skus[0]), productId);
      assert.equal(await repository.findSkuConflict(product.skus[1]), productId);
      assert.equal(await repository.findSkuConflict(product.skus[0], productId), null);
      assert.equal(await repository.findSlugConflict(product.slug), productId);
      assert.equal(await repository.findSlugConflict(product.slug, productId), null);
      await assert.rejects(service.validateProduct(input), error => error.field === "slug");
      await assert.rejects(service.validateProduct({ ...input, slug: scope.id("other-slug") }), error => error.field === "variants[0].sku");
      const edited = await service.validateProduct(product, { existingProduct: product });
      assert.deepEqual(edited.variants.map(variant => variant.id), product.variants.map(variant => variant.id));
      await assert.rejects(service.validateProduct({ ...product, variants: product.variants.slice(0, 1) }, { existingProduct: product }), error => error.field === "variants");
      const legacyId = scope.id("legacy-product");
      await scope.track("products", legacyId).set({ id: legacyId, sku: scope.id("legacy-sku"), active: false, name: scope.id("legacy-name") });
      assert.equal(await repository.findSkuConflict(scope.id("legacy-sku")), legacyId);
    });

    await t.test("bloquea desactivación con producto activo; luego desactiva y reactiva", async () => {
      await assert.rejects(service.deactivateCategory(categoryId), error => error.status === 409 && error.field === "active");
      await assert.rejects(service.deactivateCategory(` ${categoryId} `), error => error.status === 400 && error.field === "id");
      assert.equal((await categoryRef.get()).data().active, true);
      await productRef.update({ active: false });
      assert.equal(await repository.findSlugConflict(product.slug), productId);
      const disabled = await service.deactivateCategory(categoryId);
      assert.equal(disabled.active, false);
      assert.equal((await service.getCategories()).some(category => category.id === categoryId), false);
      assert.equal((await service.listCategories()).some(category => category.id === categoryId), true);
      await assert.rejects(service.validateProduct(newProductInput(categoryId)), error => error.field === "categoryId");
      await service.updateCategory(categoryId, { active: true });
      assert.equal((await service.getCategories()).some(category => category.id === categoryId), true);
      await assert.rejects(service.updateCategory(scope.id("missing"), { name: testId() }), error => error.status === 404);
    });

    await t.test("políticas usan timestamps del servidor y cada escritura invalida caché", async () => {
      const created = await service.createPolicy({ id: policyId, title: scope.id("title"), text: scope.id("text"), updatedAt: "test-client" });
      assert.equal(created.updatedAt instanceof context.Timestamp, true);
      const persisted = (await policyRef.get()).data();
      assert.equal(persisted.updatedAt.isEqual(created.updatedAt), true);
      assert.equal((await service.getPolicy(policyId)).text, created.text);
      const updated = await service.updatePolicy(policyId, { text: scope.id("updated-text"), updatedAt: 0 });
      assert.equal(updated.updatedAt instanceof context.Timestamp, true);
      assert.equal((await service.getPolicy(policyId)).text, updated.text);
      await assert.rejects(service.createPolicy({ id: policyId, title: testId(), text: testId() }), error => error.status === 409);
      await assert.rejects(service.updatePolicy(policyId, { id: scope.id("other-policy") }), error => error.field === "id");
      await service.deletePolicy(policyId);
      assert.equal(await service.getPolicy(policyId), null);
      assert.equal((await policyRef.get()).exists, false);
      await assert.rejects(service.deletePolicy(policyId), error => error.status === 404);
    });
  } finally {
    try { await scope.cleanup(); } finally { await context.close(); }
  }
});
