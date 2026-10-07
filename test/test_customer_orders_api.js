import test from "node:test";
import assert from "node:assert/strict";
import { openCustomerTestApi } from "./helpers/customer-firestore.js";
import { shippingFixture } from "./helpers/customer-fixtures.js";

test("pedidos propios: verificación, históricos explícitos, paginación e IDOR", async t => {
  const api = await openCustomerTestApi();
  try {
    const a = await api.createUser("a"); const b = await api.createUser("b");
    const examples = [
      { key: "web-new", origin: "web", phoneVerification: { verified: true, source: "web_session" } },
      { key: "wa-resolved", origin: "whatsapp", phoneVerification: { verified: true, source: "whatsapp_resolved" } },
      { key: "web-history", origin: "web" },
      { key: "typed", origin: "whatsapp", phoneVerification: { verified: false, source: "customer_supplied" } },
      { key: "wa-history", origin: "whatsapp" },
      { key: "unknown-history" },
      { key: "web-false", origin: "web", phoneVerification: { verified: false, source: "web_session" } },
    ];
    for (const [index, { key, ...data }] of examples.entries()) {
      const id = api.scope.id(key);
      await api.scope.track("orders", id).create({ id, userId: a.uid, userPhoneNumber: a.phoneNumber, orderNumber: id,
        total: 10, status: "pending", shippingAddress: shippingFixture(), items: [],
        createdAt: api.Timestamp.fromMillis(100000 + index * 1000), ...data, whatsappChatId: "interno", stockDeducted: false });
    }
    const foreign = api.scope.id("foreign");
    await api.scope.track("orders", foreign).create({ userPhoneNumber: b.phoneNumber, userId: b.uid, origin: "web", createdAt: api.Timestamp.now(), total: 20, status: "paid" });
    await t.test("lista solo elegibles y no acepta teléfono de otro usuario", async () => {
      const result = await api.request("/users/me/orders?userPhoneNumber=" + encodeURIComponent(b.phoneNumber), { phone: a.phoneNumber });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.orders.map(row => row.id), ["web-history", "wa-resolved", "web-new"].map(key => api.scope.id(key)));
      assert.equal(result.body.orders[0].whatsappChatId, undefined);
      assert.equal(typeof result.body.orders[0].createdAt, "string");
    });
    await t.test("paginación estable, cursor ligado al dueño y sin repetir", async () => {
      const seen = []; let cursor;
      do {
        const page = await api.request("/users/me/orders?limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), { phone: a.phoneNumber });
        assert.equal(page.status, 200); seen.push(...page.body.orders.map(row => row.id));
        cursor = page.body.nextCursor;
        if (cursor) assert.equal((await api.request("/users/me/orders?cursor=" + encodeURIComponent(cursor), { phone: b.phoneNumber })).status, 400);
      } while (cursor);
      assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
      assert.equal((await api.request("/users/me/orders?limit=0", { phone: a.phoneNumber })).body.field, "limit");
    });
    await t.test("detalle y PDF no permiten pedidos ajenos ni ocultos", async () => {
      for (const id of [foreign, api.scope.id("typed"), api.scope.id("wa-history"), api.scope.id("unknown-history")]) {
        for (const suffix of ["", "/pdf"]) assert.equal((await api.request(`/users/me/orders/${id}${suffix}`, { phone: a.phoneNumber })).status, 404);
      }
      const detail = await api.request(`/users/me/orders/${api.scope.id("web-new")}`, { phone: a.phoneNumber });
      assert.equal(detail.status, 200); assert.equal(detail.body.order.billing, null);
      assert.equal(detail.body.order.whatsappChatId, undefined); assert.equal(detail.body.order.stockDeducted, undefined);
    });
    await t.test("usuario sin pedidos y falta de sesión", async () => {
      const empty = await api.createUser("empty");
      assert.deepEqual((await api.request("/users/me/orders", { phone: empty.phoneNumber })).body.orders, []);
      assert.equal((await api.request("/users/me/orders")).status, 401);
    });
  } finally { await api.close(); }
});
