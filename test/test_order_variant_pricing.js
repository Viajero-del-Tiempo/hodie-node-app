import test from "node:test";
import assert from "node:assert/strict";
import { createOrderPricingService, sanitizeOrderItemInput } from "../src/services/order-pricing.service.js";
import { pricingFixture } from "./helpers/order-fixtures.js";

const calculate = fixture => createOrderPricingService({ catalog: fixture.service });
const clientError = field => error => error.statusCode === 400 && error.field === field;

test("foto comercial autoritativa, precio por variante y empaque por unidad", async () => {
  const fixture = pricingFixture();
  fixture.product.price = 9999;
  fixture.product.priceFrom = 9999;
  const result = await calculate(fixture)([{
    ...fixture.item, packagingType: "test-pack", price: 1, productName: "Producto Falso",
    sku: "test-forged", productSku: "test-forged", variantLabel: "Falso", imageUrl: "test-forged",
    selectedPackaging: { type: "test-forged", name: "Falso", price: 1, imageUrl: "test-forged" },
    customization: "  texto  ", customizationImageUrl: "https://example.test/custom.png",
  }, { ...fixture.item, variantId: fixture.product.variants[1].id, quantity: 1 }]);
  const item = result.sanitizedItems[0];
  assert.equal(item.productName, fixture.product.name);
  assert.equal(item.variantId, fixture.product.variants[0].id);
  assert.equal(item.variantLabel, "Ámbar · Liso");
  assert.equal(item.sku, fixture.product.variants[0].sku);
  assert.equal(item.productSku, item.sku);
  assert.equal(item.price, 17);
  assert.equal(item.imageUrl, fixture.product.variants[0].imageUrls[0]);
  assert.deepEqual(item.selectedPackaging, fixture.product.packagingOptions[0]);
  assert.equal(item.customization, "texto");
  assert.equal(item.customizationPending, false);
  assert.equal(item.customizationImagePending, false);
  assert.equal(result.subtotal, 75);
  assert.equal(result.total, 75);
  assert.equal(result.shippingCost, 0);
  assert.equal(result.sanitizedItems[1].price, 31);
  assert.equal(result.sanitizedItems[1].selectedPackaging, null);
});

test("precios y stock frescos aunque el catálogo público esté cacheado; no reserva", async () => {
  const fixture = pricingFixture();
  await fixture.service.getProduct(fixture.product.id);
  fixture.product.variants[0].price = 23;
  fixture.product.variants[0].stock = 1;
  await assert.rejects(calculate(fixture)([fixture.item]), clientError("quantity"));
  fixture.product.variants[0].stock = 2;
  assert.equal((await calculate(fixture)([fixture.item])).total, 46);
  assert.equal(fixture.product.variants[0].stock, 2);
});

test("stock insuficiente suma líneas de la misma variante e identifica disponibles", async () => {
  const fixture = pricingFixture();
  await assert.rejects(calculate(fixture)([{ ...fixture.item, quantity: 5 }, { ...fixture.item, quantity: 4 }]), error => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.field, "quantity");
    assert.ok(error.message.includes(fixture.product.variants[0].sku));
    assert.ok(error.message.includes("Disponibles: 8 unidades"));
    assert.ok(error.message.includes("solicitadas: 9"));
    return true;
  });
  const result = await calculate(fixture)([{ ...fixture.item, quantity: 8 }, { ...fixture.item, variantId: fixture.product.variants[1].id, quantity: 4 }]);
  assert.equal(result.sanitizedItems.length, 2);
  fixture.product.variants[0].stock = 0;
  await assert.rejects(calculate(fixture)([fixture.item]), clientError("quantity"));
});

