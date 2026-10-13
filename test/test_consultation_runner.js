import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { runEvaluation, parseCaseSelection } from "./eval/run-eval.js";
import { createStubJudge, createLLMJudge } from "./eval/judge.js";
import { writeReport } from "./eval/report.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset, evalCase, evalCart } from "./helpers/eval-fixtures.js";
import { scriptedModel, reply, FIXTURE_NOW } from "./helpers/consultation-fixtures.js";

test("adaptador real se conecta por contrato, registra handlers reales y aísla repeticiones e historial", async () => {
  const seen = [];
  let instances = 0;
  const report = await runEvaluation(evalDataset([evalCase({ turns: [{ user: "Primero" }, { user: "Segundo" }],
    expect: { tools_called: ["ver_producto", "responder"], handoff: "no" } })]), {
    judge: createStubJudge(), now: FIXTURE_NOW,
    createAgent: async input => {
      instances++;
      assert.equal(input.expect, undefined);
      const model = scriptedModel([reply("ver_producto", { productId: "product-a" }), reply("responder", { texto: "Primera respuesta", entendido: true }),
        messages => { seen.push([...messages]); return reply("responder", { texto: "Segunda respuesta", entendido: true }); }]);
      const agent = await createAgent({ ...input, model });
      assert.equal(input.world.isRealTool("ver_producto"), true);
      assert.equal(input.world.isRealTool("responder"), true);
      assert.equal(input.world.isRealTool("cotizar"), true);
      return agent;
    },
  });
  assert.equal(instances, 3);
  assert.equal(report.metadata.agentKind, "real");
  assert.equal(report.summary.executed, 3);
  assert.ok(report.cases[0].repetitions.every(run => run.checks.every(check => check.pass)));
  assert.equal(report.summary.thresholdsPassed, false); // Juez stub.
  assert.equal(report.summary.modelUsage.agent.calls, 9);
  assert.ok(seen.every(messages => messages.filter(message => message.content === "Primero").length === 1
    && messages.filter(message => message.content === "Primera respuesta").length === 1
    && messages.at(-1).content === "Segundo"));
});
test("juez independiente recibe evidencia pública y nunca el prompt privado del agente ni firmas internas", async () => {
  const privatePrompt = "PRIVATE_CONSULTATION_PROMPT_SENTINEL";
  const judge = await createLLMJudge({ model: { async invoke(messages) {
    assert.equal(JSON.stringify(messages).includes(privatePrompt), false);
    const payload = JSON.parse(messages[1][1]);
    assert.ok(payload.tools.some(tool => tool.name === "responder"));
    return { content: JSON.stringify({ verdict: "pass", explanation: "Doble de prueba.", evidence: [] }) };
  } } });
  const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge,
    createAgent: input => createAgent({ ...input, prompt: privatePrompt,
      model: scriptedModel([reply("responder", { texto: "Respuesta pública", entendido: true })]) }) });
  assert.equal(JSON.stringify(report).includes(privatePrompt), false);
  assert.equal(report.summary.modelUsage.evaluator.calls, 3);
  assert.equal(report.summary.modelUsage.evaluator.usageComplete, false);
});
test("cotizacionMostrada con carrito incompleto sigue bloqueada y no llama al modelo", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ context: { carrito: evalCart(), cotizacionMostrada: true } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input, model: scriptedModel([]) }),
  });
  assert.ok(report.cases[0].repetitions.every(run => run.status === "blocked" && run.diagnostics[0].code === "INITIAL_QUOTE_FAILED"));
  assert.equal(report.summary.modelUsage.agent.calls, 0);
  assert.equal(report.summary.modelUsage.evaluator.calls, 0);
});
test("lista de casos combina --cases y --case sin duplicar repeticiones; rechaza entradas vacías", () => {
  assert.deepEqual(parseCaseSelection({ case: ["C-01"], cases: ["C-01, C-02", "P-01"] }), ["C-01", "C-02", "P-01"]);
  assert.throws(() => parseCaseSelection({ cases: ["C-01,,P-01"] }), /ID vacío/);
});
test("CLI aplica dos presupuestos a la misma selección sin escribir .env y los registra en cada informe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-thinking-cli-"));
  try {
    const dataset = evalDataset([evalCase({ id: "C-01" }), evalCase({ id: "C-02" })]);
    const file = join(directory, "cases.yaml"), adapter = join(directory, "adapter.mjs");
    await writeFile(file, YAML.stringify({ version: dataset.version, fixtures: dataset.fixtures, cases: dataset.cases.map(item => item.input) }));
    await writeFile(adapter, [
      "import { createAgent as realAgent } from " + JSON.stringify(new URL("../src/agents/consultation/eval-adapter.js", import.meta.url).href) + ";",
      "import { scriptedModel, reply } from " + JSON.stringify(new URL("./helpers/consultation-fixtures.js", import.meta.url).href) + ";",
      "export function createAgent(input) { return realAgent({ ...input, modelEnv: {}, modelFactory: options => {",
      "  if (options.thinkingBudget !== input.thinkingBudget) throw new Error('No se aplicó override');",
      "  return scriptedModel([reply('responder', { texto: 'Respuesta', entendido: true })]);",
      "} }); }",
    ].join("\n"));
    const cli = new URL("./eval/run-eval.js", import.meta.url).pathname;
    const envFile = join(directory, ".env");
    await writeFile(envFile, "AGENT_THINKING_BUDGET=2048\nTEST_EVAL_ENV_SENTINEL=unchanged\n");
    const envBefore = await readFile(envFile);
    for (const budget of [512, 1024]) {
      const output = join(directory, "results-" + budget);
      const child = spawnSync(process.execPath, [cli, "--file", file, "--agent", adapter, "--judge", "stub", "--cases", "C-01,C-02",
        "--agent-thinking-budget", String(budget), "--output", output], { encoding: "utf8", timeout: 15000, cwd: directory });
      assert.equal(child.status, 3, child.stderr + child.stdout);
      const [folder] = await readdir(output);
      const report = JSON.parse(await readFile(join(output, folder, "report.json"), "utf8"));
      assert.deepEqual(report.cases.map(item => item.id), ["C-01", "C-02"]);
      assert.equal(report.metadata.agentThinkingBudgetOverride, budget);
      assert.deepEqual(report.metadata.agentConfigurations, [{ model: "test-model",
        thinking: { mode: "budget", thinkingBudget: budget, source: "override" } }]);
      assert.ok(report.cases.every(item => item.repetitions.every(run => run.agentConfiguration.thinking.thinkingBudget === budget)));
      assert.equal(report.summary.modelUsage.evaluator.calls, 0);
      assert.ok(child.stdout.includes('"agentConfigurations"'));
      const markdown = await readFile(join(output, folder, "summary.md"), "utf8");
      assert.ok(markdown.includes("Modelo y pensamiento del agente")); assert.ok(markdown.includes("test-model"));
      assert.ok(markdown.includes('"thinkingBudget":' + budget));
      assert.ok(markdown.includes("Llamadas al modelo por turno")); assert.ok(markdown.includes("Latencia por posición"));
    }
    const envAfter = await readFile(envFile);
    assert.deepEqual(envAfter, envBefore);
    const invalid = spawnSync(process.execPath, [cli, "--agent", "real", "--judge", "llm", "--agent-thinking-budget=-2"],
      { encoding: "utf8", timeout: 15000, cwd: directory });
    assert.equal(invalid.status, 2); assert.match(invalid.stderr, /INVALID_AGENT_THINKING_BUDGET/);
    assert.match(invalid.stderr, /--agent-thinking-budget/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CLI selecciona la lista, informa consumo separado y valida IDs antes de crear el agente real", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-consultation-cli-"));
  try {
    const dataset = evalDataset([evalCase({ id: "C-01" }), evalCase({ id: "C-02" }), evalCase({ id: "P-01" }), evalCase({ id: "OTHER-1" })]);
    const file = join(directory, "cases.yaml");
    await writeFile(file, YAML.stringify({ version: dataset.version, fixtures: dataset.fixtures, cases: dataset.cases.map(item => item.input) }));
    const cli = new URL("./eval/run-eval.js", import.meta.url).pathname;
    const output = join(directory, "results");
    const child = spawnSync(process.execPath, [cli, "--file", file, "--agent", "trivial", "--judge", "stub",
      "--case", "C-01", "--cases", "C-01,C-02,P-01", "--output", output], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 3, child.stderr + child.stdout);
    const [folder] = await readdir(output);
    const report = JSON.parse(await readFile(join(output, folder, "report.json"), "utf8"));
    assert.deepEqual(report.cases.map(item => item.id), ["C-01", "C-02", "P-01"]);
    assert.equal(report.summary.executed, 9);
    assert.equal(report.summary.modelUsage.agent.calls, 0);
    assert.equal(report.summary.modelUsage.evaluator.calls, 0);
    assert.ok(child.stdout.includes('"modelUsage"'));
    const invalid = spawnSync(process.execPath, [cli, "--file", file, "--agent", "real", "--cases", "MISSING-1"], { encoding: "utf8", timeout: 15000 });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Caso inexistente/);
    const markdown = await readFile(join(output, folder, "summary.md"), "utf8");
    assert.match(markdown, /Consumo del modelo/);
    assert.match(markdown, /evaluator: llamadas 0/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("informe conserva consumo de cada turno y el resumen total", async () => {
  const directory = await mkdtemp(join(tmpdir(), "test-consultation-report-"));
  try {
    const report = await runEvaluation(evalDataset(), { now: FIXTURE_NOW, judge: createStubJudge(),
      createAgent: input => createAgent({ ...input, model: scriptedModel([reply("responder", { texto: "Respuesta", entendido: true })]) }) });
    const output = await writeReport(report, directory);
    const trace = (await readFile(join(output, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(trace.filter(event => event.type === "turn").every(event => event.usage.calls === 1));
    assert.equal(report.summary.modelUsage.agent.calls, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
