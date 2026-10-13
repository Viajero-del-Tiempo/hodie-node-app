import test from "node:test";
import assert from "node:assert/strict";
import { purchaseFixture, itemArgs, readyContext, localShipping } from "./helpers/purchase-fixtures.js";
import { evalFixtures } from "./helpers/eval-fixtures.js";
import { CART_TTL_MS } from "../src/services/cart.service.js";
import { createCartRepository } from "../src/services/cart.repository.js";

test("informar_subtotal aparece primero, se limpia al cotizar y vuelve con otro cambio real", async () => {
  for (const quoteArgs of [{}, { lineas: [{ ...itemArgs, quantity: 1 }] }]) {
    const f = purchaseFixture();
    try {
      const added = await f.call("carrito_agregar", { ...itemArgs, sinPersonalizacion: true, packagingType: null });
      assert.deepEqual(added.pendientes.map(item => item.tipo), ["informar_subtotal", "envio", "facturacion"]);
      const id = added.lines[0].id, cart = f.world.getCart();
      assert.equal((await f.call("carrito_ver")).pendientes[0].tipo, "informar_subtotal");
      const quote = await f.call("cotizar", quoteArgs);
      assert.equal(quote.subtotal, 100); assert.equal(quote.quoteId, undefined);
      assert.equal(quote.pendientes?.some(item => item.tipo === "informar_subtotal") ?? false, false);
      assert.deepEqual(f.world.getCart(), cart); assert.equal(f.world.getState().subtotalPending, null);
      assert.deepEqual((await f.call("carrito_ver")).pendientes.map(item => item.tipo), ["envio", "facturacion"]);
      const changed = await f.call("carrito_modificar", { linea: id, cambios: { quantity: 2 } });
      assert.equal(changed.pendientes[0].tipo, "informar_subtotal");
      await f.call("cotizar");
      assert.equal(f.world.getState().subtotalPending, null);
      const before = f.world.getCart();
      const repeated = await f.call("carrito_modificar", { linea: id, cambios: { quantity: 2 } });
      assert.equal(repeated.pendientes.some(item => item.tipo === "informar_subtotal"), false);
      assert.deepEqual(f.world.getCart(), before); // sin renovar TTL ni revisión
    } finally { f.close(); }
  }
});
test("solo una línea cambiada con personalización y empaque resueltos activa informar_subtotal", async () => {
  const f = purchaseFixture();
  try {
    const added = await f.call("carrito_agregar", itemArgs), id = added.lines[0].id;
    const types = result => result.pendientes.map(item => item.tipo);
    assert.equal(types(added).includes("informar_subtotal"), false);
    const custom = await f.call("carrito_modificar", { linea: id, cambios: { sinPersonalizacion: true } });
    assert.equal(types(custom).includes("informar_subtotal"), false); // falta decidir empaque
    const complete = await f.call("carrito_modificar", { linea: id, cambios: { packagingType: "pack-a" } });
    assert.deepEqual(types(complete), ["informar_subtotal", "envio", "facturacion"]);
    const shipping = await f.call("datos_envio", localShipping);
    assert.equal(shipping.pendientes[0].tipo, "informar_subtotal");
    const billing = await f.call("datos_facturacion", { invoiceRequested: false });
    assert.deepEqual(types(billing), ["informar_subtotal", "envio"]); // falta teléfono de contacto
    const quote = await f.call("cotizar"); assert.equal(quote.subtotal, 110);
    await f.call("datos_envio", { street: "Referencia Beta" });
    assert.equal((await f.call("carrito_ver")).pendientes.some(item => item.tipo === "informar_subtotal"), false);
    const reopened = await f.call("carrito_modificar", { linea: id, cambios: { sinPersonalizacion: false } });
    assert.equal(types(reopened).includes("informar_subtotal"), false); // línea incompleta otra vez
  } finally { f.close(); }
});
test("informar_subtotal precede también los pendientes de otras líneas incompletas", async () => {
  const f = purchaseFixture();
  try {
    await f.call("carrito_agregar", { ...itemArgs, texto: "Texto Alfa" });
    const result = await f.call("carrito_agregar", { ...itemArgs, sinPersonalizacion: true, packagingType: null });
    assert.deepEqual(result.pendientes.map(item => item.tipo), ["informar_subtotal", "personalizacion", "empaque", "envio", "facturacion"]);
    const quote = await f.call("cotizar");
    assert.equal(quote.subtotal, 200); assert.equal(quote.code, "DATO_FALTANTE");
    assert.deepEqual(quote.pendientes.map(item => item.tipo), ["personalizacion", "empaque", "envio", "facturacion"]);
  } finally { f.close(); }
});
test("texto confirmado más elección de empaque obliga a cotizar y mostrar subtotal antes del envío", async () => {
  const f = purchaseFixture();
  try {
    const added = await f.call("carrito_agregar", { ...itemArgs, texto: "Texto Alfa" }), id = added.lines[0].id;
    await f.call("responder", { texto: "Revisá el texto.", entendido: true });
    f.nextTurn("Sí");
    const confirmed = await f.call("carrito_modificar", { linea: id, cambios: { confirmarTexto: "Texto Alfa" } });
    assert.equal(confirmed.pendientes[0].tipo, "empaque");
    f.nextTurn("Elijo el empaque Alfa");
    const packed = await f.call("carrito_modificar", { linea: id, cambios: { packagingType: "pack-a" } });
    assert.deepEqual(packed.pendientes.map(item => item.tipo), ["informar_subtotal", "envio", "facturacion"]);
    const quote = await f.call("cotizar"); assert.equal(quote.subtotal, 110); assert.equal(quote.confirmable, false);
    assert.equal(quote.pendientes[0].tipo, "envio"); assert.equal(quote.quoteId, undefined);
    await f.call("responder", { texto: "Te paso el subtotal.", entendido: true });
    assert.ok(f.transport.getOutgoing().at(-1).text.includes("Subtotal de productos: 110 Gs."));
    assert.equal(f.world.getState().subtotalPending, null);
  } finally { f.close(); }
});
test("cotización fallida conserva el pendiente; expiración lo elimina junto con el carrito", async () => {
  const f = purchaseFixture();
  try {
    await f.call("carrito_agregar", { ...itemArgs, sinPersonalizacion: true, packagingType: null });
    const pending = f.world.getState().subtotalPending, before = f.world.getCart();
    const product = await f.runtime.catalog.getProductForPricing(itemArgs.productId); product.variants[0].stock = 0;
    f.runtime.catalog.getProductForPricing = async () => structuredClone(product);
    assert.equal((await f.call("cotizar")).code, "SIN_STOCK");
    assert.deepEqual(f.world.getState().subtotalPending, pending); assert.deepEqual(f.world.getCart(), before);
    assert.equal((await f.call("carrito_ver")).pendientes[0].tipo, "informar_subtotal");
    await f.clock.advanceAsync(CART_TTL_MS);
    assert.equal((await f.call("carrito_ver")).cart, null); assert.equal(f.world.getState().subtotalPending, null);
  } finally { f.close(); }
});
test("cotizar no limpia el pendiente de un cambio posterior mientras espera al catálogo", async () => {
  const f = purchaseFixture(); let release;
  try {
    const added = await f.call("carrito_agregar", { ...itemArgs, sinPersonalizacion: true, packagingType: null });
    const readProduct = f.runtime.catalog.getProductForPricing;
    let hold = true, started;
    const ready = new Promise(resolve => { started = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    f.runtime.catalog.getProductForPricing = async id => {
      if (hold) { hold = false; started(); await waiting; }
      return readProduct(id);
    };
    const quoting = f.call("cotizar"); quoting.catch(() => {});
    await ready;
    await f.call("carrito_modificar", { linea: added.lines[0].id, cambios: { quantity: 2 } });
    const currentPending = f.world.getState().subtotalPending;
    release(); await quoting;
    assert.deepEqual(f.world.getState().subtotalPending, currentPending);
    assert.equal((await f.call("carrito_ver")).pendientes[0].tipo, "informar_subtotal");
  } finally { release?.(); f.close(); }
});

test("pendientes ordena personalización, empaque, envío y facturación; sin empaque es explícito", async () => {
  const f = purchaseFixture();
  try {
    const added = await f.call("carrito_agregar", itemArgs), id = added.lines[0].id;
    assert.equal(added.lines[0].packagingType, null); assert.equal(added.lines[0].packaging.declined, false);
    assert.deepEqual(added.pendientes.map(item => item.tipo), ["personalizacion", "empaque", "envio", "facturacion"]);
    assert.deepEqual(added.pendientes[1].opciones, [{ type: "pack-a", name: "Empaque Alfa", price: 10 }]);
    assert.deepEqual((await f.call("carrito_ver")).pendientes, added.pendientes);
    const custom = await f.call("carrito_modificar", { linea: id, cambios: { sinPersonalizacion: true } });
    assert.deepEqual(custom.pendientes.map(item => item.tipo), ["empaque", "envio", "facturacion"]);
    assert.equal((await f.call("cotizar")).confirmable, false);
    assert.ok((await f.call("cotizar")).fields.includes("lines." + id + ".packagingType"));
    const noPack = await f.call("carrito_modificar", { linea: id, cambios: { packagingType: null } });
    assert.equal(noPack.lines[0].packaging.declined, true);
    assert.deepEqual(noPack.pendientes.map(item => item.tipo), ["informar_subtotal", "envio", "facturacion"]);
    const chosen = await f.call("carrito_modificar", { linea: id, cambios: { packagingType: "pack-a" } });
    assert.equal(chosen.lines[0].packaging.declined, false); assert.equal(chosen.lines[0].packagingType, "pack-a");
    assert.deepEqual(chosen.pendientes.map(item => item.tipo), ["informar_subtotal", "envio", "facturacion"]);
  } finally { f.close(); }
});
test("sin empaques no se pregunta; todos los pendientes de líneas van antes de datos generales", async () => {
  const fixtures = evalFixtures();
  fixtures.products.push({ ...structuredClone(fixtures.products[0]), id: "product-b", name: "Producto Beta", packagingOptions: [],
    variants: [{ ...fixtures.products[0].variants[0], id: "variant-b", sku: "TEST-B" }] });
  const f = purchaseFixture({ fixtures });
  try {
    await f.call("carrito_agregar", itemArgs);
    const result = await f.call("carrito_agregar", { productId: "product-b", variantId: "variant-b", quantity: 1 });
    assert.deepEqual(result.pendientes.map(item => item.tipo), ["personalizacion", "personalizacion", "empaque", "envio", "facturacion"]);
    assert.equal(result.pendientes[2].linea, result.lines[0].id);
    const seen = await f.call("carrito_ver"); assert.deepEqual(seen.pendientes, result.pendientes);
    assert.equal(seen.cart.lines[1].packaging.declined, false);
  } finally { f.close(); }
});
test("sumar una línea pendiente no pierde la elección sin empaque ya guardada", async () => {
  const f = purchaseFixture();
  try {
    const added = await f.call("carrito_agregar", { ...itemArgs, packagingType: null });
    const merged = await f.call("carrito_agregar", itemArgs);
    assert.equal(merged.lines.length, 1); assert.equal(merged.lines[0].id, added.lines[0].id);
    assert.equal(merged.lines[0].quantity, 2); assert.equal(merged.lines[0].packaging.declined, true);
    assert.equal(merged.pendientes.some(item => item.tipo === "empaque"), false);
  } finally { f.close(); }
});
test("empaque pendiente no emite quoteId aunque envío y facturación estén completos; elegir sin empaque sí", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const old = f.world.getCart(); delete old.lines[0].packaging;
    f.world.setCart(old); // Formato anterior con null ambiguo: no inferir elección.
    const pending = await f.call("carrito_ver");
    assert.equal(pending.lines[0].packaging.declined, false);
    assert.deepEqual(pending.pendientes.map(item => item.tipo), ["personalizacion", "empaque"]);
    const incomplete = await f.call("cotizar"); assert.equal(incomplete.code, "DATO_FALTANTE");
    assert.equal(incomplete.confirmable, false); assert.equal(incomplete.quoteId, undefined);
    assert.equal(f.world.quotes.list().length, 0);
    await f.call("carrito_modificar", { linea: pending.lines[0].id, cambios: { sinPersonalizacion: true, packagingType: null } });
    const complete = await f.call("cotizar"); assert.equal(complete.code, "OK");
    assert.equal(complete.confirmable, true); assert.equal(typeof complete.quoteId, "string");
    assert.deepEqual(complete.pendientes, []);
  } finally { f.close(); }
});

