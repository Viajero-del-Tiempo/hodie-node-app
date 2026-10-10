import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { guardianFixture } from "./helpers/guardian-fixtures.js";
import { flushMicrotasks } from "./helpers/virtual-clock.js";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge } from "./eval/judge.js";
import { evalDataset, evalCase, evalCart } from "./helpers/eval-fixtures.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";

test("límite se guarda antes de transcribir y el consumo suma audio y agente", async () => {
  let f;
  f = guardianFixture({ audioModel: { async invoke() {
    assert.equal(f.state().guardianRateLimit.admittedAt.length, 1);
    return { content: "Texto hablado", usage_metadata: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
  } } });
  f.attachments.set("a", { data: Buffer.from([1]), mimeType: "audio/ogg" });
  try {
    const result = await f.run(f.turn([{ text: "Audio", type: "audio", attachmentId: "a" }], [{ id: "a", type: "audio", durationSeconds: 1 }]));
    assert.equal(result.usage.calls, 2); assert.equal(result.usage.reportedTokens.total, 9);
    assert.equal(result.guardian.transcriptionUsage.calls, 1);
    assert.equal(f.incoming[0].turn.messages[0].text, "[audio transcripto] Texto hablado");
  } finally { f.guardian.shutdown(); }
});
test("admisión espera la escritura del checkpoint antes de cualquier llamada costosa", async () => {
  const f = guardianFixture(); let commit;
  const original = f.runtime.setState;
  f.runtime.setState = async state => { await new Promise(resolve => { commit = resolve; }); original(state); };
  const pending = f.run();
  await flushMicrotasks(); assert.equal(f.guardian.getModelUsage().calls, 0);
  assert.equal(f.state().guardianRateLimit, undefined);
  commit(); await pending;
  assert.equal(f.state().guardianRateLimit.admittedAt.length, 1); assert.equal(f.guardian.getModelUsage().calls, 1); f.guardian.shutdown();
});
test("handoff mantiene silencio, actualiza índice y no resuelve identidad ni descarga medios", async () => {
  const f = guardianFixture({ state: { humanHandoffRequired: true, lastActivityAt: 0 } });
  f.runtime.resolveIdentity = () => assert.fail("No resolver durante handoff");
  try {
    const result = await f.run(f.turn([{ text: "[imagen adjunta]", type: "image", attachmentId: "i" }], [{ id: "i", type: "image" }]));
    assert.equal(result.guardian.outcome, "handoff"); assert.deepEqual(f.outgoing, []); assert.deepEqual(f.downloads, []);
    assert.equal(f.guardian.getModelUsage().calls, 0); assert.equal(f.handoffs.length, 1);
    assert.equal(f.handoffs[0].lastMessage, "[imagen adjunta]"); assert.equal(f.state().humanHandoffRequired, true);
  } finally { f.guardian.shutdown(); }
});
test("timeout de sesenta segundos desde cierre incluye descarga y evita efectos tardíos", async () => {
  let complete;
  const f = guardianFixture();
  f.attachments.set("i", { load: () => new Promise(resolve => { complete = resolve; }) });
  const pending = f.run(f.turn([{ text: "Imagen", type: "image", attachmentId: "i" }], [{ id: "i", type: "image" }]));
  await flushMicrotasks();
  await f.clock.advanceAsync(59999); assert.equal(f.outgoing.length, 0);
  await f.clock.advanceAsync(1); const result = await pending;
  assert.equal(result.guardian.outcome, "technical_error"); assert.equal(result.diagnostics[0].code, "GUARDIAN_TIMEOUT");
  assert.equal(f.state().humanHandoffRequired, true); assert.equal(f.outgoing.length, 1);
  complete({ data: Buffer.from([1]), mimeType: "image/png" }); await flushMicrotasks();
  assert.equal(f.guardian.getModelUsage().calls, 0); assert.equal(f.outgoing.length, 1); f.guardian.shutdown();
});
test("cancelación externa no autoriza mensaje ni handoff tardíos", async () => {
  const f = guardianFixture({ step: (_input, _runtime) => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = f.guardian.processTurn({ turn: f.turn(), signal: controller.signal });
  await flushMicrotasks(); controller.abort(new Error("Cancelado"));
  await assert.rejects(pending, /Cancelado/); assert.deepEqual(f.outgoing, []); assert.equal(f.state().humanHandoffRequired, false); f.guardian.shutdown();
});
test("apagado por señal registra lotes RAM descartados", async () => {
  const events = new EventEmitter(), f = guardianFixture({ processEvents: events });
  const pending = f.guardian.receive({ from: "test-guardian@lid", body: "Pendiente", type: "chat" });
  events.emit("SIGTERM"); await assert.rejects(pending, { code: "GUARDIAN_SHUTDOWN" });
  assert.equal(f.logs.at(-1).discardedPendingBatches, 1); assert.equal(events.listenerCount("SIGTERM"), 0);
});
test("entrada visual pasa bytes al modelo como datos del turno y nunca al estado", async () => {
  const model = scriptedModel([reply("responder", { texto: "Respuesta", entendido: true })]);
  const f = await consultationFixture({ model });
  try {
    const turn = { turn: 1, messages: [{ text: "Referencia sintética", type: "image", attachmentId: "synthetic" }],
      attachments: [{ id: "synthetic", type: "image", mode: "file" }] };
    f.transport.getAttachment = () => ({ data: Buffer.from([1, 2, 3]), mimeType: "image/png" });
    const signal = new AbortController().signal; f.world.beginTurn(1, signal);
    const result = await f.agent.runTurn({ turn, now: f.world.now(), history: [], signal });
    const messages = model.invocations[0].messages;
    assert.equal(messages[0].content.includes("data:image"), false);
    assert.equal(messages.at(-1).content[1].type, "image_url");
    assert.match(messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(JSON.stringify(f.world.getState()).includes("base64"), false);
    assert.equal(JSON.stringify(result).includes("base64"), false);
    assert.equal(result.guardian.groupedMessages, 1);
  } finally { await f.agent.dispose(); f.close(); }
});
test("imagen rechazada por tamaño no acredita cobertura visual aunque llegó como archivo", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ turns: [{ user: "Imagen sintética", attachment: "image" }] })]), {
    judge: createStubJudge(), mediaResolver: async () => ({ data: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: "image/png" }),
    createAgent: input => createAgent({ ...input, model: scriptedModel([reply("responder", { texto: "No se pudo usar la imagen.", entendido: true })]) }),
  });
  assert.equal(report.metadata.mediaComplete, false);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.turns[0].incoming[0].attachment.mode, "file");
    assert.deepEqual(run.turns[0].guardian.imageAttachmentIds, []);
    assert.ok(run.guardianEvents.some(event => event.code === "MEDIA_SIZE_LIMIT"));
  }
});
test("sesión nueva conserva el carrito y descarta historial anterior sin volverlo handoff", async () => {
  const model = scriptedModel([reply("responder", { texto: "Respuesta", entendido: true })]);
  const f = await consultationFixture({ model, context: { sesionNueva: true, carrito: evalCart(),
    historialPrevio: { haceHoras: 48, duranteHandoff: true, mensajes: [{ cliente: "ANTERIOR_SENTINEL" }] } } });
  const cart = f.world.getCart();
  try {
    const result = await f.run();
    assert.equal(result.guardian.newSession, true); assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.deepEqual(f.world.getCart(), cart); assert.equal(JSON.stringify(model.invocations).includes("ANTERIOR_SENTINEL"), false);
  } finally { await f.agent.dispose(); f.close(); }
});
test("lotes del mismo chat no invocan el agente simultáneamente", async () => {
  let release;
  const firstGate = new Promise(resolve => { release = resolve; });
  let running = 0, peak = 0;
  const f = guardianFixture({ step: async (input, runtime) => {
    running++; peak = Math.max(peak, running);
    if (input.turn.messages[0].text === "Primero") await firstGate;
    await runtime.transport.sendText(input.turn.messages[0].text); running--;
  } });
  const a = f.guardian.receive({ from: "test-guardian@lid", body: "Primero", type: "chat", id: "first" });
  await f.clock.advanceAsync(8000);
  const b = f.guardian.receive({ from: "test-guardian@lid", body: "Segundo", type: "chat", id: "second" });
  await f.clock.advanceAsync(8000); assert.equal(f.incoming.length, 1);
  release(); await Promise.all([a, b]);
  assert.equal(peak, 1); assert.deepEqual(f.outgoing, ["Primero", "Segundo"]);
  assert.equal(f.state().guardianRateLimit.admittedAt.length, 2); f.guardian.shutdown();
});
