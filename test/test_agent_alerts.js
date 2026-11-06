import test from "node:test";
import assert from "node:assert/strict";
import { createAgentAlertRepository } from "../src/services/agent-alert.repository.js";
import { createAgentAlertService, synchronizeAgentAlerts } from "../src/services/agent-alert.service.js";
import { agentMemoryFirestore } from "./helpers/agent-memory-firestore.js";
import { purchaseFixture } from "./helpers/purchase-fixtures.js";

test("solicitud durable deduplicada por ID sobrevive a otra instancia y nunca envía al equipo", async () => {
  const db = agentMemoryFirestore();
  const service = () => createAgentAlertService({ repository: createAgentAlertRepository({ db }) });
  const alert = { id: "test-episode", type: "HANDOFF", chatId: "test-chat", createdAt: 1, delivered: false };
  const results = await Promise.all(Array.from({ length: 5 }, () => service().request(alert)));
  assert.ok(results.every(value => value.id === alert.id)); assert.deepEqual(db.peek("agent_alerts", alert.id), alert);
  const ref = db.collection("agent_alerts").doc(alert.id);
  await db.runTransaction(async tx => { await tx.get(ref); tx.set(ref, { ...alert, delivered: true }); });
  assert.equal((await service().request(alert)).delivered, true);
});
test("checkpoint recupera solicitud e índice interrumpidos sin repetir mensaje ni borrar datos recientes", async () => {
  const f = purchaseFixture();
  try {
    const state = f.world.getState(); state.humanHandoffRequired = true; state.handoffEpisodeId = "episode-a";
    const handoff = { active: true, episodeId: "episode-a", motivo: "Motivo de prueba" };
    state.guardianAlerts = [{ id: "alert-a", chatId: state.whatsappChatId, type: "HANDOFF", episodeId: "episode-a", handoff, delivered: false }];
    f.world.setState(state);
    await synchronizeAgentAlerts(f.runtime); assert.equal(f.world.alertRequests.list().length, 1);
    const id = state.whatsappChatId; f.world.handoffs.set(id, { ...handoff, lastMessage: "Mensaje más reciente" });
    await synchronizeAgentAlerts(f.runtime);
    assert.equal(f.world.handoffs.get(id).lastMessage, "Mensaje más reciente"); assert.equal(f.transport.getOutgoing().length, 0);
    f.world.handoffs.set(id, { ...handoff, active: false }); await synchronizeAgentAlerts(f.runtime);
    assert.equal(f.world.handoffs.get(id).active, false); assert.equal(f.world.alertRequests.list().length, 1);
    const delivered = f.world.getState(); delivered.guardianAlerts[0].delivered = true; f.world.setState(delivered);
    f.world.alertRequests.delete("alert-a"); await synchronizeAgentAlerts(f.runtime);
    assert.equal(f.world.alertRequests.list().length, 0); // No recrear una alerta acusada si se purgó la bandeja.
  } finally { f.close(); }
});
test("cancelación o rollback no crean una solicitud de alerta", async () => {
  const faults = {}, db = agentMemoryFirestore({ faults }), alerts = createAgentAlertService({ repository: createAgentAlertRepository({ db }) });
  const value = { id: "test-error", type: "HANDOFF", chatId: "test-chat" };
  faults.beforeCommit = new Error("Rollback de prueba"); await assert.rejects(alerts.request(value));
  assert.equal(db.peek("agent_alerts", value.id), undefined);
  delete faults.beforeCommit; const controller = new AbortController(); controller.abort();
  await assert.rejects(alerts.request(value, { signal: controller.signal })); assert.equal(db.peek("agent_alerts", value.id), undefined);
});
