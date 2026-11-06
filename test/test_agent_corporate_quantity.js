import test from "node:test";
import assert from "node:assert/strict";
import { purchaseFixture, itemArgs, shownPurchaseFixture } from "./helpers/purchase-fixtures.js";
import { evalFixtures, evalCart } from "./helpers/eval-fixtures.js";

test("agregar sobre el umbral del contexto prioriza la oferta corporativa aun sin stock", async () => {
  for (const stock of [0, 1]) {
    const fixtures = evalFixtures(); fixtures.products[0].variants[0].stock = stock;
    const f = purchaseFixture({ fixtures, context: { umbralCorporativo: 5 } });
    try {
      let pricingReads = 0;
      const readProduct = f.world.catalog.getProductForPricing;
      f.world.catalog.getProductForPricing = async id => { pricingReads++; return readProduct(id); };
      const result = await f.call("carrito_agregar", { ...itemArgs, quantity: 30 });
      assert.equal(result.code, "CANTIDAD_CORPORATIVA");
      assert.equal(result.totalUnits, 30); assert.equal(result.threshold, 5);
      assert.equal(pricingReads, 0); assert.equal(f.world.getCart(), null);
      assert.equal(f.world.getState().pendingCorporateRequest.totalUnits, 30);
      assert.equal(f.world.getState().humanHandoffRequired, false);
      assert.equal(f.world.alertRequests.list().length, 0); assert.equal(f.world.uploads.list().length, 0);
      assert.equal(f.world.snapshot().orderPersistence.counter.lastOrderNumber, 0);
      assert.equal(f.world.quotes.list().length, 0);
    } finally { f.close(); }
  }
});
test("modificar sobre el umbral antecede al stock y conserva el carrito anterior", async () => {
  const fixtures = evalFixtures(); fixtures.products[0].variants[0].stock = 1;
  const f = purchaseFixture({ fixtures, context: { umbralCorporativo: 5 } });
  try {
    assert.equal((await f.call("carrito_agregar", itemArgs)).code, "OK");
    const cart = f.world.getCart();
    let pricingReads = 0;
    const readProduct = f.world.catalog.getProductForPricing;
    f.world.catalog.getProductForPricing = async id => { pricingReads++; return readProduct(id); };
    const result = await f.call("carrito_modificar", { linea: cart.lines[0].id, cambios: { quantity: 6 } });
    assert.equal(result.code, "CANTIDAD_CORPORATIVA"); assert.equal(result.threshold, 5);
    assert.equal(pricingReads, 0); assert.deepEqual(f.world.getCart(), cart);
    assert.equal(f.world.getState().pendingCorporateRequest.lines[0].quantity, 6);
    assert.equal((await f.call("cotizar")).code, "CANTIDAD_CORPORATIVA");
    assert.equal(pricingReads, 0); assert.equal(f.world.quotes.list().length, 0);
  } finally { f.close(); }
});
test("cotizar carrito inicial o líneas informativas sobre el umbral no llega a validar stock", async () => {
  for (const informative of [false, true]) {
    const fixtures = evalFixtures(); fixtures.products[0].variants[0].stock = 1;
    const cart = evalCart(); cart.lineas[0].cantidad = 6;
    const f = purchaseFixture({ fixtures, context: { umbralCorporativo: 5, ...(informative ? {} : { carrito: cart }) } });
    try {
      const before = f.world.snapshot();
      let pricingReads = 0;
      const readProduct = f.world.catalog.getProductForPricing;
      f.world.catalog.getProductForPricing = async id => { pricingReads++; return readProduct(id); };
      const result = await f.call("cotizar", informative ? { lineas: [{ ...itemArgs, quantity: 6 }] } : {});
      assert.equal(result.code, "CANTIDAD_CORPORATIVA"); assert.equal(result.totalUnits, 6);
      assert.equal(result.threshold, 5); assert.equal(result.quoteId, undefined);
      assert.equal(pricingReads, 0); assert.deepEqual(f.world.snapshot(), before);
    } finally { f.close(); }
  }
});
test("dentro del umbral siguen rechazándose stock insuficiente al agregar, modificar y cotizar", async () => {
  for (const operation of ["agregar", "modificar", "cotizar", "informativa"]) {
    const fixtures = evalFixtures(); fixtures.products[0].variants[0].stock = 1;
    const f = purchaseFixture({ fixtures, context: { umbralCorporativo: 5 } });
    try {
      if (["modificar", "cotizar"].includes(operation)) {
        assert.equal((await f.call("carrito_agregar", itemArgs)).code, "OK");
        if (operation === "cotizar") { const cart = f.world.getCart(); cart.lines[0].quantity = 5; f.world.setCart(cart); }
      }
      const previous = f.world.getCart();
      const result = operation === "agregar" ? await f.call("carrito_agregar", { ...itemArgs, quantity: 5 })
        : operation === "modificar" ? await f.call("carrito_modificar", { linea: previous.lines[0].id, cambios: { quantity: 5 } })
          : await f.call("cotizar", operation === "informativa" ? { lineas: [{ ...itemArgs, quantity: 5 }] } : {});
      assert.equal(result.code, "SIN_STOCK"); assert.equal(result.available, 1);
      assert.deepEqual(f.world.getCart(), previous); assert.equal(f.world.getState().pendingCorporateRequest, undefined);
      assert.equal(f.world.quotes.list().length, 0);
    } finally { f.close(); }
  }
});