test("identidad por producto, variante, empaque y texto; fusionar no pierde IDs ni calcula precios", async () => {
  const f = purchaseFixture();
  try {
    let result = await f.call("carrito_agregar", { ...itemArgs, texto: "Alfa" });
    const id = result.lines[0].id;
    await f.call("carrito_agregar", { ...itemArgs, texto: "Alfa", quantity: 2 });
    await f.call("carrito_agregar", { ...itemArgs, texto: "Beta" });
    result = await f.call("carrito_agregar", { ...itemArgs, texto: "Alfa", packagingType: "pack-a" });
    assert.equal(result.lines.length, 3); assert.equal(result.lines[0].id, id);
    assert.equal(result.lines[0].quantity, 3);
    const modified = await f.call("carrito_modificar", { linea: result.lines[1].id, cambios: { texto: "Alfa" } });
    assert.equal(modified.lines.length, 2); assert.equal(modified.lines[0].id, id); assert.equal(modified.lines[0].quantity, 4);
    assert.equal((await f.call("carrito_quitar", { linea: id })).lines.length, 1);
    assert.equal((await f.call("carrito_quitar", { linea: id })).code, "LINEA_INEXISTENTE");
    for (const line of f.world.getCart().lines) for (const key of ["price", "total", "productName", "sku"]) assert.equal(Object.hasOwn(line, key), false);
  } finally { f.close(); }
});
test("stock agregado entre textos distintos; errores estructurados conservan todo el borrador", async () => {
  const f = purchaseFixture();
  try {
    await f.call("carrito_agregar", { ...itemArgs, quantity: 5, texto: "Alfa" });
    const before = f.world.snapshot();
    const stock = await f.call("carrito_agregar", { ...itemArgs, quantity: 4, texto: "Beta" });
    assert.equal(stock.code, "SIN_STOCK"); assert.equal(stock.available, 8); assert.equal(stock.requested, 9);
    assert.equal(stock.variantId, "variant-a"); assert.deepEqual(f.world.snapshot(), before);
    for (const [change, code] of [[{ packagingType: "missing" }, "EMPAQUE_INEXISTENTE"],
      [{ variantId: "missing" }, "VARIANTE_INEXISTENTE"], [{ texto: "x".repeat(21) }, "TEXTO_DEMASIADO_LARGO"],
      [{ quantity: 1.5 }, "ARGUMENTOS_INVALIDOS"]]) {
      assert.equal((await f.call("carrito_modificar", { linea: f.world.getCart().lines[0].id, cambios: change })).code, code);
      assert.deepEqual(f.world.snapshot(), before);
    }
    assert.equal((await f.call("carrito_agregar", { ...itemArgs, price: 1 })).field, "price");
    const product = await f.runtime.catalog.getProductForPricing("product-a"); product.variants[0].active = false;
    f.runtime.catalog.getProductForPricing = async () => structuredClone(product);
    assert.equal((await f.call("carrito_modificar", { linea: before.cart.lines[0].id, cambios: { quantity: 1 } })).code, "VARIANTE_INACTIVA");
    assert.deepEqual(f.world.snapshot(), before);
  } finally { f.close(); }
});
test("texto literal propuesto, pendiente, confirmado y rechazado son estados distintos", async () => {
  const f = purchaseFixture();
  try {
    const exact = "Á.G. & Compañía";
    const result = await f.call("carrito_agregar", { ...itemArgs, texto: exact });
    const id = result.lines[0].id;
    assert.equal(result.lines[0].customization.text, null); assert.equal(result.lines[0].customization.textDraft, exact);
    const confirm = () => f.call("carrito_modificar", { linea: id, cambios: { confirmarTexto: exact } });
    assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA");
    await f.call("responder", { texto: "Revisá el texto.", entendido: true });
    assert.ok(f.transport.getOutgoing().at(-1).text.includes("“" + exact + "”"));
    assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA"); // mismo lote
    f.nextTurn("Sí, pero mejor otro texto"); assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA");
    f.nextTurn("Sí");
    const confirmed = await confirm(); assert.equal(confirmed.lines[0].customization.text, exact);
    assert.equal(confirmed.lines[0].customization.textDraft, null); assert.equal(confirmed.lines[0].customization.pending, false);
    const revision = f.world.getCart().revision, expiresAt = f.world.getCart().expiresAt;
    await f.clock.advanceAsync(1000);
    const repeated = await f.call("carrito_modificar", { linea: id, cambios: { texto: exact } });
    assert.equal(repeated.lines[0].customization.text, exact); assert.equal(repeated.lines[0].customization.textDraft, null);
    assert.equal(f.world.getCart().revision, revision); assert.equal(f.world.getCart().expiresAt, expiresAt);
    const declined = await f.call("carrito_modificar", { linea: id, cambios: { sinPersonalizacion: true } });
    assert.equal(declined.lines[0].customization.declined, true); assert.equal(declined.lines[0].customization.pending, false);
    assert.equal(declined.lines[0].customization.text, null);
    const pending = await f.call("carrito_modificar", { linea: id, cambios: { sinPersonalizacion: false } });
    assert.equal(pending.lines[0].customization.declined, false); assert.equal(pending.lines[0].customization.pending, true);
  } finally { f.close(); }
});
test("cambiar variante o empaque conserva texto, imagen y otros datos de la línea", async () => {
  const fixtures = evalFixtures();
  fixtures.products[0].variants.push({ ...fixtures.products[0].variants[0], id: "variant-b", sku: "TEST-B" });
  const f = purchaseFixture({ fixtures });
  try {
    const result = await f.call("carrito_agregar", { ...itemArgs, texto: "Alfa" });
    const id = result.lines[0].id;
    const changed = await f.call("carrito_modificar", { linea: id, cambios: { variantId: "variant-b", packagingType: "pack-a" } });
    assert.equal(changed.lines[0].customization.textDraft, "Alfa"); assert.equal(changed.lines[0].quantity, 1); assert.equal(changed.lines[0].id, id);
  } finally { f.close(); }
});
test("TTL de tres días desde el último cambio; leer y cotizar no renuevan; vencimiento invalida lastQuote", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const quote = await f.call("cotizar"); await f.call("responder", { texto: "Resumen", entendido: true, quoteIdMostrado: quote.quoteId });
    const expires = f.world.getCart().expiresAt;
    await f.clock.advanceAsync(CART_TTL_MS - 1);
    await f.call("carrito_ver"); await f.call("cotizar"); assert.equal(f.world.getCart().expiresAt, expires);
    await f.clock.advanceAsync(1);
    assert.equal((await f.call("carrito_ver")).cart, null); assert.equal(f.world.getState().lastQuote, null);
    assert.equal((await f.call("cotizar")).quoteId, undefined);
    await f.call("carrito_agregar", itemArgs);
    const oldExpires = f.world.getCart().expiresAt;
    await f.clock.advanceAsync(1000);
    await f.call("carrito_modificar", { linea: f.world.getCart().lines[0].id, cambios: { quantity: 2 } });
    assert.equal(f.world.getCart().expiresAt, oldExpires + 1000);
  } finally { f.close(); }
});
test("imagen solo del turno actual; no sube al fallar validaciones y conserva solo URL", async () => {
  const fixtures = evalFixtures(); fixtures.products[0].customization.allowsImage = true;
  const f = purchaseFixture({ fixtures });
  try {
    f.nextTurn("Usá esta imagen", [{ id: "test-image", data: Buffer.from("synthetic-image"), mimeType: "image/png" }]);
    assert.equal((await f.call("carrito_agregar", { ...itemArgs, quantity: 9, attachmentId: "test-image" })).code, "SIN_STOCK");
    assert.equal(f.world.uploads.list().length, 0);
    const added = await f.call("carrito_agregar", { ...itemArgs, attachmentId: "test-image" });
    assert.equal(added.lines[0].customization.imageUrl, "https://example.test/upload-1.png");
    assert.equal(f.world.uploads.list().length, 1);
    assert.equal(JSON.stringify(f.world.snapshot()).includes("attachmentId"), false);
    f.nextTurn("Otra consulta");
    assert.equal((await f.call("carrito_modificar", { linea: added.lines[0].id, cambios: { attachmentId: "test-image" } })).code, "ADJUNTO_NO_DISPONIBLE");
    assert.equal(f.world.uploads.list().length, 1);
  } finally { f.close(); }
});
test("puerto de carts comprueba revisión antes de guardar; no escribe pedidos ni inicializa Firebase", async () => {
  const writes = [];
  const current = { revision: 2, updatedAt: 10, expiresAt: 200 };
  const snapshot = { exists: true, data: () => current };
  const db = { collection: name => { assert.equal(name, "carts"); return { doc: id => ({ id, get: async () => snapshot }) }; },
    runTransaction: handler => handler({ get: async () => snapshot, set: (ref, value) => writes.push({ ref, value }) }) };
  const repo = createCartRepository({ db, now: () => 100, timestampFromMillis: value => ({ toMillis: () => value }) });
  await assert.rejects(repo.set("test-chat", current, { expectedRevision: 1 }), { code: "CARRITO_CAMBIO" });
  assert.deepEqual(writes, []);
  await repo.set("test-chat", { ...current, revision: 3 }, { expectedRevision: 2 });
  assert.equal(writes.length, 1); assert.equal(writes[0].value.expiresAt.toMillis(), 200);
});

test("subida que termina después de cancelar no guarda la línea ni pierde el carrito anterior", async () => {
  const fixtures = evalFixtures(); fixtures.products[0].customization.allowsImage = true;
  const f = purchaseFixture({ fixtures });
  try {
    await f.call("carrito_agregar", itemArgs);
    const before = f.world.snapshot();
    f.nextTurn("Usá esta referencia", [{ id: "image", data: Buffer.from("synthetic"), mimeType: "image/png" }]);
    let finish, started;
    const ready = new Promise(resolve => { started = resolve; });
    f.runtime.uploadCustomizationImage = () => { started(); return new Promise(resolve => { finish = resolve; }); };
    const controller = new AbortController();
    const pending = f.call("carrito_modificar", { linea: before.cart.lines[0].id, cambios: { attachmentId: "image" } }, { signal: controller.signal });
    await ready; controller.abort(new Error("Cancelado")); finish("https://example.test/late.png");
    await assert.rejects(pending, /Cancelado/);
    assert.deepEqual(f.world.snapshot(), before); assert.deepEqual(f.transport.getOutgoing(), []);
  } finally { f.close(); }
});
