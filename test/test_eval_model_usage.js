import test from "node:test";
import assert from "node:assert/strict";
import { createModelUsageTracker, sumModelUsage, modelUsageSince, emptyModelUsage, unknownModelUsage, estimateFixedInput } from "../src/utils/model-usage.util.js";
import { createLLMJudge, createStubJudge } from "./eval/judge.js";
import { runEvaluation } from "./eval/run-eval.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset, evalCase } from "./helpers/eval-fixtures.js";
import { scriptedModel, reply, FIXTURE_NOW } from "./helpers/consultation-fixtures.js";
import { latencyStats, countStats, turnModelCalls, evaluationMetrics } from "./eval/metrics.js";
import { writeReport } from "./eval/report.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TECHNICAL_FAILURE_NOTICE } from "../src/agents/consultation/technical-failure.js";
import { createVirtualClock } from "./helpers/virtual-clock.js";

test("llamadas por turno calcula percentiles con ceros conocidos y omite consumo desconocido", () => {
  assert.deepEqual(countStats([0, 1, 2, 4, null]), { samples: 4, unknownSamples: 1, p50: 1, p95: 4, max: 4 });
  assert.deepEqual(turnModelCalls(emptyModelUsage(), { number: 1 }), { agent: 0, consultation: 0, transcription: 0 });
  assert.deepEqual(turnModelCalls(unknownModelUsage(), { number: 1 }), { agent: null, consultation: null, transcription: null });
  assert.deepEqual(turnModelCalls({ ...emptyModelUsage(), calls: 2, observedCalls: 2 }, { number: 1 }),
    { agent: null, consultation: null, transcription: null });
});
test("latencias por posición separan consulta/transcripción, turnos y llamadas interrumpidas", () => {
  const callDetails = [{ component: "agent", turn: 1, callInTurn: 1, durationMs: 10 },
    { component: "agent", turn: 1, callInTurn: 2, durationMs: 100 },
    { component: "agent", turn: 2, callInTurn: 1, durationMs: 20, incomplete: true },
    { component: "transcription", turn: 1, callInTurn: 1, durationMs: 500 }];
  const usage = { ...emptyModelUsage(), calls: 4, observedCalls: 4, callDetails };
  const metrics = evaluationMetrics([{ repetitions: [{ modelUsage: { agent: usage, evaluator: emptyModelUsage() }, tools: [],
    turns: [{ number: 1, durationMs: 610 }, { number: 2, durationMs: 20, timeout: { code: "TURN_TIMEOUT" } }, { number: 3, durationMs: 0 }] }] }]);
  assert.deepEqual(metrics.modelCallsPerTurn.agent, { samples: 3, unknownSamples: 0, p50: 1, p95: 3, max: 3 });
  assert.deepEqual(metrics.modelCallsPerTurn.consultation, { samples: 3, unknownSamples: 0, p50: 1, p95: 2, max: 2 });
  assert.deepEqual(metrics.latency.byCallInTurn.consultation.byPosition[1],
    { samples: 2, incompleteSamples: 1, p50Ms: 10, p95Ms: 20, maxMs: 20 });
  assert.equal(metrics.latency.byCallInTurn.consultation.byPosition[2].maxMs, 100);
  assert.equal(metrics.latency.byCallInTurn.transcription.byPosition[1].maxMs, 500);
});
test("agente reinicia el ordinal por turno; informe conserva configuración solicitada y conteos", async () => {
  const requested = [];
  const report = await runEvaluation(evalDataset([evalCase({ turns: [{ user: "Primero" }, { user: "Segundo" }] })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), agentThinkingBudget: 512,
    createAgent: input => {
      requested.push(input.thinkingBudget);
      return createAgent({ ...input, modelEnv: {}, modelFactory: options => {
        assert.deepEqual(options, { thinkingBudget: 512, maxRetries: 0 });
        return scriptedModel([reply("ver_producto", { productId: "product-a" }),
          reply("responder", { texto: "Primera respuesta", entendido: true }), reply("responder", { texto: "Segunda respuesta", entendido: true })]);
      } });
    } });
  assert.deepEqual(requested, [512, 512, 512]);
  assert.equal(report.metadata.agentThinkingBudgetOverride, 512);
  assert.deepEqual(report.metadata.agentConfigurations, [{ model: "test-model", thinking: { mode: "budget", thinkingBudget: 512, source: "override" },
    modelCalls: { timeoutMs: 20000, maxRetries: 1, sdkMaxRetries: 0, retryReserveMs: 5000, transientRetryDelayMs: 500 } }]);
  for (const run of report.cases[0].repetitions) {
    assert.deepEqual(run.modelUsage.agent.callDetails.map(call => [call.turn, call.callInTurn]), [[1, 1], [1, 2], [2, 1]]);
    assert.deepEqual(run.turns.map(turn => turn.modelCalls.agent), [2, 1]);
  }
  assert.deepEqual(report.summary.modelCallsPerTurn.consultation, { samples: 6, unknownSamples: 0, p50: 1, p95: 2, max: 2 });
  assert.equal(report.summary.latency.byCallInTurn.consultation.byPosition[1].samples, 6);
  assert.equal(report.summary.latency.byCallInTurn.consultation.byPosition[2].samples, 3);
});
test("métricas cuentan cada intento y separan timeout/reintento sin inventar tokens del intento abortado", () => {
  const usage = { ...emptyModelUsage(), calls: 2, observedCalls: 2, failedCalls: 1, successfulCalls: 1,
    callsWithoutUsage: 1, usageComplete: false, reportedTokens: { input: 10, output: 2, total: 12 },
    callDetails: [
      { component: "agent", turn: 1, callInTurn: 1, modelStep: 1, attempt: 1, durationMs: 20000, errorCode: "MODEL_CALL_TIMEOUT" },
      { component: "agent", turn: 1, callInTurn: 2, modelStep: 1, attempt: 2, durationMs: 4000 },
    ] };
  const metrics = evaluationMetrics([{ repetitions: [{ modelUsage: { agent: usage, evaluator: emptyModelUsage() }, tools: [],
    turns: [{ number: 1, durationMs: 24000, usage }] }] }]);
  assert.equal(metrics.modelAttempts.agent.retries, 1); assert.equal(metrics.modelAttempts.agent.timedOut, 1);
  assert.equal(metrics.modelAttempts.agent.byAttempt[1].maxMs, 20000);
  assert.equal(metrics.modelAttempts.agent.byAttempt[2].maxMs, 4000);
  assert.equal(metrics.modelCallsPerTurn.consultation.max, 2);
});

