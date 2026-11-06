import test from "node:test";
import assert from "node:assert/strict";
import { purchaseFixture, itemArgs, localShipping, readyContext } from "./helpers/purchase-fixtures.js";

for (const scenario of [
  { name: "transportadora", city: "Ciudad Alfa", method: "transportadora_contra_entrega", requiresDocument: true,
    label: "Transportadora: flete a pagar contra entrega" },
  { name: "local", city: localShipping.city, method: "local_gratis", requiresDocument: false,
    label: "Envío local gratuito" },
]) {
  test(`datos_envio registra al destinatario y devuelve modalidad, costo y cédula para envío ${scenario.name} aunque falten personalización y empaque`, async () => {
    const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
    try {
      f.world.profiles.set("595900000001", { name: "Persona Alfa" });
      const added = await f.call("carrito_agregar", itemArgs);
      assert.deepEqual(added.pendientes.slice(0, 2).map(item => item.tipo), ["personalizacion", "empaque"]);
      const supplied = { recipientName: "Persona Beta", city: scenario.city,
        department: "Zona Beta", street: "Referencia Beta" };
      f.nextTurn(`Para ${supplied.recipientName}, ${supplied.city}, ${supplied.department}, ${supplied.street}`);
      const result = await f.call("datos_envio", supplied);
      assert.equal(result.code, "OK");
      assert.deepEqual(result.shipping, { ...f.world.getCart().shipping, ...supplied });
      for (const [field, value] of Object.entries(supplied)) {
        assert.equal(result.cart.shipping[field], value, field);
        assert.equal(f.world.getCart().shipping[field], value, field);
      }
      assert.deepEqual(result.options, { city: scenario.city, shippingMethod: scenario.method,
        shippingCost: 0, requiresRecipientDocument: scenario.requiresDocument, label: scenario.label });
      assert.equal(result.fields.includes("shipping.recipientDocument"), scenario.requiresDocument);
      assert.deepEqual(result.pendientes.map(item => item.tipo), scenario.requiresDocument
        ? ["envio", "personalizacion", "empaque", "facturacion"] : ["personalizacion", "empaque", "facturacion"]);
      assert.equal(result.lines[0].id, added.lines[0].id);
      assert.equal(f.world.getState().userPhoneNumber, "595900000001");
      assert.equal(f.world.getState().phoneVerified, true);
      assert.deepEqual(f.world.getEvents().map(event => event.name), ["carrito_agregar", "datos_envio"]);
    } finally { f.close(); }
  });
}

