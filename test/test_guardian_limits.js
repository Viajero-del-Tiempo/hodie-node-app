import test from "node:test";
import assert from "node:assert/strict";
import { admitBatch, acknowledgeGuardianAlert, RATE_LIMIT_NOTICE } from "../src/agents/guardian/rate-limit.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";
import { guardianFixture } from "./helpers/guardian-fixtures.js";

test("ventana móvil admite cuarenta lotes, bloquea el 41 y crea una alerta por episodio sin handoff", () => {
  const config = createGuardianConfig(); let state = { messages: [], humanHandoffRequired: false };
  for (let i = 0; i < 40; i++) { const admitted = admitBatch(state, i, config); assert.equal(admitted.allowed, true); state = admitted.state; }
  const blocked = admitBatch(state, 40, config); assert.equal(blocked.allowed, false); assert.equal(blocked.sendNotice, true);
  assert.equal(blocked.state.humanHandoffRequired, false); assert.equal(blocked.state.guardianAlerts.length, 1);
  const again = admitBatch(blocked.state, 41, config); assert.equal(again.sendNotice, false); assert.equal(again.state.guardianAlerts.length, 1);
  assert.equal(admitBatch(again.state, config.windowMs - 1, config).allowed, false);
  const available = admitBatch(again.state, config.windowMs, config); assert.equal(available.allowed, true);
  assert.equal(available.state.guardianRateLimit.admittedAt.length, 40);
  const newEpisode = admitBatch(available.state, config.windowMs, config); assert.equal(newEpisode.sendNotice, true);
  assert.equal(newEpisode.state.guardianAlerts.length, 2);
  assert.equal(acknowledgeGuardianAlert(newEpisode.state, blocked.episodeId).guardianAlerts[0].delivered, true);
});
test("bloqueo envía un único aviso neutro, no descarga ni llama modelos y se recupera al volver a tener cupo", async () => {
  const f = guardianFixture({ overrides: { turnsPerHour: 1 } });
  try {
    await f.run();
    const media = f.turn([{ text: "Audio", type: "audio", attachmentId: "a" }], [{ id: "a", type: "audio", mode: "file", durationSeconds: 1 }]);
    await f.run(media); await f.run(media);
    assert.deepEqual(f.outgoing, ["Respuesta de prueba.", RATE_LIMIT_NOTICE]);
    assert.equal(f.guardian.getModelUsage().calls, 1); assert.deepEqual(f.downloads, []);
    assert.equal(f.state().guardianAlerts.length, 1); assert.equal(f.state().humanHandoffRequired, false);
    await f.clock.advanceAsync(f.config.windowMs); await f.run();
    assert.equal(f.guardian.getModelUsage().calls, 2); assert.equal(f.outgoing.length, 3);
  } finally { f.guardian.shutdown(); }
});
test("restaurar el estado no reinicia el límite ni duplica el aviso", async () => {
  const first = guardianFixture({ overrides: { turnsPerHour: 1 } });
  await first.run(); await first.run();
  const second = guardianFixture({ overrides: { turnsPerHour: 1 }, state: first.state(), clock: first.clock });
  try { await second.run(); assert.deepEqual(second.outgoing, []); assert.equal(second.guardian.getModelUsage().calls, 0); assert.equal(second.state().guardianAlerts.length, 1); }
  finally { first.guardian.shutdown(); second.guardian.shutdown(); }
});
test("fallar el envío del aviso no activa handoff ni repite el intento por límite", async () => {
  const f = guardianFixture({ overrides: { turnsPerHour: 1 } });
  try {
    await f.run(); let attempts = 0;
    f.runtime.transport.sendText = async () => { attempts++; throw new Error("Transporte no disponible"); };
    const blocked = await f.run(); await f.run();
    assert.equal(blocked.guardian.outcome, "limited"); assert.equal(blocked.guardian.noticeIssued, false);
    assert.equal(blocked.diagnostics[0].code, "RATE_NOTICE_SEND_FAILED");
    assert.equal(attempts, 1); assert.equal(f.state().humanHandoffRequired, false); assert.equal(f.state().guardianAlerts.length, 1);
  } finally { f.guardian.shutdown(); }
});
test("timeout al enviar el aviso conserva el bloqueo sin handoff ni nuevos intentos", async () => {
  const f = guardianFixture({ overrides: { turnsPerHour: 1 } });
  try {
    await f.run(); let attempts = 0;
    f.runtime.transport.sendText = () => { attempts++; return new Promise(() => {}); };
    const pending = f.run();
    await f.clock.advanceAsync(0);
    await f.clock.advanceAsync(f.config.turnTimeoutMs);
    const blocked = await pending;
    assert.equal(blocked.guardian.outcome, "limited");
    assert.equal(blocked.diagnostics[0].code, "GUARDIAN_TIMEOUT");
    assert.equal(f.state().humanHandoffRequired, false);
    assert.equal(f.state().guardianRateLimit.blocked, true);
    await f.run(); assert.equal(attempts, 1);
    assert.equal(f.guardian.getModelUsage().calls, 1);
    assert.equal(f.state().guardianAlerts.length, 1);
  } finally { f.guardian.shutdown(); }
});
