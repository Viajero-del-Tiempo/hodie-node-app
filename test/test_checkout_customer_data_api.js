import test from "node:test";
import assert from "node:assert/strict";
import { openCustomerTestApi } from "./helpers/customer-firestore.js";
import { shippingFixture, billingFixture } from "./helpers/customer-fixtures.js";

test("checkout completo: variante, envío, RUC, foto y guardado opcional", async t => {
  const api = await openCustomerTestApi();
  try {
    const user = await api.createUser("buyer");
    const categoryId = api.scope.id("category");
    await api.scope.track("categories", categoryId).create({ name: "Categoría Alfa", active: true });
    const productId = api.scope.id("product"); const variantId = api.scope.id("variant");
    await api.scope.track("products", productId).create({ id: productId, schemaVersion: 2, name: "Producto Alfa", active: true, categoryId, optionNames: [],
      variants: [{ id: variantId, sku: api.scope.id("sku"), options: {}, price: 10, stock: 8, active: true, imageUrls: [] }],
      customization: { allowed: true, allowsText: true, maxChars: 30, allowsImage: false },
      packagingOptions: [{ type: "test-pack", name: "Empaque Alfa", price: 2 }] });
    const payload = { items: [{ productId, variantId, quantity: 2, packagingType: "test-pack", customization: "Nombre Uno" },
      { productId, variantId, quantity: 1, packagingType: null, customization: "Nombre Dos" }], shippingAddress: shippingFixture(), billing: billingFixture() };
    const send = body => api.request("/orders/order/send", { phone: user.phoneNumber, method: "POST", body });
    let savedId;
    await t.test("sin direcciones se guarda por defecto, con verificación de sesión y foto fiscal", async () => {
      const result = await send({ ...payload, origin: "whatsapp", phoneVerification: { verified: false }, userPhoneNumber: "otro", userId: "otro", total: 1,
        saveBillingProfile: true });
      assert.equal(result.status, 200); savedId = result.body.orderId;
      assert.equal(result.body.profileSaved, true);
      const order = (await api.db.collection("orders").doc(savedId).get()).data();
      assert.equal(order.total, 34); assert.equal(order.userId, user.uid); assert.equal(order.userPhoneNumber, user.phoneNumber);
      assert.equal(order.origin, "web"); assert.deepEqual(order.phoneVerification, { verified: true, source: "web_session" });
      assert.equal(order.shippingAddress.recipientDocument, "1234567"); assert.equal(order.billing.ruc, "1234567-9");
      assert.deepEqual(order.items.map(item => item.variantId), [variantId, variantId]);
      assert.deepEqual(order.items.map(item => item.customization), ["Nombre Uno", "Nombre Dos"]);
      const profile = (await api.request("/users/me", { phone: user.phoneNumber })).body.user;
      assert.equal(profile.addresses.length, 1); assert.equal(profile.billingProfiles.length, 1);
      assert.equal(profile.defaultAddressId, profile.addresses[0].id);
    });
    await t.test("con direcciones se desmarca por defecto y consumidor final descarta datos fiscales", async () => {
      const result = await send({ ...payload, shippingAddress: shippingFixture({ street: "Otra compra" }), billing: { invoiceRequested: false, ruc: "dato a descartar" } });
      assert.equal(result.status, 200); assert.equal(result.body.profileSaved, null);
      const order = (await api.db.collection("orders").doc(result.body.orderId).get()).data();
      assert.deepEqual(order.billing, { invoiceRequested: false });
      assert.equal((await api.profiles.get(user.phoneNumber)).addresses.length, 1);
    });
    await t.test("desmarcar explícitamente cuando no hay direcciones no modifica el perfil", async () => {
      const empty = await api.createUser("empty");
      const result = await api.request("/orders/order/send", { phone: empty.phoneNumber, method: "POST", body: { ...payload, saveShippingAddress: false } });
      assert.equal(result.status, 200); assert.equal(result.body.profileSaved, null);
      assert.equal((await api.profiles.get(empty.phoneNumber)).addresses.length, 0);
    });
    await t.test("cédula y campos obligatorios devuelven field, sin crear pedidos", async () => {
      for (const field of ["recipientName", "recipientDocument", "street", "city", "department"]) {
        const result = await send({ ...payload, shippingAddress: shippingFixture({ [field]: "" }) });
        assert.equal(result.status, 400); assert.equal(result.body.field, `shippingAddress.${field}`);
      }
      const local = await send({ ...payload, saveShippingAddress: false, shippingAddress: shippingFixture({ city: "Minga Guazú", recipientDocument: "" }) });
      assert.equal(local.status, 200);
      const order = (await api.db.collection("orders").doc(local.body.orderId).get()).data();
      assert.equal(order.shippingMethod, "local_gratis"); assert.equal(order.shippingAddress.recipientDocument, undefined);
      const options = await api.request("/orders/shipping-options?city=" + encodeURIComponent(" MINGA   GUAZÚ "), { phone: user.phoneNumber });
      assert.equal(options.body.requiresRecipientDocument, false); assert.equal(options.body.shippingCost, 0);
    });
    await t.test("base sin guion requiere confirmación exacta; DV distinto conserva aceptación", async () => {
      const pending = await send({ ...payload, billing: billingFixture({ ruc: "1234567" }) });
      assert.equal(pending.status, 400); assert.equal(pending.body.code, "RUC_COMPLETION_REQUIRED"); assert.equal(pending.body.suggestedRuc, "1234567-9");
      const confirmed = await send({ ...payload, billing: billingFixture({ ruc: "1234567", confirmedRuc: "1234567-9" }) });
      assert.equal(confirmed.status, 200);
      const mismatch = await send({ ...payload, billing: billingFixture({ ruc: "1234567-8" }) });
      assert.equal(mismatch.body.field, "billing.ruc"); assert.equal(mismatch.body.code, "RUC_DV_MISMATCH");
      const accepted = await send({ ...payload, billing: billingFixture({ ruc: "1234567-8", acknowledgeRucMismatch: true }) });
      assert.equal(accepted.status, 200);
      const order = (await api.db.collection("orders").doc(accepted.body.orderId).get()).data();
      assert.equal(order.billing.ruc, "1234567-8"); assert.equal(order.billing.rucValidation.status, "mismatch_confirmed");
    });
    await t.test("editar el perfil no cambia el pedido y el PDF propio es descargable", async () => {
      const before = (await api.db.collection("orders").doc(savedId).get()).data();
      const profile = await api.profiles.get(user.phoneNumber);
      await api.profiles.update(user.phoneNumber, { version: profile.version, addresses: [], billingProfiles: [], displayName: "Nombre posterior" });
      const after = (await api.db.collection("orders").doc(savedId).get()).data();
      assert.deepEqual(after.shippingAddress, before.shippingAddress); assert.deepEqual(after.billing, before.billing);
      const downloaded = await api.request(`/users/me/orders/${savedId}/pdf`, { phone: user.phoneNumber });
      assert.equal(downloaded.status, 200); assert.equal(downloaded.body.subarray(0, 5).toString(), "%PDF-");
    });
    await t.test("fallo del guardado opcional devuelve compra exitosa, sin pedir repetirla", async () => {
      api.simulateProfileSaveFailure(true);
      try {
        const result = await send({ ...payload, saveShippingAddress: true });
        assert.equal(result.status, 200); assert.equal(result.body.success, true);
        assert.equal(result.body.profileSaved, false); assert.equal(typeof result.body.profileWarning, "string");
        assert.equal((await api.db.collection("orders").doc(result.body.orderId).get()).exists, true);
        assert.equal((await api.profiles.get(user.phoneNumber)).addresses.length, 0);
      } finally { api.simulateProfileSaveFailure(false); }
    });
  } finally { await api.close(); }
});
