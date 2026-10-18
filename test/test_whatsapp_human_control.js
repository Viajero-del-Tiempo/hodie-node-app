import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createAgentWhatsAppConfig } from "../src/config/agent-whatsapp.config.js";
import { createOwnMessageRepository, installWhatsAppClient, readAlertsPhone } from "../src/services/whatsapp-client.service.js";
import { createAgentChatControl, applyChatControl } from "../src/services/agent-chat-control.service.js";
import { createWhatsAppPilot } from "../src/services/whatsapp-agent.service.js";
import { createControlledCheckpointStore } from "../src/agents/consultation/checkpoint-store.js";
import { initialAgentState, createProductionAgent } from "../src/agents/consultation/production-adapter.js";
import { createWhatsAppTransport } from "../src/services/whatsapp-transport.service.js";
import { deliveryFixture, incoming, FakeMessageMedia } from "./helpers/whatsapp-fixtures.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";
import { scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { memoryPrivateReceiptStorage } from "./helpers/receipt-memory.js";

const chatId = "595900000001@c.us", phone = "595900000001";
const config = () => createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: phone, AGENT_MAINTENANCE_MODE: "silent" });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(options = {}) {
  const f = deliveryFixture(), control = createAgentChatControl({ db: f.db, now: f.now });
  await control.ensure(chatId, phone);
  const ownMessages = installWhatsAppClient({ client: f.client, repository: createOwnMessageRepository({ db: f.db, now: f.now }),
    config: config(), resolvePhone: async () => phone, alertsPhone: "595900000009" });
  const pilot = createWhatsAppPilot({ config: config(), repository: f.repository, control, ownMessages, transport: f.transport,
    resolvePhone: async () => phone, createRuntime: async () => ({ receive: async () => {}, shutdown() {} }), ...options });
  return { ...f, control, ownMessages, pilot };
}

test("correlación global por ID: texto, imágenes, PDF, mantenimiento y alertas; misma frase humana no es propia", async () => {
  const f = await fixture();
  try {
    for (const content of ["Texto", { mimetype: "image/png" }, { mimetype: "application/pdf" }, "Mantenimiento", "Alerta"]) {
      const sent = await f.client.sendMessage(chatId, content);
      assert.equal(await f.ownMessages.owns(chatId, sent.id._serialized), true);
      await f.pilot.handleCreated({ fromMe: true, to: chatId, body: "Texto", id: sent.id });
    }
    assert.equal((await f.control.get(chatId)).paused, false);
    await f.pilot.handleCreated({ fromMe: true, to: chatId, body: "Texto", id: { _serialized: "human-same-text" } });
    assert.equal((await f.control.get(chatId)).reason, "toma_manual");
    assert.ok([...f.db.rows].filter(([key]) => key.startsWith("agent_whatsapp_own_messages/")).every(([, row]) => !Object.hasOwn(row, "body")));
  } finally { await f.pilot.shutdown(); }
});

test("OTP real de la app: message_create anterior a sendMessage espera el ID incluso entre PN/LID y no pausa", async () => {
  const f = deliveryFixture(), gate = deferred(); let pilot, observed;
  const lidChat = "test-otp@lid";
  f.client.sendMessage = async to => {
    assert.equal(to, lidChat);
    const id = { _serialized: "otp-own-id" };
    observed = pilot.handleCreated({ fromMe: true, to: chatId, id });
    await gate.promise; return { id };
  };
  const control = createAgentChatControl({ db: f.db, now: f.now }); await control.ensure(lidChat, phone);
  const ownMessages = installWhatsAppClient({ client: f.client, repository: createOwnMessageRepository({ db: f.db, now: f.now }), config: config(), resolvePhone: async () => phone });
  pilot = createWhatsAppPilot({ config: config(), control, ownMessages, repository: f.repository, transport: f.transport,
    resolvePhone: async () => phone, createRuntime: () => assert.fail("OTP no ejecuta agente") });
  const source = await readFile(new URL("../src/services/whatsapp.service.js", import.meta.url), "utf8");
  const actual = source.slice(source.indexOf("export const resolveChatId"), source.indexOf("export const sendWelcomeMessage"));
  const sendOTP = vm.runInNewContext(actual.replace(/export const/g, "const") + "\nsendVerificationCode;", {
    whatsappClient: f.client, console: { log() {}, warn() {}, error: error => assert.fail(String(error)) },
  });
  try {
    const sending = sendOTP(lidChat, "000000");
    await flushMicrotasks(); assert.equal((await control.get(lidChat)).paused, false);
    gate.resolve(); await sending; await observed;
    assert.equal((await control.get(lidChat)).paused, false);
    assert.equal(await ownMessages.owns(chatId, "otp-own-id"), true);
  } finally { gate.resolve(); await pilot.shutdown(); }
});

