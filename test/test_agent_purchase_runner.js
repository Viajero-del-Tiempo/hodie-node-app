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
