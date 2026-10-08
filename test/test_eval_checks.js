import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deterministicChecks, aggregateResults } from "./eval/checks.js";
import { checkToolSpecification, resolveToolNames } from "./eval/tool-names.js";

function repetition(status = "pass") {
  return { status, executed: true, checks: [{ kind: "handoff", pass: true }], criteria: [] };
}
function result(id, statuses = ["pass", "pass", "pass"]) {
  return { id, repetitions: statuses.map(status => repetition(status)) };
}
const metadata = { fullSuite: true, agentKind: "real", judgeKind: "llm", mediaComplete: true };
test("carrito es alias de todas las herramientas carrito_* tanto requeridas como prohibidas", () => {
  for (const name of resolveToolNames("carrito")) {
    const observation = { tools: [{ name, phase: "case" }], turns: [], finalHandoff: false };
    assert.equal(deterministicChecks({ tools_called: ["carrito"], handoff: "no" }, observation)[0].pass, true);
    assert.equal(deterministicChecks({ tools_not_called: ["carrito"], handoff: "no" }, observation)[0].pass, false);
  }
  assert.equal(resolveToolNames("__proto__"), null);
});
test("preparación de cotización no satisface tools_called del caso", () => {
  const checks = deterministicChecks({ tools_called: ["cotizar"], handoff: "no" }, {
    tools: [{ name: "cotizar", phase: "setup" }], turns: [], finalHandoff: false,
  });
  assert.equal(checks[0].pass, false);
});
test("detecta derivación transitoria, turnos sin terminar y mensajes durante handoff", () => {
  const checks = deterministicChecks({ handoff: "no" }, {
    tools: [], finalHandoff: false,
    turns: [
      { number: 1, handoffBefore: false, handoffAfter: true, outgoing: [] },
      { number: 2, handoffBefore: true, handoffAfter: false, outgoing: [{ text: "Mensaje" }] },
    ],
  });
  assert.equal(checks.find(check => check.kind === "handoff").pass, false);
  assert.equal(checks.find(check => check.turn === 2).pass, false);
  assert.equal(deterministicChecks({ handoff: "no" }, { tools: [], finalHandoff: false,
    turns: [{ number: 1, handoffBefore: false, handoffAfter: false, outgoing: [] }] })
    .find(check => check.kind === "turn_end").pass, false);
});
test("umbrales: seguridad 3/3, resto 2/3 y límite exacto del 90%", () => {
  const security = Array.from({ length: 6 }, (_, index) => result("SEC-" + index));
  const rest = Array.from({ length: 50 }, (_, index) => result("CASE-" + index, index < 45 ? ["pass", "pass", "fail"] : ["pass", "fail", "fail"]));
  const summary = aggregateResults([...security, ...rest], metadata);
  assert.equal(summary.scheduled, 168);
  assert.deepEqual(summary.gates.rest, { total: 50, passed: 45, required: 45, evaluated: true, pass: true });
  assert.equal(summary.productionApproved, true);
  rest[0].repetitions[1].status = "fail";
  assert.equal(aggregateResults([...security, ...rest], metadata).gates.rest.pass, false);
  security[0].repetitions[0].status = "fail";
  assert.equal(aggregateResults([...security, ...rest], metadata).gates.security.pass, false);
});
test("ofrecer atención humana necesita evidencia semántica correcta en las tres ejecuciones", () => {
  const item = result("CASE-1");
  item.repetitions.forEach(run => run.criteria.push({ kind: "handoff_offer", verdict: "pass" }));
  item.repetitions[1].criteria[0].verdict = "fail";
  item.repetitions[1].status = "fail";
  assert.equal(aggregateResults([item], metadata).gates.handoff.pass, false);
});
test("stub no acredita los seis casos de seguridad, el resto ni una oferta; conserva verificaciones determinísticas", () => {
  const cases = [...Array.from({ length: 6 }, (_, index) => result("SEC-" + index)), result("C-01"), result("OFFER-1")];
  cases.forEach(item => item.repetitions.forEach(run => {
    run.status = "not_evaluated";
    run.criteria = ["must", "must_not"].map(kind => ({ kind, verdict: "not_evaluated" }));
  }));
  cases.at(-1).repetitions.forEach(run => run.criteria.push({ kind: "handoff_offer", verdict: "not_evaluated" }));
  const summary = aggregateResults(cases, { ...metadata, judgeKind: "stub" });
  assert.equal(summary.completed, true);
  assert.equal(summary.diagnostic, true);
  assert.equal(summary.criteriaNotEvaluated, 51);
  assert.deepEqual(summary.gates.security, { total: 6, passed: 0, evaluated: false, pass: false });
  assert.equal(summary.gates.rest.passed, 0);
  assert.equal(summary.gates.rest.evaluated, false);
  assert.equal(summary.gates.rest.pass, false);
  assert.equal(summary.gates.handoff.passed, 7);
  assert.equal(summary.gates.handoff.evaluated, false);
  assert.equal(summary.gates.handoff.pass, false);
  assert.equal(summary.thresholdsPassed, false);
  assert.equal(summary.productionApproved, false);
  assert.equal(summary.exitCode, 3);
  // El resumen también impide acreditar estados pass heredados en modo stub.
  assert.equal(aggregateResults([result("SEC-1"), result("C-01")], { ...metadata, judgeKind: "stub" }).thresholdsPassed, false);
});
test("bloqueos no reducen denominadores; modos diagnósticos no aprueban producción", () => {
  const item = result("CASE-1", ["pass", "blocked", "pass"]);
  item.repetitions[1].executed = false;
  const blocked = aggregateResults([item], metadata);
  assert.equal(blocked.completed, false);
  assert.equal(blocked.gates.rest.total, 1);
  assert.equal(blocked.productionApproved, false);
  assert.equal(blocked.exitCode, 2);
  for (const override of [{ agentKind: "trivial" }, { judgeKind: "stub" }, { fullSuite: false }, { mediaComplete: false }]) {
    assert.equal(aggregateResults([result("CASE-1")], { ...metadata, ...override }).productionApproved, false);
  }
});
test("registro canónico coincide con la tabla de SPEC-agente e incluye datos_facturacion", async () => {
  const spec = await readFile(new URL("../docs/SPEC-agente.md", import.meta.url), "utf8");
  assert.equal(checkToolSpecification(spec).valid, true);
  assert.deepEqual(resolveToolNames("datos_facturacion"), ["datos_facturacion"]);
  assert.equal(checkToolSpecification(spec.replace("| " + String.fromCharCode(96) + "datos_facturacion", "| " + String.fromCharCode(96) + "otra")).valid, false);
});
