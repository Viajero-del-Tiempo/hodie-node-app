import test from "node:test";
import assert from "node:assert/strict";
import { createOrderConfirmationConfig } from "../src/agents/consultation/order-confirmation.config.js";
import { isOrderAffirmation, acceptsOrderConfirmation } from "../src/agents/consultation/confirmations.js";
import { shownPurchaseFixture, purchaseFixture, readyContext } from "./helpers/purchase-fixtures.js";

test("afirmaciones completas admiten puntuación, emojis y agregados neutros configurables", () => {
  for (const text of ["sí", "sí, confirmo", "dale", "listo", "ok", "confirmo", "Dale 👍", "Sí, confirmo, gracias!",
    "confirmo el pedido", "sí por favor", "OK, perfecto, gracias 🙏", "genial, de acuerdo", "Sí 👍🏽", "confirmo el pedido por favor ✅"]) {
    assert.equal(isOrderAffirmation(text), true, text);
  }
  for (const text of ["sí, pero mandalo a otra dirección", "sí, cambiá la cantidad", "Sí?", "¿Confirmo?", "sí ❓", "sí 👎",
    "sí quiero otro", "dale y cuánto tarda", "confirmo si llega mañana", "ok, enviado", "perfecto", "gracias", "genial", "el pedido", ""])
    assert.equal(isOrderAffirmation(text), false, text);
  const env = Object.freeze({ AGENT_ORDER_AFFIRMATIONS: '["autorizo"]', AGENT_ORDER_NEUTRAL_ADDITIONS: '["muchas gracias"]' });
  const config = createOrderConfirmationConfig(env);
  assert.equal(isOrderAffirmation("autorizo, muchas gracias", config), true);
  assert.equal(isOrderAffirmation("sí, gracias", config), false);
  assert.equal(isOrderAffirmation("autorizo, muchas gracias, cambialo", config), false);
  assert.equal(isOrderAffirmation("autorizo?", config), false);
  for (const raw of [null, "[]", "null", "{}", '[".*"]', '["sí?"]', '[""]', 5])
    assert.throws(() => createOrderConfirmationConfig({ AGENT_ORDER_AFFIRMATIONS: raw }), { code: "INVALID_ORDER_CONFIRMATION_CONFIG" });
});
test("confirmación exige lote posterior y completo; otra parte de la ráfaga, imagen o metadatos inválidos no autoriza", () => {
  const pending = { shownSequence: 2, shownBatchId: "shown" };
  const turn = text => ({ sequence: 3, id: "later", messages: [{ type: "text", text }] });
  assert.equal(acceptsOrderConfirmation(pending, turn("Sí confirmo gracias")), true);
  assert.equal(acceptsOrderConfirmation(pending, { ...turn("sí"), sequence: 2 }), false);
  assert.equal(acceptsOrderConfirmation(pending, { ...turn("sí"), id: "shown" }), false);
  assert.equal(acceptsOrderConfirmation(null, turn("sí")), false);
  assert.equal(acceptsOrderConfirmation(pending, { ...turn("sí"), messages: [{ type: "text", text: "sí" }, { type: "text", text: "pero quiero cambiar" }] }), false);
  assert.equal(acceptsOrderConfirmation(pending, { ...turn("sí"), messages: [{ type: "image", text: "sí" }] }), false);
  assert.equal(acceptsOrderConfirmation(pending, { ...turn("sí"), messages: [{ type: "text", text: null }] }), false);
  assert.equal(acceptsOrderConfirmation(pending, { ...turn("sí"), messages: [{ type: "ptt", text: "[audio transcripto] sí confirmo" }] }), true);
});
test("un sí a otra pregunta y una aceptación en el mismo lote de mostrar el resumen no crean pedido", async () => {
  const f = await shownPurchaseFixture();
  try {
    await f.call("responder", { texto: "¿Querés ver imágenes?", entendido: true });
    f.nextTurn("Sí");
    assert.equal((await f.call("crear_pedido", { quoteId: f.quote.quoteId })).code, "CONFIRMACION_REQUERIDA");
    assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 0); assert.ok(f.world.getCart());
  } finally { f.close(); }
  const same = purchaseFixture({ context: readyContext() });
  try {
    same.nextTurn("Sí, confirmo");
    const quote = await same.call("cotizar");
    await same.call("responder", { texto: "Resumen.", entendido: true, quoteIdMostrado: quote.quoteId });
    assert.equal((await same.call("crear_pedido", { quoteId: quote.quoteId })).code, "CONFIRMACION_REQUERIDA");
    assert.equal(same.world.orderRepository.inspect().jobs.length, 0);
  } finally { same.close(); }
});
test("una pregunta con cotización vigente rearma pregunta corta sin repetir resumen; la aceptación posterior crea", async () => {
  const f = await shownPurchaseFixture();
  try {
    f.nextTurn("Cuánto tarda la preparación");
    const before = f.world.getState().lastQuote;
    const response = await f.call("responder", { texto: "Te explico la política consultada.", entendido: true });
    assert.equal(response.code, "OK");
    const text = f.transport.getOutgoing().at(-1).text;
    assert.equal(text, "Te explico la política consultada.\n\n¿Confirmás este pedido?");
    assert.equal(text.includes("Subtotal de productos"), false);
    assert.equal(f.world.getState().lastQuote.quoteId, before.quoteId);
    assert.ok(f.world.getState().lastQuote.shownTurn > before.shownTurn);
    assert.equal((await f.call("crear_pedido", { quoteId: f.quote.quoteId })).code, "CONFIRMACION_REQUERIDA");
    f.nextTurn("Sí, confirmo, gracias!");
    assert.equal((await f.call("crear_pedido", { quoteId: f.quote.quoteId })).code, "OK");
  } finally { f.close(); }
});
test("si cambió el precio, repreguntar exige una cotización nueva con resumen completo", async () => {
  const f = await shownPurchaseFixture();
  try {
    const original = f.world.catalog.getProductForPricing;
    f.world.catalog.getProductForPricing = async id => { const product = await original(id); product.variants[0].price = 240; return product; };
    f.nextTurn("¿Cuánto tarda?");
    assert.equal((await f.call("responder", { texto: "Te explico la política.", entendido: true })).code, "PRECIO_CAMBIO");
    const quote = await f.call("cotizar");
    await f.call("responder", { texto: "Cambió el precio.", entendido: true, quoteIdMostrado: quote.quoteId });
    assert.notEqual(quote.quoteId, f.quote.quoteId);
    assert.ok(f.transport.getOutgoing().at(-1).text.includes("Total del pedido: 240 Gs."));
    assert.ok(f.transport.getOutgoing().at(-1).text.includes("¿Confirmás este pedido?"));
  } finally { f.close(); }
});
