import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertLocalEnvironment } from "../scripts/local-catalog.config.js";
import { createWhatsAppDeliveryRepository, WHATSAPP_INBOX_COLLECTION, WHATSAPP_OUTBOX_COLLECTION, WHATSAPP_MAINTENANCE_COLLECTION } from "../src/services/whatsapp-delivery.repository.js";
import { createAgentCheckpointStore } from "../src/agents/consultation/checkpoint-store.js";
import { initialAgentState } from "../src/agents/consultation/production-adapter.js";
import { openCatalogTestFirestore } from "./helpers/catalog-firestore.js";

// Ni ALLOW_PROD_FIRESTORE_TESTS autoriza esta suite fuera del emulador demo.
assertLocalEnvironment(process.env);
test("Firestore real del emulador: IDs y mantenimiento concurrentes, checkpoint aislado y lecturas estrictas", async () => {
  const context = await openCatalogTestFirestore(), { db, Timestamp } = context;
  const chatId = "test-agent-whatsapp-" + randomUUID() + "@lid";
  const legacy = db.collection("langgraph_checkpoints").doc(chatId);
  let time = Date.now();
  const options = { db, timestampFromMillis: value => Timestamp.fromMillis(value), now: () => time };
  const first = createWhatsAppDeliveryRepository(options), second = createWhatsAppDeliveryRepository(options);
  try {
    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).claimMessage(chatId, "same-message")));
    assert.equal(claims.filter(Boolean).length, 1);
    const id = claims.find(Boolean), row = (await db.collection(WHATSAPP_INBOX_COLLECTION).doc(id).get()).data();
    assert.equal(row.expiresAt.toMillis() - row.receivedAt.toMillis(), 7 * 24 * 60 * 60 * 1000);
    assert.equal(await createWhatsAppDeliveryRepository(options).claimMessage(chatId, "same-message"), null);
    const notices = await Promise.all(Array.from({ length: 20 }, () => first.claimMaintenance(chatId)));
    assert.equal(notices.filter(Boolean).length, 1);
    time += 6 * 60 * 60 * 1000;
    assert.equal(await second.claimMaintenance(chatId), true);
    await legacy.create({ marker: "legacy-intacto" });
    const store = await createAgentCheckpointStore({ db, chatId });
    assert.equal(await store.read(), null);
    const state = { ...initialAgentState(chatId), consecutiveMisunderstandings: 2, humanHandoffRequired: true };
    await store.write(state);
    assert.deepEqual(await (await createAgentCheckpointStore({ db, chatId })).read(), state);
    assert.deepEqual((await legacy.get()).data(), { marker: "legacy-intacto" });
    const { FirestoreCheckpointSaver } = await import("../src/agents/checkpointer/firestore.checkpointer.js");
    const failing = new FirestoreCheckpointSaver({ collection: () => { throw new Error("Lectura interrumpida"); } }, undefined,
      { checkpointsCollection: "agent_checkpoints", writesCollection: "agent_checkpoint_writes", throwOnReadError: true });
    await assert.rejects(failing.getTuple({ configurable: { thread_id: chatId } }), { code: "CHECKPOINT_READ_FAILED" });
  } finally {
    try {
      // Solo el chat propio de esta ejecución. Borra subcolecciones primero.
      for (const collection of [WHATSAPP_INBOX_COLLECTION, WHATSAPP_OUTBOX_COLLECTION, WHATSAPP_MAINTENANCE_COLLECTION]) {
        const rows = await db.collection(collection).where("chatId", "==", chatId).get();
        for (const row of rows.docs) await row.ref.delete();
      }
      const checkpoints = db.collection("agent_checkpoints").doc(chatId).collection("checkpoints");
      for (const checkpoint of (await checkpoints.get()).docs) {
        const writes = await db.collection("agent_checkpoint_writes").where("outer_key", "==", chatId + "__default__" + checkpoint.id).get();
        for (const write of writes.docs) await write.ref.delete();
        await checkpoint.ref.delete();
      }
      await db.collection("agent_checkpoints").doc(chatId).delete(); await legacy.delete();
    } finally { await context.close(); }
  }
});