test("toma humana dirigida al PN pausa también el chat identificado por LID del mismo teléfono resuelto", async () => {
  const f = await fixture();
  try {
    await f.control.ensure("test-other-identifier@lid", phone);
    await f.pilot.handleCreated({ fromMe: true, to: chatId, id: { _serialized: "manual-pn" } });
    assert.equal((await f.control.get(chatId)).reason, "toma_manual");
    assert.equal((await f.control.get("test-other-identifier@lid")).reason, "toma_manual");
    assert.equal((await f.control.listPaused()).length, 2);
  } finally { await f.pilot.shutdown(); }
});

test("toma manual cancela el turno; duplica por ID sin volver a pausar después de reactivar; conserva carrito", async () => {
  const entered = deferred(), result = deferred(); let stopped = 0;
  const f = await fixture({ createRuntime: async () => ({ receive: () => { entered.resolve(); return result.promise; },
    shutdown() { stopped++; result.reject(Object.assign(new Error("Cancelado"), { code: "CHAT_CONTROL_CHANGED" })); } }) });
  await f.db.collection("carts").doc(chatId).set({ draft: "Texto de prueba", lines: [{ quantity: 2 }] });
  await f.db.collection("order_confirmations").doc(chatId).set({ quoteId: "old" });
  try {
    const pending = f.pilot.handle(incoming("customer")), rejected = assert.rejects(pending, { code: "CHAT_CONTROL_CHANGED" });
    await entered.promise;
    const message = { fromMe: true, to: chatId, id: { _serialized: "human-id" } };
    await f.pilot.handleCreated(message); await rejected;
    const paused = await f.control.get(chatId);
    assert.equal(paused.paused, true); assert.equal(paused.reason, "toma_manual"); assert.equal(stopped, 1);
    assert.equal((await f.db.collection("order_confirmations").doc(chatId).get()).exists, false);
    assert.deepEqual((await f.db.collection("carts").doc(chatId).get()).data(), { draft: "Texto de prueba", lines: [{ quantity: 2 }] });
    await f.control.resume(paused.id, paused.version);
    await f.pilot.handleCreated(message);
    assert.equal((await f.control.get(chatId)).paused, false); assert.deepEqual(f.outgoing, []);
  } finally { await f.pilot.shutdown(); }
});

test("autoría incierta no se confunde con toma humana; grupos y sistema no pausan", async () => {
  const f = await fixture();
  try {
    for (const message of [{ to: "group@g.us" }, { type: "e2e_notification" }, { fromMe: false }]) {
      await f.pilot.handleCreated({ fromMe: true, to: chatId, id: { _serialized: "ignored" }, ...message });
    }
    assert.equal((await f.control.get(chatId)).paused, false);
    const own = createOwnMessageRepository({ db: f.db, now: f.now });
    const gate = deferred(); let event, uncertainPilot;
    const client = { async sendMessage() {
      event = uncertainPilot.handleCreated({ fromMe: true, to: chatId, id: { _serialized: "uncertain-id" } });
      event.catch(() => {}); await gate.promise; return { id: { _serialized: "uncertain-id" } };
    } };
    const correlated = installWhatsAppClient({ client, config: config(), resolvePhone: async () => phone,
      repository: { ...own, record: async () => { throw new Error("Persistencia caída"); } } });
    uncertainPilot = createWhatsAppPilot({ config: config(), repository: f.repository, transport: f.transport, control: f.control,
      ownMessages: correlated, resolvePhone: async () => phone, createRuntime: () => assert.fail("Sin runtime") });
    try {
      const sending = assert.rejects(client.sendMessage(chatId, "OTP"), { code: "OWN_MESSAGE_RECORD_FAILED" });
      await flushMicrotasks(); gate.resolve(); await sending;
      await assert.rejects(event, { code: "OWN_MESSAGE_CORRELATION_UNCERTAIN" });
      assert.equal((await f.control.get(chatId)).paused, false);
    } finally { gate.resolve(); await uncertainPilot.shutdown(); }
  } finally { await f.pilot.shutdown(); }
});

