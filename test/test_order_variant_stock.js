import test from "node:test";
import assert from "node:assert/strict";
import { createOrderStockService, getStockWarnings } from "../src/services/order-stock.service.js";
import { pricingFixture, memoryOrderStore } from "./helpers/order-fixtures.js";
import { testId } from "./helpers/catalog-fixtures.js";

function fixture() {
  const pricing = pricingFixture();
  pricing.product.stock = 500; // Debe quedar intacto, aunque esté presente.
  const order = { id: testId(), status: "pending", items: [pricing.item], total: 34 };
  const store = memoryOrderStore([pricing.product], [order]);
  const warnings = [];
  const service = createOrderStockService({ ...store, timestampNow: () => 123, warn: message => warnings.push(message) });
  const product = () => store.documents.get(`products/${pricing.product.id}`);
  return { ...pricing, ...store, order, product, warnings, service };
}

test("agrupa líneas por producto y variante sin perder otras variantes/campos", async () => {
  const f = fixture();
  const before = structuredClone(f.product());
  const lines = [f.item, { ...f.item, quantity: 3 }, { ...f.item, variantId: before.variants[1].id, quantity: 1 }];
  await f.service.deductStockInTransaction(lines);
  assert.equal(f.product().variants[0].stock, 3);
  assert.equal(f.product().variants[1].stock, 3);
  assert.equal(f.product().stock, 500);
  assert.equal(f.reads.filter(path => path.startsWith("products/")).length, 1);
  assert.deepEqual(f.product().variants.map(({ stock, ...variant }) => variant), before.variants.map(({ stock, ...variant }) => variant));
  assert.equal(f.invalidations(), 1);
  f.product().active = false;
  f.product().variants[0].active = false;
  await f.service.restoreStockInTransaction(lines);
  assert.equal(f.product().variants[0].stock, 8);
  assert.equal(f.product().variants[1].stock, 4);
  assert.equal(f.invalidations(), 2);
});

test("pedidos viejos no consultan productos; avisos también en pedidos mixtos", async () => {
  const f = fixture();
  const legacy = [{ productId: "test-missing-legacy", quantity: 50 }];
  const result = await f.service.deductStockInTransaction(legacy);
  assert.equal(f.reads.length, 0);
  assert.equal(f.invalidations(), 0);
  assert.equal(result.stockWarnings[0].code, "LEGACY_ITEM_WITHOUT_VARIANT");
  assert.equal(f.warnings.length, 1);
  await f.service.restoreStockInTransaction(legacy);
  assert.equal(f.reads.length, 0);
  const mixed = await f.service.deductStockInTransaction([...legacy, f.item]);
  assert.equal(mixed.stockWarnings.length, 1);
  assert.equal(f.product().variants[0].stock, 6);
  assert.deepEqual(getStockWarnings(legacy), result.stockWarnings);
});

test("fallos revierten todo, no invalidan, no aceptan fallback al stock raíz", async t => {
  for (const [name, mutate, lines] of [
    ["insuficiente por líneas repetidas", () => {}, f => [{ ...f.item, quantity: 5 }, { ...f.item, quantity: 4 }]],
    ["variante desaparecida", () => {}, f => [f.item, { ...f.item, variantId: "test-missing" }]],
    ["producto ausente", () => {}, f => [f.item, { ...f.item, productId: "test-missing" }]],
    ["variante inactiva", f => { f.product().variants[0].active = false; }, f => [f.item]],
    ["producto inactivo", f => { f.product().active = false; }, f => [f.item]],
    ["modelo viejo con variante", f => { delete f.product().schemaVersion; }, f => [f.item]],
    ["cantidad inválida", () => {}, f => [{ ...f.item, quantity: "2" }]],
    ["stock inválido", f => { f.product().variants[0].stock = -1; }, f => [f.item]],
  ]) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    const before = structuredClone([...f.documents]);
    await assert.rejects(f.service.deductStockInTransaction(lines(f)), error => error.statusCode === 400);
    assert.deepEqual([...f.documents], before);
    assert.equal(f.invalidations(), 0);
  });
  const f = fixture();
  await assert.rejects(f.service.restoreStockInTransaction([{ ...f.item, variantId: "test-missing" }]), error => error.statusCode === 400);
});

test("estado y stock atómicos; transiciones repetidas son idempotentes", async () => {
  const f = fixture();
  const readOrder = () => f.documents.get(`orders/${f.order.id}`);
  await f.service.transitionOrderStatus(f.order.id, "paid");
  assert.equal(readOrder().status, "paid");
  assert.equal(f.product().variants[0].stock, 6);
  assert.equal((await f.service.transitionOrderStatus(f.order.id, "paid")).changed, false);
  await f.service.transitionOrderStatus(f.order.id, "preparing");
  assert.equal(f.product().variants[0].stock, 6);
  await f.service.transitionOrderStatus(f.order.id, "pending");
  assert.equal(f.product().variants[0].stock, 8);
  await f.service.transitionOrderStatus(f.order.id, "shipped");
  assert.equal(f.product().variants[0].stock, 6);
  await f.service.transitionOrderStatus(f.order.id, "cancelled");
  assert.equal(f.product().variants[0].stock, 8);
  assert.equal((await f.service.transitionOrderStatus(f.order.id, "cancelled")).changed, false);
  await assert.rejects(f.service.transitionOrderStatus(f.order.id, "paid"), error => error.statusCode === 400);
  await assert.rejects(f.service.transitionOrderStatus(f.order.id, "test-status"), error => error.statusCode === 400);
  await assert.rejects(f.service.transitionOrderStatus("test-missing", "paid"), error => error.statusCode === 404);
});

test("transacción inyectada no anida ni invalida antes del commit", async () => {
  const f = fixture();
  await f.db.runTransaction(async transaction => {
    const result = await f.service.deductStockInTransaction([f.item], transaction);
    assert.equal(result.stockChanged, true);
    assert.equal(f.product().variants[0].stock, 8);
    assert.equal(f.invalidations(), 0);
  });
  assert.equal(f.product().variants[0].stock, 6);
});

test("un fallo de stock deja pendiente el pedido y preserva su foto", async () => {
  const f = fixture();
  f.product().variants[0].stock = 1;
  const before = structuredClone([...f.documents]);
  await assert.rejects(f.service.transitionOrderStatus(f.order.id, "paid"), error => error.statusCode === 400);
  assert.deepEqual([...f.documents], before);
});
