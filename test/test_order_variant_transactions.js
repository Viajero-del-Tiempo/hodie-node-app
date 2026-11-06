import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogRepository } from "../src/services/catalog.repository.js";
import { createCatalogService } from "../src/services/catalog.service.js";
import { createOrderStockService } from "../src/services/order-stock.service.js";
import { createTestScope, openCatalogTestFirestore } from "./helpers/catalog-firestore.js";

test("transacciones reales: estado y stock por variante bajo concurrencia", async t => {
  const context = await openCatalogTestFirestore();
  const { db, Timestamp } = context;
  const scope = createTestScope(db);
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY ||= scope.id("unused-llm-key");
    const { createUpdateAdminOrderStatus, getAdminOrderById } = await import("../src/controllers/admin.order.controller.js");
    const catalog = createCatalogService({ repository: createCatalogRepository(db, { timestampNow: () => Timestamp.now() }) });
    const stock = createOrderStockService({ db, catalog, timestampNow: () => Timestamp.now(), warn: () => {} });
    const categoryId = scope.id("category");
    await scope.track("categories", categoryId).set({ id: categoryId, name: "Categoría Alfa", active: true, order: 0 });
    const seed = async (suffix, quantity = 1, available = 1) => {
      const productId = scope.id(`${suffix}-product`);
      const variantId = scope.id(`${suffix}-variant`);
      const productRef = scope.track("products", productId);
      const variants = [
        { id: variantId, sku: scope.id(`${suffix}-sku`), active: true, options: { tono: "Ámbar" }, price: 7, stock: available, imageUrls: [] },
        { id: scope.id(`${suffix}-other-variant`), sku: scope.id(`${suffix}-other-sku`), active: true, options: { tono: "Azul" }, price: 11, stock: 5, imageUrls: [] },
      ];
      await productRef.set({ id: productId, schemaVersion: 2, name: "Producto Alfa", active: true, categoryId, optionNames: ["tono"], variants, stock: 900, skus: variants.map(variant => variant.sku), priceFrom: 7, attributes: { dato: "Alfa" }, packagingOptions: [], customization: { allowed: false, allowsText: false, allowsImage: false, notes: "" } });
      const orderId = scope.id(`${suffix}-order`);
      const orderRef = scope.track("orders", orderId);
      const items = [{ productId, variantId, quantity, price: 7, productName: "Producto Alfa", sku: variants[0].sku }];
      await orderRef.set({ id: orderId, orderNumber: orderId, status: "pending", items, total: 7 * quantity, createdAt: Timestamp.now(), whatsappChatId: `${scope.id(suffix)}@lid` });
      return { productId, variantId, productRef, orderId, orderRef, items, variants };
    };
    const state = async ref => (await ref.get()).data();

    await t.test("dos pedidos disputan la última unidad: uno confirma y el otro queda pendiente", async () => {
      const f = await seed("last-unit");
      const otherId = scope.id("last-unit-second-order");
      const otherRef = scope.track("orders", otherId);
      await otherRef.set({ status: "pending", items: f.items, total: 7 });
      const results = await Promise.allSettled([stock.transitionOrderStatus(f.orderId, "paid"), stock.transitionOrderStatus(otherId, "paid")]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const rejected = results.find(result => result.status === "rejected");
      assert.equal(rejected.reason.statusCode, 400);
      assert.equal((await state(f.productRef)).variants[0].stock, 0);
      assert.deepEqual([(await state(f.orderRef)).status, (await state(otherRef)).status].sort(), ["paid", "pending"]);
    });

    await t.test("doble pago y doble cancelación del mismo pedido mueven stock una vez", async () => {
      const f = await seed("same-order", 2, 5);
      const paid = await Promise.all([stock.transitionOrderStatus(f.orderId, "paid"), stock.transitionOrderStatus(f.orderId, "paid")]);
      assert.equal(paid.filter(result => result.changed).length, 1);
      assert.equal((await state(f.productRef)).variants[0].stock, 3);
      await stock.transitionOrderStatus(f.orderId, "preparing");
      assert.equal((await state(f.productRef)).variants[0].stock, 3);
      const cancelled = await Promise.all([stock.transitionOrderStatus(f.orderId, "cancelled"), stock.transitionOrderStatus(f.orderId, "cancelled")]);
      assert.equal(cancelled.filter(result => result.changed).length, 1);
      assert.equal((await state(f.productRef)).variants[0].stock, 5);
      await assert.rejects(stock.transitionOrderStatus(f.orderId, "paid"), error => error.statusCode === 400);
    });

    await t.test("dos variantes del mismo producto, sin actualizaciones perdidas", async () => {
      const f = await seed("two-variants", 2, 6);
      const otherId = scope.id("two-variants-other-order");
      const otherRef = scope.track("orders", otherId);
      await otherRef.set({ status: "pending", items: [{ ...f.items[0], variantId: f.variants[1].id, quantity: 3 }], total: 33 });
      await Promise.all([stock.transitionOrderStatus(f.orderId, "paid"), stock.transitionOrderStatus(otherId, "paid")]);
      const product = await state(f.productRef);
      assert.deepEqual(product.variants.map(variant => variant.stock), [4, 2]);
      assert.equal(product.stock, 900);
      assert.deepEqual(product.attributes, { dato: "Alfa" });
    });

    await t.test("líneas repetidas y fallos de referencias hacen rollback integral", async () => {
      const f = await seed("rollback", 1, 5);
      await f.orderRef.update({ items: [{ ...f.items[0], quantity: 3 }, { ...f.items[0], quantity: 3 }] });
      await assert.rejects(stock.transitionOrderStatus(f.orderId, "paid"), error => error.statusCode === 400);
      assert.equal((await state(f.orderRef)).status, "pending");
      assert.equal((await state(f.productRef)).variants[0].stock, 5);
      await f.orderRef.update({ items: [f.items[0], { ...f.items[0], variantId: scope.id("missing-variant") }] });
      await assert.rejects(stock.transitionOrderStatus(f.orderId, "paid"), error => error.statusCode === 400);
      await f.orderRef.update({ items: [f.items[0], { ...f.items[0], productId: scope.id("missing-product") }] });
      await assert.rejects(stock.transitionOrderStatus(f.orderId, "paid"), error => error.statusCode === 400);
      assert.equal((await state(f.productRef)).variants[0].stock, 5);
      assert.equal((await state(f.orderRef)).status, "pending");
    });

    await t.test("notifica después del commit, sin repetir; errores de WhatsApp no revierten", async () => {
      const f = await seed("notify", 1, 3);
      let notifications = 0;
      const observations = [];
      const update = createUpdateAdminOrderStatus({ stock, notify: async (recipient, status, total) => {
        notifications++;
        observations.push({ recipient, status, total, persistedStatus: (await state(f.orderRef)).status, persistedStock: (await state(f.productRef)).variants[0].stock });
      } });
      const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
      await Promise.all([update({ params: { id: f.orderId }, body: { status: "paid" } }, response()), update({ params: { id: f.orderId }, body: { status: "paid" } }, response())]);
      assert.equal(notifications, 1);
      assert.deepEqual(observations, [{ recipient: `${scope.id("notify")}@lid`, status: "paid", total: 7, persistedStatus: "paid", persistedStock: 2 }]);
      const failingNotifier = createUpdateAdminOrderStatus({ stock, notify: async () => { throw new Error("test-notify-failure"); } });
      const res = response();
      await failingNotifier({ params: { id: f.orderId }, body: { status: "cancelled" } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal((await state(f.orderRef)).status, "cancelled");
      assert.equal((await state(f.productRef)).variants[0].stock, 3);
    });

    await t.test("pedido viejo cambia de estado con aviso y mantiene stock raíz", async () => {
      const f = await seed("legacy", 1, 3);
      await f.orderRef.update({ items: [{ productId: f.productId, quantity: 2, price: 7 }, { productId: scope.id("legacy-deleted-product"), quantity: 1, price: 1 }] });
      const before = await state(f.productRef);
      const update = createUpdateAdminOrderStatus({ stock, notify: async () => {} });
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await update({ params: { id: f.orderId }, body: { status: "paid" } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.stockWarnings.length, 2);
      assert.ok(res.body.message.includes("Aviso"));
      await stock.transitionOrderStatus(f.orderId, "cancelled");
      assert.deepEqual(await state(f.productRef), before);
      await getAdminOrderById({ params: { id: f.orderId } }, res);
      assert.equal(res.body.order.stockWarnings.length, 2);
    });
  } finally {
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    try { await scope.cleanup(); } finally { await context.close(); }
  }
});
