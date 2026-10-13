import test from "node:test";
import assert from "node:assert/strict";
import { assertLocalEnvironment } from "../scripts/local-catalog.config.js";
import { openCustomerTestApi } from "./helpers/customer-firestore.js";
import { evalFixtures } from "./helpers/eval-fixtures.js";
import { EVAL_BANK_CONFIG } from "./eval/memory-world.js";
import { createOrderConfirmationRepository } from "../src/services/order-confirmation.repository.js";
import { createOrderConfirmationService } from "../src/services/order-confirmation.service.js";
import { createOrderPricingService } from "../src/services/order-pricing.service.js";
import { evaluateCartPricing, ORDER_CONFIRMATION_QUESTION } from "../src/services/order-quote.service.js";
import { inspectPurchaseData } from "../src/services/purchase-data.service.js";
import { inspectCartProgress } from "../src/agents/consultation/cart-progress.js";
import { acceptsOrderConfirmation } from "../src/agents/consultation/confirmations.js";
import { createOrderConfirmationConfig } from "../src/agents/consultation/order-confirmation.config.js";
import { normalizePurchasePhone } from "../src/agents/consultation/order-access.js";
import { renderQuoteSummary } from "../src/agents/consultation/quote-summary.js";
import { createOrderPdfJobService } from "../src/services/order-pdf-job.service.js";
import { createOrderPersistence } from "../src/services/order-persistence.service.js";
import { shippingFixture } from "./helpers/customer-fixtures.js";

// Guardia obligatoria aun cuando ALLOW_PROD_FIRESTORE_TESTS=1. Antes del SDK.
assertLocalEnvironment(process.env);

