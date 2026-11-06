import test from "node:test";
import assert from "node:assert/strict";
import { createOrderPersistence } from "../src/services/order-persistence.service.js";
import { createOrderProcessor } from "../src/services/order-processing.service.js";
import { getShippingOptions, validateShippingAddress } from "../src/services/shipping.service.js";
import { canReadCustomerOrder, resolveOrderIdentity } from "../src/services/order-identity.service.js";
import { customerOrderDto } from "../src/services/customer-order.service.js";
import { createOrderPricingService } from "../src/services/order-pricing.service.js";
import { pricingFixture } from "./helpers/order-fixtures.js";
import { memoryCustomerStore, shippingFixture, billingFixture } from "./helpers/customer-fixtures.js";

test("tipo de envío usa regla existente y cédula condicional", () => {
  for (const city of ["Minga Guazú", "  MINGA   GUAZU  ", "Minga Guazú km 20"]) {
    assert.equal(getShippingOptions(city).shippingMethod, "local_gratis");
    assert.equal(getShippingOptions(city).requiresRecipientDocument, false);
    assert.equal(validateShippingAddress(shippingFixture({ city })).recipientDocument, undefined);
  }
  assert.equal(getShippingOptions("Ciudad Alfa").requiresRecipientDocument, true);
  assert.throws(() => getShippingOptions(""), error => error.field === "shippingAddress.city");
  for (const field of ["recipientName", "recipientDocument", "city", "department", "street"]) {
    assert.throws(() => validateShippingAddress(shippingFixture({ [field]: "" })), error => error.field === `shippingAddress.${field}`);
  }
});
test("verificación viene de sesión/transporte; teléfono escrito y desconocido quedan fuera", async () => {
  const store = memoryCustomerStore({ "lid_phone_map/1234": { phoneNumber: "595900000002" } });
  const order = { userPhoneNumber: "595900000002", whatsappChatId: "1234@lid" };
  const resolved = await resolveOrderIdentity(store.db, order);
  assert.equal(resolved.phoneVerification.source, "whatsapp_resolved");
  assert.equal(canReadCustomerOrder({ ...order, ...resolved }, order.userPhoneNumber), true);
  const typed = await resolveOrderIdentity(store.db, { ...order, userPhoneNumber: "595900000003", phoneVerification: { verified: true } });
  assert.equal(typed.phoneVerification.verified, false);
  assert.equal(typed.phoneVerification.source, "customer_supplied");
  const pn = await resolveOrderIdentity(store.db, { ...order, whatsappChatId: "595900000002@c.us" });
  assert.equal(pn.phoneVerification.verified, true);
  assert.equal(canReadCustomerOrder({ ...order, origin: "web" }, order.userPhoneNumber), true);
  for (const old of [{}, { origin: "whatsapp" }, { origin: "web", phoneVerification: { verified: false, source: "web_session" } }]) {
    assert.equal(canReadCustomerOrder({ ...order, ...old }, order.userPhoneNumber), false);
  }
  assert.equal(canReadCustomerOrder({ ...order, ...resolved }, "otro"), false);
  const explicitManual = await resolveOrderIdentity(store.db, order, { origin: "whatsapp", resolvedPhone: "" });
  assert.equal(explicitManual.phoneVerification.verified, false);
});
test("persistencia guarda foto fiscal, ignora verificación forjada y no altera fotos existentes", async () => {
  const fixture = pricingFixture();
  const store = memoryCustomerStore();
  const persistence = createOrderPersistence({ ...store, calculatePricing: createOrderPricingService({ catalog: fixture.service }), generateNumber: async () => "test-number" });
  const payload = { id: "test-order", userId: "test-user", userPhoneNumber: "test-phone", userDisplayName: "Cliente Alfa",
    items: [fixture.item], shippingAddress: shippingFixture(), billing: billingFixture({ ruc: "1234567-8", acknowledgeRucMismatch: true }),
    origin: "whatsapp", phoneVerification: { verified: false }, total: 1, stockDeducted: true };
  // El servicio de catálogo usa un repositorio en memoria, sin Firestore.
  const identity = { origin: "web", phone: "test-phone" };
  const order = await persistence.persistOrderSnapshot(payload, { identity });
  assert.equal(order.origin, "web");
  assert.deepEqual(order.phoneVerification, { verified: true, source: "web_session" });
  assert.equal(order.billing.ruc, "1234567-8");
  assert.equal(order.billing.rucValidation.status, "mismatch_confirmed");
  assert.equal(order.billing.acknowledgeRucMismatch, undefined);
  assert.equal(order.stockDeducted, undefined);
  assert.equal(order.items[0].variantId, fixture.item.variantId);
  assert.equal(order.total, 34);
  payload.shippingAddress.street = "Otra referencia"; payload.billing.ruc = "1234567-9";
  const again = await persistence.persistOrderSnapshot(payload, { identity });
  assert.deepEqual(again.shippingAddress, order.shippingAddress); assert.deepEqual(again.billing, order.billing);
});
test("consumidor final y fallo de PDF preservan el pedido", async () => {
  const store = memoryCustomerStore();
  const persistence = createOrderPersistence({ ...store, generateNumber: async () => "test-number",
    calculatePricing: async items => ({ sanitizedItems: items, subtotal: 10, total: 10 }) });
  let notification;
  const processor = createOrderProcessor({ ...store, persistence, generatePdf: async () => { throw new Error("Fallo simulado"); },
    sendPdf: async () => { assert.fail("No se intenta enviar si no se generó"); }, notifyFailure: async order => { notification = order.id; } });
  const result = await processor({ id: "test-order", userId: "test-user", userPhoneNumber: "test-phone", userDisplayName: "Cliente Alfa",
    items: [{ productId: "test-product", variantId: "test-variant", quantity: 1 }], shippingAddress: shippingFixture(),
    billing: { invoiceRequested: false, legalName: "Descartar", ruc: "invalid" } }, { identity: { origin: "web", phone: "test-phone" } });
  assert.equal(result.success, true); assert.equal(result.pdfDelivered, false);
  assert.equal(notification, "test-order");
  assert.deepEqual(store.documents.get("orders/test-order").billing, { invoiceRequested: false });
});
test("DTO del cliente no expone datos internos ni empaques extraños", () => {
  const dto = customerOrderDto("test-order", { orderNumber: "test-number", userId: "privado", whatsappChatId: "privado", stockDeducted: true,
    status: "pending", total: 10, shippingAddress: shippingFixture(),
    items: [{ productId: "test-product", variantId: "test-variant", quantity: 1, selectedPackaging: { type: "libre", name: "Empaque Alfa", price: 2, secret: "oculto" } }],
    billing: { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567-9", secret: "oculto" } });
  for (const field of ["userId", "whatsappChatId", "stockDeducted"]) assert.equal(dto[field], undefined);
  assert.equal(dto.items[0].selectedPackaging.secret, undefined);
  assert.equal(dto.billing.secret, undefined);
  assert.equal(customerOrderDto("test-old", {}).billing, null);
  assert.equal(customerOrderDto("test-old", { billing: null }).billing, null);
});
