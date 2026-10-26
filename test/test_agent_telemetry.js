import test from "node:test";
import assert from "node:assert/strict";
import { createModelUsageTracker, modelUsageSince, sumModelUsage, modelUsageForComponent } from "../src/utils/model-usage.util.js";
import { createAgentTurnTelemetry } from "../src/services/agent-telemetry.service.js";
import { createProcessMemoryMonitor, readMemoryWarnMb, MEMORY_LOG_INTERVAL_MS } from "../src/services/process-memory.service.js";
import { createVirtualClock } from "./helpers/virtual-clock.js";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge } from "./eval/judge.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset } from "./helpers/eval-fixtures.js";
import { scriptedModel, reply, FIXTURE_NOW } from "./helpers/consultation-fixtures.js";
import { writeReport } from "./eval/report.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("caché de Gemini y LangChain: elegir un campo sin duplicar entrada ni total; deltas y componentes", async () => {
  const agent = createModelUsageTracker({ component: "agent" }), audio = createModelUsageTracker({ component: "transcription" });
  const initial = sumModelUsage([agent.snapshot(), audio.snapshot()]);
  await agent.invoke(async () => ({ usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    cachedContentTokenCount: 40, input_token_details: { cache_read: 40 } } }));
  await agent.invoke(async () => ({ usage_metadata: { input_tokens: 50, output_tokens: 5, total_tokens: 55, input_token_details: { cache_read: 10 } } }));
  await audio.invoke(async () => ({ response_metadata: { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 3,
    totalTokenCount: 33, cachedContentTokenCount: 5 } } }));
  const usage = modelUsageSince(initial, sumModelUsage([agent.snapshot(), audio.snapshot()]));
  assert.deepEqual(usage.reportedTokens, { input: 180, output: 28, total: 208 });
  assert.equal(usage.cachedContentTokenCount, 55); assert.equal(usage.cacheUsageReportedCalls, 3);
  assert.equal(modelUsageForComponent(usage, "agent").cachedContentTokenCount, 50);
  assert.equal(modelUsageForComponent(usage, "transcription").cachedContentTokenCount, 5);
  assert.equal(modelUsageForComponent(usage, "agent").reportedTokens.total, 175);
  const before = agent.snapshot();
  await agent.invoke(async () => ({ usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  const delta = modelUsageSince(before, agent.snapshot());
  assert.equal(delta.cachedContentTokenCount, 0); assert.equal(delta.cacheUsageReportedCalls, 0);
  assert.equal(delta.callDetails[0].cachedContentTokenCount, null);
});
test("una línea por turno y por herramienta: orden, caché separada y ausencia de datos sensibles", async () => {
  const logs = [], telemetry = createAgentTurnTelemetry({ chatId: "595900000001@c.us", logger: row => logs.push(row) });
  const tracker = createModelUsageTracker({ component: "agent" });
  await tracker.invoke(async () => ({ usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_token_details: { cache_read: 4 } } }));
  telemetry.start({ batchId: "batch" });
  telemetry.tool({ batchId: "batch", name: "ver_producto", code: "OK", durationMs: 2 });
  telemetry.tool({ batchId: "batch", name: "responder", code: "OK", durationMs: 3 });
  telemetry.finish({ batchId: "batch", groupedMessages: 2, media: { count: 1, types: { audio: 1 }, bytes: 100 },
    outcome: "processed", durationMs: 8, handoff: false, usage: tracker.snapshot() });
  assert.deepEqual(logs.map(row => row.event), ["agent_tool", "agent_tool", "agent_turn"]);
  assert.deepEqual(logs[2].tools, ["ver_producto", "responder"]); assert.equal(logs[2].groupedMessages, 2);
  assert.equal(logs[2].consumption.agent.cachedContentTokenCount, 4); assert.equal(logs[2].consumption.agent.tokens.total, 12);
  assert.equal(logs[2].consumption.transcription.calls, 0);
  assert.equal(JSON.stringify(logs).includes("595900000001"), false);
  for (const row of logs) for (const key of ["args", "arguments", "text", "prompt", "caption"]) assert.equal(Object.hasOwn(row, key), false);
  telemetry.start({ batchId: "next" });
  telemetry.tool({ batchId: "batch", name: "ver_producto", code: "TURN_CLOSED", durationMs: 9 });
  telemetry.finish({ batchId: "next", usage: tracker.snapshot(), groupedMessages: 1, outcome: "cancelled" });
  assert.deepEqual(logs.at(-1).tools, []); assert.equal(logs.at(-2).batch, "batch");
});
test("memoria al arrancar y cada diez minutos, umbral configurable y stop sin esperas reales", async () => {
  assert.equal(readMemoryWarnMb({}), 700);
  for (const value of ["0", "-1", "NaN", "1.5", "", "Infinity"]) assert.throws(() => readMemoryWarnMb({ MEMORY_WARN_MB: value }));
  assert.equal(readMemoryWarnMb({ MEMORY_WARN_MB: "750" }), 750);
  const clock = createVirtualClock(), logs = [];
  let rss = 700 * 1024 * 1024;
  const monitor = createProcessMemoryMonitor({ clock, warnMb: 700, memoryUsage: () => ({ rss, heapUsed: 12 }), logger: row => logs.push(row) });
  monitor.start(); monitor.start(); assert.equal(logs.length, 1); assert.equal(logs[0].code, "MEMORY_SAMPLE");
  await clock.advanceAsync(MEMORY_LOG_INTERVAL_MS - 1); assert.equal(logs.length, 1);
  rss++; await clock.advanceAsync(1); assert.equal(logs.length, 2); assert.equal(logs[1].code, "MEMORY_WARN");
  assert.equal(logs[1].rss, rss); assert.equal(logs[1].heapUsed, 12);
  monitor.stop(); await clock.advanceAsync(2 * MEMORY_LOG_INTERVAL_MS); assert.equal(logs.length, 2);
});
test("resumen de evaluación incluye caché y separa componentes sin cambiar totales ni los criterios", async () => {
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge: createStubJudge(),
    createAgent: input => {
      const response = reply("responder", { texto: "Respuesta de prueba", entendido: true });
      response.usage_metadata = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_token_details: { cache_read: 4 } };
      return createAgent({ ...input, model: scriptedModel([response]) });
    } });
  assert.equal(report.summary.modelUsage.agent.cachedContentTokenCount, 12);
  assert.equal(report.summary.modelUsage.agent.reportedTokens.total, 36);
  assert.equal(report.summary.modelUsageByComponent.agent.cachedContentTokenCount, 12);
  assert.equal(report.summary.modelUsageByComponent.transcription.calls, 0);
  assert.equal(report.summary.modelUsage.evaluator.calls, 0);
  const directory = await mkdtemp(join(tmpdir(), "eval-cache-"));
  try {
    const output = await writeReport(report, directory);
    const summary = await readFile(join(output, "summary.md"), "utf8");
    assert.ok(summary.includes("caché (parte de entrada, no se suma al total): 12"));
    assert.ok(summary.includes("Componente transcription"));
    const trace = await readFile(join(output, "trace.jsonl"), "utf8");
    assert.ok(trace.includes('"cachedContentTokenCount":4'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
