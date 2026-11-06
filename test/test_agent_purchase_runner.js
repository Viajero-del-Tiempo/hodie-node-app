import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runEvaluation } from "./eval/run-eval.js";
import { createStubJudge } from "./eval/judge.js";
import { createAgent } from "../src/agents/consultation/eval-adapter.js";
import { prepareShownQuote } from "./eval/initial-state.js";
import { evalDataset, evalCase, evalFixtures } from "./helpers/eval-fixtures.js";
import { consultationFixture, scriptedModel, reply, FIXTURE_NOW } from "./helpers/consultation-fixtures.js";
import { readyContext, itemArgs } from "./helpers/purchase-fixtures.js";
import { TECHNICAL_FAILURE_NOTICE } from "../src/agents/consultation/technical-failure.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

test("consulta de importe sin intención de compra usa cotizar(lineas) y no arma carrito", async () => {
  const f = await consultationFixture({ model: scriptedModel([
    reply("cotizar", { lineas: [{ ...itemArgs, quantity: 3 }] }),
    messages => { const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.items[0].subtotal, 300); assert.equal(result.confirmable, false);
      return reply("responder", { texto: "Te paso el cálculo informativo.", entendido: true }); },
  ]) });
  try {
    await f.run({ user: "¿Cuánto salen tres unidades?" });
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["cotizar", "responder"]);
    assert.ok(f.transport.getOutgoing()[0].text.includes("Subtotal de productos: 300 Gs."));
    assert.equal(f.world.getCart(), null); assert.equal(f.world.getState().lastQuote, null);
    assert.equal(f.world.quotes.list().length, 0);
  } finally { await f.agent.dispose(); f.close(); }
});

