import test from "node:test";
import assert from "node:assert/strict";
import { shownPurchaseFixture, readyContext, itemArgs, localShipping } from "./helpers/purchase-fixtures.js";

test("crear_pedido confirma en una sola transacción, guarda foto web, borra carrito y no descuenta stock", async () => {
  const f = await shownPurchaseFixture();
  try {
    const before = f.world.snapshot();
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    assert.equal(result.code, "OK"); assert.equal(result.created, true); assert.equal(result.total, f.quote.total);
    assert.match(result.orderNumber, /^hodie\d{6}$/u); assert.equal(result.pdfDelivered, false);
    const order = await f.world.orderRepository.getOrder(result.orderId);
    assert.equal(order.origin, "whatsapp"); assert.equal(order.status, "pending");
    assert.deepEqual(order.phoneVerification, { verified: true, source: "whatsapp_resolved" });
    assert.equal(order.userPhoneNumber, "595900000001"); assert.equal(order.items[0].variantId, "variant-a");
    assert.equal(order.items[0].customizationDeclined, true);
    assert.deepEqual(order.shippingAddress, f.quote.shippingAddress); assert.deepEqual(order.billing, f.quote.billing);
    assert.equal(order.stockDeducted, undefined); assert.equal(f.world.getCart(), null);
    assert.deepEqual(f.world.snapshot().catalog, before.catalog);
    assert.equal(f.world.quotes.get(f.quote.quoteId).orderId, order.id);
    const persistence = f.world.orderRepository.inspect();
    assert.equal(persistence.counter.lastOrderNumber, 1); assert.equal(persistence.jobs.length, 1);
    const trace = persistence.traces.find(trace => trace.some(item => item.operation === "write"));
    const firstWrite = trace.findIndex(item => item.operation === "write");
    assert.ok(trace.slice(0, firstWrite).some(item => item.name === "counter"));
    for (const name of ["cart", "quote", "confirmation", "product", "category", "agentConfig"]) assert.ok(trace.slice(0, firstWrite).some(item => item.name === name));
    assert.ok(trace.slice(firstWrite).every(item => item.operation === "write"));
  } finally { f.close(); }
});
test("dos solicitudes del mismo quoteId devuelven el mismo pedido y un único número/trabajo", async () => {
  const f = await shownPurchaseFixture({}, "confirmo el pedido");
  try {
    const responses = await Promise.all([f.call("crear_pedido", { quoteId: f.quote.quoteId }), f.call("crear_pedido", { quoteId: f.quote.quoteId })]);
    assert.ok(responses.every(result => result.code === "OK"));
    assert.equal(new Set(responses.map(result => result.orderId)).size, 1);
    assert.equal(new Set(responses.map(result => result.orderNumber)).size, 1);
    assert.deepEqual(responses.map(result => result.created).sort(), [false, true]);
    assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 1);
    assert.equal(f.world.orderRepository.inspect().jobs.length, 1);
    assert.equal(f.world.orders.list().filter(order => order.id === responses[0].orderId).length, 1);
  } finally { f.close(); }
});
test("repetir un quoteId anterior preserva un carrito nuevo y su cotización", async () => {
  const f = await shownPurchaseFixture();
  try {
    const first = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    await f.call("responder", { texto: "Cierre.", entendido: true });
    f.nextTurn("Otra compra");
    await f.call("carrito_agregar", { ...itemArgs, sinPersonalizacion: true, packagingType: null });
    await f.call("datos_envio", localShipping); await f.call("datos_facturacion", { invoiceRequested: false });
    const newer = await f.call("cotizar");
    await f.call("responder", { texto: "Otro resumen.", entendido: true, quoteIdMostrado: newer.quoteId });
    const cart = f.world.getCart();
    const repeated = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    assert.equal(repeated.orderId, first.orderId); assert.equal(repeated.created, false);
    assert.deepEqual(f.world.getCart(), cart); assert.equal(f.world.getState().lastQuote.quoteId, newer.quoteId);
    assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 1);
  } finally { f.close(); }
});
test("rollback antes del commit conserva carrito, cotización y contador; respuesta perdida después se recupera", async () => {
  for (const phase of ["beforeCommit", "afterCommit"]) {
    const faults = {}, f = await shownPurchaseFixture({ orderFaults: faults });
    try {
      const cart = f.world.getCart(); faults[phase] = new Error("Fallo inyectado " + phase);
      await assert.rejects(f.call("crear_pedido", { quoteId: f.quote.quoteId }), /Fallo inyectado/u);
      const state = f.world.orderRepository.inspect();
      if (phase === "beforeCommit") {
        assert.deepEqual(f.world.getCart(), cart); assert.equal(state.counter.lastOrderNumber, 0);
        assert.equal(state.jobs.length, 0); assert.equal(f.world.quotes.get(f.quote.quoteId).orderId, undefined);
      } else {
        assert.equal(f.world.getCart(), null); assert.equal(state.counter.lastOrderNumber, 1); assert.equal(state.jobs.length, 1);
        await f.call("responder", { texto: "No repetir.", entendido: true });
        assert.ok(f.transport.getOutgoing().at(-1).text.includes(state.jobs[0].orderNumber));
        assert.ok(f.transport.getOutgoing().at(-1).text.includes(f.world.bankConfig.accountNumber));
        const recovered = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
        assert.equal(recovered.orderId, state.jobs[0].orderId); assert.equal(recovered.created, false);
        assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 1);
      }
    } finally { f.close(); }
  }
});
test("el servidor agrega textual el mensaje de pedido y pago; el modelo no recibe ni puede reformular datos bancarios", async () => {
  const f = await shownPurchaseFixture();
  try {
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    const job = await f.world.orderRepository.getJob(result.orderId);
    assert.equal(result.customerMessage, undefined); assert.equal(result.bankConfig, undefined);
    for (const value of Object.values(f.world.bankConfig)) assert.equal(JSON.stringify(result).includes(value), false, value);
    await f.call("responder", { texto: "Transferí a una cuenta inventada. Pago confirmado.", entendido: true });
    assert.equal(f.transport.getOutgoing().at(-1).text, job.customerMessage);
    assert.ok(job.customerMessage.includes(result.orderNumber));
    assert.ok(job.customerMessage.includes(f.world.bankConfig.accountNumber));
    assert.ok(job.customerMessage.includes("verifica el pago manualmente"));
    assert.equal(job.customerMessage.split("\n").at(-1), "Apenas confirmemos el pago, empezamos a prepararlo");
    assert.equal(f.transport.getOutgoing().at(-1).text.split("\n").at(-1), "Apenas confirmemos el pago, empezamos a prepararlo");
    assert.equal((await f.world.orderRepository.getOrder(result.orderId)).status, "pending");
    assert.equal((await f.world.orderRepository.getJob(result.orderId)).receiptDelivered, true);
  } finally { f.close(); }
});
test("cambios de carrito o precio, agotados y argumentos comerciales/verificación falsos no crean pedidos", async () => {
  for (const scenario of ["cart", "price", "stock", "foreign", "arguments"]) {
    const f = await shownPurchaseFixture();
    try {
      let args = { quoteId: f.quote.quoteId }, code;
      if (scenario === "cart") { await f.call("datos_envio", { street: "Referencia Beta" }); code = "CARRITO_CAMBIO"; }
      if (["price", "stock"].includes(scenario)) {
        const original = f.world.catalog.getProductForPricing;
        f.world.catalog.getProductForPricing = async id => { const product = await original(id);
          product.variants[0][scenario === "price" ? "price" : "stock"] = scenario === "price" ? 101 : 0; return product; };
        code = scenario === "price" ? "PRECIO_CAMBIO" : "SIN_STOCK";
      }
      if (scenario === "foreign") { const quote = f.world.quotes.get(f.quote.quoteId); quote.chatId = "another@lid"; f.world.quotes.set(f.quote.quoteId, quote); code = "COTIZACION_INEXISTENTE"; }
      if (scenario === "arguments") { args = { ...args, total: 1, phoneVerified: true }; code = "ARGUMENTOS_INVALIDOS"; }
      assert.equal((await f.call("crear_pedido", args)).code, code, scenario);
      assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 0); assert.equal(f.world.orderRepository.inspect().jobs.length, 0);
      assert.ok(f.world.getCart());
    } finally { f.close(); }
  }
});
test("vuelve a verificar stock sumando líneas repetidas de la misma variante", async () => {
  const context = readyContext();
  context.carrito.lineas = [3, 3].map(cantidad => ({ producto: "product-a", variante: "variant-a", cantidad, texto: null, empaque: null }));
  const f = await shownPurchaseFixture({ context });
  try {
    const original = f.world.catalog.getProductForPricing;
    f.world.catalog.getProductForPricing = async id => { const product = await original(id); product.variants[0].stock = 5; return product; };
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    assert.equal(result.code, "SIN_STOCK"); assert.equal(result.requested, 6); assert.equal(result.available, 5);
    assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 0);
  } finally { f.close(); }
});
test("teléfono de contacto escrito crea foto no verificada, sin convertirlo en identidad de sesión", async () => {
  const context = readyContext(); delete context.telefonoCliente; context.carrito.envio.telefono = "0900000001";
  const f = await shownPurchaseFixture({ context });
  try {
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    const order = await f.world.orderRepository.getOrder(result.orderId);
    assert.equal(order.userPhoneNumber, "595900000001");
    assert.deepEqual(order.phoneVerification, { verified: false, source: "customer_supplied" });
    assert.equal(f.world.getState().phoneVerified, false);
  } finally { f.close(); }
});
