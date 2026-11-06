import test from "node:test";
import assert from "node:assert/strict";
import { purchaseFixture, itemArgs, readyContext } from "./helpers/purchase-fixtures.js";
import { ORDER_CONFIRMATION_QUESTION } from "../src/services/order-quote.service.js";

test("cotizar con lineas calcula subtotales sin carrito, confirmación ni quoteId", async () => {
  const f = purchaseFixture();
  try {
    const before = f.world.snapshot();
    const quote = await f.call("cotizar", { lineas: [{ ...itemArgs, quantity: 3 }, { ...itemArgs, quantity: 2, packagingType: "pack-a" }] });
    assert.equal(quote.code, "OK"); assert.equal(quote.mode, "informative"); assert.equal(quote.confirmable, false);
    assert.deepEqual(quote.items.map(item => item.subtotal), [300, 220]);
    assert.equal(quote.subtotal, 520); assert.equal(quote.productsTotal, 520);
    for (const key of ["quoteId", "total", "cartFingerprint", "shippingAddress", "billing"]) assert.equal(Object.hasOwn(quote, key), false);
    assert.deepEqual(f.world.snapshot(), before); assert.equal(f.world.quotes.list().length, 0);
    await f.call("responder", { texto: "Estos son los importes.", entendido: true });
    const text = f.transport.getOutgoing()[0].text;
    assert.ok(text.includes("Subtotal de esta línea: 300 Gs.")); assert.ok(text.includes("Subtotal de esta línea: 220 Gs."));
    assert.ok(text.includes("Subtotal de productos: 520 Gs.")); assert.equal(f.world.getCart(), null);
    assert.equal(text.includes("Texto pendiente"), false);
    assert.equal(f.world.getState().lastQuote, null);
  } finally { f.close(); }
});
test("cálculo informativo conserva carrito, TTL y última cotización mostrada, aun ante errores", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const quote = await f.call("cotizar");
    await f.call("responder", { texto: "Resumen", entendido: true, quoteIdMostrado: quote.quoteId });
    const before = f.world.snapshot(), lastQuote = f.world.getState().lastQuote, quotes = f.world.quotes.list();
    const info = await f.call("cotizar", { lineas: [{ ...itemArgs, quantity: 3 }] });
    assert.equal(info.subtotal, 300); assert.equal(info.confirmable, false); assert.equal(info.quoteId, undefined);
    for (const [lineas, code] of [
      [[{ ...itemArgs, quantity: 5 }, { ...itemArgs, quantity: 4 }], "SIN_STOCK"],
      [[{ ...itemArgs, packagingType: "missing" }], "EMPAQUE_INEXISTENTE"],
      [[{ ...itemArgs, variantId: "missing" }], "VARIANTE_INEXISTENTE"],
    ]) {
      const error = await f.call("cotizar", { lineas }); assert.equal(error.code, code);
      if (code === "SIN_STOCK") { assert.equal(error.available, 8); assert.equal(error.requested, 9); }
      assert.deepEqual(f.world.snapshot(), before); assert.deepEqual(f.world.getState().lastQuote, lastQuote);
      assert.deepEqual(f.world.quotes.list(), quotes);
    }
    const actual = await f.call("cotizar"); assert.equal(actual.total, 100); assert.equal(actual.confirmable, true);
  } finally { f.close(); }
});
test("esquema informativo rechaza precios, teléfonos, cantidades inválidas y líneas mal formadas", async () => {
  const f = purchaseFixture();
  try {
    for (const [args, field] of [[{ lineas: [] }, "lineas"], [{ lineas: {} }, "lineas"],
      [{ lineas: [null] }, "lineas[0]"], [{ lineas: [{ ...itemArgs, quantity: 1.5 }] }, "lineas[0].quantity"],
      [{ lineas: [{ ...itemArgs, price: 1 }] }, "lineas[0].price"],
      [{ lineas: [{ ...itemArgs, phoneVerified: true }] }, "lineas[0].phoneVerified"],
      [{ lineas: [{ ...itemArgs, productId: "a/b" }] }, "lineas[0].productId"]]) {
      const error = await f.call("cotizar", args); assert.equal(error.code, "ARGUMENTOS_INVALIDOS"); assert.equal(error.field, field);
    }
    assert.equal(f.world.getCart(), null); assert.equal(f.world.quotes.list().length, 0);
    const definition = f.registry.definitions()[0].functionDeclarations.find(item => item.name === "cotizar");
    assert.equal(definition.parameters.properties.lineas.items.type, "object");
    assert.deepEqual(definition.parameters.properties.lineas.items.required, ["productId", "variantId", "quantity"]);
  } finally { f.close(); }
});