test("runner soporta confirmación K-01/K-02 real en memoria, pago textual y PDF independiente en tres repeticiones", async () => {
  const cases = ["Sí, confirmo, gracias!", "Dale 👍"].map((user, index) => evalCase({ id: "K-0" + (index + 1),
    context: { ...readyContext(), cotizacionMostrada: true }, turns: [{ user }],
    expect: { tools_called: ["crear_pedido", "responder"], handoff: "no" } }));
  const report = await runEvaluation(evalDataset(cases), { now: FIXTURE_NOW, judge: createStubJudge(),
    createAgent: input => createAgent({ ...input, model: scriptedModel([
      messages => { const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
        return reply("crear_pedido", { quoteId: context.lastQuote.quoteId }); },
      messages => { const result = JSON.parse(messages.at(-1).content); assert.equal(result.code, "OK");
        assert.equal(result.bankConfig, undefined); assert.equal(result.customerMessage, undefined);
        return reply("responder", { texto: "Texto del modelo sin datos de pago.", entendido: true }); },
    ]) }) });
  for (const item of report.cases) for (const run of item.repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    assert.equal(run.after.orders.length, run.before.orders.length + 1); assert.equal(run.after.cart, null);
    const order = run.after.orders.find(order => order.whatsappChatId?.startsWith("eval-"));
    assert.equal(order.status, "pending"); assert.equal(order.pdfDelivered, true);
    const message = run.turns[0].outgoing.find(message => message.type === "text").text;
    assert.ok(message.includes(order.orderNumber)); assert.ok(message.includes(run.before.paymentConfig.accountNumber));
    assert.equal(message.includes("Texto del modelo"), false);
    assert.equal(run.turns[0].outgoing.filter(message => message.type === "document").length, 1);
    assert.equal(run.after.orderPersistence.jobs.length, 1);
  }
  assert.equal(report.summary.diagnostic, true); // El stub no acredita calidad.
});
test("K-05: sí a mostrar el resumen cotiza y pide confirmación posterior sin registrar pedido", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "K-05", context: { ...readyContext(),
    conversacion: [{ agente: "¿Te muestro el resumen?" }] }, turns: [{ user: "Sí" }],
    expect: { tools_called: ["cotizar", "responder"], tools_not_called: ["crear_pedido"], handoff: "no" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("cotizar", {}), messages => reply("responder", { texto: "Revisá el resumen.", entendido: true,
        quoteIdMostrado: JSON.parse(messages.at(-1).content).quoteId }),
    ]) }) });
  for (const run of report.cases[0].repetitions) {
    assert.ok(run.checks.every(check => check.pass)); assert.deepEqual(run.after.orders, run.before.orders);
    assert.equal(run.after.orderPersistence.jobs.length, 0);
    assert.ok(run.turns[0].outgoing[0].text.includes("Subtotal de productos"));
    assert.ok(run.turns[0].outgoing[0].text.includes("¿Confirmás este pedido?"));
  }
});
test("el agente recupera un commit cuya respuesta falló y cierra con pago textual, sin derivar ni recrear", async () => {
  const faults = {}, model = scriptedModel([
    messages => {
      const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
      return reply("crear_pedido", { quoteId: context.lastQuote.quoteId });
    },
  ]);
  const f = await consultationFixture({ context: readyContext(), model, orderFaults: faults });
  try {
    await prepareShownQuote({ cotizacionMostrada: true }, f.world);
    const prior = f.world.getState(); prior.consecutiveTechnicalFailures = 1; f.world.setState(prior);
    faults.afterCommit = new Error("Respuesta perdida después del commit");
    const result = await f.run({ user: "Sí, confirmo, gracias!" });
    assert.equal(result.usage.calls, 1);
    assert.deepEqual(f.world.getEvents().filter(event => event.phase === "case").map(event => event.name), ["crear_pedido", "responder"]);
    const persistence = f.world.orderRepository.inspect();
    assert.equal(persistence.jobs.length, 1); assert.equal(persistence.counter.lastOrderNumber, 1);
    const order = await f.world.orderRepository.getOrder(persistence.jobs[0].orderId);
    assert.equal(order.status, "pending"); assert.equal(order.pdfDelivered, false);
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
    assert.deepEqual(f.world.getState().guardianAlerts, []);
    assert.equal(f.transport.getOutgoing().length, 1);
    assert.equal(f.transport.getOutgoing()[0].text, persistence.jobs[0].customerMessage);
    assert.ok(f.transport.getOutgoing()[0].text.includes(f.world.bankConfig.accountNumber));
    assert.equal(f.transport.getOutgoing()[0].text.includes(TECHNICAL_FAILURE_NOTICE), false);
  } finally { await f.agent.dispose(); f.close(); }
});
test("un aviso técnico desarma la confirmación anterior sin borrar el carrito", async () => {
  let quoteId;
  const f = await consultationFixture({ context: readyContext(), model: scriptedModel([
    () => { throw new Error("Falla de prueba"); },
    () => reply("crear_pedido", { quoteId }),
    messages => { assert.equal(JSON.parse(messages.at(-1).content).code, "CONFIRMACION_REQUERIDA");
      return reply("responder", { texto: "Hace falta mostrar el resumen de nuevo.", entendido: true }); },
  ]) });
  try {
    await prepareShownQuote({ cotizacionMostrada: true }, f.world);
    quoteId = f.world.getState().lastQuote.quoteId;
    const cart = f.world.getCart();
    await f.run({ user: "Confirmo" });
    assert.equal(f.transport.getOutgoing()[0].text, TECHNICAL_FAILURE_NOTICE);
    assert.equal(f.world.getState().lastQuote, null); assert.equal(f.world.getState().pendingOrderConfirmation, null);
    assert.deepEqual(f.world.getCart(), cart);
    await f.run({ user: "Sí" }, 2);
    assert.deepEqual(f.world.getCart(), cart); assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 0);
    assert.equal(f.world.orderRepository.inspect().jobs.length, 0);
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
  } finally { await f.agent.dispose(); f.close(); }
});
test("el timeout del guardián después del commit deja recuperar el pago y no envía el aviso técnico", async () => {
  const modelClock = createVirtualClock(0);
  let notifyStarted, finish;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const model = scriptedModel([
    messages => {
      const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
      return reply("crear_pedido", { quoteId: context.lastQuote.quoteId });
    },
    () => { notifyStarted(); return new Promise(resolve => { finish = resolve; }); },
  ]);
  const f = await consultationFixture({ context: readyContext(), model, modelClock });
  await prepareShownQuote({ cotizacionMostrada: true }, f.world);
  const task = f.run({ user: "Sí, confirmo" });
  const outcome = task.then(result => ({ result }), error => ({ error }));
  try {
    await Promise.race([started, outcome.then(value => { throw value.error ?? new Error("El turno terminó antes de confirmar"); })]);
    await f.world.clock.advanceAsync(60000);
    const result = await task;
    assert.equal(result.guardian.orderCommitted, true);
    assert.equal(result.diagnostics[0].code, "GUARDIAN_TIMEOUT");
    assert.deepEqual(f.transport.getOutgoing(), []);
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
    assert.deepEqual(f.world.getState().guardianAlerts, []);
    await f.world.orderJobs.drain();
    const job = f.world.orderRepository.inspect().jobs[0];
    const texts = f.transport.getOutgoing().filter(message => message.type === "text");
    assert.equal(texts.length, 1); assert.equal(texts[0].text, job.customerMessage);
    assert.ok(texts[0].text.includes(f.world.bankConfig.accountNumber));
    assert.equal(texts[0].text.includes(TECHNICAL_FAILURE_NOTICE), false);
    assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 1);
    finish(reply("responder", { texto: "No enviar después del cierre", entendido: true }));
    await flushMicrotasks();
    assert.deepEqual(f.transport.getOutgoing().filter(message => message.type === "text"), texts);
  } finally { await f.agent.dispose(); await outcome; f.close(); }
});
test("K-04: pregunta sobre política rearma confirmación corta y crea solo tras el sí posterior", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "K-04", context: { ...readyContext(), cotizacionMostrada: true },
    turns: [{ user: "¿Cuánto tarda?" }, { user: "Confirmo el pedido, gracias" }], expect: { handoff: "no" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("consultar_politicas", {}), reply("responder", { texto: "Te explico la política consultada.", entendido: true }),
      messages => { const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n")); return reply("crear_pedido", { quoteId: context.lastQuote.quoteId }); },
      reply("responder", { texto: "Cierre.", entendido: true }),
    ]) }) });
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.turns[0].outgoing[0].text, "Te explico la política consultada.\n\n¿Confirmás este pedido?");
    assert.equal(run.turns[0].snapshotAfter.orders.length, run.before.orders.length);
    assert.equal(run.after.orders.length, run.before.orders.length + 1);
    assert.equal(run.tools.filter(tool => tool.name === "crear_pedido")[0].turn, 2);
  }
});
test("recuperar un pedido confirmado no autoriza una novena herramienta si el cierre ya agotó las ocho", async () => {
  const steps = Array.from({ length: 6 }, () => reply("consultar_politicas", {}));
  steps.push(messages => {
    const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
    return reply("crear_pedido", { quoteId: context.lastQuote.quoteId });
  }, reply("responder", { texto: "Cierre.", entendido: true }));
  const f = await consultationFixture({ context: readyContext(), model: scriptedModel(steps) });
  try {
    await prepareShownQuote({ cotizacionMostrada: true }, f.world);
    let sends = 0;
    f.transport.sendText = async () => { sends++; throw new Error("Entrega incierta del mensaje"); };
    await f.run({ user: "Sí, confirmo" });
    const tools = f.world.getEvents().filter(event => event.phase === "case");
    assert.equal(tools.length, 8); assert.equal(tools.at(-1).name, "responder");
    assert.equal(sends, 1); assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 1);
    assert.equal(f.world.orderRepository.inspect().jobs[0].phase, "receipt_sending");
    assert.equal(f.world.getState().humanHandoffRequired, false);
  } finally { await f.agent.dispose(); f.close(); }
});
test("K-03: una confirmación mezclada con cambio de envío invalida el resumen y no crea", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "K-03", context: { ...readyContext(), cotizacionMostrada: true },
    turns: [{ user: "Sí, pero mandalo a Ciudad Beta" }],
    expect: { tools_called: ["datos_envio"], tools_not_called: ["crear_pedido"], handoff: "no" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(), createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("datos_envio", { city: "Ciudad Beta" }), reply("responder", { texto: "Necesito la cédula del destinatario.", entendido: true }),
    ]) }) });
  for (const run of report.cases[0].repetitions) {
    assert.ok(run.checks.every(check => check.pass)); assert.deepEqual(run.after.orders, run.before.orders);
    assert.equal(run.after.cart.shipping.city, "Ciudad Beta"); assert.equal(run.after.orderPersistence.confirmations.length, 0);
    assert.equal(run.after.orderPersistence.jobs.length, 0);
  }
});

