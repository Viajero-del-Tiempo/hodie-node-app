import test from "node:test";
import assert from "node:assert/strict";
import { createAgentWhatsAppConfig, allowsAgentPhone, DEFAULT_MAINTENANCE_MESSAGE, MAINTENANCE_INTERVAL_MS } from "../src/config/agent-whatsapp.config.js";
import { createWhatsAppPilot } from "../src/services/whatsapp-agent.service.js";
import { MESSAGE_ID_TTL_MS } from "../src/config/agent-whatsapp.config.js";
import { WHATSAPP_INBOX_COLLECTION, WHATSAPP_OUTBOX_COLLECTION } from "../src/services/whatsapp-delivery.repository.js";
import { deliveryFixture, incoming } from "./helpers/whatsapp-fixtures.js";

test("configuración: apagado no interpreta variables nuevas; lista ausente, vacía, normalizada e inválida", () => {
  assert.deepEqual(createAgentWhatsAppConfig({ AGENT_ENABLED: "false", AGENT_ALLOWLIST: 12, AGENT_MAINTENANCE_MESSAGE: null }), { enabled: false, allowlist: null });
  assert.equal(createAgentWhatsAppConfig({}).enabled, false);
  const all = createAgentWhatsAppConfig({ AGENT_ENABLED: "true" });
  assert.equal(all.allowlist, null); assert.equal(allowsAgentPhone(all, null), true);
  const none = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: " " });
  assert.deepEqual(none.allowlist, []); assert.equal(allowsAgentPhone(none, "595900000001"), false);
  const selected = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "+595 900 000 001,0900000001" });
  assert.deepEqual(selected.allowlist, ["595900000001"]);
  assert.equal(allowsAgentPhone(selected, "595900000001"), true); assert.equal(allowsAgentPhone(selected, "123@lid"), false);
  for (const value of ["", "on", "yes"]) assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: value }));
  for (const value of ["123@lid", "595900000001,", "texto", 1]) assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: value }));
  for (const value of ["", " ", 12]) assert.throws(() => createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_MAINTENANCE_MESSAGE: value }));
});

test("interruptor apagado entrega el control al legacy sin tocar DB, identidad, transporte ni runtime", async () => {
  const forbidden = () => assert.fail("El piloto apagado no tiene efectos");
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({}), repository: { claimMessage: forbidden },
    resolvePhone: forbidden, transport: { sendText: forbidden }, createRuntime: forbidden });
  assert.equal(await pilot.handle(incoming("disabled")), false);
});

test("matriz activa: lista ausente habilita todos; lista vacía mantiene; lista restringida resuelve LID sin confiar en body", async () => {
  for (const [allowlist, resolved, enabled] of [[undefined, null, true], ["", "595900000001", false],
    ["595900000001", "595900000001", true], ["595900000001", null, false], ["595900000002", "595900000001", false]]) {
    const f = deliveryFixture(); let received = 0;
    const config = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", ...(allowlist === undefined ? {} : { AGENT_ALLOWLIST: allowlist }) });
    const pilot = createWhatsAppPilot({ config, repository: f.repository, transport: f.transport, resolvePhone: async () => resolved,
      createRuntime: async () => ({ receive: async () => { received++; }, shutdown() {} }) });
    try {
      assert.equal(await pilot.handle(incoming("matrix", { from: "test@lid", body: "Mi teléfono es 595900000001" })), true);
      assert.equal(received, enabled ? 1 : 0); assert.equal(f.outgoing.length, enabled ? 0 : 1);
      if (!enabled) assert.equal(f.outgoing[0].content, DEFAULT_MAINTENANCE_MESSAGE);
    } finally { await pilot.shutdown(); }
  }
});

