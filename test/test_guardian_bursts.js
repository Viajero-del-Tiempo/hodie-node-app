import test from "node:test";
import assert from "node:assert/strict";
import { createBurstBuffer } from "../src/agents/guardian/burst-buffer.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

test("espera ocho segundos de silencio, conserva orden y separa chats", async () => {
  const clock = createVirtualClock(), batches = [];
  const buffer = createBurstBuffer({ clock, config: createGuardianConfig(), onBatch: batch => batches.push(batch) });
  const first = buffer.push({ from: "a", body: "Uno" });
  await clock.advanceAsync(7000);
  const second = buffer.push({ from: "a", body: "Dos" });
  const other = buffer.push({ from: "b", body: "Otro" });
  await clock.advanceAsync(7999); assert.equal(batches.length, 0);
  await clock.advanceAsync(1); await Promise.all([first, second, other]);
  assert.deepEqual(batches.map(batch => batch.messages.map(message => message.body)), [["Uno", "Dos"], ["Otro"]]);
  assert.equal(batches[0].closedAt, 15000); buffer.close();
});
test("cierra a los treinta segundos aunque sigan llegando mensajes y abre otro lote", async () => {
  const clock = createVirtualClock(), batches = [], promises = [];
  const buffer = createBurstBuffer({ clock, config: createGuardianConfig(), onBatch: batch => batches.push(batch) });
  for (let index = 0; index < 5; index++) {
    promises.push(buffer.push({ from: "a", body: String(index) }));
    if (index < 4) await clock.advanceAsync(7000);
  }
  await clock.advanceAsync(2000); assert.equal(batches[0].closedAt, 30000);
  const next = buffer.push({ from: "a", body: "Nuevo" });
  await clock.advanceAsync(8000); await Promise.all([...promises, next]);
  assert.equal(batches[0].messages.length, 5); assert.equal(batches[1].messages.length, 1); buffer.close();
});
test("apagado registra lotes pendientes descartados y cancela sus temporizadores", async () => {
  const clock = createVirtualClock(), logs = [];
  const buffer = createBurstBuffer({ clock, config: createGuardianConfig(), onBatch: () => assert.fail("No debe procesar"), logger: value => logs.push(value) });
  const a = buffer.push({ from: "a", body: "Uno" }), b = buffer.push({ from: "b", body: "Dos" });
  assert.equal(buffer.close(), 2);
  await assert.rejects(a, { code: "GUARDIAN_SHUTDOWN" }); await assert.rejects(b, { code: "GUARDIAN_SHUTDOWN" });
  await clock.advanceAsync(60000); assert.equal(clock.pendingTimers(), 0);
  assert.deepEqual(logs, [{ event: "guardian_shutdown", discardedPendingBatches: 2 }]);
  assert.equal(buffer.close(), 0);
});
test("el lote congelado no incorpora mensajes posteriores mientras espera procesamiento", async () => {
  const clock = createVirtualClock(), batches = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const buffer = createBurstBuffer({ clock, config: createGuardianConfig(), onBatch: async batch => { batches.push(batch); await blocked; } });
  const first = buffer.push({ from: "a", body: "Primero" }); await clock.advanceAsync(8000);
  const second = buffer.push({ from: "a", body: "Después" }); await clock.advanceAsync(8000);
  assert.deepEqual(batches.map(batch => batch.messages.map(message => message.body)), [["Primero"], ["Después"]]);
  release(); await flushMicrotasks(); await Promise.all([first, second]); buffer.close();
});
