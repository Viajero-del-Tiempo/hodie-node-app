import test from "node:test";
import assert from "node:assert/strict";
import { createTestScope, openCatalogTestFirestore } from "./helpers/catalog-firestore.js";

test("pedidos persistidos y API con precios por variante y fotos inmutables", async t => {
  const context = await openCatalogTestFirestore();
  const { db, Timestamp } = context;
  const scope = createTestScope(db);
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalJwtSecret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.GEMINI_API_KEY ||= scope.id("unused-llm-key");
    process.env.JWT_SECRET ||= scope.id("jwt-secret");
    const [{ processAndSendOrder, persistOrderSnapshot }, { createSendOrderController }, { default: express }, { default: jwt }, { requireAuth, loadActiveUser }, { JWT_SECRET }] = await Promise.all([
      import("../src/services/order.service.js"), import("../src/controllers/order.controller.js"),
      import("express"), import("jsonwebtoken"), import("../src/middlewares/auth.middleware.js"), import("../src/config/jwt.js"),
    ]);
    const categoryId = scope.id("category");
    await scope.track("categories", categoryId).set({ id: categoryId, name: "Categoría Alfa", active: true, order: 0 });
    const productId = scope.id("product");
    const variantId = scope.id("variant");
    const sku = scope.id("sku");
    const productRef = scope.track("products", productId);
    const variant = { id: variantId, sku, price: 19, stock: 5, active: true, options: { tono: "Azul" }, imageUrls: ["https://example.test/product.png"] };
    const packaging = { type: "test-pack", name: "Empaque Alfa", price: 3, imageUrl: "https://example.test/pack.png" };
    await productRef.set({ id: productId, schemaVersion: 2, name: "Producto Alfa", active: true, categoryId, optionNames: ["tono"], variants: [variant], packagingOptions: [packaging], customization: { allowed: true, allowsText: true, maxChars: 30, allowsImage: false } });
    const userId = scope.id("user");
    const phone = scope.id("phone");
    await scope.track("users", userId).set({ uid: userId, phoneNumber: phone, displayName: "Cliente Alfa", active: true, role: "customer", whatsappChatId: `${scope.id("chat")}@lid` });
    const token = jwt.sign({ phone }, JWT_SECRET, { expiresIn: "1h" });
    const payload = {
      userId, userPhoneNumber: phone, userDisplayName: "Cliente Alfa",
      items: [{ productId, variantId, quantity: 2, packagingType: "test-pack", customization: "texto" }],
      shippingAddress: { street: "Calle de prueba", city: "Ciudad de prueba" },
    };
    // Doble de la entrega externa; no genera archivos ni envía mensajes reales.
    const delivery = { generatePdf: async () => null, sendPdf: async () => true };
    let sequence = 0;
    let cleanPayload;
    const checkout = createSendOrderController({ processOrder: async input => {
      cleanPayload = input;
      const id = scope.id(`api-order-${++sequence}`);
      scope.track("orders", id); // Registro antes de persistir, incluso si falla el test.
      // Los IDs/números los asigna este doble de servidor, nunca el body HTTP.
      return processAndSendOrder({ ...input, id, orderNumber: id }, delivery);
    }, notifyStatus: async () => {} });
    const app = express();
    app.use(express.json());
    app.post("/orders/order/send", requireAuth, loadActiveUser, checkout);
    server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      listening.once("error", reject);
    });
    const url = `http://127.0.0.1:${server.address().port}/orders/order/send`;
    const request = async body => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };

    await t.test("HTTP conserva referencias nuevas, ignora identidad/precios/estado del body", async () => {
      const result = await request({
        ...payload, id: scope.id("forged-id"), orderNumber: "test-forged", userId: "test-forged", status: "paid", subtotal: 1, total: 1, shippingCost: 1, createdAt: "2020-01-01",
        items: [{ ...payload.items[0], price: 1, productName: "Falso", variantLabel: "Falso", sku: "test-forged", selectedPackaging: { name: "Falso", price: 9999, imageUrl: "test-forged" } }],
      });
      assert.equal(result.status, 200);
      const saved = (await db.collection("orders").doc(result.body.orderId).get()).data();
      assert.equal(cleanPayload.id, undefined);
      assert.equal(saved.userId, userId);
      assert.equal(saved.status, "pending");
      assert.equal(saved.items[0].variantId, variantId);
      assert.equal(saved.items[0].sku, sku);
      assert.equal(saved.items[0].productName, "Producto Alfa");
      assert.equal(saved.items[0].variantLabel, "Azul");
      assert.equal(saved.items[0].price, 19);
      assert.deepEqual(saved.items[0].selectedPackaging, packaging);
      assert.equal(saved.total, 44);
      assert.equal(saved.shippingCost, 0);
      assert.ok(saved.createdAt instanceof Timestamp);
      assert.equal(saved.pdfDelivered, true);
      assert.equal((await productRef.get()).data().variants[0].stock, 5);
    });

    await t.test("stock acumulado insuficiente devuelve 400 y no guarda pedido", async () => {
      const result = await request({ ...payload, items: [{ ...payload.items[0], quantity: 3 }, { ...payload.items[0], quantity: 3 }] });
      assert.equal(result.status, 400);
      assert.ok(result.body.error.includes(sku));
      assert.ok(result.body.error.includes("Disponibles: 5 unidades"));
      assert.equal((await db.collection("orders").doc(scope.id(`api-order-${sequence}`)).get()).exists, false);
    });

    await t.test("variante inactiva, cantidades y empaque ajeno devuelven 400", async () => {
      for (const items of [[{ ...payload.items[0], quantity: "2" }], [{ ...payload.items[0], variantId: undefined }], [{ ...payload.items[0], packagingType: "test-other-pack" }], [null]]) {
        assert.equal((await request({ ...payload, items })).status, 400);
      }
      await productRef.update({ variants: [{ ...variant, active: false }] });
      assert.equal((await request(payload)).status, 400);
      await productRef.update({ variants: [variant] });
    });

    await t.test("reprocesamiento y colisión de ID conservan foto, estado y createdAt", async () => {
      const id = scope.id("snapshot-order");
      const ref = scope.track("orders", id);
      await Promise.all([
        persistOrderSnapshot({ ...payload, id, orderNumber: id }),
        persistOrderSnapshot({ ...payload, id, orderNumber: id }),
      ]);
      await ref.update({ status: "paid" });
      const before = (await ref.get()).data();
      await productRef.update({ name: "Producto Beta", variants: [{ ...variant, price: 71, stock: 0, active: false, sku: scope.id("changed-sku") }], packagingOptions: [{ ...packaging, name: "Empaque Beta", price: 29 }] });
      const result = await processAndSendOrder({ ...payload, id, orderNumber: "test-forged", status: "pending", items: [{ ...payload.items[0], quantity: 4 }], createdAt: "2020-01-01" }, delivery);
      const after = (await ref.get()).data();
      assert.deepEqual(after.items, before.items);
      for (const key of ["subtotal", "total", "shippingCost", "shippingMethod", "orderNumber", "status"]) assert.equal(after[key], before[key]);
      assert.equal(after.createdAt.toMillis(), before.createdAt.toMillis());
      assert.equal(result.total, before.total);
      assert.equal(result.orderNumber, before.orderNumber);
    });
  } finally {
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalJwtSecret;
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      try { await scope.cleanup(); } finally { await context.close(); }
    }
  }
});
