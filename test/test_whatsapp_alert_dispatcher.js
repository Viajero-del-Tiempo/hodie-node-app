import test from "node:test";
import assert from "node:assert/strict";
import { createWhatsAppAlertDispatcher, renderTeamAlert } from "../src/services/whatsapp-alert-dispatcher.service.js";
import { whatsappMemoryDatabase } from "./helpers/whatsapp-fixtures.js";

const phone = "595900000009";
async function setup({ count = 1, collection = "agent_alerts", client, ...options } = {}) {
  const db = whatsappMemoryDatabase(); let time = 100000, calls = 0;
  for (let i = 0; i < count; i++) await db.collection(collection).doc("alert-" + i).set({ id: "alert-" + i, type: "HANDOFF", chatId: "private-chat",
    createdAt: 0, delivered: false, context: { phone: "privado", text: "no enviar", ruc: "1234567-9", url: "https://example.test/private" } });
  const dispatcher = createWhatsAppAlertDispatcher({ db, now: () => time, alertsPhone: phone,
    client: client ?? { async sendMessage(to, text, args) { calls++; assert.equal(to, phone + "@c.us"); assert.equal(args.appOrigin, "alert"); return { id: { _serialized: "own-" + calls } }; } }, ...options });
  return { db, dispatcher, now: () => time, advance: ms => { time += ms; }, calls: () => calls,
    row: async () => (await db.collection(collection).doc("alert-0").get()).data() };
}

test("alertas agent/order concurrentes se reclaman una vez y el texto no contiene datos sensibles", async () => {
  for (const collection of ["agent_alerts", "order_alerts"]) {
    let sends = 0;
    const client = { async sendMessage() { sends++; return { id: { _serialized: "own-" + sends } }; } };
    const f = await setup({ collection, client });
    const other = createWhatsAppAlertDispatcher({ db: f.db, alertsPhone: phone, now: f.now,
      client });
    try {
      // Ambos leen la misma candidata; el lease decide cuál la despacha.
      await Promise.all([f.dispatcher.tick(), other.tick(), f.dispatcher.tick()]);
      assert.equal(sends, 1); assert.equal((await f.row()).delivered, true);
      await other.tick(); assert.equal(sends, 1);
      const text = renderTeamAlert(await f.row());
      for (const secret of ["private-chat", "privado", "no enviar", "1234567-9", "https://", "phone", "ruc"]) assert.equal(text.includes(secret), false);
    } finally { await f.dispatcher.stop(); await other.stop(); }
  }
});

test("sin ALERTS_PHONE advierte una vez al arrancar y deja todo pendiente sin reclamar", async () => {
  const logs = [], f = await setup({ alertsPhone: null, logger: entry => logs.push(entry) });
  const before = await f.row();
  f.dispatcher.start(); await f.dispatcher.tick(); await f.dispatcher.tick();
  assert.deepEqual(await f.row(), before); assert.equal(f.calls(), 0);
  assert.equal(logs.length, 1); assert.equal(logs[0].code, "ALERTS_PHONE_MISSING");
  await f.dispatcher.stop();
});

test("fallo antes de enviar tiene espera creciente y reintento recuperable tras reinicio", async () => {
  let attempts = 0;
  const client = { async sendMessage() {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("No iniciado"), { code: "PRE_SEND_FAILURE", deliveryStarted: false });
    return { id: { _serialized: "retry-own" } };
  } };
  const f = await setup({ client });
  try {
    await f.dispatcher.tick(); assert.equal(attempts, 1);
    assert.equal((await f.row()).dispatch.nextAttemptAt, f.now() + 1000);
    await f.dispatcher.tick(); assert.equal(attempts, 1);
    f.advance(1000); await f.dispatcher.tick(); assert.equal(attempts, 2);
    assert.equal((await f.row()).dispatch.nextAttemptAt, f.now() + 2000);
    await f.dispatcher.stop(); f.advance(2000);
    const restarted = createWhatsAppAlertDispatcher({ db: f.db, client, alertsPhone: phone, now: f.now });
    await restarted.tick(); await restarted.stop();
    assert.equal(attempts, 3); assert.equal((await f.row()).delivered, true);
  } finally { await f.dispatcher.stop(); }
});

test("rechazo del SDK o falta de ID es incierto: no se reenvía ni tras reiniciar", async () => {
  for (const result of ["throw", "missing-id"]) {
    let attempts = 0;
    const client = { async sendMessage() { attempts++; if (result === "throw") throw new Error("Red cortada después de enviar"); return {}; } };
    const f = await setup({ client });
    try {
      await f.dispatcher.tick(); assert.equal((await f.row()).dispatch.status, "uncertain"); assert.equal((await f.row()).delivered, false);
      f.advance(10000000); await f.dispatcher.tick(); await f.dispatcher.stop();
      const restarted = createWhatsAppAlertDispatcher({ db: f.db, client, now: f.now, alertsPhone: phone });
      await restarted.tick(); await restarted.stop(); assert.equal(attempts, 1);
    } finally { await f.dispatcher.stop(); }
  }
});

test("lease vencido: recupera solo si no había iniciado envío; sending requiere revisión humana", async () => {
  for (const phase of ["claimed", "sending"]) {
    const f = await setup();
    try {
      await f.db.collection("agent_alerts").doc("alert-0").update({ dispatch: { status: "running", phase, attempts: 1, leaseUntil: 0, token: "old" } });
      await f.dispatcher.tick();
      assert.equal(f.calls(), phase === "claimed" ? 1 : 0);
      assert.equal((await f.row()).dispatch.status, phase === "claimed" ? "sent" : "uncertain");
    } finally { await f.dispatcher.stop(); }
  }
});

test("WhatsApp no listo nunca inicia envío y registra reintento; apagar no despacha nuevos", async () => {
  const f = await setup({ isReady: () => false });
  await f.dispatcher.tick(); assert.equal(f.calls(), 0); assert.equal((await f.row()).dispatch.status, "pending");
  assert.equal((await f.row()).dispatch.failureCode, "WHATSAPP_NOT_READY");
  await f.dispatcher.stop(); f.advance(5000); await f.dispatcher.tick(); assert.equal(f.calls(), 0);
});
