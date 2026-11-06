import test from "node:test";
import assert from "node:assert/strict";
import { buildInitialState, prepareShownQuote, CART_TTL_MS } from "./eval/initial-state.js";
import { createMemoryWorld, createClock, EVAL_AGENT_CONFIG } from "./eval/memory-world.js";
import { createFakeWhatsApp } from "./eval/fake-whatsapp.js";
import { evalFixtures, evalCart } from "./helpers/eval-fixtures.js";

const now = Date.parse("2026-01-01T12:00:00Z");
function initialize(context) {
  const fixtures = evalFixtures();
  const transport = createFakeWhatsApp();
  const world = createMemoryWorld(fixtures, { clock: createClock(now), transport });
  world.initialize(buildInitialState(context, fixtures, { chatId: "test-chat@lid", now }));
  return world;
}
test("umbral del contexto configura solo el servidor en memoria y no contamina otros casos", async () => {
  const fixtures = evalFixtures();
  const initial = buildInitialState({ umbralCorporativo: 5, carrito: evalCart() }, fixtures, { chatId: "test-chat@lid", now });
  assert.deepEqual(initial.agentConfig, { corporateQuantityThreshold: 5 });
  assert.equal(Object.hasOwn(initial.state, "umbralCorporativo"), false);
  assert.equal(Object.hasOwn(initial.state, "agentConfig"), false);
  assert.equal(Object.hasOwn(initial.cart, "umbralCorporativo"), false);
  const first = initialize({ umbralCorporativo: 5 }), second = initialize({ umbralCorporativo: 12 }), base = initialize({});
  try {
    assert.equal((await first.agentConfig.get()).corporateQuantityThreshold, 5);
    assert.equal((await second.agentConfig.get()).corporateQuantityThreshold, 12);
    assert.deepEqual(await base.agentConfig.get(), EVAL_AGENT_CONFIG);
    first.agentConfig.set({ corporateQuantityThreshold: 2 });
    assert.equal((await second.agentConfig.get()).corporateQuantityThreshold, 12);
    assert.deepEqual(await base.agentConfig.get(), EVAL_AGENT_CONFIG);
    assert.equal(first.snapshot().agentConfig.corporateQuantityThreshold, 2);
    // La configuración de un caso no se reutiliza al inicializar el siguiente.
    first.initialize(buildInitialState({}, fixtures, { chatId: "next-chat@lid", now }));
    assert.deepEqual(await first.agentConfig.get(), EVAL_AGENT_CONFIG);
    assert.deepEqual(buildInitialState({}, fixtures, { chatId: "next-chat@lid", now }).agentConfig, undefined);
  } finally { first.close(); second.close(); base.close(); }
});
test("initial-state rechaza umbral inválido aun sin pasar por el loader", () => {
  for (const value of [null, 0, -1, 1.5, "5", true, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.throws(() => buildInitialState({ umbralCorporativo: value }, evalFixtures(), { chatId: "test-chat@lid", now }), error => {
      assert.equal(error.code, "INVALID_CONTEXT");
      assert.ok(error.diagnostics.some(issue => issue.code === "INVALID_CONTEXT"
        && issue.path.join(".") === "context.umbralCorporativo"));
      return true;
    });
  }
});
test("mapea carrito, envío y facturación sin guardar precios ni confirmar RUC", () => {
  const cart = evalCart({
    actualizadoHaceHoras: 24,
    envio: { destinatario: "Persona Alfa", documento: "123456", ciudad: "Ciudad Alfa", departamento: "Zona Alfa", direccion: "Referencia Alfa", telefono: "0900000000" },
    facturacion: { requiere: true, razonSocial: "Entidad Alfa", ruc: "1234567-9" },
  });
  cart.lineas[0].texto = "Texto A";
  cart.lineas[0].empaque = "pack-a";
  const world = initialize({ telefonoCliente: "595900000001", carrito: cart });
  try {
    assert.equal(world.getState().phoneVerified, true);
    assert.equal(world.getState().userPhoneNumber, "595900000001");
    assert.equal(world.getCart().lines[0].productId, "product-a");
    assert.equal(world.getCart().lines[0].variantId, "variant-a");
    assert.equal(world.getCart().lines[0].packagingType, "pack-a");
    assert.equal(world.getCart().lines[0].customization.text, "Texto A");
    assert.equal(world.getCart().shipping.recipientName, "Persona Alfa");
    assert.equal(world.getCart().shipping.recipientDocument, "123456");
    assert.equal(world.getCart().billing.rucValidation, null);
    assert.equal(world.getCart().billing.ruc, "1234567-9");
    assert.equal(Object.hasOwn(world.getCart().lines[0], "price"), false);
    assert.equal(world.getCart().updatedAt, now - 24 * 3600000);
  } finally { world.close(); }
});
test("excluye historial anterior y conserva los mensajes declarados de la sesión actual", () => {
  const world = initialize({
    sesionNueva: true,
    historialPrevio: { haceHoras: 48, duranteHandoff: true, mensajes: [{ cliente: "Enlace viejo" }, { agente: "Respuesta vieja" }] },
    conversacion: [{ cliente: "Mensaje actual" }, { agente: "Respuesta actual" }],
    carrito: evalCart({ actualizadoHaceHoras: 24 }),
  });
  try {
    assert.equal(world.getState().messages.length, 4);
    assert.deepEqual(world.getHistory().map(message => message.content), ["Mensaje actual", "Respuesta actual"]);
    assert.equal(world.getState().humanHandoffRequired, false);
    assert.equal(world.getState().consecutiveMisunderstandings, 0);
    assert.equal(world.getState().phoneVerified, false);
    assert.equal(world.getState().userPhoneNumber, null);
    assert.equal(world.scenario.previousSession.duringHandoff, true);
    assert.ok(world.getCart());
  } finally { world.close(); }
});
test("null explícito es una decisión tomada; clave omitida conserva pendiente, sin leer ni editar YAML", () => {
  for (const explicit of [true, false]) {
    const cart = evalCart();
    if (!explicit) { delete cart.lineas[0].texto; delete cart.lineas[0].empaque; }
    const world = initialize({ carrito: cart });
    try {
      const line = world.getCart().lines[0];
      assert.equal(line.customization.declined, explicit);
      assert.equal(line.customization.pending, !explicit);
      assert.equal(line.packaging.declined, explicit);
      assert.equal(line.customization.text, null);
    } finally { world.close(); }
  }
});
test("carrito vence a 72 horas y el historial del modelo se limita a 20 mensajes", () => {
  const world = initialize({ carrito: evalCart({ actualizadoHaceHoras: CART_TTL_MS / 3600000 }),
    conversacion: Array.from({ length: 25 }, (_, index) => ({ cliente: "Mensaje " + index })) });
  try {
    assert.equal(world.getCart(), null);
    assert.equal(world.getHistory().length, 20);
    assert.equal(world.getHistory()[0].content, "Mensaje 5");
  } finally { world.close(); }
});
test("cotizacionMostrada no usa un sustituto ni inventa quoteId", async () => {
  const world = initialize({ carrito: evalCart() });
  try {
    await assert.rejects(prepareShownQuote({ cotizacionMostrada: true }, world), { code: "QUOTE_TOOL_UNAVAILABLE" });
    world.registerTool("cotizar", async () => ({ code: "OK", quoteId: "fake", cartFingerprint: "fake" }));
    await assert.rejects(prepareShownQuote({ cotizacionMostrada: true }, world), { code: "QUOTE_TOOL_UNAVAILABLE" });
    assert.equal(world.getState().lastQuote, null);
    assert.deepEqual(world.getEvents(), []);
  } finally { world.close(); }
});
test("cotización real usa el carrito inicial y el umbral del caso antes de mostrarse", async () => {
  const world = initialize({ carrito: evalCart(), umbralCorporativo: 5 });
  let calls = 0;
  world.registerTool("cotizar", async () => {
    calls++;
    assert.equal(world.getCart().lines[0].quantity, 1);
    assert.equal((await world.agentConfig.get()).corporateQuantityThreshold, 5);
    return { code: "OK", quoteId: "real-quote", cartFingerprint: "fingerprint", summary: "Resumen de prueba" };
  }, { real: true });
  try {
    await prepareShownQuote({ cotizacionMostrada: true }, world);
    assert.equal(calls, 1);
    assert.deepEqual(world.getState().lastQuote, {
      quoteId: "real-quote", cartFingerprint: "fingerprint", shownAt: now - 1, shownTurn: 0,
    });
    assert.equal(world.getEvents()[0].phase, "setup");
    assert.equal(world.getHistory().at(-1).content, "Resumen de prueba");
  } finally { world.close(); }
});
test("cotización rechazada no se registra como mostrada", async () => {
  const world = initialize({ carrito: evalCart() });
  world.registerTool("cotizar", async () => ({ code: "DATO_FALTANTE" }), { real: true });
  try {
    await assert.rejects(prepareShownQuote({ cotizacionMostrada: true }, world), { code: "INITIAL_QUOTE_FAILED" });
    assert.equal(world.getState().lastQuote, null);
  } finally { world.close(); }
});
test("servicio central lee solo las copias de fixtures y no expone CRUD admin", async () => {
  const world = initialize({});
  try {
    assert.equal((await world.catalog.searchProducts({ query: "Alfa" }))[0].id, "product-a");
    const product = await world.catalog.getProduct("product-a");
    product.variants[0].stock = 999;
    assert.equal((await world.catalog.getProduct("product-a")).variants[0].stock, 8);
    assert.equal(world.catalog.createProduct, undefined);
    assert.equal(world.snapshot().orders[0].status, "pending");
  } finally { world.close(); }
});