test("checkpoint cercado: escritura tardía no quita pausa ni restaura confirmaciones tras reactivación", async () => {
  const f = await fixture();
  try {
    const state = { ...initialAgentState(chatId), messages: [{ role: "user", content: "Anterior" }],
      lastQuote: { quoteId: "old" }, pendingTextConfirmation: { textDraft: "Borrador", shown: true }, pendingRucConfirmation: { shown: true } };
    const fallback = { read: async () => state };
    const old = await createControlledCheckpointStore({ db: f.db, chatId, control: f.control, fallback });
    await old.write(state);
    const paused = await f.control.pause(chatId, { reason: "toma_manual" });
    await assert.rejects(old.write(state), { code: "CHAT_CONTROL_CHANGED" });
    const inactive = applyChatControl(state, paused);
    assert.equal(inactive.lastQuote, null); assert.equal(inactive.pendingTextConfirmation.shown, false);
    assert.equal(inactive.pendingTextConfirmation.textDraft, "Borrador");
    await f.control.resume(paused.id, paused.version);
    await assert.rejects(old.write(state), { code: "CHAT_CONTROL_CHANGED" });
    const fresh = await createControlledCheckpointStore({ db: f.db, chatId, control: f.control, fallback });
    const restarted = await fresh.read();
    assert.equal(restarted.humanHandoffRequired, false); assert.equal(restarted.sessionCutoff, 1);
    assert.equal(restarted.lastQuote, null); assert.equal(restarted.pendingTextConfirmation.textDraft, "Borrador");
    assert.deepEqual(f.outgoing, []);
  } finally { await f.pilot.shutdown(); }
});

test("duplicado manual tras reactivación tampoco cancela el runtime de la sesión nueva", async () => {
  let stopped = 0, started = 0;
  const f = await fixture({ createRuntime: async () => { started++; return { receive: async () => {}, shutdown: () => { stopped++; } }; } });
  try {
    await f.pilot.handle(incoming("first-session"));
    const manual = { fromMe: true, to: chatId, id: { _serialized: "same-human" } };
    await f.pilot.handleCreated(manual); assert.equal(stopped, 1);
    const paused = await f.control.get(chatId); await f.control.resume(paused.id, paused.version);
    await f.pilot.handle(incoming("second-session")); assert.equal(started, 2);
    await f.pilot.handleCreated(manual);
    assert.equal(stopped, 1); assert.equal((await f.control.get(chatId)).paused, false);
  } finally { await f.pilot.shutdown(); }
});

test("reactivación vieja pierde contra toma manual concurrente; ambas pausas aparecen con DTO truncado", async () => {
  const f = await fixture();
  try {
    await f.control.touch(chatId, "x".repeat(300));
    const old = await f.control.pause(chatId, { reason: "derivacion" });
    await f.control.pause(chatId, { reason: "toma_manual", eventId: "new-human" });
    await assert.rejects(f.control.resume(old.id, old.version), { code: "CHAT_CONTROL_CHANGED", statusCode: 409 });
    const rows = await f.control.listPaused();
    assert.equal(rows.length, 1); assert.equal(rows[0].reason, "toma_manual"); assert.equal(rows[0].lastCustomerMessage.length, 200);
    assert.equal(rows[0].phoneMasked, "…0001"); assert.equal(JSON.stringify(rows).includes(chatId), false);
    assert.equal(Object.hasOwn(rows[0], "chatId"), false);
  } finally { await f.pilot.shutdown(); }
});

