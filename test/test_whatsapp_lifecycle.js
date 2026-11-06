import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWhatsAppLifecycle } from "../src/services/whatsapp-lifecycle.service.js";
import { createOwnMessageRepository, installWhatsAppClient } from "../src/services/whatsapp-client.service.js";
import { whatsappMemoryDatabase, deliveryFixture, incoming } from "./helpers/whatsapp-fixtures.js";
import { createWhatsAppPilot } from "../src/services/whatsapp-agent.service.js";
import { createAgentWhatsAppConfig } from "../src/config/agent-whatsapp.config.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

function fixture(options = {}) {
  const clock = createVirtualClock(), client = new EventEmitter(), events = [], logs = [], alerts = [];
  let initialized = 0, destroyed = 0;
  client.initialize = async () => { initialized++; if (options.failInitialize) throw new Error("Error privado"); };
  client.destroy = async () => { destroyed++; };
  client.logout = () => assert.fail("Nunca borrar sesión ni llamar a logout");
  const worker = { start: () => events.push("start"), suspend: () => events.push("suspend"), stop: async () => events.push("stop") };
  const lifecycle = createWhatsAppLifecycle({ client, workers: [worker], clock, now: clock.now,
    logger: value => logs.push(value), requestAlert: async value => alerts.push(value), ...options });
  return { clock, client, lifecycle, events, logs, alerts, initialized: () => initialized, destroyed: () => destroyed };
}
test("authenticated no arranca trabajadores; ready es idempotente y disconnected suspende y cancela la conexión", async () => {
  const f = fixture();
  try {
    await f.lifecycle.start(); f.client.emit("authenticated");
    assert.equal(f.lifecycle.isReady(), false); assert.deepEqual(f.events, []);
    f.client.emit("ready"); f.client.emit("ready");
    assert.deepEqual(f.events, ["start"]); assert.equal(f.lifecycle.isReady(), true);
    const active = f.lifecycle.getSignal();
    f.client.emit("disconnected", "mensaje privado");
    assert.equal(active.aborted, true); assert.equal(f.lifecycle.isReady(), false);
    assert.deepEqual(f.events, ["start", "suspend"]);
    assert.equal(JSON.stringify(f.logs).includes("mensaje privado"), false);
    f.client.emit("ready"); assert.equal(f.lifecycle.getSignal().aborted, false);
    assert.deepEqual(f.events, ["start", "suspend", "start"]);
  } finally { await f.lifecycle.stop(); }
  assert.equal(f.clock.pendingTimers(), 0); assert.equal(f.client.listenerCount("ready"), 0);
});
test("reconexión única con espera creciente, sin superponer initialize y detenida al cerrar", async () => {
  const f = fixture({ failInitialize: true });
  try {
    await f.lifecycle.start(); assert.equal(f.initialized(), 1);
    f.client.emit("disconnected", "TIMEOUT"); f.client.emit("disconnected", "TIMEOUT");
    assert.equal(f.clock.pendingTimers(), 1);
    await f.clock.advanceAsync(4999); assert.equal(f.initialized(), 1);
    await f.clock.advanceAsync(1); assert.equal(f.initialized(), 2); assert.equal(f.destroyed(), 1);
    await f.clock.advanceAsync(9999); assert.equal(f.initialized(), 2);
    await f.clock.advanceAsync(1); assert.equal(f.initialized(), 3);
    assert.deepEqual(f.logs.filter(row => row.waitMs).map(row => row.waitMs), [5000, 10000, 20000]);
  } finally { await f.lifecycle.stop(); }
  await f.clock.advanceAsync(1000000); assert.equal(f.initialized(), 3);
});
test("auth_failure conserva sesión, frena procesamiento/reconexión y solicita una alerta durable por episodio", async () => {
  const db = whatsappMemoryDatabase();
  const f = fixture({ requestAlert: async alert => db.collection("agent_alerts").doc(alert.id).create(alert) });
  try {
    await f.lifecycle.start(); f.client.emit("ready");
    f.client.emit("auth_failure", "credenciales privadas"); f.client.emit("auth_failure", "repetido");
    f.client.emit("disconnected", "LOGOUT"); f.client.emit("ready");
    await flushMicrotasks(); await f.clock.advanceAsync(1000000);
    assert.equal(f.lifecycle.getState(), "auth_failed"); assert.equal(f.lifecycle.isReady(), false);
    assert.equal(f.initialized(), 1); assert.equal(f.destroyed(), 0);
    const alerts = await db.collection("agent_alerts").get();
    assert.equal(alerts.docs.length, 1); assert.equal(alerts.docs[0].data().delivered, false);
    assert.equal(alerts.docs[0].data().type, "WHATSAPP_AUTH_FAILURE");
    assert.equal(JSON.stringify(f.logs).includes("credenciales privadas"), false);
  } finally { await f.lifecycle.stop(); }
});
test("fallo al persistir alerta de autenticación reintenta su mismo ID con reloj y no reconecta", async () => {
  const attempts = [];
  const f = fixture({ requestAlert: async alert => { attempts.push(alert.id); if (attempts.length === 1) throw new Error("Base caída"); } });
  try {
    f.client.emit("auth_failure"); await flushMicrotasks();
    await f.clock.advanceAsync(5000);
    assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]); assert.equal(f.initialized(), 0);
  } finally { await f.lifecycle.stop(); }
});
test("ACK anterior a sendMessage espera ID propio; es durable, monotónico y no confirma pagos", async () => {
  const db = whatsappMemoryDatabase(), client = new EventEmitter(), clock = createVirtualClock();
  const chat = "595900000001@c.us";
  let release;
  client.sendMessage = () => new Promise(resolve => { release = () => resolve({ id: { _serialized: "own-early" } }); });
  client.initialize = async () => {}; client.destroy = async () => {};
  const own = installWhatsAppClient({ client, repository: createOwnMessageRepository({ db, now: clock.now }), config: { enabled: false },
    resolvePhone: async () => "595900000001" });
  const lifecycle = createWhatsAppLifecycle({ client, clock, recordAck: (...args) => own.recordAck(...args) });
  own.setConnection(lifecycle);
  await db.collection("orders").doc("order").set({ status: "pending", pdfDelivered: false });
  try {
    await assert.rejects(client.sendMessage(chat, "No listo"), { code: "WHATSAPP_NOT_READY" });
    client.emit("ready");
    const sent = client.sendMessage(chat, "Texto de prueba");
    client.emit("message_ack", { fromMe: true, to: "test-alias@lid", id: { _serialized: "own-early" } }, 2);
    await flushMicrotasks(); assert.equal(db.rows.size, 1);
    release(); await sent; await flushMicrotasks();
    client.emit("message_ack", { fromMe: true, to: chat, id: { _serialized: "own-early" } }, 1);
    client.emit("message_ack", { fromMe: true, to: chat, id: { _serialized: "manual" } }, 3);
    await flushMicrotasks();
    const rows = (await db.collection("agent_whatsapp_own_messages").get()).docs;
    assert.equal(rows.length, 1); assert.equal(rows[0].data().ack, 2); assert.equal(rows[0].data().lastAckEvent, 1);
    assert.deepEqual((await db.collection("orders").doc("order").get()).data(), { status: "pending", pdfDelivered: false });
  } finally { await lifecycle.stop(); }
});
test("desconectar cancela el turno en curso, impide nuevas admisiones y ready crea otro runtime", async () => {
  const f = deliveryFixture(), client = new EventEmitter(), clock = createVirtualClock();
  const config = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "595900000001" });
  client.initialize = async () => client.emit("ready"); client.destroy = async () => {};
  let entered, runtimeCount = 0, activeSignal, shutdowns = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const pilot = createWhatsAppPilot({ config, repository: f.repository, resolvePhone: async () => "595900000001", transport: f.transport,
    createRuntime: async (_chat, { signal }) => {
      runtimeCount++; activeSignal = signal;
      return { receive: () => runtimeCount > 1 ? Promise.resolve() : new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered();
      }), shutdown: () => { shutdowns++; } };
    } });
  pilot.suspend();
  const lifecycle = createWhatsAppLifecycle({ client, clock, onSuspend: pilot.suspend, onReady: pilot.resume });
  try {
    await lifecycle.start();
    const turn = pilot.handle(incoming("in-progress"));
    const rejected = assert.rejects(turn, { code: "WHATSAPP_DISCONNECTED" });
    await started; client.emit("disconnected", "TIMEOUT");
    await rejected; await flushMicrotasks(); assert.equal(activeSignal.aborted, true); assert.equal(shutdowns, 1);
    const before = structuredClone(f.db.rows); await pilot.handle(incoming("offline"));
    assert.deepEqual(f.db.rows, before); assert.equal(runtimeCount, 1);
    client.emit("ready"); await pilot.handle(incoming("after-ready"));
    assert.equal(runtimeCount, 2); assert.equal(activeSignal.aborted, false);
  } finally { await lifecycle.stop(); await pilot.shutdown(); }
});
test("reconexión espera el checkpoint en curso antes de abrir otro runtime del mismo chat", async () => {
  const f = deliveryFixture(), config = createAgentWhatsAppConfig({ AGENT_ENABLED: "true" });
  let release, runtimeCount = 0, saved = "anterior";
  const pendingWrite = new Promise(resolve => { release = () => { saved = "escritura anterior terminada"; resolve(); }; });
  const pilot = createWhatsAppPilot({ config, repository: f.repository, resolvePhone: async () => "595900000001", transport: f.transport,
    createRuntime: async () => {
      runtimeCount++;
      if (runtimeCount > 1) assert.equal(saved, "escritura anterior terminada");
      return { receive: async () => {}, shutdown() {}, settled: () => runtimeCount === 1 ? pendingWrite : Promise.resolve() };
    } });
  try {
    await pilot.handle(incoming("first")); pilot.suspend(); pilot.resume();
    const next = pilot.handle(incoming("second")); await flushMicrotasks();
    assert.equal(runtimeCount, 1);
    release(); await next; assert.equal(runtimeCount, 2);
  } finally { release?.(); await pilot.shutdown(); }
});
