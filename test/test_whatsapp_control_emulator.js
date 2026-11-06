import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { assertLocalEnvironment } from "../scripts/local-catalog.config.js";
import { openCatalogTestFirestore } from "./helpers/catalog-firestore.js";
import { createAgentChatControl } from "../src/services/agent-chat-control.service.js";
import { createControlledCheckpointStore } from "../src/agents/consultation/checkpoint-store.js";
import { initialAgentState } from "../src/agents/consultation/production-adapter.js";
import { createWhatsAppAlertDispatcher } from "../src/services/whatsapp-alert-dispatcher.service.js";
import { createOwnMessageRepository } from "../src/services/whatsapp-client.service.js";
import { createOrderConfirmationRepository } from "../src/services/order-confirmation.repository.js";
import { createAdminAgentChatRouter } from "../src/routes/admin.agent-chat.routes.js";

assertLocalEnvironment(process.env);

test("emulador: bloqueo/reactivación concurrentes, checkpoint y confirmación tardíos cercados, deduplicación y alertas", async () => {
  const context = await openCatalogTestFirestore(), { db, Timestamp } = context;
  const chatId = "test-control-" + randomUUID() + "@lid", alertId = "test-alert-" + randomUUID();
  const control = createAgentChatControl({ db, timestampFromMillis: Timestamp.fromMillis });
  const first = await control.ensure(chatId, null), state = initialAgentState(chatId);
  const originalCart = { lines: [{ quantity: 2 }], textDraft: "Borrador sintético" };
  const record = db.collection("agent_checkpoints").doc(chatId);
  const ownedId = "test-own-" + randomUUID(), own = createOwnMessageRepository({ db, timestampFromMillis: Timestamp.fromMillis });
  const alerts = [];
  let unsubscribe;
  try {
    await db.collection("carts").doc(chatId).set(originalCart);
    const store = await createControlledCheckpointStore({ db, chatId, control, fallback: { read: async () => null } });
    await store.write(state);
    const oldRepository = createOrderConfirmationRepository({ db, timestampNow: Timestamp.now,
      beforeTransaction: tx => control.assertActive(tx, chatId, first.version) });
    const observed = new Promise((resolve, reject) => { unsubscribe = control.watch(chatId, next => { if (next?.paused) resolve(next); }, reject); });
    const paused = await control.pause(chatId, { reason: "derivacion" });
    assert.equal((await observed).version, paused.version);
    const results = await Promise.allSettled([
      control.resume(paused.id, paused.version),
      control.pause(chatId, { reason: "toma_manual", eventId: "manual-concurrent" }),
      store.write({ ...state, humanHandoffRequired: false }),
      oldRepository.saveConfirmation(chatId, { quoteId: "expired" }),
    ]);
    assert.equal(results[2].status, "rejected"); assert.equal(results[3].status, "rejected");
    assert.equal(results[2].reason.code, "CHAT_CONTROL_CHANGED");
    const current = await control.get(chatId);
    // En ambos órdenes de commit, la nueva intervención manual gana.
    assert.equal(current.paused, true); assert.equal(current.reason, "toma_manual");
    assert.equal((await db.collection("order_confirmations").doc(chatId).get()).exists, false);
    let enteredOrderTransaction = false;
    await assert.rejects(oldRepository.transact(async () => { enteredOrderTransaction = true; }), { code: "CHAT_CONTROL_CHANGED" });
    assert.equal(enteredOrderTransaction, false);
    const duplicated = await control.pause(chatId, { reason: "toma_manual", eventId: "manual-concurrent" });
    assert.equal(duplicated.version, current.version);
    await control.resume(current.id, current.version);
    await assert.rejects(store.write(state), { code: "CHAT_CONTROL_CHANGED" });
    const fresh = await createControlledCheckpointStore({ db, chatId, control, fallback: { read: async () => null } });
    const resumed = await fresh.read(); assert.equal(resumed.humanHandoffRequired, false); assert.equal(resumed.lastQuote, null);
    assert.deepEqual((await db.collection("carts").doc(chatId).get()).data(), originalCart);
    await own.record(chatId, ownedId); assert.equal(await own.owns(chatId, ownedId), true);

    await db.collection("agent_alerts").doc(alertId).create({ type: "HANDOFF", chatId, delivered: false, createdAt: 0 });
    const client = { async sendMessage(to, text) { alerts.push({ to, text }); return { id: { _serialized: "alert-own" } }; } };
    // La base puede contener otras alertas del recorrido manual: este test usa
    // un repositorio que expone únicamente la candidata de su ejecución.
    const isolatedDb = { runTransaction: db.runTransaction.bind(db), collection(name) {
      if (name === "agent_alerts" || name === "order_alerts") return { where: () => ({ get: async () => ({ docs: name === "agent_alerts" ? [await db.collection(name).doc(alertId).get()] : [] }) }) };
      return db.collection(name);
    } };
    const dispatchers = [0, 1].map(() => createWhatsAppAlertDispatcher({ db: isolatedDb, client, alertsPhone: "595900000009" }));
    try { await Promise.all(dispatchers.map(dispatcher => dispatcher.tick())); }
    finally { await Promise.all(dispatchers.map(dispatcher => dispatcher.stop())); }
    assert.equal(alerts.length, 1); assert.equal((await db.collection("agent_alerts").doc(alertId).get()).data().delivered, true);
  } finally {
    unsubscribe?.();
    const events = await db.collection("agent_whatsapp_messages").where("chatId", "==", chatId).get();
    const ownRows = await db.collection("agent_whatsapp_own_messages").where("chatId", "==", chatId).get();
    try {
      await Promise.all([control.ref(chatId).delete(), record.delete(), db.collection("carts").doc(chatId).delete(),
        db.collection("order_confirmations").doc(chatId).delete(), db.collection("handoff_threads").doc(chatId).delete(),
        db.collection("agent_alerts").doc(alertId).delete(), ...events.docs.map(doc => doc.ref.delete()), ...ownRows.docs.map(doc => doc.ref.delete())]);
    } finally { await context.close(); }
  }
});

