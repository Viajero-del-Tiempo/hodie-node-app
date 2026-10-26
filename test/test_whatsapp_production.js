import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createProductionAgent, initialAgentState } from "../src/agents/consultation/production-adapter.js";
import { createAgentCheckpointStore, AGENT_CHECKPOINT_COLLECTIONS } from "../src/agents/consultation/checkpoint-store.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";
import { productsWithImages } from "./helpers/product-images-fixtures.js";
import { scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { createVirtualClock } from "./helpers/virtual-clock.js";
import { memoryPrivateReceiptStorage } from "./helpers/receipt-memory.js";
import { deliveryFixture, incoming, FakeMessageMedia } from "./helpers/whatsapp-fixtures.js";

test("puerto nuevo conserva thread_id, restaura snapshot, rechaza medios y propaga error de lectura", async () => {
  const rows = new Map();
  const graph = { async getState(config) { return { values: { snapshot: rows.get(config.configurable.thread_id) } }; },
    async updateState(config, value, node) { assert.equal(node, "checkpoint"); rows.set(config.configurable.thread_id, structuredClone(value.snapshot)); } };
  const first = await createAgentCheckpointStore({ chatId: "test@lid", graph });
  assert.equal(await first.read(), null);
  const state = { ...initialAgentState("test@lid"), humanHandoffRequired: true };
  await first.write(state);
  assert.deepEqual(await (await createAgentCheckpointStore({ chatId: "test@lid", graph })).read(), state);
  assert.equal(await (await createAgentCheckpointStore({ chatId: "other@lid", graph })).read(), null);
  await assert.rejects(first.write({ ...state, data: Buffer.from([1]) }), /Bytes fuera del turno/);
  const error = new Error("Lectura fallida"); graph.getState = async () => { throw error; };
  await assert.rejects(first.read(), error);
  assert.deepEqual(AGENT_CHECKPOINT_COLLECTIONS, { checkpointsCollection: "agent_checkpoints", writesCollection: "agent_checkpoint_writes" });
});

test("saver compartido: modo estricto propaga el fallo; configuración legacy mantiene nombres y comportamiento", async () => {
  // Evalúa la clase real con dependencias inyectadas, sin inicializar Firebase.
  const source = (await readFile(new URL("../src/agents/checkpointer/firestore.checkpointer.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gmu, "").replace("export class FirestoreCheckpointSaver", "class FirestoreCheckpointSaver");
  let warnings = 0;
  const db = { collection: () => { throw new Error("Firestore fuera de servicio"); } };
  const Saver = vm.runInNewContext(source + "\nFirestoreCheckpointSaver;", { BaseCheckpointSaver: class {}, db,
    console: { error: () => { warnings++; } } });
  const old = new Saver(db);
  assert.equal(old.checkpointsCollection, "langgraph_checkpoints"); assert.equal(old.writesCollection, "langgraph_checkpoint_writes");
  assert.equal(await old.getTuple({ configurable: { thread_id: "test@lid" } }), undefined); assert.equal(warnings, 1);
  const strict = new Saver(db, undefined, { ...AGENT_CHECKPOINT_COLLECTIONS, throwOnReadError: true });
  await assert.rejects(strict.getTuple({ configurable: { thread_id: "test@lid" } }), { code: "CHECKPOINT_READ_FAILED" });
  assert.equal(warnings, 1); assert.equal(strict.checkpointsCollection, "agent_checkpoints");
});

test("piloto real usa el guardián y las herramientas comunes: ráfaga, fotos y checkpoint sin bytes; reinicio conserva sesión", async () => {
  const clock = createVirtualClock(Date.parse("2026-01-01T12:00:00Z"));
  const f = deliveryFixture({ now: clock.now, pause: async ms => clock.advance(ms) });
  const fixtures = productsWithImages();
  for (const category of fixtures.categories) await f.db.collection("categories").doc(category.id).set({ ...category, active: true });
  for (const product of fixtures.products) await f.db.collection("products").doc(product.id).set({ ...product, schemaVersion: 2, active: true,
    slug: product.id, variants: product.variants.map(variant => ({ ...variant, active: true })) });
  const stored = new Map(), chatId = incoming("unused").from, telemetry = [];
  const store = { read: async () => structuredClone(stored.get(chatId) ?? null), write: async state => { stored.set(chatId, structuredClone(state)); } };
  const model = scriptedModel([reply("buscar_productos", { consulta: "producto" }), reply("responder", {
    texto: "Estas son las opciones.", cierre: "¿Querés más?", entendido: true, productosMostrados: ["product-a", "product-b"],
  })]);
  const options = { db: f.db, chatId, store, now: clock.now, clock, model, guardianConfig: createGuardianConfig(),
    timestampNow: () => new Date(clock.now()), timestampFromMillis: value => new Date(value),
    resolvePhone: async () => "595900000001", transport: f.transport, receiptStorage: memoryPrivateReceiptStorage(),
    bankConfig: JSON.parse(await readFile(new URL("./fixtures/agent-bank.json", import.meta.url), "utf8")), logger: event => telemetry.push(event) };
  let runtime, restarted;
  try {
    runtime = await createProductionAgent(options);
    const first = runtime.receive(incoming("first", { body: "Mostrame opciones" }));
    const second = runtime.receive(incoming("second", { body: "Con fotos" }));
    await clock.advanceAsync(8000); await Promise.all([first, second]);
    assert.equal(model.invocations.length, 2);
    assert.deepEqual(f.outgoing.map(row => row.content instanceof FakeMessageMedia ? row.options.caption : row.content), [
      "Estas son las opciones.", "Producto de prueba 1 — 100 Gs.", "Producto de prueba 2 — 200 Gs.", "¿Querés más?",
    ]);
    const saved = await store.read();
    assert.equal(saved.turnSequence, 1); assert.equal(saved.guardianRateLimit.admittedAt.length, 1);
    assert.equal(saved.phoneVerified, true); assert.equal(saved.userPhoneNumber, "595900000001");
    assert.deepEqual(saved.messages.slice(0, 2), [{ role: "user", content: "Mostrame opciones" }, { role: "user", content: "Con fotos" }]);
    assert.equal(saved.sentProductImages.length, 2); assert.equal(JSON.stringify(saved).includes("base64"), false);
    const logs = telemetry.filter(event => ["agent_turn", "agent_tool"].includes(event.event));
    assert.deepEqual(logs.map(event => event.event), ["agent_tool", "agent_tool", "agent_turn"]);
    assert.deepEqual(logs.at(-1).tools, ["buscar_productos", "responder"]);
    assert.equal(logs.at(-1).groupedMessages, 2); assert.equal(logs.at(-1).result, "processed");
    assert.equal(logs.at(-1).consumption.agent.calls, 2); assert.equal(logs.at(-1).consumption.transcription.calls, 0);
    assert.equal(JSON.stringify(logs).includes(chatId), false); assert.equal(JSON.stringify(logs).includes("Mostrame opciones"), false);
    runtime.shutdown();
    const next = deliveryFixture({ db: f.db, now: clock.now, pause: async ms => clock.advance(ms) });
    const nextModel = scriptedModel([messages => {
      assert.ok(messages.some(message => message.content === "Mostrame opciones"));
      return reply("responder", { texto: "Seguimos con esas opciones.", entendido: true, productosMostrados: ["product-a"] });
    }]);
    restarted = await createProductionAgent({ ...options, model: nextModel, transport: next.transport });
    const turn = restarted.receive(incoming("third", { body: "Recordame la primera" }));
    await clock.advanceAsync(8000); await turn;
    assert.equal(nextModel.invocations.length, 1); assert.equal((await store.read()).turnSequence, 2);
    assert.ok(next.outgoing.every(row => !(row.content instanceof FakeMessageMedia)));
  } finally { runtime?.shutdown(); restarted?.shutdown(); f.transport.close(); }
});

test("lectura de checkpoint fallida no inicia modelo ni reinicia la conversación", async () => {
  let writes = 0, models = 0;
  await assert.rejects(createProductionAgent({ db: {}, chatId: "test@lid",
    store: { read: async () => { throw Object.assign(new Error("Checkpoint inaccesible"), { code: "CHECKPOINT_READ_FAILED" }); }, write: async () => { writes++; } },
    modelFactory: () => { models++; },
  }), { code: "CHECKPOINT_READ_FAILED" });
  assert.equal(writes, 0); assert.equal(models, 0);
});

test("handoff legacy del índice prevalece sobre un checkpoint nuevo activo y evita medios/modelo", async () => {
  const clock = createVirtualClock(0), f = deliveryFixture({ now: clock.now }), chatId = incoming("unused").from;
  let state = initialAgentState(chatId);
  await f.db.collection("handoff_threads").doc(chatId).set({ active: true, motivo: "Atención previa" });
  const model = scriptedModel([]);
  const runtime = await createProductionAgent({ db: f.db, chatId,
    store: { read: async () => structuredClone(state), write: async value => { state = structuredClone(value); } },
    clock, now: clock.now, model, transport: f.transport,
    timestampNow: () => new Date(clock.now()), timestampFromMillis: value => new Date(value),
    bankConfig: JSON.parse(await readFile(new URL("./fixtures/agent-bank.json", import.meta.url), "utf8")),
    resolvePhone: () => assert.fail("Handoff no resuelve identidad dentro del guardián"), receiptStorage: memoryPrivateReceiptStorage(),
  });
  try {
    const turn = runtime.receive(incoming("handoff", { type: "image", hasMedia: true, _data: { mimetype: "image/png", size: 1 },
      downloadMedia: () => assert.fail("Handoff no descarga medios") }));
    await clock.advanceAsync(8000); await turn;
    assert.equal(state.humanHandoffRequired, true); assert.equal(state.humanHandoffReason, "Atención previa");
    assert.equal(model.invocations.length, 0); assert.deepEqual(f.outgoing, []);
  } finally { runtime.shutdown(); }
});
