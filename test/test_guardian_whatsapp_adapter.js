import test from "node:test";
import assert from "node:assert/strict";
import { createWhatsAppAdapter } from "../src/agents/guardian/whatsapp-adapter.js";

test("adaptador inactivo usa puertos inyectados, filtra antes de descargar y nunca usa LID como teléfono", async () => {
  const seen = [], sent = [];
  let downloads = 0, phoneLookups = 0;
  const adapter = createWhatsAppAdapter({ chatId: "test@lid", resolvePhone: async () => { phoneLookups++; return "test@lid"; },
    sendText: async (...args) => sent.push(args) });
  adapter.bindGuardian({ async receive(envelope) {
    seen.push(envelope);
    const identity = await adapter.resolveIdentity(); assert.equal(identity.phoneVerified, false); assert.equal(identity.userPhoneNumber, null);
    const file = await adapter.getAttachment(envelope.attachment.id).load(); assert.deepEqual(file.data, Buffer.from([1, 2]));
    return { guardian: { outcome: "processed" } };
  }, shutdown() {} });
  const message = { from: "test@lid", body: "", hasMedia: true, type: "audio", duration: "120", id: { _serialized: "test-message" },
    _data: { mimetype: "audio/ogg", size: 2 }, async downloadMedia() { downloads++; return { data: "AQI=", mimetype: "audio/ogg" }; } };
  await adapter.receive({ ...message, fromMe: true }); assert.equal(downloads, 0); assert.equal(phoneLookups, 0);
  await adapter.receive(message); assert.equal(downloads, 1); assert.equal(seen[0].attachment.durationSeconds, "120");
  assert.equal(adapter.getAttachment(seen[0].attachment.id), null);
  await adapter.sendText("Respuesta"); assert.deepEqual(sent, [["test@lid", "Respuesta"]]); adapter.shutdown();
});
test("filtrar no requiere conectar un cliente WhatsApp y el adaptador no acepta otro chat", async () => {
  const adapter = createWhatsAppAdapter({ chatId: "test@lid", resolvePhone: async () => "595900000001", sendText: async () => {} });
  adapter.bindGuardian({ receive: () => assert.fail("No aceptar filtro"), shutdown() {} });
  assert.equal((await adapter.receive({ from: "0@c.us", body: "Sistema" })).guardian.outcome, "filtered");
  assert.throws(() => adapter.receive({ from: "other@lid", body: "Mensaje" }), /otro chat/); adapter.shutdown();
});