test("emulador: listado/reactivación con requireAdmin real, cliente y token sin permiso rechazados", async () => {
  const context = await openCatalogTestFirestore(), { db } = context;
  const { requireAuth, requireAdmin } = await import("../src/middlewares/auth.middleware.js");
  const suffix = randomUUID(), chatId = "test-admin-chat-" + suffix + "@lid";
  const adminPhone = "5959" + randomInt(10000000, 99999999), customerPhone = "5959" + randomInt(10000000, 99999999);
  const adminRef = db.collection("users").doc("test-admin-" + suffix), customerRef = db.collection("users").doc("test-customer-" + suffix);
  const control = createAgentChatControl({ db }), resumed = [];
  let server;
  try {
    await adminRef.create({ phoneNumber: adminPhone, role: "admin", active: true });
    await customerRef.create({ phoneNumber: customerPhone, role: "customer", active: true });
    await control.ensure(chatId, null); const paused = await control.pause(chatId, { reason: "toma_manual" });
    const app = express(); app.use(express.json());
    app.use("/admin", createAdminAgentChatRouter({ control, requireAuth, requireAdmin, onResume: id => resumed.push(id) }));
    server = await new Promise(resolve => { const current = app.listen(0, "127.0.0.1", () => resolve(current)); });
    const request = (token, body) => fetch(`http://127.0.0.1:${server.address().port}/admin/chats/agent/${body ? paused.id + "/resume-bot" : "paused"}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const admin = jwt.sign({ phone: adminPhone }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const customer = jwt.sign({ phone: customerPhone, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    for (const token of [null, customer]) {
      assert.equal((await request(token)).status, token ? 403 : 401);
      assert.equal((await request(token, { version: paused.version })).status, token ? 403 : 401);
    }
    const list = await (await request(admin)).json();
    assert.ok(list.chats.some(row => row.id === paused.id));
    assert.equal((await request(admin, { version: paused.version })).status, 200);
    assert.deepEqual(resumed, [chatId]); assert.equal((await control.get(chatId)).paused, false);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    try { await Promise.all([adminRef.delete(), customerRef.delete(), control.ref(chatId).delete(), db.collection("handoff_threads").doc(chatId).delete()]); }
    finally { await context.close(); }
  }
});