test("latencia por llamada usa reloj inyectado e incluye fallos y tiempo observado de pendientes", async () => {
  let time = 0, finish;
  const tracker = createModelUsageTracker({ now: () => time, component: "agent" });
  await tracker.invoke(async () => { time = 10; return { usage_metadata: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }; }, { turn: 1 });
  await assert.rejects(tracker.invoke(async () => { time = 40; throw new Error("Fallo"); }, { turn: 1 }));
  const pending = tracker.invoke(() => new Promise(resolve => { finish = resolve; }), { turn: 2 });
  time = 60;
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.callDetails.map(call => call.durationMs), [10, 30, 20]);
  assert.deepEqual(snapshot.callDetails.map(call => call.status), ["success", "failed", "pending"]);
  assert.equal(snapshot.callDetails[2].incomplete, true); assert.equal(snapshot.callDetails[2].reportedTokens.input, null);
  finish({}); await pending;
  assert.equal(tracker.snapshot().callDetails[2].incomplete, false);
});
test("delta de medición no mezcla transcripciones con llamadas previas del agente", async () => {
  const agent = createModelUsageTracker({ component: "agent" }), audio = createModelUsageTracker({ component: "transcription" });
  await agent.invoke(async () => ({})); await audio.invoke(async () => ({}));
  const before = sumModelUsage([agent.snapshot(), audio.snapshot()]);
  await agent.invoke(async () => ({})); await audio.invoke(async () => ({}));
  const delta = modelUsageSince(before, sumModelUsage([agent.snapshot(), audio.snapshot()]));
  assert.equal(delta.calls, 2); assert.deepEqual(delta.callDetails.map(call => call.component), ["agent", "transcription"]);
  assert.ok(delta.callDetails.every(call => !before.callDetails.some(old => old.id === call.id)));
});
test("percentiles usan rango más próximo y no convierten ausencia de medición en cero", () => {
  assert.deepEqual(latencyStats([1, 2, 3, { durationMs: 100, incomplete: true }]),
    { samples: 4, incompleteSamples: 1, p50Ms: 2, p95Ms: 100, maxMs: 100 });
  assert.deepEqual(latencyStats([]), { samples: 0, incompleteSamples: 0, p50Ms: null, p95Ms: null, maxMs: null });
});
test("desglose fijo estima cada bloque sin guardar su contenido ni inventar tokens del proveedor", () => {
  const result = estimateFixedInput({ systemPrompt: "abcdefgh", toolSchemas: [{ name: "example" }], serverContext: "abcd" });
  assert.deepEqual(result.systemPrompt, { characters: 8, estimatedTokens: 2 });
  assert.deepEqual(result.serverContext, { characters: 4, estimatedTokens: 1 });
  assert.equal(result.toolSchemas.characters, JSON.stringify([{ name: "example" }]).length);
  assert.equal(result.method, "characters_div_4"); assert.equal(result.estimated, true);
  assert.equal(JSON.stringify(result).includes("abcdefgh"), false);
});
test("informe incluye llamadas, latencias por herramienta/turno y desglose privado sin llegar al juez", async () => {
  const secret = "PRIVATE_SYSTEM_PROMPT_MARKER", observations = [];
  const judge = await createLLMJudge({ model: { async invoke(messages) {
    observations.push(messages); return { content: JSON.stringify({ verdict: "pass", explanation: "Prueba", evidence: [] }),
      usage_metadata: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } };
  } } });
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge,
    createAgent: input => createAgent({ ...input, prompt: secret, model: scriptedModel([
      reply("ver_producto", { productId: "product-a" }), reply("responder", { texto: "Respuesta", entendido: true }),
    ]) }) });
  assert.equal(report.summary.latency.models.agent.samples, 6); assert.equal(report.summary.latency.models.evaluator.samples, 3);
  assert.equal(report.summary.latency.tools.byName.ver_producto.samples, 3); assert.equal(report.summary.latency.turns.samples, 3);
  assert.equal(report.summary.fixedInput.callsWithBreakdown, 6);
  for (const run of report.cases[0].repetitions) {
    for (const call of run.modelUsage.agent.callDetails) {
      assert.ok(call.durationMs >= 0); assert.equal(call.fixedInput.systemPrompt.characters, secret.length);
      assert.ok(call.fixedInput.toolSchemas.characters > 0); assert.ok(call.fixedInput.serverContext.characters > 0);
      assert.equal(call.reportedTokens.input, 10); assert.equal(call.fixedInput.estimated, true);
    }
  }
  assert.equal(JSON.stringify(observations).includes(secret), false); assert.equal(JSON.stringify(report).includes(secret), false);
  const dir = await mkdtemp(join(tmpdir(), "eval-metrics-"));
  try {
    const output = await writeReport(report, dir);
    const trace = await readFile(join(output, "trace.jsonl"), "utf8");
    const summary = await readFile(join(output, "summary.md"), "utf8");
    assert.ok(trace.includes('"type":"model_call"')); assert.ok(trace.includes('"fixedInput"'));
    assert.ok(summary.includes("p95")); assert.ok(summary.includes("tool: ver_producto"));
    assert.ok(summary.includes("Estimación local")); assert.equal(trace.includes(secret), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("TURN_TIMEOUT conserva fase model y llamada interrumpida sin cambiar su veredicto", async () => {
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge: createStubJudge(), timeoutMs: 150,
    createAgent: input => createAgent({ ...input, model: scriptedModel([(_messages, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]) }) });
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "error");
    const diagnostic = run.diagnostics.find(item => item.code === "TURN_TIMEOUT");
    assert.equal(diagnostic.interruptedPhase.phase, "model"); assert.equal(diagnostic.interruptedPhase.modelCall, 1);
    assert.equal(run.turns[0].timeout.interruptedPhase.phase, "model");
    assert.equal(run.turns[0].timeout.interruptedPhase.callInTurn, 1);
    assert.deepEqual(run.turns[0].modelCalls, { agent: 1, consultation: 1, transcription: 0 });
    assert.equal(run.modelUsage.agent.calls, 1); assert.ok(run.modelUsage.agent.callDetails[0].durationMs >= 0);
  }
  assert.equal(report.summary.exitCode, 2); assert.equal(report.summary.thresholdsPassed, false);
});
test("TURN_TIMEOUT identifica la herramienta en curso y conserva su tiempo observado", async () => {
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge: createStubJudge(), timeoutMs: 150,
    createAgent: input => {
      let modelSignal;
      input.world.catalog.listPolicies = () => new Promise((_, reject) => {
        if (modelSignal.aborted) reject(modelSignal.reason);
        else modelSignal.addEventListener("abort", () => reject(modelSignal.reason), { once: true });
      });
      return createAgent({ ...input, model: scriptedModel([(_messages, { signal }) => {
        modelSignal = signal; return reply("consultar_politicas", {});
      }]) });
    } });
  for (const run of report.cases[0].repetitions) {
    const diagnostic = run.diagnostics.find(item => item.code === "TURN_TIMEOUT");
    assert.equal(run.status, "error"); assert.equal(diagnostic.interruptedPhase.phase, "tool");
    assert.equal(diagnostic.interruptedPhase.tool, "consultar_politicas");
    assert.equal(run.tools[0].name, "consultar_politicas"); assert.ok(run.tools[0].durationMs >= 0);
  }
  assert.equal(report.summary.latency.tools.byName.consultar_politicas.samples, 3);
});
test("timeouts devueltos como diagnóstico son error técnico y no se evalúan como calidad", async () => {
  for (const code of ["TURN_TIMEOUT", "AGENT_TIMEOUT", "GUARDIAN_TIMEOUT", "MODEL_CALL_TIMEOUT"]) {
    const judge = createStubJudge();
    judge.evaluate = () => assert.fail("Un timeout no debe enviarse al juez");
    const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge,
      createAgent: async () => ({ kind: "real", getModelUsage: () => emptyModelUsage(),
        runTurn: async () => ({ diagnostics: [{ code, message: "Plazo agotado", interruptedPhase: { phase: "model", callInTurn: 1 } }] }) }) });
    for (const run of report.cases[0].repetitions) {
      assert.equal(run.status, "error"); assert.equal(run.executed, true);
      assert.equal(run.diagnostics[0].code, code); assert.equal(run.turns[0].timeout.code, code);
      assert.deepEqual(run.turns[0].timeout.interruptedPhase, { phase: "model", callInTurn: 1 });
      assert.deepEqual(run.criteria, []);
    }
    assert.equal(report.summary.exitCode, 2); assert.equal(report.summary.thresholdsPassed, false);
  }
});

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
test("fallos no transitorios se cuentan y el aviso técnico deja error, sin pasar por el juez ni derivar", async () => {
  const judge = createStubJudge();
  judge.evaluate = () => assert.fail("Una falla técnica no se evalúa como calidad");
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge,
    createAgent: input => createAgent({ ...input, model: scriptedModel([() => {
      throw Object.assign(new Error("PRIVATE_PROVIDER_ERROR con prompt privado"), { status: 400 });
    }]) }) });
  assert.equal(report.summary.modelUsage.agent.calls, 3);
  assert.equal(report.summary.modelUsage.agent.failedCalls, 3);
  assert.equal(report.summary.modelUsage.agent.callsWithoutUsage, 3);
  assert.equal(report.summary.modelUsage.agent.usageComplete, false);
  assert.equal(report.summary.modelUsage.evaluator.calls, 0);
  assert.ok(report.cases[0].repetitions.every(run => run.turns[0].agentDiagnostics.length === 1));
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "error"); assert.equal(run.diagnostics[0].code, "AGENT_ERROR");
    assert.equal(run.diagnostics[0].technicalFailure, true);
    assert.equal(run.diagnostics[0].errorName, "Error"); assert.equal(run.diagnostics[0].httpStatus, 400);
    assert.equal(run.diagnostics[0].errorClass, "HTTP_4XX");
    assert.equal(run.modelUsage.agent.callDetails[0].errorName, "Error"); assert.equal(run.modelUsage.agent.callDetails[0].httpStatus, 400);
    assert.equal(run.modelUsage.agent.callDetails[0].errorClass, "HTTP_4XX");
    assert.equal(run.turns[0].outgoing[0].text, TECHNICAL_FAILURE_NOTICE); assert.equal(run.turns[0].handoffAfter, false);
    assert.deepEqual(run.criteria, []);
  }
  assert.equal(JSON.stringify(report).includes("PRIVATE_PROVIDER_ERROR"), false);
  assert.equal(report.summary.exitCode, 2); assert.equal(report.summary.thresholdsPassed, false);
});