test("duplicados concurrentes entre receptores y tras reiniciar: una sola ejecución, TTL exacto de siete días", async () => {
  const f = deliveryFixture(); let calls = 0;
  const options = { config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true" }), repository: f.repository, transport: f.transport,
    resolvePhone: async () => "595900000001", createRuntime: async () => ({ receive: async () => { calls++; }, shutdown() {} }) };
  const first = createWhatsAppPilot(options), second = createWhatsAppPilot(options);
  try {
    await Promise.all(Array.from({ length: 25 }, (_, index) => (index % 2 ? first : second).handle(incoming("same-id"))));
    assert.equal(calls, 1);
    const row = [...f.db.rows.entries()].find(([path]) => path.startsWith(WHATSAPP_INBOX_COLLECTION + "/"))[1];
    assert.equal(row.expiresAt.getTime() - row.receivedAt.getTime(), MESSAGE_ID_TTL_MS);
    assert.equal(row.status, "completed");
    await createWhatsAppPilot(options).handle(incoming("same-id")); assert.equal(calls, 1);
    await first.handle(incoming("different-id")); assert.equal(calls, 2);
    f.advance(MESSAGE_ID_TTL_MS);
    await second.handle(incoming("same-id")); assert.equal(calls, 3);
  } finally { await first.shutdown(); await second.shutdown(); }
});

test("la admisión preserva orden pero no espera el turno: mensajes distintos pueden entrar a la misma ráfaga", async () => {
  const f = deliveryFixture(), received = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true" }), repository: f.repository,
    transport: f.transport, resolvePhone: async () => "595900000001",
    createRuntime: async () => ({ receive(message) { received.push(message.id._serialized); if (received.length === 2) release(); return pending; }, shutdown() { release(); } }) });
  try {
    await Promise.all([pilot.handle(incoming("one")), pilot.handle(incoming("two"))]);
    assert.deepEqual(received, ["one", "two"]);
  } finally { await pilot.shutdown(); }
});

test("mantenimiento configurable reservado una vez por seis horas, incluso con concurrencia y reconstrucción; registra envío propio", async () => {
  const f = deliveryFixture(), text = "Aviso configurable de prueba";
  const options = { config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "", AGENT_MAINTENANCE_MESSAGE: text }),
    repository: f.repository, transport: f.transport, resolvePhone: async () => null, createRuntime: () => assert.fail("Sin modelo") };
  const pilot = createWhatsAppPilot(options);
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => pilot.handle(incoming("maintenance-" + i))));
    assert.equal(f.outgoing.length, 1); assert.equal(f.outgoing[0].content, text);
    const delivery = [...f.db.rows.entries()].find(([path]) => path.startsWith(WHATSAPP_OUTBOX_COLLECTION + "/"))[1];
    assert.equal(delivery.origin, "maintenance"); assert.equal(delivery.own, true);
    assert.equal(delivery.whatsappMessageId, "own-1"); assert.equal(delivery.status, "accepted");
    f.advance(MAINTENANCE_INTERVAL_MS - 1);
    await createWhatsAppPilot(options).handle(incoming("before-six-hours")); assert.equal(f.outgoing.length, 1);
    f.advance(1); await pilot.handle(incoming("at-six-hours")); assert.equal(f.outgoing.length, 2);
  } finally { await pilot.shutdown(); }
});

test("filtros y errores del piloto activo nunca vuelven al router; no descarga grupos, difusión, sistema o propios", async () => {
  const f = deliveryFixture(); let lookedUp = 0;
  const pilot = createWhatsAppPilot({ config: createAgentWhatsAppConfig({ AGENT_ENABLED: "true" }), repository: f.repository,
    transport: f.transport, resolvePhone: async () => { lookedUp++; return null; }, createRuntime: async () => { throw new Error("Error técnico"); } });
  try {
    for (const overrides of [{ fromMe: true }, { from: "group@g.us" }, { from: "list@broadcast" }, { from: "status@broadcast" },
      { from: "channel@newsletter" }, { from: "0@c.us" }, { type: "e2e_notification" }, { broadcast: true }]) {
      assert.equal(await pilot.handle(incoming("filtered", { ...overrides, hasMedia: true, downloadMedia: () => assert.fail("No descargar") })), true);
    }
    assert.equal(lookedUp, 0); assert.equal(f.db.rows.size, 0);
    await assert.rejects(pilot.handle(incoming("bad-runtime")), /Error técnico/);
    await assert.rejects(pilot.handle(incoming(null, { id: {} })), { code: "MESSAGE_ID_REQUIRED" });
  } finally { await pilot.shutdown(); }
});
