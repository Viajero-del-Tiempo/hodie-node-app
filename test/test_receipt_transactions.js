import test from "node:test";
import assert from "node:assert/strict";
import { assertLocalEnvironment } from "../scripts/local-catalog.config.js";
import { openCustomerTestApi } from "./helpers/customer-firestore.js";
import { createPaymentReceiptRepository } from "../src/services/payment-receipt.repository.js";
import { createPaymentReceiptService } from "../src/services/payment-receipt.service.js";
import { receiptPng } from "./helpers/receipt-fixtures.js";

assertLocalEnvironment(process.env); // Ningún permiso habilita producción.
test("5B: asociación, carreras, rollback y descarga protegida con Firestore real del emulador", async t => {
  const api = await openCustomerTestApi({ includeReceipts: true });
  const alerts = [];
  const repository = db => createPaymentReceiptRepository({ db, newAlertId: (_chat, _type, id) => {
    const key = api.scope.id("alert-" + id); alerts.push(api.scope.track("agent_alerts", key)); return key;
  } });
  const fixture = async suffix => {
    const chatId = api.scope.id(suffix + "-chat"), orderId = api.scope.id(suffix + "-order"), ref = api.scope.track("orders", orderId);
    const order = { id: orderId, orderNumber: orderId, status: "pending", whatsappChatId: chatId, total: 123, items: [] };
    await ref.create(order);
    const create = repo => createPaymentReceiptService({ repository: repo, storage: api.receiptStorage,
      getState: () => ({ whatsappChatId: chatId, phoneVerified: false }), getAttachment: () => ({ data: receiptPng, mimeType: "image/png" }),
      newReceiptId: (_chat, digest) => { const id = api.scope.id(suffix + "-" + digest); api.scope.track("payment_receipts", id); return id; } });
    const repo = repository(api.db), service = create(repo);
    await assert.rejects(service.register({ attachmentId: "file", orderNumber: api.scope.id("missing") }), { code: "PEDIDO_NO_DISPONIBLE" });
    const receipt = (await repo.listUnassigned(chatId))[0];
    return { chatId, orderId, ref, order, receipt, repo, service, create };
  };
  try {
    const admin = await api.createUser("receipt-admin", { role: "admin" }), customer = await api.createUser("receipt-customer");
    await t.test("dos asociaciones simultáneas: misma relación y una alerta, sin cambiar el pedido", async () => {
      const f = await fixture("concurrent"), before = (await f.ref.get()).data();
      const results = await Promise.all([1, 2].map(() => f.service.register({ comprobanteId: f.receipt.id, orderNumber: f.orderId })));
      assert.ok(results.every(result => result.code === "OK"));
      assert.deepEqual(results.map(result => result.alreadyAssociated).sort(), [false, true]);
      assert.deepEqual((await f.ref.get()).data(), before);
      assert.equal((await f.repo.get(f.receipt.id)).orderId, f.orderId);
      const unique = [...new Map(alerts.map(ref => [ref.path, ref])).values()];
      const matches = (await Promise.all(unique.map(ref => ref.get()))).filter(doc => doc.exists && doc.data().receiptId === f.receipt.id);
      assert.equal(matches.length, 1); assert.equal(matches[0].data().delivered, false);
    });
    await t.test("estado cambia entre selección y lectura transaccional: rechaza sin relación ni alerta", async () => {
      const f = await fixture("race"); let signalRead, release;
      const reached = new Promise(resolve => { signalRead = resolve; }), resume = new Promise(resolve => { release = resolve; });
      let pause = true;
      const db = { collection: name => api.db.collection(name), runTransaction: action => api.db.runTransaction(tx => action({
        get: async ref => { if (ref.path === f.ref.path && pause) { pause = false; signalRead(); await resume; } return tx.get(ref); },
        create: tx.create.bind(tx), set: tx.set.bind(tx), delete: tx.delete.bind(tx),
      })) };
      const operation = f.create(repository(db)).register({ comprobanteId: f.receipt.id, orderNumber: f.orderId });
      const rejected = assert.rejects(operation, { code: "PEDIDO_NO_DISPONIBLE" });
      await reached; try { await f.ref.update({ status: "paid" }); } finally { release(); }
      await rejected;
      assert.equal((await f.repo.get(f.receipt.id)).status, "unassigned");
      assert.equal((await f.ref.get()).data().status, "paid");
      for (const ref of alerts) { const doc = await ref.get(); assert.ok(!doc.exists || doc.data().receiptId !== f.receipt.id); }
    });
    await t.test("rollback después de preparar asociación y alerta revierte ambos documentos", async () => {
      const f = await fixture("rollback"), before = (await f.ref.get()).data();
      const db = { collection: name => api.db.collection(name), runTransaction: action => api.db.runTransaction(async tx => {
        await action(tx); throw new Error("Rollback de prueba");
      }) };
      await assert.rejects(f.create(repository(db)).register({ comprobanteId: f.receipt.id, orderNumber: f.orderId }), /Rollback/);
      assert.equal((await f.repo.get(f.receipt.id)).status, "unassigned"); assert.deepEqual((await f.ref.get()).data(), before);
      for (const ref of alerts) { const doc = await ref.get(); assert.ok(!doc.exists || doc.data().receiptId !== f.receipt.id); }
    });
    await t.test("lista/descarga requieren admin real; bytes no públicos y no se descarga desde otro pedido", async () => {
      const f = await fixture("download"); await f.service.register({ comprobanteId: f.receipt.id, orderNumber: f.orderId });
      const list = "/admin/orders/" + f.orderId + "/receipts", download = list + "/" + f.receipt.id + "/download";
      for (const path of [list, download]) {
        assert.equal((await api.request(path)).status, 401);
        assert.equal((await api.request(path, { phone: customer.phoneNumber })).status, 403);
      }
      const listing = await api.request(list, { phone: admin.phoneNumber }); assert.equal(listing.status, 200);
      assert.equal(listing.body.receipts.length, 1); assert.equal(JSON.stringify(listing.body).includes("publicId"), false);
      assert.equal(JSON.stringify(listing.body).includes("https:"), false);
      const downloaded = await api.request(download, { phone: admin.phoneNumber });
      assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, receiptPng);
      assert.equal(downloaded.headers["cache-control"], "private, no-store"); assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
      assert.match(downloaded.headers["content-disposition"], /^attachment;/);
      assert.equal((await api.request("/admin/orders/" + api.scope.id("other") + "/receipts/" + f.receipt.id + "/download", { phone: admin.phoneNumber })).status, 404);
      await api.db.collection("users").doc(admin.uid).update({ active: false });
      assert.equal((await api.request(download, { phone: admin.phoneNumber })).status, 403);
    });
  } finally { await api.close(); }
});