test("informe conserva la clase de cada intento fallido y cuenta el reintento, sin calidad ni mensajes privados", async () => {
  const judge = createStubJudge();
  judge.evaluate = () => assert.fail("Dos intentos fallidos cierran como error técnico");
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge,
    createAgent: input => {
      const clock = createVirtualClock(0), schedule = clock.setTimeout;
      // Avanzar únicamente la espera programada: ningún retardo real de 500 ms.
      clock.setTimeout = (fn, milliseconds) => {
        const id = schedule(fn, milliseconds);
        if (milliseconds === 500) queueMicrotask(() => clock.advance(500));
        return id;
      };
      return createAgent({ ...input, modelClock: clock, model: scriptedModel([503, 429].map(status => () => {
        throw Object.assign(new Error("PRIVATE_PROVIDER_ERROR con prompt privado"), { status });
      })) });
    } });
  assert.equal(report.summary.modelUsage.agent.calls, 6); assert.equal(report.summary.modelUsage.agent.failedCalls, 6);
  assert.equal(report.summary.modelUsage.agent.callsWithoutUsage, 6); assert.equal(report.summary.modelUsage.agent.usageComplete, false);
  assert.equal(report.summary.modelUsage.evaluator.calls, 0); assert.equal(report.summary.modelAttempts.agent.retries, 3);
  assert.deepEqual(report.summary.modelAttempts.agent.byErrorClass, { PROVIDER_5XX: 3, RATE_LIMIT: 3 });
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "error"); assert.deepEqual(run.criteria, []);
    assert.deepEqual(run.modelUsage.agent.callDetails.map(call => [call.attempt, call.errorClass, call.httpStatus]),
      [[1, "PROVIDER_5XX", 503], [2, "RATE_LIMIT", 429]]);
    assert.equal(run.turns[0].technicalFailure.errorClass, "RATE_LIMIT"); assert.equal(run.diagnostics[0].errorClass, "RATE_LIMIT");
    assert.equal(run.turns[0].outgoing[0].text, TECHNICAL_FAILURE_NOTICE); assert.equal(run.turns[0].handoffAfter, false);
  }
  assert.equal(report.summary.exitCode, 2); assert.equal(report.summary.thresholdsPassed, false);
  const directory = await mkdtemp(join(tmpdir(), "eval-retry-classes-"));
  try {
    const output = await writeReport(report, directory);
    const saved = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
    const rawTrace = await readFile(join(output, "trace.jsonl"), "utf8");
    const trace = rawTrace.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "model_call");
    const summary = await readFile(join(output, "summary.md"), "utf8");
    assert.deepEqual(trace.map(call => [call.attempt, call.errorClass, call.httpStatus]),
      Array.from({ length: 3 }, () => [[1, "PROVIDER_5XX", 503], [2, "RATE_LIMIT", 429]]).flat());
    assert.deepEqual(saved.summary.modelAttempts.agent.byErrorClass, { PROVIDER_5XX: 3, RATE_LIMIT: 3 });
    assert.ok(summary.includes('"PROVIDER_5XX":3')); assert.ok(summary.includes('"RATE_LIMIT":3'));
    assert.equal(JSON.stringify(saved).includes("PRIVATE_PROVIDER_ERROR"), false);
    assert.equal(rawTrace.includes("PRIVATE_PROVIDER_ERROR"), false); assert.equal(summary.includes("PRIVATE_PROVIDER_ERROR"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
