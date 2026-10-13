import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge } from "./eval/judge.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { evalDataset, evalCase, evalFixtures } from "./helpers/eval-fixtures.js";
import { scriptedModel, reply, FIXTURE_NOW } from "./helpers/consultation-fixtures.js";

test("runner usa derivar real, registra alerta y estado consultado; siguientes turnos quedan silenciosos", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "SUPPORT-CLAIM", context: { telefonoCliente: "595900000001" },
    turns: [{ user: "Tengo un reclamo" }, { user: "Otro mensaje" }],
    expect: { tools_called: ["estado_pedido", "derivar"], handoff: "si" } })]), { now: FIXTURE_NOW, judge: createStubJudge(),
    createAgent: async input => {
      const agent = await createAgent({ ...input, model: scriptedModel([
      reply("estado_pedido", { orderNumber: "test-order-a" }), reply("derivar", { motivo: "Reclamo del cliente", texto: "Una persona seguirá por acá." }),
      ]) });
      assert.equal(input.world.isRealTool("derivar"), true); return agent;
    } });
  for (const run of report.cases[0].repetitions) {
    assert.notEqual(run.status, "error"); assert.ok(run.checks.every(check => check.pass));
    assert.deepEqual(run.tools.map(tool => tool.name), ["estado_pedido", "derivar"]);
    assert.equal(run.tools[1].handlerInvoked, true);
    assert.equal(run.turns[0].handoffAfter, true); assert.equal(run.turns[1].outgoing.length, 0);
    assert.equal(run.after.alertRequests.length, 1); assert.equal(run.modelUsage.agent.calls, 2);
  }
});
test("runner observa cuarto responder false como handoff por código, sin inventar llamada del modelo a derivar", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "SUPPORT-MISUNDERSTANDING",
    turns: [1, 2, 3, 4].map(number => ({ user: "Mensaje sin encauzar " + number })), expect: { handoff: "si" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input,
      model: scriptedModel([1, 2, 3, 4].map(() => reply("responder", { texto: "Repregunta de prueba", entendido: false }))) }) });
  for (const run of report.cases[0].repetitions) {
    assert.notEqual(run.status, "error"); assert.deepEqual(run.turns.map(turn => turn.handoffAfter), [false, false, false, true]);
    assert.deepEqual(run.tools.map(tool => tool.name), ["responder", "responder", "responder", "responder"]);
    assert.equal(run.after.alertRequests[0].type, "MISUNDERSTANDING"); assert.equal(run.modelUsage.agent.calls, 4);
  }
});
test("runner observa escalada por alcance o comprensión en el cuarto cierre, sin llamada a derivar", async () => {
  const flags = [{ entendido: true, fueraDeAlcance: true }, { entendido: false },
    { entendido: false, fueraDeAlcance: true }, { entendido: true, fueraDeAlcance: true }];
  const report = await runEvaluation(evalDataset([evalCase({ id: "SUPPORT-OUTSIDE-SCOPE",
    turns: flags.map((_args, index) => ({ user: "Consulta fuera del alcance de prueba " + index })),
    expect: { tools_not_called: ["derivar"], handoff: "si" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input,
      model: scriptedModel(flags.map((args, index) => () => {
        assert.equal(input.world.getState().consecutiveMisunderstandings, index);
        return reply("responder", { texto: "Respuesta de prueba", ...args });
      })) }),
  });
  assert.equal(report.cases[0].repetitions.length, 3);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.deepEqual(run.turns.map(turn => turn.handoffAfter), [false, false, false, true]);
    assert.deepEqual(run.tools.map(tool => tool.name), ["responder", "responder", "responder", "responder"]);
    assert.equal(run.tools.at(-1).result.handoff, true);
    assert.equal(run.after.alertRequests.length, 1); assert.equal(run.after.alertRequests[0].type, "MISUNDERSTANDING");
    assert.equal(run.modelUsage.agent.calls, 4);
  }
});
test("runner aplica el umbral de cada caso antes de herramientas, en las tres repeticiones", async () => {
  const fixtures = evalFixtures(); fixtures.products[0].variants[0].stock = 8;
  const cases = [8, 30].map(quantity => evalCase({ id: "SUPPORT-VOLUME-" + quantity, category: "corporativo",
    context: { umbralCorporativo: 5 }, turns: [{ user: "Quiero " + quantity + " unidades" }],
    expect: { tools_called: ["carrito_agregar"], tools_not_called: ["crear_pedido", "derivar"], handoff: "ofrece" } }));
  const report = await runEvaluation(evalDataset(cases, fixtures), { now: FIXTURE_NOW, judge: createStubJudge(),
    createAgent: async input => {
      assert.equal((await input.world.agentConfig.get()).corporateQuantityThreshold, 5);
      return createAgent({ ...input, model: scriptedModel([
        messages => {
          const text = String(messages.at(-1).content);
          const units = text.includes("30 unidades") ? 30 : 8;
          return reply("carrito_agregar", { productId: "product-a", variantId: "variant-a", quantity: units });
        },
        reply("responder", { texto: "Esa cantidad la coordina el equipo. ¿Querés hablar con una persona?", entendido: true }),
      ]) });
    } });
  for (const item of report.cases) {
    assert.equal(item.repetitions.length, 3);
    for (const run of item.repetitions) {
      assert.equal(run.executed, true); assert.equal(run.status, "not_evaluated");
      assert.deepEqual(run.diagnostics, []); assert.ok(run.checks.every(check => check.pass));
      assert.equal(run.before.agentConfig.corporateQuantityThreshold, 5);
      const result = run.tools.find(tool => tool.name === "carrito_agregar").result;
      assert.equal(result.code, "CANTIDAD_CORPORATIVA"); assert.equal(result.threshold, 5);
      assert.equal(result.totalUnits, Number(item.id.split("-").at(-1)));
      assert.equal(run.after.cart, null); assert.equal(run.after.alertRequests.length, 0);
      assert.equal(run.after.orderPersistence.counter.lastOrderNumber, 0);
      assert.equal(run.turns[0].handoffAfter, false);
    }
  }
});
test("runner conserva oferta del historial con umbral por caso y deriva al aceptar", async () => {
  const offer = "¿Querés que te comunique con una persona?";
  const report = await runEvaluation(evalDataset([evalCase({ id: "SUPPORT-VOLUME-ACCEPTED", category: "corporativo",
    context: { umbralCorporativo: 5, conversacion: [{ cliente: "Necesito varias unidades" }, { agente: offer }] },
    turns: [{ user: "Sí, dale" }], expect: { tools_called: ["derivar"], tools_not_called: ["crear_pedido"], handoff: "si" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: async input => {
      assert.equal((await input.world.agentConfig.get()).corporateQuantityThreshold, 5);
      assert.equal(input.world.getHistory().at(-1).content, offer);
      return createAgent({ ...input, model: scriptedModel([
        reply("derivar", { motivo: "Cliente aceptó atención para su solicitud de volumen", texto: "Una persona del equipo seguirá por este chat." }),
      ]) });
    } });
  assert.equal(report.cases[0].repetitions.length, 3);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.deepEqual(run.tools.map(tool => tool.name), ["derivar"]);
    assert.equal(run.turns[0].handoffAfter, true); assert.equal(run.after.alertRequests.length, 1);
    assert.equal(run.after.orderPersistence.counter.lastOrderNumber, 0);
  }
});
