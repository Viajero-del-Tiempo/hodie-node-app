import test from "node:test";
import assert from "node:assert/strict";
import { validateProductModel } from "../src/validators/catalog.validator.js";
import { createProductController } from "../src/controllers/admin.product.controller.js";
import { createOrderPricingService } from "../src/services/order-pricing.service.js";
import { categoryFixture, memoryCatalog, newProductInput } from "./helpers/catalog-fixtures.js";

const input = categoryId => newProductInput(categoryId, { name: "Producto Alfa", slug: "producto-alfa", packagingOptions: [
  { type: "libre-a", name: "Empaque Alfa", price: 7, imageUrl: "https://example.test/a.png" },
  { type: "libre-b", name: "Empaque Beta", price: 0 },
] });
test("foto de producto con empaque se conserva en modelo, detalle público y snapshot de pricing", async () => {
  const category = categoryFixture(), model = { id: "test-product", ...validateProductModel(input(category.id)) };
  const { service } = memoryCatalog({ categories: [category], products: [model] });
  const product = await service.getProduct(model.id), bySlug = await service.getProductBySlug(model.slug);
  assert.deepEqual(product.packagingOptions, model.packagingOptions); assert.deepEqual(bySlug.packagingOptions, model.packagingOptions);
  const before = structuredClone(model);
  const pricing = await createOrderPricingService({ catalog: service })([{ productId: model.id, variantId: model.variants[0].id,
    quantity: 1, packagingType: "libre-a", selectedPackaging: { imageUrl: "https://example.test/forged.png", price: 999 } }]);
  assert.deepEqual(pricing.sanitizedItems[0].selectedPackaging, model.packagingOptions[0]);
  assert.deepEqual(model, before);
  product.packagingOptions[0].imageUrl = "https://example.test/changed.png";
  assert.equal((await service.getProduct(model.id)).packagingOptions[0].imageUrl, "https://example.test/a.png");
});
test("imagen de empaque opcional, reemplazable y removible; acepta URL HTTP/HTTPS y ruta del mismo origen", () => {
  for (const url of ["", "https://example.test/new.png", "http://localhost:3000/local-images/a.png", "/local-images/a.png"] ) {
    const value = input("test-category"); value.packagingOptions[1].imageUrl = url;
    assert.equal(validateProductModel(value).packagingOptions[1].imageUrl, url);
  }
  const value = input("test-category"); value.packagingOptions[1].imageUrl = "  https://example.test/new.png  ";
  assert.equal(validateProductModel(value).packagingOptions[1].imageUrl, value.packagingOptions[1].imageUrl.trim());
  delete value.packagingOptions[1].imageUrl;
  assert.equal(Object.hasOwn(validateProductModel(value).packagingOptions[1], "imageUrl"), false);
});
test("URLs de empaque inválidas se rechazan con el camino exacto, sin cambiar el borrador", async () => {
  for (const url of [null, 7, [], "javascript:alert(1)", "data:image/svg+xml,test", "file:///tmp/a.png", "ftp://example.test/a.png",
    "//example.test/a.png", "https://user:secret@example.test/a.png", "/path\\a.png", "no-url", "https://example.test/a b.png"]) {
    const value = input("test-category"); value.packagingOptions[1].imageUrl = url; const before = structuredClone(value);
    assert.throws(() => validateProductModel(value), error => error.status === 400 && error.field === "packagingOptions[1].imageUrl");
    const controller = createProductController({ createProduct: async body => validateProductModel(body) });
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.create({ body: value }, res); assert.equal(res.statusCode, 400); assert.equal(res.body.field, "packagingOptions[1].imageUrl");
    assert.deepEqual(value, before);
  }
});
