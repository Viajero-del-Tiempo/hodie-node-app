import test from "node:test";
import assert from "node:assert/strict";
import { prepareSession, sessionHistory } from "../src/agents/guardian/session.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";
import { createCheckpointStateStore } from "../src/agents/guardian/state-store.js";
import { assertCheckpointState } from "../src/agents/guardian/attachments.js";

const config = createGuardianConfig();
const state = () => ({ messages: [{ role: "user", content: "Anterior" }], sessionCutoff: 0, lastActivityAt: 0,
  consecutiveMisunderstandings: 3, humanHandoffRequired: false, lastQuote: { quoteId: "old" } });
test("solo más de seis horas inicia sesión; corta historial y no conserva una cotización vieja", () => {
  assert.equal(prepareSession(state(), config.sessionMs, config).newSession, false);
  const next = prepareSession(state(), config.sessionMs + 1, config);
  assert.equal(next.newSession, true); assert.equal(next.state.sessionCutoff, 1);
  assert.equal(next.state.consecutiveMisunderstandings, 0); assert.equal(next.state.lastQuote, null);
  assert.deepEqual(sessionHistory(next.state), []);
});
test("handoff nunca vence y la señal de reactivación se aplica una sola vez después de desactivarlo", () => {
  const current = { ...state(), humanHandoffRequired: true, resumeRequestedAt: 100 };
  assert.equal(prepareSession(current, 100000000, config, { newSession: true }).newSession, false);
  current.humanHandoffRequired = false;
  const resumed = prepareSession(current, 101, config);
  assert.equal(resumed.newSession, true); assert.equal(resumed.state.resumeAppliedAt, 100);
  assert.equal(prepareSession(resumed.state, 102, config).newSession, false);
});
test("historial de la sesión queda limitado a veinte mensajes", () => {
  const current = { ...state(), messages: Array.from({ length: 30 }, (_, i) => ({ role: "user", content: String(i) })), sessionCutoff: 4 };
  assert.equal(sessionHistory(current).length, 20); assert.equal(sessionHistory(current)[0].content, "10");
});
test("puerto de checkpoint restaura estado, distingue namespace y nunca guarda medios", async () => {
  const entries = new Map();
  const graph = { async getState(config) { return { values: entries.get(JSON.stringify(config)) }; },
    async updateState(config, value, asNode) { assert.equal(asNode, "guardian_state"); entries.set(JSON.stringify(config), structuredClone(value)); } };
  const options = { graph, threadId: "test-chat@lid", namespace: "test-guardian-isolated", asNode: "guardian_state" };
  const store = createCheckpointStateStore(options);
  const persisted = { ...state(), humanHandoffRequired: true, guardianRateLimit: { admittedAt: [1], blocked: false } };
  await store.write(persisted);
  assert.deepEqual(await createCheckpointStateStore(options).read(), persisted);
  assert.equal(await createCheckpointStateStore({ ...options, namespace: "other" }).read(), null);
  await assert.rejects(store.write({ ...state(), data: Buffer.from([1]) }), /Bytes fuera del turno/);
  assert.throws(() => assertCheckpointState({ ...state(), attachmentId: "transient" }), /efímero/);
});