test("rechaza referencias, inactivos, cantidades y precios inválidos", async t => {
  for (const [name, mutate, itemChange, field] of [
    ["producto ausente", f => { f.data.products.length = 0; }, {}, "productId"],
    ["producto inactivo", f => { f.product.active = false; }, {}, "productId"],
    ["categoría inactiva", f => { f.category.active = false; }, {}, "categoryId"],
    ["categoría ausente", f => { f.data.categories.length = 0; }, {}, "categoryId"],
    ["variante ausente", () => {}, { variantId: "test-missing" }, "variantId"],
    ["variante inactiva", f => { f.product.variants[0].active = false; }, {}, "variantId"],
    ["sin variante", () => {}, { variantId: undefined }, "variantId"],
    ["precio fraccionario", f => { f.product.variants[0].price = 1.5; }, {}, "variants.price"],
    ["precio cero", f => { f.product.variants[0].price = 0; }, {}, "variants.price"],
    ["stock inválido", f => { f.product.variants[0].stock = -1; }, {}, "variants.stock"],
  ]) await t.test(name, async () => {
    const f = pricingFixture(); mutate(f);
    await assert.rejects(calculate(f)([{ ...f.item, ...itemChange }]), clientError(field));
  });
  for (const quantity of [0, -1, 101, 1.5, "2", true, null, undefined, NaN, Infinity]) {
    const f = pricingFixture();
    await assert.rejects(calculate(f)([{ ...f.item, quantity }]), clientError("quantity"));
  }
  const f = pricingFixture();
  for (const input of [[], null, [null], ["test"], [[f.item]]]) await assert.rejects(calculate(f)(input), clientError("items"));
});

test("empaques libres solo del producto, estándar gratuito y personalización configurada", async () => {
  const f = pricingFixture();
  await assert.rejects(calculate(f)([{ ...f.item, packagingType: "test-other" }]), clientError("packagingType"));
  await assert.rejects(calculate(f)([{ ...f.item, selectedPackaging: "test-pack" }]), clientError("packagingType"));
  f.product.packagingOptions[0].type = "test/free-type";
  assert.equal((await calculate(f)([{ ...f.item, packagingType: "test/free-type" }])).sanitizedItems[0].selectedPackaging.type, "test/free-type");
  await assert.rejects(calculate(f)([{ ...f.item, customization: "x".repeat(21) }]), clientError("customization"));
  await assert.rejects(calculate(f)([{ ...f.item, instructions: "x".repeat(501) }]), clientError("instructions"));
  const pending = (await calculate(f)([f.item])).sanitizedItems[0];
  assert.equal(pending.customizationPending, true);
  assert.equal(pending.customizationImagePending, true);
  f.product.customization.allowed = false;
  await assert.rejects(calculate(f)([{ ...f.item, customization: "texto" }]), clientError("customization"));
  await assert.rejects(calculate(f)([{ ...f.item, customizationImageUrl: "https://example.test/custom.png" }]), clientError("customizationImageUrl"));
  const plain = (await calculate(f)([f.item])).sanitizedItems[0];
  assert.equal(plain.customizationPending, false);
  assert.equal(plain.customizationImagePending, false);
});

test("compatibilidad temporal depende del modelo persistido, nunca del body", async () => {
  const f = pricingFixture();
  delete f.product.schemaVersion;
  f.product.price = 11;
  f.product.sku = "test-legacy-sku";
  f.product.packagingPrices = { "test-legacy-pack": 3 };
  f.product.packagingImages = { "test-legacy-pack": "https://example.test/legacy-pack.png" };
  const legacy = { productId: f.product.id, quantity: "2", schemaVersion: 2, selectedPackaging: { name: "test-legacy-pack decorativo", price: 999 } };
  const result = await calculate(f)([legacy]);
  assert.equal(result.total, 28);
  assert.equal(result.sanitizedItems[0].variantId, undefined);
  assert.equal(result.sanitizedItems[0].selectedPackaging.name, "test-legacy-pack");
  await assert.rejects(calculate(f)([f.item]), clientError("variantId"));
  f.product.schemaVersion = 2;
  await assert.rejects(calculate(f)([{ productId: f.product.id, quantity: 1, schemaVersion: 1 }]), clientError("variantId"));
});

test("whitelist conserva referencias nuevas e ignora campos comerciales", () => {
  const f = pricingFixture();
  const item = sanitizeOrderItemInput({ ...f.item, packagingType: "test-pack", price: 999, sku: "Falso", productName: "Falso", instructions: "texto" });
  assert.equal(item.variantId, f.item.variantId);
  assert.equal(item.packagingType, "test-pack");
  assert.equal(item.customization, "texto");
  for (const key of ["price", "sku", "productName"]) assert.equal(Object.hasOwn(item, key), false);
});