test("silent bloquea TODO envío de la app fuera de lista excepto alertas explícitas al equipo", async () => {
  const f = deliveryFixture();
  installWhatsAppClient({ client: f.client, repository: createOwnMessageRepository({ db: f.db }), config: config(),
    resolvePhone: async id => id.replace("@c.us", ""), alertsPhone: "595900000009" });
  try {
    for (const content of ["OTP", "Estado", { mimetype: "application/pdf" }]) await assert.rejects(f.client.sendMessage("595900000002@c.us", content), { code: "WHATSAPP_OUTSIDE_ALLOWLIST", deliveryStarted: false });
    assert.equal(f.db.rows.size, 0); assert.deepEqual(f.outgoing, []);
    await assert.rejects(f.client.sendMessage("595900000009@c.us", "OTP"), { code: "WHATSAPP_OUTSIDE_ALLOWLIST" });
    await f.client.sendMessage("595900000009@c.us", "Alerta", { appOrigin: "alert" });
    assert.equal(f.outgoing.length, 1); assert.equal(f.outgoing[0].options.appOrigin, undefined);
    await assert.rejects(f.client.sendMessage("595900000002@c.us", "Alerta", { appOrigin: "alert" }), { code: "WHATSAPP_OUTSIDE_ALLOWLIST" });
    for (const value of ["wrong", "123@lid", "595900000001,"]) assert.throws(() => readAlertsPhone({ ALERTS_PHONE: value }));
  } finally { f.transport.close(); }
});

test("envío en cola que no inició se cancela al tomar control", async () => {
  const f = deliveryFixture(), gate = deferred(); let paused = false, calls = 0;
  const transport = createWhatsAppTransport({ client: { async sendMessage() { calls++; await gate.promise; return { id: { _serialized: "in-flight" } }; } },
    MessageMedia: FakeMessageMedia, repository: f.repository, pause: async () => {},
    beforeSend: async () => { if (paused) throw Object.assign(new Error("Pausado"), { code: "CHAT_CONTROL_CHANGED" }); } });
  try {
    const first = transport.sendText(chatId, "Ya iniciado"), second = transport.sendText(chatId, "No iniciado");
    const rejected = assert.rejects(second);
    await flushMicrotasks(); assert.equal(calls, 1);
    paused = true; transport.close(); gate.resolve();
    await assert.rejects(first, { code: "TRANSPORT_CLOSED" }); await rejected;
    assert.equal(calls, 1);
  } finally { gate.resolve(); transport.close(); f.transport.close(); }
});

test("cancelación durante resolución de lista blanca impide iniciar el SDK", async () => {
  const f = deliveryFixture(), gate = deferred(), abort = new AbortController();
  installWhatsAppClient({ client: f.client, repository: createOwnMessageRepository({ db: f.db }), config: config(), resolvePhone: () => gate.promise });
  try {
    const sending = f.client.sendMessage(chatId, "No enviar", { appSignal: abort.signal });
    const rejected = assert.rejects(sending, { code: "CHAT_CONTROL_CHANGED", deliveryStarted: false });
    abort.abort(Object.assign(new Error("Tomado por persona"), { code: "CHAT_CONTROL_CHANGED" }));
    gate.resolve(phone); await rejected;
    assert.deepEqual(f.outgoing, []); assert.equal(f.db.rows.size, 0);
  } finally { gate.resolve(phone); f.transport.close(); }
});