test("4B: transacciones reales, concurrencia, rollback, recuperación y contrato de lectura web/WhatsApp", async t => {
  const api = await openCustomerTestApi({ includeAdminOrders: true });
  const { db, Timestamp, scope } = api;
  let sequence = 0;
  const phone = "5959" + String(Math.floor(Math.random() * 100000000)).padStart(8, "0");
  try {
  const customer = await api.createUser("agent-customer", { phoneNumber: phone });
  const admin = await api.createUser("agent-admin", { role: "admin" });
  const data = evalFixtures().products[0];
  const productId = scope.id("product"), categoryId = scope.id("category");
  const product = { ...data, id: productId, schemaVersion: 2, active: true, categoryId,
    variants: data.variants.map(variant => ({ ...variant, active: true })), skus: data.variants.map(variant => variant.sku) };
  const productRef = scope.track("products", productId);
  const config = createOrderConfirmationConfig({});
  const catalog = {
    async getProductForPricing(id) { const doc = await db.collection("products").doc(id).get(); return doc.exists ? { id, ...doc.data() } : null; },
    async getCategoryForPricing(id) { const doc = await db.collection("categories").doc(id).get(); return doc.exists ? { id, ...doc.data() } : null; },
  };
  async function scenario(suffix, { counterId = scope.id("counter-" + suffix) } = {}) {
    const chatId = scope.id("chat-" + suffix), quoteId = scope.id("quote-" + suffix);
    const cart = { id: scope.id("cart-" + suffix), revision: 0, updatedAt: Date.now(), expiresAt: Date.now() + 86400000,
      lines: [{ id: scope.id("line-" + suffix), productId, variantId: "variant-a", quantity: 1,
        packagingType: null, packaging: { declined: true }, customization: { text: "Texto Alfa", textDraft: null, imageUrl: null, declined: false, pending: false } }],
      shipping: { ...shippingFixture(), phone: phone },
      billing: { invoiceRequested: false, legalName: null, ruc: null, rucValidation: null } };
    await scope.track("carts", chatId).create(cart);
    scope.track("counters", counterId); scope.track("order_confirmations", chatId);
    const { quote } = await evaluateCartPricing(cart, { catalog,
      calculatePricing: createOrderPricingService({ catalog, structuredErrors: true, includeLineSubtotals: true }),
      inspectData: value => inspectCartProgress(value, { catalog,
        inspectData: value => inspectPurchaseData(value, { verifiedPhone: phone, normalizePhone: normalizePurchasePhone }) }),
      renderSummary: renderQuoteSummary });
    assert.equal(quote.confirmable, true);
    await scope.track("order_quotes", quoteId).create({ ...quote, quoteId, chatId, issuedAt: Date.now() });
    const repository = createOrderConfirmationRepository({ db, now: Date.now, timestampNow: () => Timestamp.now(), counterId,
      generateOrderId: () => {
        const id = scope.id("order-" + ++sequence); scope.track("orders", id); scope.track("order_pdf_jobs", id);
        for (const code of ["PDF_DELIVERY_UNCERTAIN", "ORDER_RECEIPT_UNCERTAIN", "PDF_DELIVERY_FAILED", "PDF_DELIVERY_STATE_UNCERTAIN", "PDF_JOB_FAILED"]) scope.track("order_alerts", id + "-" + code);
        return id;
      } });
    const pending = { quoteId, cartId: cart.id, cartFingerprint: quote.cartFingerprint, pricingFingerprint: quote.pricingFingerprint,
      shownAt: Date.now(), shownSequence: 0, shownBatchId: "shown-" + suffix };
    await repository.saveConfirmation(chatId, pending);
    const state = { user: customer, pushname: customer.displayName, phoneVerified: true,
      userPhoneNumber: "+" + phone.slice(0, 3) + " (" + phone.slice(3, 6) + ") " + phone.slice(6, 9) + "-" + phone.slice(9),
      lastQuote: { quoteId }, pendingOrderConfirmation: pending };
    function service(port = repository) {
      let localState = structuredClone(state);
      return createOrderConfirmationService({ repository: port, chatId, now: Date.now,
        getTurn: () => ({ id: "confirm-" + suffix, sequence: 1, messages: [{ type: "text", text: "Sí, confirmo, gracias!" }] }),
        getState: () => structuredClone(localState), setState: value => { localState = structuredClone(value); },
        normalizePhone: normalizePurchasePhone, acceptsConfirmation: (pending, turn) => acceptsOrderConfirmation(pending, turn, config),
        inspectProgress: inspectCartProgress, renderSummary: renderQuoteSummary, bankConfig: EVAL_BANK_CONFIG });
    }
    return { repository, service, quoteId, chatId, counterId, quote, cart };
  }
    await scope.track("categories", categoryId).create({ id: categoryId, name: "Categoría Alfa", active: true, order: 1 });
    await productRef.create(product);
    await t.test("mismo quoteId concurrente desde instancias independientes: un pedido y un incremento", async () => {
      const s = await scenario("same");
      const results = await Promise.all(Array.from({ length: 5 }, () => s.service().create(s.quoteId)));
      assert.equal(new Set(results.map(result => result.orderId)).size, 1);
      assert.equal(results.filter(result => result.created).length, 1);
      assert.equal((await db.collection("counters").doc(s.counterId).get()).data().lastOrderNumber, 1);
      assert.equal((await db.collection("carts").doc(s.chatId).get()).exists, false);
      assert.equal((await productRef.get()).data().variants[0].stock, product.variants[0].stock);
      assert.equal((await s.repository.getJob(results[0].orderId)).status, "pending");
    });
    await t.test("cotizaciones distintas comparten contador y tienen números únicos", async () => {
      const counterId = scope.id("counter-shared");
      const scenarios = await Promise.all(["a", "b", "c"].map(suffix => scenario("distinct-" + suffix, { counterId })));
      const results = await Promise.all(scenarios.map(s => s.service().create(s.quoteId)));
      assert.equal(new Set(results.map(result => result.orderNumber)).size, 3);
      assert.equal((await db.collection("counters").doc(counterId).get()).data().lastOrderNumber, 3);
    });
    await t.test("numeración web y nueva transacción compiten por el mismo contador sin duplicarlo", async () => {
      const s = await scenario("web-counter");
      const legacy = createOrderPersistence({ db, timestampNow: () => Timestamp.now(), counterId: s.counterId,
        calculatePricing: createOrderPricingService({ catalog }) });
      const [webNumber, agentOrder] = await Promise.all([legacy.generateUniqueOrderNumber(), s.service().create(s.quoteId)]);
      assert.notEqual(webNumber, agentOrder.orderNumber);
      assert.equal((await db.collection("counters").doc(s.counterId).get()).data().lastOrderNumber, 2);
    });
    await t.test("fallo después de encolar escrituras hace rollback completo de Firestore", async () => {
      const s = await scenario("rollback");
      const port = { ...s.repository, transact: action => s.repository.transact(async tx => {
        await action(tx); throw new Error("Rollback inyectado");
      }) };
      await assert.rejects(s.service(port).create(s.quoteId), /Rollback inyectado/u);
      const discardedId = scope.id("order-" + sequence);
      assert.equal((await db.collection("orders").doc(discardedId).get()).exists, false);
      assert.equal((await db.collection("order_pdf_jobs").doc(discardedId).get()).exists, false);
      assert.equal((await db.collection("order_confirmations").doc(s.chatId).get()).exists, true);
      assert.equal((await db.collection("carts").doc(s.chatId).get()).exists, true);
      assert.equal((await db.collection("counters").doc(s.counterId).get()).exists, false);
      assert.equal((await db.collection("order_quotes").doc(s.quoteId).get()).data().orderId, undefined);
      const created = await s.service().create(s.quoteId);
      assert.equal(created.created, true); assert.equal((await db.collection("counters").doc(s.counterId).get()).data().lastOrderNumber, 1);
    });
    await t.test("precio/stock fresco rechaza sin escribir contador ni borrar carrito", async () => {
      for (const kind of ["price", "stock"]) {
        const s = await scenario("fresh-" + kind);
        const changed = structuredClone(product.variants); changed[0][kind] = kind === "price" ? 101 : 0;
        await productRef.update({ variants: changed });
        await assert.rejects(s.service().create(s.quoteId), error => error.code === (kind === "price" ? "PRECIO_CAMBIO" : "SIN_STOCK"));
        assert.equal((await db.collection("counters").doc(s.counterId).get()).exists, false);
        assert.equal((await db.collection("carts").doc(s.chatId).get()).exists, true);
        await productRef.update({ variants: product.variants });
      }
    });
    await t.test("WhatsApp verificado y web son legibles por admin y Mis pedidos con el mismo teléfono canónico", async () => {
      const s = await scenario("reading"); const whatsapp = await s.service().create(s.quoteId);
      const web = await api.request("/orders/order/send", { phone, method: "POST", body: {
        items: [{ productId, variantId: "variant-a", quantity: 1, packagingType: null, customization: "Texto Alfa" }],
        shippingAddress: shippingFixture(), billing: { invoiceRequested: false }, saveShippingAddress: false,
      } });
      assert.equal(web.status, 200); const webId = web.body.orderId;
      const adminWa = await api.request("/admin/orders/" + whatsapp.orderId, { phone: admin.phoneNumber });
      const adminWeb = await api.request("/admin/orders/" + webId, { phone: admin.phoneNumber });
      assert.equal(adminWa.status, 200); assert.equal(adminWeb.status, 200);
      for (const field of ["items", "subtotal", "shippingCost", "total", "shippingAddress", "billing", "shippingMethod", "userPhoneNumber", "userId"])
        assert.deepEqual(adminWa.body.order[field], adminWeb.body.order[field], field);
      assert.equal(adminWa.body.order.userPhoneNumber, phone);
      assert.deepEqual(adminWa.body.order.phoneVerification, { verified: true, source: "whatsapp_resolved" });
      assert.deepEqual(adminWeb.body.order.phoneVerification, { verified: true, source: "web_session" });
      const list = await api.request("/users/me/orders", { phone });
      assert.equal(list.status, 200);
      assert.ok(list.body.orders.some(order => order.id === whatsapp.orderId)); assert.ok(list.body.orders.some(order => order.id === webId));
      const ownWa = await api.request("/users/me/orders/" + whatsapp.orderId, { phone });
      const ownWeb = await api.request("/users/me/orders/" + webId, { phone });
      assert.equal(ownWa.status, 200); assert.equal(ownWeb.status, 200);
      for (const field of ["items", "subtotal", "total", "shippingAddress", "billing", "shippingMethod", "status"])
        assert.deepEqual(ownWa.body.order[field], ownWeb.body.order[field], field);
      assert.equal(ownWa.body.order.userPhoneNumber, undefined);
      const other = await api.createUser("outsider");
      assert.equal((await api.request("/users/me/orders/" + whatsapp.orderId, { phone: other.phoneNumber })).status, 404);
    });
    await t.test("trabajo abandonado antes de enviar se recupera; envío incierto registra alerta sin reenviar", async () => {
      for (const phase of ["rendering", "sending"]) {
        const s = await scenario("pdf-" + phase), result = await s.service().create(s.quoteId);
        await s.repository.updateJob(result.orderId, { status: "running", phase, receiptDelivered: true, leaseToken: "abandoned", leaseUntil: Date.now() - 1 });
        let sent = 0;
        const worker = createOrderPdfJobService({ repository: s.repository, generatePdf: async () => null,
          transport: { sendText: async () => { throw new Error("No debe repetir el mensaje"); }, sendPdf: async () => { sent++; return true; } } });
        await worker.run(result.orderId);
        assert.equal(sent, phase === "rendering" ? 1 : 0);
        assert.equal((await s.repository.getOrder(result.orderId)).pdfDelivered, phase === "rendering");
        if (phase === "sending") {
          const alert = await db.collection("order_alerts").doc(result.orderId + "-PDF_DELIVERY_UNCERTAIN").get();
          assert.equal(alert.exists, true); assert.equal(alert.data().delivered, false);
        }
      }
    });
    assert.equal(ORDER_CONFIRMATION_QUESTION, "¿Confirmás este pedido?");
  } finally { await api.close(); }
});
