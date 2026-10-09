import test from "node:test";
import assert from "node:assert/strict";
import { createModelUsageTracker, sumModelUsage, emptyModelUsage, unknownModelUsage } from "../src/utils/model-usage.util.js";
import { createLLMJudge, createStubJudge } from "./eval/judge.js";
import { runEvaluation } from "./eval/run-eval.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset, evalCase } from "./helpers/eval-fixtures.js";
import { scriptedModel, reply, FIXTURE_NOW } from "./helpers/consultation-fixtures.js";

test("contador registra invocaciones efectivas, tokens del proveedor y fallos sin inventar consumo", async () => {
  const tracker = createModelUsageTracker();
  await tracker.invoke(async () => ({ usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 15 } }));
  await tracker.invoke(async () => ({}));
  await assert.rejects(tracker.invoke(async () => { throw new Error("Proveedor caído"); }));
  const usage = tracker.snapshot();
  assert.equal(usage.calls, 3);
  assert.equal(usage.successfulCalls, 2);
  assert.equal(usage.failedCalls, 1);
  assert.deepEqual(usage.reportedTokens, { input: 10, output: 3, total: 15 });
  assert.equal(usage.callsWithoutUsage, 2);
  assert.equal(usage.usageComplete, false);
});
test("consumo desconocido de un adaptador sin instrumentar no se convierte en cero", () => {
  const merged = sumModelUsage([emptyModelUsage(), unknownModelUsage()]);
  assert.equal(merged.calls, null);
  assert.equal(merged.instrumented, false);
  assert.equal(merged.usageComplete, false);
});
test("metadata parcial no reconstruye el total y deja el consumo marcado como incompleto", async () => {
  const tracker = createModelUsageTracker();
  await tracker.invoke(async () => ({ usage_metadata: { input_tokens: 7, output_tokens: 2 } }));
  assert.deepEqual(tracker.snapshot().reportedTokens, { input: 7, output: 2, total: 0 });
  assert.equal(tracker.snapshot().callsWithoutUsage, 1);
  assert.equal(tracker.snapshot().usageComplete, false);
});
test("runner separa agente y evaluador, suma tres repeticiones y excluye invocaciones previas del juez", async () => {
  const judge = await createLLMJudge({ model: { async invoke() {
    return { content: JSON.stringify({ verdict: "pass", explanation: "Evaluador de prueba inyectado.", evidence: [] }),
      usage_metadata: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } };
  } } });
  const dataset = evalDataset([evalCase({ expect: { must: ["Responde"], must_not: ["Inventa"], handoff: "no" } })]);
  // Uso del proveedor anterior a esta corrida: no debe inflar su resumen.
  await judge.evaluate({ criterion: { kind: "must", text: "Previo" }, conversation: [], tools: [],
    referenceData: { catalog: { categories: [], products: [] }, policies: [], orders: [] },
    before: { cart: null, orders: [] }, after: { cart: null, orders: [] }, identity: {} });
  const report = await runEvaluation(dataset, { now: FIXTURE_NOW, judge,
    createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("ver_producto", { productId: "product-a" }), reply("responder", { texto: "Respuesta", entendido: true }),
    ]) }) });
  assert.equal(report.summary.modelUsage.agent.calls, 6);
  assert.deepEqual(report.summary.modelUsage.agent.reportedTokens, { input: 60, output: 12, total: 72 });
  assert.equal(report.summary.modelUsage.evaluator.calls, 6);
  assert.deepEqual(report.summary.modelUsage.evaluator.reportedTokens, { input: 120, output: 24, total: 144 });
  assert.ok(report.cases[0].repetitions.every(run => run.modelUsage.agent.calls === 2));
  assert.ok(report.cases[0].repetitions.every(run => run.modelUsage.evaluator.calls === 2));
  assert.equal(report.metadata.agentModelInjected, true);
  assert.equal(report.metadata.judgeModelInjected, true);
  assert.equal(report.summary.productionEligible, false);
});
test("JSON inválido del evaluador conserva ambas llamadas, sus tokens y el extracto en el informe de error", async () => {
  const content = "JSON incorrecto: " + "x".repeat(400);
  const judge = await createLLMJudge({ model: { async invoke() {
    return { content, usage_metadata: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } };
  } } });
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge,
    createAgent: input => createAgent({ ...input, model: scriptedModel([reply("responder", { texto: "Respuesta", entendido: true })]) }) });
  assert.equal(report.summary.modelUsage.evaluator.calls, 6);
  assert.equal(report.summary.modelUsage.evaluator.reportedTokens.total, 54);
  assert.ok(report.cases[0].repetitions.every(run => run.status === "error"
    && run.criteria.every(criterion => criterion.verdict === "error")));
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.modelUsage.evaluator.calls, 2);
    const diagnostic = run.diagnostics.find(item => item.code === "INVALID_JUDGE_JSON");
    assert.equal(diagnostic.rawExcerpt, content.slice(0, 300));
    assert.equal(diagnostic.rawExcerpt.length, 300);
  }
  assert.equal(report.summary.exitCode, 2);
  assert.equal(report.summary.thresholdsPassed, false);
  assert.equal(report.summary.productionApproved, false);
});
test("fallos del modelo se cuentan aun cuando el agente cierre por derivación técnica", async () => {
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge: createStubJudge(),
    createAgent: input => createAgent({ ...input, model: scriptedModel([() => { throw new Error("Falla de prueba"); }]) }) });
  assert.equal(report.summary.modelUsage.agent.calls, 3);
  assert.equal(report.summary.modelUsage.agent.failedCalls, 3);
  assert.equal(report.summary.modelUsage.agent.callsWithoutUsage, 3);
  assert.equal(report.summary.modelUsage.agent.usageComplete, false);
  assert.equal(report.summary.modelUsage.evaluator.calls, 0);
  assert.ok(report.cases[0].repetitions.every(run => run.turns[0].agentDiagnostics.length === 1));
});