test("total entre líneas supera umbral: conserva carrito, guarda solicitud y ofrece sin handoff", async () => {
  const f = purchaseFixture();
  try {
    f.world.agentConfig.set({ corporateQuantityThreshold: 3 });
    assert.equal((await f.call("carrito_agregar", { ...itemArgs, quantity: 2, texto: "Texto Alfa" })).code, "OK");
    const previous = f.world.getCart();
    const result = await f.call("carrito_agregar", { ...itemArgs, quantity: 2, texto: "Texto Beta" });
    assert.equal(result.code, "CANTIDAD_CORPORATIVA"); assert.equal(result.totalUnits, 4); assert.equal(result.threshold, 3);
    assert.deepEqual(f.world.getCart(), previous);
    const request = f.world.getState().pendingCorporateRequest; assert.equal(request.totalUnits, 4); assert.equal(request.lines.length, 2);
    assert.equal(request.lines[1].productName, "Producto Alfa"); assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.world.alertRequests.list().length, 0); assert.equal(f.world.snapshot().orderPersistence.counter.lastOrderNumber, 0);
    assert.equal((await f.call("cotizar")).code, "CANTIDAD_CORPORATIVA");
    await f.call("responder", { texto: "Puedo ofrecerte una persona del equipo.", entendido: true });
    assert.deepEqual(f.transport.getOutgoing().map(value => value.text), ["Puedo ofrecerte una persona del equipo."]);
    assert.equal((await f.call("derivar", { motivo: "Solicitud corporativa aceptada", texto: "Una persona seguirá por este chat." })).code, "OK");
    const context = f.world.alertRequests.list()[0].context;
    const lineDto = { productName: "Producto Alfa", variantLabel: "Opción Alfa", quantity: 2, customizationText: null, packagingName: null };
    assert.deepEqual(context.corporateRequest, { totalUnits: 4, lines: [lineDto, lineDto] });
    assert.deepEqual(context.cart, { lines: [lineDto],
      shipping: { recipientName: null, recipientDocument: null, city: null, department: null, street: null, phone: null },
      billing: { invoiceRequested: null, legalName: null, ruc: null } });
    assert.deepEqual(f.world.getCart(), previous);
    for (const hidden of ["productId", "variantId", "createdAt", "expiresAt", "textDraft", "Texto Alfa", "Texto Beta", "threshold"]) {
      assert.equal(JSON.stringify(context).includes(hidden), false, hidden);
    }
  } finally { f.close(); }
});
test("igualar el umbral permite seguir; modificar supera y una corrección válida limpia la solicitud", async () => {
  const f = purchaseFixture();
  try {
    f.world.agentConfig.set({ corporateQuantityThreshold: 3 });
    assert.equal((await f.call("carrito_agregar", { ...itemArgs, quantity: 3 })).code, "OK");
    const cart = f.world.getCart(), line = cart.lines[0].id;
    assert.equal((await f.call("carrito_modificar", { linea: line, cambios: { quantity: 4 } })).code, "CANTIDAD_CORPORATIVA");
    assert.deepEqual(f.world.getCart(), cart);
    assert.equal((await f.call("carrito_modificar", { linea: line, cambios: { quantity: 3 } })).code, "OK");
    assert.equal(f.world.getState().pendingCorporateRequest, null);
    assert.equal((await f.call("cotizar")).code, "DATO_FALTANTE");
  } finally { f.close(); }
});
test("suma variantes y productos; solicitudes no cambian precios, stock ni crean imágenes", async () => {
  const fixtures = evalFixtures(), other = structuredClone(fixtures.products[0]);
  other.id = "product-b"; other.name = "Producto Beta"; other.variants[0].id = "variant-b"; other.variants[0].sku = "TEST-B";
  fixtures.products.push(other);
  const f = purchaseFixture({ fixtures });
  try {
    f.world.agentConfig.set({ corporateQuantityThreshold: 2 });
    await f.call("carrito_agregar", { ...itemArgs, quantity: 2 }); const before = f.world.snapshot().catalog;
    const result = await f.call("carrito_agregar", { productId: "product-b", variantId: "variant-b", quantity: 1 });
    assert.equal(result.code, "CANTIDAD_CORPORATIVA"); assert.equal(result.totalUnits, 3);
    assert.deepEqual(f.world.snapshot().catalog, before); assert.equal(f.world.uploads.list().length, 0);
  } finally { f.close(); }
});
test("configuración faltante bloquea agregar, modificar y cotizar sin default", async () => {
  const f = purchaseFixture();
  try {
    await f.call("carrito_agregar", itemArgs); const cart = f.world.getCart(); f.world.agentConfig.set(null);
    for (const [name, args] of [["carrito_agregar", itemArgs], ["carrito_modificar", { linea: cart.lines[0].id, cambios: { quantity: 2 } }], ["cotizar", {}], ["cotizar", { lineas: [itemArgs] }]]) {
      const result = await f.call(name, args); assert.equal(result.code, "CONFIGURACION_INCOMPLETA"); assert.equal(result.field, "corporateQuantityThreshold");
      assert.deepEqual(f.world.getCart(), cart);
    }
    assert.equal(f.world.quotes.list().length, 0);
  } finally { f.close(); }
});
test("cotizar informativo suma sus líneas y no emite quoteId ni modifica carrito", async () => {
  const f = purchaseFixture();
  try {
    f.world.agentConfig.set({ corporateQuantityThreshold: 2 }); const before = f.world.snapshot();
    const result = await f.call("cotizar", { lineas: [{ ...itemArgs, quantity: 2 }, itemArgs] });
    assert.equal(result.code, "CANTIDAD_CORPORATIVA"); assert.equal(result.totalUnits, 3); assert.equal(result.quoteId, undefined);
    assert.deepEqual(f.world.snapshot(), before);
  } finally { f.close(); }
});
test("pricing conserva su tope por ítem aun con un umbral corporativo mayor", async () => {
  const fixtures = evalFixtures(); fixtures.products[0].variants[0].stock = 300;
  const f = purchaseFixture({ fixtures });
  try {
    f.world.agentConfig.set({ corporateQuantityThreshold: 250 });
    const result = await f.call("carrito_agregar", { ...itemArgs, quantity: 101 });
    assert.equal(result.code, "CANTIDAD_INVALIDA"); assert.equal(f.world.getCart(), null);
    assert.equal(f.world.getState().pendingCorporateRequest, undefined);
  } finally { f.close(); }
});
test("subir el umbral no aplica silenciosamente la solicitud rechazada ni cotiza el carrito anterior", async () => {
  const f = purchaseFixture();
  try {
    f.world.agentConfig.set({ corporateQuantityThreshold: 1 });
    assert.equal((await f.call("carrito_agregar", { ...itemArgs, quantity: 2 })).code, "CANTIDAD_CORPORATIVA");
    f.world.agentConfig.set({ corporateQuantityThreshold: 3 });
    assert.equal((await f.call("cotizar")).code, "SOLICITUD_PENDIENTE"); assert.equal(f.world.getCart(), null);
    assert.equal((await f.call("carrito_agregar", { ...itemArgs, quantity: 2 })).code, "OK");
    assert.equal(f.world.getState().pendingCorporateRequest, null);
  } finally { f.close(); }
});
test("crear_pedido vuelve a leer configuración en transacción; no toca pedido ni contador al rechazar", async () => {
  for (const missing of [false, true]) {
    const f = await shownPurchaseFixture();
    try {
      // Preparar una cotización de dos unidades con la configuración anterior.
      const cart = f.world.getCart(); cart.lines[0].quantity = 2; f.world.setCart(cart);
      f.nextTurn("Quiero dos"); const quote = await f.call("cotizar");
      await f.call("responder", { texto: "Revisá el resumen.", entendido: true, quoteIdMostrado: quote.quoteId });
      f.nextTurn("Sí, confirmo"); const previous = f.world.snapshot().orderPersistence;
      const previousOrders = f.world.orders.list();
      f.world.agentConfig.set(missing ? null : { corporateQuantityThreshold: 1 });
      // Si llegara al pricing, la foto fresca tampoco tiene stock suficiente.
      let pricingReads = 0;
      const readProduct = f.world.catalog.getProductForPricing;
      f.world.catalog.getProductForPricing = async id => {
        pricingReads++; const product = await readProduct(id);
        return { ...product, variants: product.variants.map(variant => ({ ...variant, stock: 0 })) };
      };
      const result = await f.call("crear_pedido", { quoteId: quote.quoteId });
      assert.equal(result.code, missing ? "CONFIGURACION_INCOMPLETA" : "CANTIDAD_CORPORATIVA");
      assert.equal(pricingReads, 0); assert.deepEqual(f.world.orders.list(), previousOrders);
      const after = f.world.snapshot().orderPersistence;
      assert.deepEqual(after.counter, previous.counter); assert.deepEqual(after.jobs, previous.jobs);
      assert.deepEqual(f.world.getCart(), cart); assert.equal(f.world.quotes.get(quote.quoteId).orderId, undefined);
    } finally { f.close(); }
  }
});
test("un pedido ya creado sigue idempotente aunque después falte la configuración", async () => {
  const f = await shownPurchaseFixture();
  try {
    const first = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    assert.equal(first.code, "OK"); f.world.agentConfig.set(null);
    const repeated = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    assert.equal(repeated.code, "OK"); assert.equal(repeated.orderId, first.orderId); assert.equal(repeated.created, false);
    assert.equal(f.world.snapshot().orderPersistence.counter.lastOrderNumber, 1);
    const rejected = await f.call("derivar", { motivo: "Persona", texto: "No reemplazar el pago" });
    assert.equal(rejected.code, "CIERRE_PEDIDO_REQUERIDO"); assert.equal(f.world.getState().humanHandoffRequired, false);
    await f.call("responder", { texto: "Texto que no debe reformular el banco", entendido: true });
    assert.equal(f.transport.getOutgoing().at(-1).text, f.world.orderRepository.inspect().jobs[0].customerMessage);
  } finally { f.close(); }
});
