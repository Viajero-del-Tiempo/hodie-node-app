import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runEvaluation } from "./eval/run-eval.js";
import { createAgent as trivialAgent } from "./eval/agents/trivial-agent.js";
import { createStubJudge } from "./eval/judge.js";
import { writeReport } from "./eval/report.js";
import { evalDataset, evalCase, evalCart } from "./helpers/eval-fixtures.js";
import { memoryOnlyResolve } from "./eval/production-guard.js";

const now = Date.parse("2026-01-01T12:00:00Z");
const options = { createAgent: trivialAgent, judge: createStubJudge(), now };
test("runner trivial completa tres repeticiones y no expone expectativas al adaptador", async () => {
  let instances = 0;
  const report = await runEvaluation(evalDataset(), { ...options, createAgent: async input => {
    instances++;
    assert.equal(input.expect, undefined);
    assert.equal(input.world.expect, undefined);
    return trivialAgent(input);
  } });
  assert.equal(instances, 3);
  assert.equal(report.summary.executed, 3);
  assert.equal(report.summary.completed, true);
  assert.equal(report.summary.productionApproved, false);
  assert.ok(report.cases[0].repetitions.every(run => run.turns[0].outgoing[0].text === run.tools.find(tool => tool.name === "responder").args.texto));
});
test("resolver bloquea SDKs productivos y el inicializador Firebase antes de ejecutarlos", () => {
  let resolved = false;
  assert.throws(() => memoryOnlyResolve("firebase-admin/firestore", {}, () => { resolved = true; }), { code: "PRODUCTION_IMPORT_BLOCKED" });
  assert.equal(resolved, false);
  assert.throws(() => memoryOnlyResolve("./firebase.js", {}, () => ({
    url: new URL("../src/config/firebase.js", import.meta.url).href,
  })), { code: "PRODUCTION_IMPORT_BLOCKED" });
  const allowed = { url: "node:fs" };
  assert.equal(memoryOnlyResolve("node:fs", {}, () => allowed), allowed);
});
test("protección real del proceso bloquea import y require sin cargar el SDK", () => {
  const guard = new URL("./eval/production-guard.js", import.meta.url).href;
  const code = "import { enableMemoryOnly } from " + JSON.stringify(guard) + ";"
    + "import { createRequire } from 'node:module'; enableMemoryOnly();"
    + "for (const action of [() => import('firebase-admin/firestore'), () => createRequire(import.meta.url)('firebase-admin/firestore')]) {"
    + "try { await action(); process.exitCode = 1; } catch (error) { if (error.code !== 'PRODUCTION_IMPORT_BLOCKED') throw error; }}";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
test("mutaciones de carrito y pedido se aíslan por repetición y de los fixtures originales", async () => {
  const dataset = evalDataset([evalCase({ context: { carrito: evalCart() } })]);
  const chats = new Set();
  const report = await runEvaluation(dataset, { ...options, createAgent: async ({ world }) => ({
    kind: "trivial",
    async runTurn() {
      chats.add(world.getState().whatsappChatId);
      assert.equal(world.getCart().lines[0].quantity, 1);
      assert.equal(world.orders.get("test-order-a").status, "pending");
      const cart = world.getCart();
      cart.lines[0].quantity = 2;
      world.setCart(cart);
      world.orders.set("test-order-a", { ...world.orders.get("test-order-a"), status: "changed-in-test" });
      await world.invokeTool("responder", { texto: "Respuesta", entendido: true });
    },
  }) });
  assert.equal(chats.size, 3);
  assert.equal(dataset.fixtures.orders[0].status, "pending");
  assert.equal(dataset.cases[0].input.context.carrito.lineas[0].cantidad, 1);
  assert.ok(report.cases[0].repetitions.every(run => run.after.cart.lines[0].quantity === 2));
});
test("historial actual se conserva entre turnos y una ráfaga llama una sola vez al agente", async () => {
  const seen = [];
  const dataset = evalDataset([evalCase({
    context: { sesionNueva: true, conversacion: [{ agente: "Antecedente" }] },
    turns: [{ user: "Uno", burst: ["Dos", "Tres"] }, { user: "Cuatro" }],
  })]);
  await runEvaluation(dataset, { ...options, createAgent: async ({ world }) => ({
    kind: "trivial",
    async runTurn({ turn, history, scenario }) {
      seen.push({ messages: turn.messages.map(message => message.text), history, scenario });
      await world.invokeTool("responder", { texto: "Respuesta", entendido: true });
    },
  }) });
  assert.equal(seen.length, 6);
  assert.deepEqual(seen[0].messages, ["Uno", "Dos", "Tres"]);
  assert.deepEqual(seen[1].history.map(message => message.content), ["Antecedente", "Uno", "Dos", "Tres", "Respuesta"]);
  assert.equal(seen[0].scenario.newSession, true);
  assert.equal(seen[1].scenario.newSession, false);
});
test("turnos mal formados bloquean el caso y permiten informar y ejecutar los demás", async () => {
  const report = await runEvaluation(evalDataset([
    evalCase({ turns: [null] }), evalCase({ id: "EVAL-2", turns: "invalid" }), evalCase({ id: "EVAL-3" }),
  ]), options);
  assert.equal(report.cases.length, 3);
  assert.ok(report.cases[0].repetitions.every(run => run.status === "blocked"));
  assert.ok(report.cases[1].repetitions.every(run => run.status === "blocked"));
  assert.ok(report.cases[2].repetitions.every(run => run.status === "pass"));
});
test("contextos inválidos y cotizacionMostrada sin herramienta quedan bloqueados sin inventar una ejecución", async () => {
  const dataset = evalDataset([
    evalCase({ context: { desconocido: true } }),
    evalCase({ id: "EVAL-2", context: { carrito: evalCart(), cotizacionMostrada: true } }),
    evalCase({ id: "EVAL-3" }),
  ]);
  const report = await runEvaluation(dataset, options);
  assert.equal(report.summary.cases, 3);
  assert.equal(report.summary.scheduled, 9);
  assert.equal(report.summary.executed, 3);
  assert.equal(report.summary.exitCode, 2);
  assert.ok(report.cases[0].repetitions.every(run => run.status === "blocked" && run.diagnostics[0].line > 0));
  assert.ok(report.cases[1].repetitions.every(run => run.status === "blocked" && run.diagnostics[0].code === "QUOTE_TOOL_UNAVAILABLE"));
  assert.ok(report.cases[2].repetitions.every(run => run.status === "pass"));
});
test("cotización inicial real no satisface la expectativa de volver a cotizar durante el caso", async () => {
  const report = await runEvaluation(evalDataset([evalCase({
    context: { carrito: evalCart(), cotizacionMostrada: true },
    expect: { tools_called: ["cotizar"], handoff: "no" },
  })]), { ...options, createAgent: async ({ world }) => {
    world.registerTool("cotizar", async () => ({ code: "OK", quoteId: "test-quote", cartFingerprint: "test-fingerprint" }), { real: true });
    return trivialAgent({ world });
  } });
  assert.ok(report.cases[0].repetitions.every(run => run.status === "fail" && run.tools[0].phase === "setup"));
});
test("fallo del evaluador conserva los demás criterios y casos; no reduce el denominador", async () => {
  const judge = { kind: "llm", async evaluate({ criterion }) {
    if (criterion.text === "Error de prueba") throw new Error("Proveedor caído");
    return { verdict: "pass", explanation: "Prueba", evidence: [] };
  } };
  const report = await runEvaluation(evalDataset([
    evalCase({ expect: { must: ["Error de prueba", "Otro criterio"], handoff: "no" } }),
    evalCase({ id: "EVAL-2" }),
  ]), { ...options, judge });
  assert.ok(report.cases[0].repetitions.every(run => run.status === "error" && run.criteria.length === 2));
  assert.ok(report.cases[1].repetitions.every(run => run.status === "pass"));
  assert.equal(report.summary.gates.rest.total, 2);
  assert.equal(report.summary.productionApproved, false);
});
test("criterio no observable y timeout del agente tienen diagnósticos distintos del fallo de calidad", async () => {
  const unobservable = await runEvaluation(evalDataset(), { ...options, judge: {
    kind: "llm", async evaluate() { return { verdict: "not_observable", explanation: "Falta evidencia.", evidence: [] }; },
  } });
  assert.ok(unobservable.cases[0].repetitions.every(run => run.status === "blocked" && run.criteria[0].verdict === "not_observable"));
  const timedOut = await runEvaluation(evalDataset(), { ...options, timeoutMs: 10, createAgent: async () => ({
    kind: "trivial", async runTurn() { await new Promise(() => {}); },
  }) });
  assert.ok(timedOut.cases[0].repetitions.every(run => run.status === "error" && run.diagnostics[0].code === "TURN_TIMEOUT"));
  assert.equal(timedOut.summary.exitCode, 2);
});
test("selección parcial y adjuntos descriptivos se registran como cobertura incompleta", async () => {
  const report = await runEvaluation(evalDataset([
    evalCase({ turns: [{ user: "Descripción", attachment: "image" }] }), evalCase({ id: "EVAL-2" }),
  ]), { ...options, caseIds: ["EVAL-1"] });
  assert.equal(report.metadata.fullSuite, false);
  assert.equal(report.metadata.mediaComplete, false);
  assert.equal(report.summary.productionEligible, false);
});
test("informe guarda JSON, trazas y explicaciones sin serializar al agente", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-eval-report-"));
  try {
    const report = await runEvaluation(evalDataset(), options);
    const output = await writeReport(report, directory);
    assert.deepEqual((await readdir(output)).sort(), ["report.json", "summary.md", "trace.jsonl"]);
    const saved = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
    assert.deepEqual(saved.summary, report.summary);
    const trace = (await readFile(join(output, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(trace.some(event => event.type === "tool" && event.name === "responder"));
    assert.ok(trace.some(event => event.type === "turn" && event.outgoing.length === 1));
    assert.match(await readFile(join(output, "summary.md"), "utf8"), /Aprobación de producción: false/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