test("envío y facturación devuelven líneas del catálogo, carrito actualizado y próximos pendientes sin releer", async () => {
  const f = purchaseFixture();
  try {
    const added = await f.call("carrito_agregar", itemArgs);
    const shipping = await f.call("datos_envio", { city: "Ciudad Alfa" });
    assert.equal(shipping.cart.shipping.city, "Ciudad Alfa");
    assert.equal(shipping.lines[0].id, added.lines[0].id); assert.equal(shipping.lines[0].productName, "Producto Alfa");
    assert.deepEqual(shipping.lines[0].packagingOptions, added.lines[0].packagingOptions);
    assert.deepEqual(shipping.pendientes.map(item => item.tipo), ["envio", "personalizacion", "empaque", "facturacion"]);
    const billing = await f.call("datos_facturacion", { invoiceRequested: false });
    assert.equal(billing.cart.billing.invoiceRequested, false); assert.equal(billing.cart.shipping.city, "Ciudad Alfa");
    assert.equal(billing.lines[0].id, added.lines[0].id); assert.equal(billing.options.requiresRecipientDocument, true);
    // Facturación ya quedó completa; envío sigue en curso en el mismo turno.
    assert.deepEqual(billing.pendientes.map(item => item.tipo), ["envio", "personalizacion", "empaque"]);
    assert.equal(billing.fields.includes("billing.invoiceRequested"), false);
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["carrito_agregar", "datos_envio", "datos_facturacion"]);
    assert.equal(Object.hasOwn(billing, "pending"), false);
  } finally { f.close(); }
});
test("envío en curso adelanta la cédula faltante y conserva la prioridad en lecturas del mismo turno", async () => {
  const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
  try {
    await f.call("carrito_agregar", itemArgs);
    f.nextTurn("Enviar a Persona Beta en Ciudad Alfa");
    const result = await f.call("datos_envio", { ...localShipping, city: "Ciudad Alfa" });
    assert.deepEqual(result.pendientes.map(item => item.tipo), ["envio", "personalizacion", "empaque", "facturacion"]);
    assert.deepEqual(result.pendientes[0], { tipo: "envio", fields: ["shipping.recipientDocument"] });
    assert.deepEqual((await f.call("carrito_ver")).pendientes, result.pendientes);
    assert.equal(result.options.requiresRecipientDocument, true);
    assert.equal(f.world.getCart().shipping.recipientDocument, null);
  } finally { f.close(); }
});
test("datos_envio también inicia el bloque en curso al crear un carrito antes de agregar líneas", async () => {
  const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
  try {
    const shipping = await f.call("datos_envio", { ...localShipping, city: "Ciudad Alfa" });
    assert.equal(shipping.code, "OK"); assert.deepEqual(shipping.cart.lines, []);
    assert.deepEqual(shipping.pendientes[0], { tipo: "envio", fields: ["shipping.recipientDocument"] });
    const added = await f.call("carrito_agregar", itemArgs);
    assert.equal(added.cart.id, shipping.cart.id);
    assert.deepEqual(added.pendientes.map(item => item.tipo), ["envio", "personalizacion", "empaque", "facturacion"]);
  } finally { f.close(); }
});
test("al completar el bloque de envío se vuelve al orden fijo de los otros pendientes", async () => {
  const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
  try {
    await f.call("carrito_agregar", itemArgs);
    const incomplete = await f.call("datos_envio", { ...localShipping, city: "Ciudad Alfa" });
    assert.deepEqual(incomplete.pendientes[0], { tipo: "envio", fields: ["shipping.recipientDocument"] });
    const complete = await f.call("datos_envio", { recipientDocument: "1234567" });
    assert.deepEqual(complete.pendientes.map(item => item.tipo), ["personalizacion", "empaque", "facturacion"]);
    assert.equal(complete.fields.some(field => field.startsWith("shipping.")), false);
    assert.deepEqual((await f.call("carrito_ver")).pendientes, complete.pendientes);
  } finally { f.close(); }
});
test("facturación en curso adelanta sus campos en orden propio y al completarla vuelve al orden fijo", async () => {
  const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
  try {
    await f.call("carrito_agregar", itemArgs);
    const started = await f.call("datos_facturacion", { invoiceRequested: true });
    assert.equal(started.code, "DATO_FALTANTE");
    assert.deepEqual(started.pendientes.map(item => item.tipo), ["facturacion", "personalizacion", "empaque", "envio"]);
    assert.deepEqual(started.pendientes[0], { tipo: "facturacion", fields: ["billing.legalName", "billing.ruc"] });
    assert.deepEqual((await f.call("carrito_ver")).pendientes, started.pendientes);
    const named = await f.call("datos_facturacion", { invoiceRequested: true, legalName: "Persona Beta" });
    assert.deepEqual(named.pendientes[0], { tipo: "facturacion", fields: ["billing.ruc"] });
    const complete = await f.call("datos_facturacion", { invoiceRequested: false });
    assert.deepEqual(complete.pendientes.map(item => item.tipo), ["personalizacion", "empaque", "envio"]);
    assert.equal(complete.fields.some(field => field.startsWith("billing.")), false);
  } finally { f.close(); }
});
test("sin bloque en curso rige el orden fijo; una marca del turno anterior o una escritura sin cambios no lo altera", async () => {
  const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
  try {
    const fixed = ["personalizacion", "empaque", "envio", "facturacion"];
    const added = await f.call("carrito_agregar", itemArgs);
    assert.deepEqual(added.pendientes.map(item => item.tipo), fixed);
    await f.call("datos_envio", { city: "Ciudad Alfa" });
    assert.equal((await f.call("carrito_ver")).pendientes[0].tipo, "envio");
    f.nextTurn("Consulta de prueba sin datos nuevos");
    const seen = await f.call("carrito_ver");
    assert.deepEqual(seen.pendientes.map(item => item.tipo), fixed);
    assert.deepEqual(seen.pendientes.find(item => item.tipo === "envio").fields,
      ["shipping.recipientName", "shipping.department", "shipping.street", "shipping.recipientDocument"]);
    const before = f.world.getCart();
    const unchanged = await f.call("datos_envio", { city: "Ciudad Alfa" });
    assert.deepEqual(unchanged.pendientes.map(item => item.tipo), fixed);
    assert.deepEqual(f.world.getCart(), before);
  } finally { f.close(); }
});
test("informar_subtotal conserva prioridad sobre bloques en curso sin duplicar sus pendientes", async () => {
  const f = purchaseFixture({ context: { telefonoCliente: "595900000001" } });
  try {
    await f.call("carrito_agregar", { ...itemArgs, texto: "Texto Alfa" });
    await f.call("carrito_agregar", { ...itemArgs, sinPersonalizacion: true, packagingType: null });
    const shipping = await f.call("datos_envio", { ...localShipping, city: "Ciudad Alfa" });
    assert.deepEqual(shipping.pendientes.map(item => item.tipo), ["informar_subtotal", "envio", "personalizacion", "empaque", "facturacion"]);
    const billing = await f.call("datos_facturacion", { invoiceRequested: true });
    assert.deepEqual(billing.pendientes.map(item => item.tipo), ["informar_subtotal", "facturacion", "envio", "personalizacion", "empaque"]);
    assert.deepEqual(billing.pendientes[1].fields, ["billing.legalName", "billing.ruc"]);
    assert.deepEqual(billing.pendientes[2].fields, ["shipping.recipientDocument"]);
    const quote = await f.call("cotizar");
    assert.equal(quote.code, "DATO_FALTANTE");
    assert.deepEqual(quote.pendientes.map(item => item.tipo), ["facturacion", "envio", "personalizacion", "empaque"]);
  } finally { f.close(); }
});
test("borrador fiscal pendiente de confirmar trae contexto actualizado y conserva diagnóstico de RUC", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const billing = await f.call("datos_facturacion", { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567" });
    assert.equal(billing.code, "RUC_COMPLETION_REQUIRED"); assert.equal(billing.field, "billing.ruc");
    assert.equal(billing.suggestedRuc, "1234567-9"); assert.equal(billing.cart.billing.ruc, "1234567");
    assert.equal(billing.lines[0].productName, "Producto Alfa");
    assert.ok(billing.pendientes.some(item => item.tipo === "facturacion" && item.fields.includes("billing.ruc")));
    assert.ok(billing.fields.includes("billing.ruc")); assert.equal(Object.hasOwn(billing, "pending"), false);
    assert.deepEqual(f.world.getEvents().map(event => event.name), ["datos_facturacion"]);
  } finally { f.close(); }
});

