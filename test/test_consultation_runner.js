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
      assert.equal(input.world.isRealTool("cotizar"), false);
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
test("cotizacionMostrada continúa bloqueada sin cotizar real y no llama al modelo", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ context: { carrito: evalCart(), cotizacionMostrada: true } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input, model: scriptedModel([]) }),
  });
  assert.ok(report.cases[0].repetitions.every(run => run.status === "blocked" && run.diagnostics[0].code === "QUOTE_TOOL_UNAVAILABLE"));
  assert.equal(report.summary.modelUsage.agent.calls, 0);
  assert.equal(report.summary.modelUsage.evaluator.calls, 0);
});
test("lista de casos combina --cases y --case sin duplicar repeticiones; rechaza entradas vacías", () => {
  assert.deepEqual(parseCaseSelection({ case: ["C-01"], cases: ["C-01, C-02", "P-01"] }), ["C-01", "C-02", "P-01"]);
  assert.throws(() => parseCaseSelection({ cases: ["C-01,,P-01"] }), /ID vacío/);
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