test("cotizacionMostrada usa cotizar real; cambio fiscal F-05 emite otro resumen en tres repeticiones", async () => {
  const report = await runEvaluation(evalDataset([evalCase({ id: "F-05", context: { ...readyContext(), cotizacionMostrada: true },
    turns: [{ user: "Necesito factura, Persona Alfa, RUC 1234567-9" }],
    expect: { tools_called: ["datos_facturacion", "cotizar", "responder"], handoff: "no" } })]), {
    now: FIXTURE_NOW, judge: createStubJudge(),
    createAgent: input => createAgent({ ...input, model: scriptedModel([
      reply("datos_facturacion", { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567-9" }), reply("cotizar", {}),
      messages => reply("responder", { texto: "Actualicé los datos fiscales.", entendido: true, quoteIdMostrado: JSON.parse(messages.at(-1).content).quoteId }),
    ]) }),
  });
  assert.equal(report.summary.executed, 3); assert.equal(report.summary.modelUsage.agent.calls, 9);
  for (const run of report.cases[0].repetitions) {
    assert.equal(run.status, "not_evaluated"); assert.ok(run.checks.every(check => check.pass));
    const quotes = run.tools.filter(tool => tool.name === "cotizar");
    assert.equal(quotes.length, 2); assert.equal(quotes[0].phase, "setup");
    assert.notEqual(quotes[0].result.quoteId, quotes[1].result.quoteId);
    assert.notEqual(quotes[0].result.cartFingerprint, quotes[1].result.cartFingerprint);
    assert.equal(run.after.cart.billing.ruc, "1234567-9");
    assert.ok(run.turns[0].outgoing[0].text.includes("Persona Alfa · 1234567-9"));
    assert.deepEqual(run.after.orders, run.before.orders);
  }
});
test("setup real marca turno cero y guarda resumen autoritativo sin enviar ni llamar al modelo", async () => {
  const f = await consultationFixture({ context: readyContext() });
  try {
    await prepareShownQuote({ cotizacionMostrada: true }, f.world);
    const last = f.world.getState().lastQuote;
    assert.equal(last.shownTurn, 0); assert.equal(last.shownBatchId, "setup"); assert.ok(last.pricingFingerprint);
    assert.equal(last.quoteId, f.world.getEvents()[0].result.quoteId);
    assert.ok(f.world.getHistory().at(-1).content.includes("Subtotal de productos"));
    assert.deepEqual(f.transport.getOutgoing(), []); assert.equal(f.model.invocations.length, 0);
  } finally { await f.agent.dispose(); f.close(); }
});
test("sesión de más de seis horas conserva carrito y elimina cotización y confirmaciones anteriores", async () => {
  const f = await consultationFixture({ context: readyContext(), model: scriptedModel([
    reply("responder", { texto: "Retomamos el carrito.", entendido: true }),
  ]) });
  try {
    await prepareShownQuote({ cotizacionMostrada: true }, f.world);
    const cart = f.world.getCart(), state = f.world.getState();
    state.pendingTextConfirmation = { value: "Texto Alfa", shown: true, shownSequence: 0 };
    state.pendingRucConfirmation = { input: "1234567", shown: true, shownSequence: 0 };
    f.world.setState(state);
    await f.world.clock.advanceAsync(6 * 60 * 60 * 1000 + 1);
    const result = await f.run({ user: "Seguimos" });
    assert.equal(result.guardian.newSession, true); assert.deepEqual(f.world.getCart(), cart);
    for (const key of ["lastQuote", "pendingTextConfirmation", "pendingRucConfirmation"]) assert.equal(f.world.getState()[key], null);
    assert.equal(f.transport.getOutgoing()[0].text, "Retomamos el carrito.");
  } finally { await f.agent.dispose(); f.close(); }
});
test("contrato del agente permite carrito, subtotal incompleto y cierre dentro del límite de llamadas", async () => {
  const model = scriptedModel([reply("carrito_agregar", { ...itemArgs, quantity: 3 }), reply("cotizar", {}),
    messages => { const quote = JSON.parse(messages.at(-1).content); assert.equal(quote.subtotal, 300);
      assert.equal(quote.quoteId, undefined); return reply("responder", { texto: "¿Necesitás factura?", entendido: true }); }]);
  const f = await consultationFixture({ model });
  try {
    await f.run({ user: "Quiero tres productos Alfa" });
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["carrito_agregar", "cotizar", "responder"]);
    assert.ok(f.transport.getOutgoing()[0].text.includes("Subtotal de productos: 300 Gs."));
    assert.equal(f.world.getCart().lines[0].quantity, 3); assert.equal(f.world.getState().lastQuote, null);
  } finally { await f.agent.dispose(); f.close(); }
});
test("Q-03 usa PNG sintético: upload en memoria, literal por confirmar y ningún byte persistido", async () => {
  const fixtures = evalFixtures(); fixtures.products[0].customization.allowsImage = true;
  const png = await readFile(new URL("./eval/media/q03-reference.png", import.meta.url));
  const model = scriptedModel([messages => {
    const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
    assert.equal(messages.at(-1).content[1].type, "image_url");
    return reply("carrito_agregar", { ...itemArgs, texto: "Texto Alfa", attachmentId: context.attachments[0].attachmentId });
  }, reply("responder", { texto: "La imagen queda como referencia; una persona debe revisar el diseño.", entendido: true })]);
  const f = await consultationFixture({ fixtures, model });
  try {
    f.transport.getAttachment = () => ({ data: png, mimeType: "image/png" });
    const turn = { turn: 1, messages: [{ text: "Usá Texto Alfa y esta referencia sintética", type: "image", attachmentId: "synthetic" }],
      attachments: [{ id: "synthetic", type: "image", mode: "file" }] };
    const signal = new AbortController().signal; f.world.beginTurn(1, signal);
    await f.agent.runTurn({ turn, history: [], now: f.world.now(), signal });
    const line = f.world.getCart().lines[0];
    assert.equal(line.customization.textDraft, "Texto Alfa"); assert.equal(line.customization.text, null);
    assert.equal(line.customization.imageUrl, "https://example.test/upload-1.png"); assert.equal(f.world.uploads.list().length, 1);
    assert.ok(f.transport.getOutgoing()[0].text.includes("“Texto Alfa”"));
    const persistent = JSON.stringify({ state: f.world.getState(), cart: f.world.getCart(), uploads: f.world.uploads.list() });
    for (const forbidden of ["attachmentId", "base64", png.toString("base64")]) assert.equal(persistent.includes(forbidden), false);
  } finally { await f.agent.dispose(); f.close(); }
});