test("datos de envío son borradores; modalidad inmediata, cédula solo transportadora, identidad fuera del modelo", async () => {
  const f = purchaseFixture();
  try {
    // La cotización completa necesita una decisión de empaque, además de envío.
    await f.call("carrito_agregar", { ...itemArgs, packagingType: null });
    const carrier = await f.call("datos_envio", { city: "Ciudad Alfa" });
    assert.equal(carrier.options.shippingMethod, "transportadora_contra_entrega");
    assert.ok(carrier.fields.includes("shipping.recipientDocument"));
    await f.call("datos_envio", { ...localShipping, phone: "0900000001", recipientDocument: "1234567" });
    await f.call("datos_facturacion", { invoiceRequested: false });
    const quote = await f.call("cotizar");
    assert.equal(quote.confirmable, true); assert.equal(quote.shippingAddress.recipientDocument, undefined);
    assert.equal(f.world.getCart().shipping.recipientDocument, "1234567");
    assert.equal(f.world.getState().phoneVerified, false);
    assert.equal(f.world.getState().userPhoneNumber, null);
    assert.equal((await f.call("datos_envio", { phoneVerified: true })).field, "phoneVerified");
    const before = f.world.getCart();
    assert.equal((await f.call("datos_envio", { phone: "not-a-phone" })).code, "TELEFONO_INVALIDO");
    assert.deepEqual(f.world.getCart(), before);
    await f.call("datos_envio", { city: "Ciudad Beta" });
    assert.equal((await f.call("cotizar")).shippingAddress.recipientDocument, "1234567");
  } finally { f.close(); }
});
test("RUC sin guion se propone sin guardar DV; ni mismo turno ni afirmación del modelo lo confirman", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const args = { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567" };
    const result = await f.call("datos_facturacion", args);
    assert.equal(result.code, "RUC_COMPLETION_REQUIRED"); assert.equal(result.suggestedRuc, "1234567-9");
    assert.equal(f.world.getCart().billing.ruc, "1234567");
    const confirm = () => f.call("datos_facturacion", { ...args, confirmedRuc: "1234567-9" });
    assert.equal((await f.call("datos_facturacion", { ...args, ruc: "1234567-9" })).code, "CONFIRMACION_REQUERIDA");
    assert.equal(f.world.getCart().billing.ruc, "1234567");
    assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA");
    assert.equal((await f.call("cotizar")).quoteId, undefined);
    await f.call("responder", { texto: "Revisá el RUC.", entendido: true });
    assert.ok(f.transport.getOutgoing().at(-1).text.includes("¿Tu RUC es 1234567-9?"));
    assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA");
    f.nextTurn("Sí, pero cambia el nombre"); assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA");
    f.nextTurn("Sí"); assert.equal((await confirm()).code, "OK");
    assert.equal(f.world.getCart().billing.ruc, "1234567-9");
    assert.equal((await f.call("cotizar")).billing.legalName, "Persona Alfa");
  } finally { f.close(); }
});
test("DV discrepante se conserva sin arreglarlo y requiere aceptación explícita posterior", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const args = { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567-8" };
    f.nextTurn("Persona Alfa, RUC 1234567-8");
    assert.equal((await f.call("datos_facturacion", args)).code, "RUC_DV_MISMATCH");
    assert.equal(f.world.getCart().billing.ruc, "1234567-8");
    assert.equal((await f.call("datos_facturacion", { ...args, acknowledgeRucMismatch: true })).code, "CONFIRMACION_REQUERIDA");
    await f.call("responder", { texto: "Revisá los datos.", entendido: true });
    const question = f.transport.getOutgoing().at(-1).text;
    assert.ok(question.includes("corregir")); assert.ok(question.includes("continuar"));
    f.nextTurn("Sí");
    assert.equal((await f.call("datos_facturacion", { ...args, acknowledgeRucMismatch: true })).code, "CONFIRMACION_REQUERIDA");
    f.nextTurn("Continuar igual");
    assert.equal((await f.call("datos_facturacion", { ...args, acknowledgeRucMismatch: true })).code, "OK");
    assert.equal((await f.call("cotizar")).confirmable, true);
    assert.equal((await f.call("datos_facturacion", { invoiceRequested: true })).code, "OK");
    assert.equal(f.world.getCart().billing.rucValidation.status, "mismatch_confirmed");
    await f.call("datos_facturacion", { ...args, legalName: "Persona Beta" });
    assert.equal((await f.call("cotizar")).confirmable, false);
    f.nextTurn("Corregí a 1234567-9");
    await f.call("datos_facturacion", { ...args, legalName: "Persona Beta", ruc: "1234567-9" });
    assert.equal((await f.call("cotizar")).confirmable, true);
  } finally { f.close(); }
});
test("consumidor final limpia borrador fiscal; RUC válido no exige confirmar cada dato", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    f.nextTurn("Persona Alfa, RUC 1234567-9");
    await f.call("datos_facturacion", { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567-9" });
    assert.equal((await f.call("cotizar")).confirmable, true);
    await f.call("datos_facturacion", { invoiceRequested: false });
    assert.deepEqual((await f.call("cotizar")).billing, { invoiceRequested: false });
    assert.equal(f.world.getCart().billing.ruc, null); assert.equal(f.world.getState().pendingRucConfirmation, null);
    assert.equal((await f.call("datos_facturacion", { invoiceRequested: true, ruc: "abc" })).field, "billing.ruc");
  } finally { f.close(); }
});
test("perfiles fiscales solo del teléfono verificado propio; el modelo no puede elegir identidad", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    f.world.profiles.set("595900000001", { billingProfiles: [{ id: "fiscal-a", legalName: "Persona Alfa", ruc: "1234567-9" }] });
    f.world.profiles.set("595900000002", { billingProfiles: [{ id: "fiscal-b", legalName: "Persona Beta", ruc: "7654321-5" }] });
    assert.equal((await f.call("datos_facturacion", { invoiceRequested: true, billingProfileId: "fiscal-a" })).code, "OK");
    assert.equal((await f.call("datos_facturacion", { invoiceRequested: true, billingProfileId: "fiscal-b" })).code, "PERFIL_FISCAL_NO_DISPONIBLE");
    assert.equal((await f.call("datos_facturacion", { invoiceRequested: true, phoneVerified: true })).field, "phoneVerified");
    const state = f.world.getState(); state.phoneVerified = false; f.world.setState(state);
    assert.equal((await f.call("datos_facturacion", { invoiceRequested: true, billingProfileId: "fiscal-a" })).code, "PERFIL_FISCAL_NO_DISPONIBLE");
  } finally { f.close(); }
});

test("un sí a la pregunta de texto no confirma también una propuesta de RUC anterior", async () => {
  const f = purchaseFixture({ context: readyContext() });
  try {
    const fiscal = { invoiceRequested: true, legalName: "Persona Alfa", ruc: "1234567" };
    await f.call("datos_facturacion", fiscal); await f.call("responder", { texto: "Revisá el RUC.", entendido: true });
    const id = (await f.call("carrito_ver")).lines[0].id;
    f.nextTurn("Que diga Texto Alfa");
    await f.call("carrito_modificar", { linea: id, cambios: { texto: "Texto Alfa" } });
    await f.call("responder", { texto: "Revisá el texto.", entendido: true });
    f.nextTurn("Sí");
    const confirm = () => f.call("datos_facturacion", { ...fiscal, confirmedRuc: "1234567-9" });
    assert.equal((await confirm()).code, "CONFIRMACION_REQUERIDA");
    assert.equal((await f.call("carrito_modificar", { linea: id, cambios: { confirmarTexto: "Texto Alfa" } })).code, "OK");
    await f.call("responder", { texto: "Ahora revisá el RUC.", entendido: true });
    f.nextTurn("Sí"); assert.equal((await confirm()).code, "OK");
  } finally { f.close(); }
});