test("cotización incompleta devuelve subtotal informativo sin total ni quoteId y responder lo rotula", async () => {
  const f = purchaseFixture();
  try {
    await f.call("carrito_agregar", { ...itemArgs, quantity: 2, packagingType: "pack-a" });
    const quote = await f.call("cotizar");
    assert.equal(quote.code, "DATO_FALTANTE"); assert.equal(quote.confirmable, false);
    assert.equal(quote.subtotal, 220); assert.equal(quote.total, undefined); assert.equal(quote.quoteId, undefined);
    assert.ok(quote.summary.includes("Empaque Alfa: 10 Gs. por unidad"));
    assert.ok(quote.fields.includes("billing.invoiceRequested")); assert.equal(f.world.quotes.list().length, 0);
    await f.call("responder", { texto: "¿Necesitás factura?", entendido: true });
    assert.ok(f.transport.getOutgoing()[0].text.includes("Subtotal de productos: 220 Gs."));
    assert.equal(f.world.getState().lastQuote, null);
  } finally { f.close(); }
});
test("quoteId pertenece al chat y a las dos huellas; solo envío exitoso registra lastQuote", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const quote = await f.call("cotizar");
    assert.equal(quote.code, "OK"); assert.equal(quote.confirmable, true); assert.equal(quote.total, 100);
    assert.equal(f.world.getState().lastQuote, null);
    const answer = { texto: "Este es tu resumen.", entendido: true, quoteIdMostrado: quote.quoteId };
    const send = f.transport.sendText;
    f.transport.sendText = async () => { throw new Error("No enviado"); };
    await assert.rejects(f.call("responder", answer), /No enviado/);
    assert.equal(f.world.getState().lastQuote, null);
    f.transport.sendText = send;
    await f.call("responder", answer);
    assert.equal(f.transport.getOutgoing().length, 1);
    const message = f.transport.getOutgoing()[0].text;
    assert.ok(message.includes(quote.summary)); assert.ok(message.endsWith(ORDER_CONFIRMATION_QUESTION));
    assert.equal(message, answer.texto + "\n\n" + quote.summary + "\n\n" + ORDER_CONFIRMATION_QUESTION);
    const last = f.world.getState().lastQuote;
    assert.equal(last.quoteId, quote.quoteId); assert.equal(last.cartFingerprint, quote.cartFingerprint);
    assert.equal(last.pricingFingerprint, quote.pricingFingerprint); assert.equal(last.shownTurn, 1);
    const other = { ...f.world.quotes.get(quote.quoteId), quoteId: "other-chat", chatId: "other@lid" };
    f.world.quotes.set(other.quoteId, other);
    assert.equal((await f.call("responder", { ...answer, quoteIdMostrado: other.quoteId })).code, "COTIZACION_INEXISTENTE");
    assert.equal((await f.call("responder", { ...answer, quoteIdMostrado: "forged" })).code, "COTIZACION_INEXISTENTE");
    assert.equal(f.transport.getOutgoing().length, 1);
  } finally { f.close(); }
});
test("cada cambio comercial, de envío o fiscal invalida el resumen mostrado conservando el resto", async () => {
  for (const [tool, args] of [["carrito_modificar", { cambios: { quantity: 2 } }],
    ["datos_envio", { street: "Referencia Beta" }], ["datos_facturacion", { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567-9" }]]) {
    const f = purchaseFixture({ context: readyContext() });
    try {
      const quote = await f.call("cotizar"); await f.call("responder", { texto: "Resumen", entendido: true, quoteIdMostrado: quote.quoteId });
      const before = f.world.getCart();
      if (tool === "datos_facturacion") f.nextTurn("Persona Alfa, RUC 1234567-9");
      const input = tool === "carrito_modificar" ? { ...args, linea: (await f.call("carrito_ver")).lines[0].id } : args;
      assert.equal((await f.call(tool, input)).code, "OK");
      assert.equal(f.world.getState().lastQuote, null);
      const rejected = await f.call("responder", { texto: "No enviar", entendido: true, quoteIdMostrado: quote.quoteId });
      assert.equal(rejected.code, "CARRITO_CAMBIO"); assert.equal(f.transport.getOutgoing().length, 1);
      assert.equal(f.world.getCart().shipping.recipientName, before.shipping.recipientName);
      assert.notEqual((await f.call("cotizar")).cartFingerprint, quote.cartFingerprint);
    } finally { f.close(); }
  }
});
test("precio o stock frescos se revalidan al mostrar, sin reserva ni alteración de pedidos", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const before = f.world.snapshot();
    const quote = await f.call("cotizar");
    const product = f.world.snapshot().catalog.products[0];
    // El puerto de catálogo se sustituye por una lectura fresca mutable en este test.
    f.runtime.catalog.getProductForPricing = async () => structuredClone(product);
    product.variants[0].price = 150;
    assert.equal((await f.call("responder", { texto: "No enviar", entendido: true, quoteIdMostrado: quote.quoteId })).code, "PRECIO_CAMBIO");
    const refreshed = await f.call("cotizar"); assert.equal(refreshed.total, 150);
    assert.notEqual(refreshed.pricingFingerprint, quote.pricingFingerprint);
    product.variants[0].stock = 0;
    const stock = await f.call("responder", { texto: "No enviar", entendido: true, quoteIdMostrado: refreshed.quoteId });
    assert.equal(stock.code, "SIN_STOCK"); assert.equal(stock.available, 0);
    assert.deepEqual(f.transport.getOutgoing(), []); assert.equal(f.world.getState().lastQuote, null);
    assert.deepEqual(f.world.snapshot().orders, before.orders);
    assert.equal(before.catalog.products[0].variants[0].stock, 8);
    assert.equal((await f.call("crear_pedido", { quoteId: refreshed.quoteId })).code, "CONFIRMACION_REQUERIDA");
    const after = f.world.snapshot();
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.orderPersistence.counter, before.orderPersistence.counter);
    assert.deepEqual(after.orderPersistence.jobs, before.orderPersistence.jobs);
    assert.equal(f.world.quotes.get(refreshed.quoteId).orderId, undefined);
  } finally { f.close(); }
});

test("un subtotal del turno anterior no se muestra como si se hubiera calculado en este turno", async () => {
  const f = purchaseFixture();
  try {
    await f.call("carrito_agregar", itemArgs); await f.call("cotizar");
    f.nextTurn("Gracias"); await f.call("responder", { texto: "De nada.", entendido: true });
    assert.equal(f.transport.getOutgoing().at(-1).text, "De nada.");
    assert.equal(f.world.getState().lastQuote, null);
  } finally { f.close(); }
});