test("guardián/modelo real cancelado por toma humana no acepta respuesta tardía", async () => {
  const clock = createVirtualClock(Date.parse("2026-01-01T12:00:00Z")), f = deliveryFixture({ now: clock.now });
  const control = createAgentChatControl({ db: f.db, now: clock.now }); await control.ensure(chatId, phone);
  const entered = deferred(), late = deferred(), lifetime = new AbortController();
  const bankConfig = JSON.parse(await readFile(new URL("./fixtures/agent-bank.json", import.meta.url), "utf8"));
  let runtime;
  try {
    runtime = await createProductionAgent({ db: f.db, chatId, control, clock, now: clock.now, signal: lifetime.signal,
      transport: f.transport, bankConfig, store: { read: async () => initialAgentState(chatId) },
      timestampNow: () => new Date(clock.now()), timestampFromMillis: value => new Date(value), resolvePhone: async () => phone,
      receiptStorage: memoryPrivateReceiptStorage(), model: scriptedModel([() => { entered.resolve(); return late.promise; }]) });
    const turn = runtime.receive(incoming("manual-during-model")), rejected = assert.rejects(turn, { code: "GUARDIAN_SHUTDOWN" });
    await clock.advanceAsync(8000); await entered.promise;
    const paused = await control.pause(chatId, { reason: "toma_manual" });
    lifetime.abort(Object.assign(new Error("Toma manual"), { code: "CHAT_CONTROL_CHANGED" }));
    await rejected;
    late.resolve(reply("responder", { texto: "Respuesta tardía", entendido: true }));
    await flushMicrotasks();
    assert.deepEqual(f.outgoing, []); assert.equal((await control.get(chatId)).version, paused.version);
    const store = await createControlledCheckpointStore({ db: f.db, chatId, control, fallback: { read: async () => null } });
    assert.equal((await store.read()).humanHandoffRequired, true);
  } finally { late.resolve(reply("responder", { texto: "Tardía", entendido: true })); runtime?.shutdown(); f.transport.close(); }
});

test("derivar real persiste el mismo bloqueo, conserva el carrito y solo envía el cierre de derivación", async () => {
  const clock = createVirtualClock(Date.parse("2026-01-01T12:00:00Z")), f = deliveryFixture({ now: clock.now, pause: async ms => clock.advance(ms) });
  const control = createAgentChatControl({ db: f.db, now: clock.now }); await control.ensure(chatId, phone);
  const bankConfig = JSON.parse(await readFile(new URL("./fixtures/agent-bank.json", import.meta.url), "utf8"));
  let runtime;
  const transport = createWhatsAppTransport({ client: f.client, MessageMedia: FakeMessageMedia, repository: f.repository,
    beforeSend: (_id, metadata) => runtime.assertCanSend(metadata), pause: async () => {} });
  const originalCart = { id: chatId, revision: 1, lines: [], shipping: {}, billing: {}, updatedAt: clock.now(), expiresAt: clock.now() + 100000 };
  await f.db.collection("carts").doc(chatId).set(originalCart);
  try {
    runtime = await createProductionAgent({ db: f.db, chatId, control, clock, now: clock.now, transport, bankConfig,
      store: { read: async () => initialAgentState(chatId) }, timestampNow: () => new Date(clock.now()), timestampFromMillis: value => new Date(value),
      resolvePhone: async () => phone, receiptStorage: memoryPrivateReceiptStorage(),
      model: scriptedModel([reply("derivar", { motivo: "Solicitud de persona", texto: "Una persona del equipo sigue por acá." })]) });
    const turn = runtime.receive(incoming("handoff", { body: "Quiero una persona" }));
    await clock.advanceAsync(8000); await turn;
    const paused = await control.get(chatId);
    assert.equal(paused.paused, true); assert.equal(paused.reason, "derivacion"); assert.ok(paused.pausedAt);
    assert.deepEqual(f.outgoing.map(item => item.content), ["Una persona del equipo sigue por acá."]);
    assert.deepEqual((await f.db.collection("carts").doc(chatId).get()).data(), originalCart);
    assert.equal(runtime.getState().lastQuote, null);
    assert.equal([...f.db.rows.keys()].filter(key => key.startsWith("agent_alerts/")).length, 1);
  } finally { runtime?.shutdown(); transport.close(); f.transport.close(); }
});
