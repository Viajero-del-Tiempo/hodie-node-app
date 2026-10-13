import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { evalCart } from "./helpers/eval-fixtures.js";
import { MISUNDERSTANDING_HANDOFF_MESSAGE } from "../src/services/agent-handoff.service.js";
import { purchaseFixture, readyContext, shownPurchaseFixture } from "./helpers/purchase-fixtures.js";

test("derivar es cierre con texto del modelo, alerta/contexto durables y silencio posterior", async () => {
  const text = "Una persona del equipo seguirá por este chat.";
  const cart = evalCart({ envio: { destinatario: "Persona Alfa", documento: "1234567", ciudad: "Ciudad Alfa",
    departamento: "Zona Alfa", direccion: "Referencia Alfa", telefono: "0900000000" },
    facturacion: { requiere: true, razonSocial: "Entidad Alfa", ruc: "1234567-9" } });
  cart.lineas[0] = { ...cart.lineas[0], cantidad: 2, texto: "Texto confirmado", empaque: "pack-a" };
  cart.lineas.push({ producto: "product-a", variante: "variant-a", cantidad: 1, empaque: null });
  const f = await consultationFixture({ model: scriptedModel([reply("derivar", { motivo: "Reclamo de prueba", texto: text })]),
    context: { telefonoCliente: "595900000001", carrito: cart } });
  try {
    const internal = f.world.getCart(); internal.id = "carrito-interno"; internal.revision = 7;
    internal.lines[0].id = "linea-interna-confirmada";
    internal.lines[1].id = "linea-interna-borrador"; internal.lines[1].customization.textDraft = "Texto sin confirmar";
    internal.billing.rucValidation = { status: "valid", expectedDigit: "9" }; f.world.setCart(internal);
    const state = f.world.getState();
    state.messages = [{ role: "user", content: "Mensaje previo", id: "mensaje-interno", metadata: { hash: "huella-interna" } }];
    f.world.setState(state);
    const previous = f.world.getCart(); const result = await f.run({ user: "Necesito una persona" });
    assert.deepEqual(result.diagnostics, []); assert.equal(f.world.getState().humanHandoffRequired, true);
    assert.deepEqual(f.transport.getOutgoing().map(value => value.text), [text]);
    assert.deepEqual(f.world.getCart(), previous); assert.equal(f.world.alertRequests.list().length, 1);
    const alert = f.world.alertRequests.list()[0]; assert.equal(alert.type, "HANDOFF"); assert.equal(alert.delivered, false);
    assert.deepEqual(alert.context.cart, {
      lines: [
        { productName: "Producto Alfa", variantLabel: "Opción Alfa", quantity: 2, customizationText: "Texto confirmado", packagingName: "Empaque Alfa" },
        { productName: "Producto Alfa", variantLabel: "Opción Alfa", quantity: 1, customizationText: null, packagingName: null },
      ],
      shipping: { recipientName: "Persona Alfa", recipientDocument: "1234567", city: "Ciudad Alfa", department: "Zona Alfa", street: "Referencia Alfa", phone: "0900000000" },
      billing: { invoiceRequested: true, legalName: "Entidad Alfa", ruc: "1234567-9" },
    });
    assert.deepEqual(Object.keys(alert.context).sort(), ["cart", "corporateRequest", "identity", "lastQuoteTotal", "messages", "orders"]);
    assert.deepEqual(alert.context.identity, { name: null, userPhoneNumber: "595900000001" });
    assert.equal(alert.context.lastQuoteTotal, null); assert.equal(alert.context.corporateRequest, null);
    const humanContext = JSON.stringify(alert.context);
    for (const hidden of ["carrito-interno", "linea-interna-confirmada", "linea-interna-borrador", "Texto sin confirmar",
      "productId", "variantId", "textDraft", "expiresAt", "revision", "rucValidation", "phoneVerified", "contextUnavailable",
      "mensaje-interno", "huella-interna"]) {
      assert.equal(humanContext.includes(hidden), false, hidden);
    }
    assert.equal(alert.context.orders[0].orderNumber, "test-order-a");
    assert.equal(alert.context.messages.at(-1).content, "Necesito una persona");
    assert.deepEqual(alert.context.messages, [{ role: "user", content: "Mensaje previo" }, { role: "user", content: "Necesito una persona" }]);
    const index = f.world.handoffs.get(f.world.getState().whatsappChatId); assert.equal(index.active, true);
    await f.run({ user: "Otro mensaje" }, 2); assert.equal(f.model.invocations.length, 1); assert.equal(f.transport.getOutgoing().length, 1);
    assert.equal(f.world.alertRequests.list().length, 1);
  } finally { await f.agent.dispose(); f.close(); }
});
test("alerta conserva solo el total del resumen mostrado y descarta sus huellas e identificadores", async () => {
  const f = await shownPurchaseFixture();
  try {
    const shown = f.world.getState().lastQuote; const cart = f.world.getCart();
    f.nextTurn("Necesito una persona");
    assert.equal((await f.call("derivar", { motivo: "Persona solicitada", texto: "Una persona seguirá por acá." })).code, "OK");
    const context = f.world.alertRequests.list()[0].context;
    assert.equal(context.lastQuoteTotal, f.quote.total); assert.deepEqual(f.world.getCart(), cart);
    assert.equal(f.world.getState().lastQuote, null);
    const content = JSON.stringify(context);
    for (const value of [shown.quoteId, shown.cartFingerprint, shown.pricingFingerprint, "shownAt", "shownTurn", "shownBatchId", "quoteId"]) {
      assert.equal(content.includes(value), false, value);
    }
  } finally { f.close(); }
});
test("una cotización no mostrada, ajena o con huellas distintas no aporta un total a la alerta", async () => {
  for (const kind of ["not_shown", "other_chat", "changed_fingerprint"]) {
    const f = purchaseFixture({ context: readyContext() });
    try {
      const quote = await f.call("cotizar"); assert.equal(quote.code, "OK");
      if (kind !== "not_shown") {
        await f.call("responder", { texto: "Resumen", entendido: true, quoteIdMostrado: quote.quoteId });
        f.world.quotes.set(quote.quoteId, { ...f.world.quotes.get(quote.quoteId),
          ...(kind === "other_chat" ? { chatId: "other@lid" } : { pricingFingerprint: "otra-huella" }) });
      }
      f.nextTurn("Quiero una persona");
      await f.call("derivar", { motivo: "Persona solicitada", texto: "Una persona seguirá por acá." });
      assert.equal(f.world.alertRequests.list()[0].context.lastQuoteTotal, null);
    } finally { f.close(); }
  }
});
test("cuarto turno false deriva por código con un solo mensaje, sin confiar en el texto del modelo", async () => {
  const f = await consultationFixture({ model: scriptedModel(Array.from({ length: 4 }, () => reply("responder", { texto: "Repregunta de prueba", entendido: false }))), context: { carrito: evalCart() } });
  try {
    const cart = f.world.getCart();
    for (let number = 1; number <= 4; number++) {
      await f.run({ user: "Mensaje de prueba " + number }, number);
      assert.equal(f.world.getState().consecutiveMisunderstandings, number);
      assert.equal(f.world.getState().humanHandoffRequired, number === 4);
    }
    assert.equal(f.transport.getOutgoing().length, 4); assert.equal(f.transport.getOutgoing()[3].text, MISUNDERSTANDING_HANDOFF_MESSAGE);
    assert.equal(f.world.getState().consecutiveTechnicalFailures, 0); assert.deepEqual(f.world.getCart(), cart);
    assert.equal(f.world.alertRequests.list().length, 1); assert.equal(f.world.alertRequests.list()[0].type, "MISUNDERSTANDING");
  } finally { await f.agent.dispose(); f.close(); }
});
test("fuera de alcance entendido y racha combinada escalan una vez por turno y derivan en el cuarto", async () => {
  const outside = { entendido: true, fueraDeAlcance: true };
  for (const flags of [Array.from({ length: 4 }, () => outside), [
    { entendido: false, fueraDeAlcance: false }, outside,
    { entendido: false, fueraDeAlcance: true }, outside,
  ]]) {
    const f = await consultationFixture({ context: { carrito: evalCart() }, model: scriptedModel(flags.map((args, index) => messages => {
      const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
      assert.equal(context.consecutiveMisunderstandings, index);
      return reply("responder", { texto: index === 2 ? "Puedo ayudarte con la tienda. ¿Querés hablar con una persona?" : "Respuesta de prueba", ...args });
    })) });
    try {
      const previous = f.world.getCart();
      for (let number = 1; number <= 4; number++) {
        const result = await f.run({ user: "Consulta fuera del catálogo de prueba " + number }, number);
        assert.deepEqual(result.diagnostics, []);
        assert.equal(f.world.getState().consecutiveMisunderstandings, number);
        assert.equal(f.world.getState().humanHandoffRequired, number === 4);
        assert.equal(f.world.alertRequests.list().length, number === 4 ? 1 : 0);
      }
      assert.equal(f.transport.getOutgoing().length, 4);
      assert.equal(f.transport.getOutgoing()[2].text, "Puedo ayudarte con la tienda. ¿Querés hablar con una persona?");
      assert.equal(f.transport.getOutgoing()[3].text, MISUNDERSTANDING_HANDOFF_MESSAGE);
      assert.deepEqual(f.world.getEvents().map(event => event.name), ["responder", "responder", "responder", "responder"]);
      assert.equal(f.world.alertRequests.list()[0].type, "MISUNDERSTANDING");
      assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
      assert.deepEqual(f.world.getCart(), previous);
      await f.run({ user: "Otra consulta" }, 5);
      assert.equal(f.model.invocations.length, 4); assert.equal(f.transport.getOutgoing().length, 4);
      assert.equal(f.world.alertRequests.list().length, 1);
    } finally { await f.agent.dispose(); f.close(); }
  }
});
test("un cierre normal reinicia la racha combinada; dos causas en un turno suman solo uno", async () => {
  const flags = [{ entendido: false }, { entendido: true, fueraDeAlcance: true }, { entendido: true, fueraDeAlcance: false },
    { entendido: false, fueraDeAlcance: true }, { entendido: false }];
  const f = await consultationFixture({ model: scriptedModel(flags.map(args => reply("responder", { texto: "Respuesta de prueba", ...args }))) });
  try {
    const expected = [1, 2, 0, 1, 2];
    for (let index = 0; index < flags.length; index++) {
      await f.run({ user: "Consulta de prueba " + index }, index + 1);
      assert.equal(f.world.getState().consecutiveMisunderstandings, expected[index]);
      assert.equal(f.world.getState().humanHandoffRequired, false);
    }
    assert.equal(f.world.alertRequests.list().length, 0); assert.equal(f.transport.getOutgoing().length, flags.length);
  } finally { await f.agent.dispose(); f.close(); }
});
test("ofrecer en el tercer turno no impide derivar cuando el cliente pide una persona explícitamente", async () => {
  const f = await consultationFixture({ model: scriptedModel([
    reply("responder", { texto: "Respuesta de prueba", entendido: true, fueraDeAlcance: true }),
    reply("responder", { texto: "Otra respuesta", entendido: false }),
    reply("derivar", { motivo: "Persona solicitada por el cliente", texto: "Una persona del equipo seguirá por este chat." }),
  ]) });
  try {
    await f.run({ user: "Consulta de prueba" }, 1); await f.run({ user: "Otra consulta" }, 2);
    assert.equal(f.world.getState().consecutiveMisunderstandings, 2);
    await f.run({ user: "Quiero hablar con una persona" }, 3);
    assert.equal(f.world.getState().humanHandoffRequired, true); assert.equal(f.world.alertRequests.list().length, 1);
    assert.equal(f.world.alertRequests.list()[0].type, "HANDOFF");
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["responder", "responder", "derivar"]);
  } finally { await f.agent.dispose(); f.close(); }
});
test("una lectura de contexto fallida no inventa datos ni pierde la solicitud humana", async () => {
  const f = await consultationFixture({ model: scriptedModel([reply("derivar", { motivo: "Persona solicitada", texto: "Una persona seguirá por acá." })]) });
  try {
    const original = f.world.cartRepository.get; let reads = 0;
    f.world.cartRepository.get = id => { if (++reads > 1) throw new Error("Lectura de contexto fallida"); return original(id); };
    await f.run();
    assert.equal(f.world.getState().humanHandoffRequired, true);
    const alert = f.world.alertRequests.list()[0], context = alert.context;
    assert.equal(alert.contextUnavailable, true); assert.equal(context.cart, null);
    assert.deepEqual(context.orders, []); assert.equal(f.transport.getOutgoing()[0].text, "Una persona seguirá por acá.");
  } finally { await f.agent.dispose(); f.close(); }
});
test("si falla leer el catálogo, deriva con datos parciales sin filtrar IDs ni borradores", async () => {
  const f = purchaseFixture({ context: { carrito: evalCart() } });
  try {
    f.world.catalog.getProductForPricing = async () => { throw new Error("Catálogo no disponible"); };
    const cart = f.world.getCart();
    const result = await f.call("derivar", { motivo: "Persona solicitada", texto: "Una persona seguirá por acá." });
    assert.equal(result.code, "OK"); assert.deepEqual(f.world.getCart(), cart);
    const alert = f.world.alertRequests.list()[0]; assert.equal(alert.contextUnavailable, true);
    assert.deepEqual(alert.context.cart.lines, [{ productName: null, variantLabel: null, quantity: 1, customizationText: null, packagingName: null }]);
    assert.equal(JSON.stringify(alert.context).includes("product-a"), false);
    assert.equal(JSON.stringify(alert.context).includes("variant-a"), false);
    assert.equal(f.transport.getOutgoing()[0].text, "Una persona seguirá por acá.");
  } finally { f.close(); }
});
test("alerta incluye pedidos del mismo chat sin resolver teléfono y excluye chats ajenos", async () => {
  const f = await consultationFixture({ model: scriptedModel([reply("derivar", { motivo: "Persona", texto: "Una persona seguirá por acá." })]) });
  try {
    f.world.orders.set("own-chat", { orderNumber: "own-chat", whatsappChatId: f.world.getState().whatsappChatId, userPhoneNumber: "595900000002", status: "pending" });
    f.world.orders.set("other-chat", { orderNumber: "other-chat", whatsappChatId: "other@lid", userPhoneNumber: "595900000002", status: "pending" });
    await f.run(); assert.deepEqual(f.world.alertRequests.list()[0].context.orders, [{ orderNumber: "own-chat", status: "pending" }]);
    assert.equal(f.world.getState().phoneVerified, false);
  } finally { await f.agent.dispose(); f.close(); }
});
test("un turno entendido y una sesión nueva reinician incomprensiones sin disparar handoff", async () => {
  for (const understood of [true, false]) {
    const f = await consultationFixture({ model: scriptedModel([reply("responder", { texto: "Respuesta", entendido: understood })]),
      context: understood ? {} : { sesionNueva: true } });
    try {
      const state = f.world.getState(); state.consecutiveMisunderstandings = 3; f.world.setState(state); await f.run();
      assert.equal(f.world.getState().consecutiveMisunderstandings, understood ? 0 : 1);
      assert.equal(f.world.getState().humanHandoffRequired, false); assert.equal(f.world.alertRequests.list().length, 0);
    } finally { await f.agent.dispose(); f.close(); }
  }
});
test("reserva octava permite derivar; lotes con cierres dobles o acciones posteriores no ejecutan efectos", async () => {
  const reads = Array.from({ length: 7 }, (_, index) => ({ id: "read-" + index, name: "ver_producto", args: { productId: "product-a" }, type: "tool_call" }));
  const f = await consultationFixture({ model: scriptedModel([new AIMessage({ content: "", tool_calls: reads }), reply("derivar", { motivo: "Solicitud de prueba", texto: "Una persona seguirá por acá." })]) });
  try { await f.run(); assert.equal(f.world.getEvents().length, 8); assert.equal(f.world.getState().humanHandoffRequired, true);
    assert.deepEqual(f.model.bindings.at(-1).options.allowedFunctionNames, ["responder", "derivar"]); } finally { await f.agent.dispose(); f.close(); }
  for (const names of [["derivar", "responder"], ["responder", "derivar"], ["derivar", "ver_producto"], ["derivar", "derivar"]]) {
    const bad = await consultationFixture({ model: scriptedModel([new AIMessage({ content: "", tool_calls: names.map((name, index) => ({ id: "call-" + index, name,
      args: name === "derivar" ? { motivo: "Motivo", texto: "No enviar" } : name === "responder" ? { texto: "No enviar", entendido: true } : { productId: "product-a" }, type: "tool_call" })) })]) });
    try { const result = await bad.run(); assert.equal(result.diagnostics[0].code, "INVALID_TOOL_BATCH");
      assert.equal(bad.world.getEvents().length, 0); assert.equal(bad.world.getState().humanHandoffRequired, false); }
    finally { await bad.agent.dispose(); bad.close(); }
  }
});
