import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { evalCart } from "./helpers/eval-fixtures.js";
import { productsWithImages } from "./helpers/product-images-fixtures.js";
import { createToolRegistry } from "../src/agents/consultation/tool-registry.js";
import { createResponder } from "../src/agents/consultation/terminal.js";
import { createFakeWhatsApp } from "./eval/fake-whatsapp.js";
import { prepareSession } from "../src/agents/guardian/session.js";
import { createGuardianConfig } from "../src/agents/guardian/config.js";
import { readyContext } from "./helpers/purchase-fixtures.js";
import { createProductImages } from "../src/agents/consultation/product-images.js";

const presented = ["product-a", "product-b", "product-c"];
const response = (productosMostrados = presented) => ({ texto: "Opciones del catálogo de prueba.", entendido: true, productosMostrados });
const close = async f => { await f.agent.dispose(); f.close(); };

test("responder envía texto primero y una foto por cada uno de hasta tres productos, con pie del catálogo", async () => {
  const f = await consultationFixture({ fixtures: productsWithImages() });
  try {
    const result = await f.world.invokeTool("responder", response());
    assert.equal(result.code, "OK");
    assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text", "image", "image", "image"]);
    assert.deepEqual(result.productImages, { sent: [
      { productId: "product-a", caption: "Producto de prueba 1 — 100 Gs." },
      { productId: "product-b", caption: "Producto de prueba 2 — 200 Gs." },
      { productId: "product-c", caption: "Producto de prueba 3 — 300 Gs." },
    ], skipped: [], failed: [], textOnly: [] });
    assert.deepEqual(f.transport.getOutgoing().slice(1).map(({ productId, caption }) => ({ productId, caption })), result.productImages.sent);
    assert.ok(f.world.getState().sentProductImages.every(entry => entry.delivery === "sent"));
  } finally { await close(f); }
});
test("principal respeta orden activo, salta variantes sin fotos y precio desde del servidor en foto o línea", async () => {
  for (const hasPhoto of [true, false]) {
    const fixtures = productsWithImages(), variant = fixtures.products[0].variants[0];
    fixtures.products[0].variants = [
      { ...variant, id: "inactive", sku: "TEST-INACTIVE", options: { finish: "Inactiva" }, active: false, price: 1, imageUrls: ["https://example.test/inactive.png"] },
      { ...variant, id: "no-image", sku: "TEST-NONE", options: { finish: "Sin foto" }, price: 80, imageUrls: [] },
      { ...variant, id: "first-photo", sku: "TEST-FIRST", options: { finish: "Primera foto" }, price: 120, stock: 0 },
      { ...variant, id: "other-photo", sku: "TEST-OTHER", options: { finish: "Otra foto" }, imageUrls: ["https://example.test/other.png"] },
    ];
    if (!hasPhoto) for (const row of fixtures.products[0].variants) row.imageUrls = [];
    const f = await consultationFixture({ fixtures });
    try {
      const result = await f.world.invokeTool("responder", response(["product-a"]));
      const outgoing = f.transport.getOutgoing(), caption = "Producto de prueba 1 — Desde 80 Gs.";
      assert.equal(result.code, "OK");
      assert.deepEqual(outgoing.map(item => item.type), hasPhoto ? ["text", "image"] : ["text", "text"]);
      if (hasPhoto) {
        assert.equal(result.productImages.sent[0].caption, caption);
        assert.equal(outgoing[1].caption, caption);
        assert.equal(outgoing[1].source, "https://example.test/a.png");
        assert.deepEqual(result.productImages.textOnly, []);
      } else {
        assert.equal(outgoing[1].text, caption);
        assert.deepEqual(result.productImages.sent, []);
        assert.deepEqual(result.productImages.textOnly, [{ productId: "product-a", caption }]);
        assert.deepEqual(result.productImages.skipped, [{ productId: "product-a", reason: "SIN_IMAGENES" }]);
      }
    } finally { await close(f); }
  }
});
test("sin foto no inventa envío; producto inexistente o inactivo se omite sin romper el cierre", async () => {
  const fixtures = productsWithImages(); fixtures.products[0].variants[0].imageUrls = []; fixtures.products[1].active = false;
  const f = await consultationFixture({ fixtures });
  try {
    const result = await f.world.invokeTool("responder", response(["product-a", "product-b", "missing"]));
    assert.deepEqual(result.productImages, { sent: [], skipped: [
      { productId: "product-a", reason: "SIN_IMAGENES" }, { productId: "product-b", reason: "PRODUCTO_NO_ENCONTRADO" },
      { productId: "missing", reason: "PRODUCTO_NO_ENCONTRADO" },
    ], failed: [], textOnly: [{ productId: "product-a", caption: "Producto de prueba 1 — 100 Gs." }] });
    assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text", "text"]);
    assert.equal(f.transport.getOutgoing()[1].text, "Producto de prueba 1 — 100 Gs.");
    assert.equal(f.world.getState().sentProductImages, undefined);
  } finally { await close(f); }
});
test("no repite fotos en sesión ni tras restaurar checkpoint; sesión nueva permite enviarlas otra vez", async () => {
  const fixtures = productsWithImages(), f = await consultationFixture({ fixtures }); let restored;
  try {
    await f.world.invokeTool("responder", response(["product-a"]));
    const repeated = await f.world.invokeTool("responder", response(["product-a"]));
    assert.deepEqual(repeated.productImages.skipped, [{ productId: "product-a", reason: "YA_ENVIADA" }]);
    assert.equal(f.transport.getOutgoing().filter(item => item.type === "image").length, 1);
    assert.deepEqual(repeated.productImages.textOnly, [{ productId: "product-a", caption: "Producto de prueba 1 — 100 Gs." }]);
    restored = await consultationFixture({ fixtures }); restored.world.setState(f.world.getState());
    assert.equal((await restored.world.invokeTool("responder", response(["product-a"]))).productImages.sent.length, 0);
    restored.world.setState(prepareSession(restored.world.getState(), restored.world.now(), createGuardianConfig(), { newSession: true }).state);
    assert.equal((await restored.world.invokeTool("responder", response(["product-a"]))).productImages.sent.length, 1);
  } finally { if (restored) await close(restored); await close(f); }
});
test("enviar_imagenes pide fotos adicionales, comparte deduplicación y no consume el cupo con la principal ya enviada", async () => {
  const fixtures = productsWithImages(); fixtures.products[0].variants[0].imageUrls.push("https://example.test/a-third.png", "https://example.test/a-fourth.png");
  const f = await consultationFixture({ fixtures });
  try {
    await f.world.invokeTool("responder", response(["product-a"]));
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a" }), { code: "OK", sent: 3 });
    assert.deepEqual(f.transport.getOutgoing().filter(item => item.type === "image").map(item => item.source), [
      "https://example.test/a.png", "https://example.test/a-extra.png", "https://example.test/a-third.png", "https://example.test/a-fourth.png",
    ]);
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a" }), { code: "YA_ENVIADAS", sent: 0 });
    const seen = await f.world.invokeTool("responder", response(["product-a"])); assert.equal(seen.productImages.sent.length, 0);
  } finally { await close(f); }
});
test("foto explícita anterior y URL compartida por productos también se deduplican", async () => {
  const fixtures = productsWithImages(); fixtures.products[1].variants[0].imageUrls = fixtures.products[0].variants[0].imageUrls;
  const f = await consultationFixture({ fixtures });
  try {
    await f.world.invokeTool("enviar_imagenes", { productId: "product-a", variantId: "variant-a" });
    const result = await f.world.invokeTool("responder", response(["product-a", "product-b"]));
    assert.equal(result.productImages.sent.length, 0); assert.equal(result.productImages.skipped.length, 2);
    assert.equal(f.transport.getOutgoing().filter(item => item.type === "image").length, 2);
  } finally { await close(f); }
});
test("fallo de foto se registra, informa el resultado y sigue con las demás, sin error técnico ni handoff", async () => {
  const f = await consultationFixture({ fixtures: productsWithImages(), model: scriptedModel([reply("responder", response())]) });
  const send = f.transport.sendImage;
  f.transport.sendImage = value => value.productId === "product-b" ? Promise.reject(new Error("Fallo de envío de prueba")) : send(value);
  try {
    const result = await f.run();
    assert.equal(result.guardian.outcome, "processed"); assert.deepEqual(result.diagnostics, []);
    assert.equal(f.world.getState().humanHandoffRequired, false); assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
    const photoResult = f.world.getEvents().find(event => event.name === "responder").result.productImages;
    assert.deepEqual(photoResult.sent.map(row => row.productId), ["product-a", "product-c"]);
    assert.deepEqual(photoResult.failed, [{ productId: "product-b", code: "PRODUCT_IMAGE_SEND_FAILED" }]);
    assert.ok(f.world.getGuardianEvents().some(event => event.code === "PRODUCT_IMAGE_SEND_FAILED" && event.productId === "product-b"));
    assert.equal(f.world.getState().sentProductImages.some(entry => entry.productId === "product-b"), false);
    f.transport.sendImage = send;
    assert.equal((await f.world.invokeTool("responder", response(["product-b"]))).productImages.sent.length, 1);
  } finally { await close(f); }
});
test("resultado del cierre informa fotos enviadas y el siguiente contexto del modelo solo anuncia productos entregados", async () => {
  const model = scriptedModel([reply("responder", response(["product-a"])), messages => {
    const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
    assert.deepEqual(context.productPhotosSent, ["product-a"]);
    return reply("responder", { texto: "Seguimos con la consulta.", entendido: true });
  }]);
  const f = await consultationFixture({ fixtures: productsWithImages(), model });
  try {
    await f.run(); await f.run({ user: "Seguimos" }, 2);
    assert.deepEqual(f.world.getEvents()[0].result.productImages.sent, [{ productId: "product-a", caption: "Producto de prueba 1 — 100 Gs." }]);
    assert.equal(model.invocations.length, 2); assert.equal(f.transport.getOutgoing().filter(item => item.type === "image").length, 1);
  } finally { await close(f); }
});
test("consulta/checkpoint fallidos de fotos no invalidan texto y no envían sin reserva durable", async () => {
  for (const failure of ["lookup", "checkpoint"]) {
    let state = { messages: [], consecutiveMisunderstandings: 0 }; const events = [], transport = createFakeWhatsApp();
    const product = { ...productsWithImages().products[0], variants: productsWithImages().products[0].variants.map(row => ({ ...row, active: true })) };
    const respond = createResponder({ transport, getState: () => structuredClone(state), recordImageEvent: event => events.push(event),
      setState: next => { if (failure === "checkpoint" && next.sentProductImages?.length) throw new Error("Checkpoint fallido de prueba"); state = next; },
      catalog: { getProduct: () => { if (failure === "lookup") throw new Error("Lectura fallida de prueba"); return product; } } });
    try {
      const result = await respond(response(["product-a"])); assert.equal(result.code, "OK");
      assert.deepEqual(transport.getOutgoing().map(item => item.type), failure === "lookup" ? ["text"] : ["text", "text"]);
      if (failure === "checkpoint") assert.equal(transport.getOutgoing()[1].text, "Producto de prueba 1 — 100 Gs.");
      const code = failure === "lookup" ? "PRODUCT_IMAGE_LOOKUP_FAILED" : "PRODUCT_IMAGE_CHECKPOINT_FAILED";
      assert.deepEqual(result.productImages.failed, [{ productId: "product-a", code }]); assert.equal(events[0].code, code);
      assert.equal(state.humanHandoffRequired, undefined); assert.equal(state.consecutiveTechnicalFailures, undefined);
    } finally { transport.close(); }
  }
});
test("cancelación no acepta un envío tardío ni empieza las siguientes fotos o escribe después del cierre", async () => {
  let state = { messages: [] }, reached, release; const started = new Promise(resolve => { reached = resolve; });
  const pending = new Promise(resolve => { release = resolve; }), signal = new AbortController(); const sends = [];
  const product = { ...productsWithImages().products[0], variants: productsWithImages().products[0].variants.map(row => ({ ...row, active: true })) };
  const images = createProductImages({ getState: () => structuredClone(state), setState: next => { state = next; },
    catalog: { getProduct: id => ({ ...product, id }) }, transport: { sendImage: async value => { sends.push(value); reached(); await pending; } } });
  const error = new Error("Cierre de prueba"); let operation;
  try {
    operation = images.show(["product-a", "product-b"], { signal: signal.signal });
    const rejected = assert.rejects(operation, error); await started;
    signal.abort(error); const before = structuredClone(state); release(); await rejected;
    assert.equal(sends.length, 1); assert.deepEqual(state, before); assert.equal(state.sentProductImages[0].delivery, "pending");
  } finally { release?.(); await operation?.catch(() => {}); }
});
test("productosMostrados valida tope, tipo, IDs y unicidad antes de enviar texto o fotos", async () => {
  const f = await consultationFixture({ fixtures: productsWithImages() });
  try {
    for (const ids of [[...presented, "product-d"], "product-a", [null], ["../otro"], [" product-a"], ["product-a", "product-a"]]) {
      const result = await f.world.invokeTool("responder", response(ids)); assert.equal(result.code, "ARGUMENTOS_INVALIDOS");
      assert.ok(result.field.startsWith("productosMostrados"));
    }
    assert.deepEqual(f.transport.getOutgoing(), []); assert.equal(f.world.getState().sentProductImages, undefined);
    const schema = createToolRegistry({}).definitions()[0].functionDeclarations.find(tool => tool.name === "responder").parameters;
    assert.equal(schema.properties.productosMostrados.type, "array"); assert.equal(schema.properties.productosMostrados.maxItems, 3);
    assert.equal(schema.properties.productosMostrados.items.type, "string");
    assert.equal(schema.required.includes("productosMostrados"), false);
  } finally { await close(f); }
});
test("políticas y estado de pedido inhiben fotos incluso con IDs aportados por el modelo", async () => {
  for (const [name, args] of [["consultar_politicas", {}], ["estado_pedido", { orderNumber: "test-order-a" }]]) {
    const f = await consultationFixture({ fixtures: productsWithImages(), context: { telefonoCliente: "595900000001" },
      model: scriptedModel([reply(name, args), reply("responder", { ...response(["product-a"]), cierre: "Este cierre no corresponde a la política o estado." }), reply("responder", response(["product-a"]))]) });
    try {
      await f.run(); assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text"]);
      assert.deepEqual(f.world.getEvents().at(-1).result.productImages.skipped, [{ productId: "product-a", reason: "CONTENIDO_NO_APLICA" }]);
      await f.run({ user: "Ahora mostrame un producto" }, 2);
      assert.deepEqual(f.transport.getOutgoing().filter(item => item.type === "image").map(item => item.productId), ["product-a"]);
      assert.equal(f.world.getEvents().at(-1).result.productImages.sent.length, 1);
    } finally { await close(f); }
  }
});
test("cotización completa, incompleta e informativa no envían fotos y conservan el resumen del servidor", async () => {
  for (const scenario of ["complete", "incomplete", "informative"]) {
    const complete = scenario === "complete";
    const f = await consultationFixture({ fixtures: productsWithImages(), context: complete ? readyContext() : { carrito: evalCart() },
      model: scriptedModel([reply("cotizar", scenario === "informative" ? { lineas: [{ productId: "product-a", variantId: "variant-a", quantity: 1 }] } : {}), messages => {
        const quote = JSON.parse(messages.at(-1).content);
        assert.equal(quote.confirmable, complete);
        assert.equal(quote.code, scenario === "incomplete" ? "DATO_FALTANTE" : "OK");
        return reply("responder", { ...response(["product-a"]), ...(quote.quoteId ? { quoteIdMostrado: quote.quoteId } : {}) });
      }]) });
    try {
      await f.run(); assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text"]);
      assert.ok(f.transport.getOutgoing()[0].text.includes(complete ? "Total del pedido:" : "Subtotal de productos:"));
      assert.equal(f.world.getEvents().at(-1).result.productImages.sent.length, 0);
      assert.deepEqual(f.world.getEvents().at(-1).result.productImages.skipped, [{ productId: "product-a", reason: "CONTENIDO_NO_APLICA" }]);
    } finally { await close(f); }
  }
});
test("mensaje de pedido exclusivo del servidor nunca agrega fotos, aunque responder reciba productosMostrados", async () => {
  let state = { messages: [], consecutiveMisunderstandings: 0 }; const transport = createFakeWhatsApp();
  const customerMessage = "Pedido de prueba creado. Instrucciones de pago del servidor.";
  const respond = createResponder({ getState: () => structuredClone(state), setState: next => { state = next; }, transport,
    catalog: { getProduct: () => { throw new Error("No debe leer fotos en un mensaje de pedido"); } },
    purchase: { orders: { receiptForTurn: () => ({ job: { receiptDelivered: true }, customerMessage }) } } });
  try {
    const result = await respond({ ...response(), cierre: "Este cierre no debe alterar el pago." }); assert.equal(result.orderMessageAdded, true);
    assert.deepEqual(transport.getOutgoing().map(item => [item.type, item.text]), [["text", customerMessage]]);
    assert.equal(result.productImages.sent.length, 0); assert.equal(result.productImages.skipped.length, 3);
  } finally { transport.close(); }
});
test("prompt limita a tres, ofrece más y no afirma entregas; reserva fotos explícitas para pedidos del cliente", async () => {
  const prompt = await readFile(new URL("../src/agents/prompts/agente.md", import.meta.url), "utf8");
  for (const rule of ["máximo tres productos por mensaje", "cerrá ofreciendo ver más", "responder.productosMostrados", "Nunca afirmes haber",
    "resultado informa qué se envió", "pide más fotos de un producto", "estados de pedido ni políticas"]) assert.ok(prompt.includes(rule), rule);
  assert.equal(prompt.includes("cinco productos por mensaje"), false);
  for (const rule of ["solo una introducción breve", "un cierre opcional", "no listes productos ni precios", "foto o línea por producto con nombre y precio, y cierre"]) assert.ok(prompt.includes(rule), rule);
});

test("lista del servidor respeta orden de IDs, texto en lugar de foto y cierre opcional después de todos los productos", async () => {
  for (const withClose of [true, false]) {
    const fixtures = productsWithImages(); fixtures.products[1].variants[0].imageUrls = [];
    const f = await consultationFixture({ fixtures });
    try {
      const result = await f.world.invokeTool("responder", { ...response(["product-c", "product-b", "product-a"]), texto: "Estas son algunas opciones.",
        ...(withClose ? { cierre: "¿Querés ver más opciones?" } : {}) });
      const outgoing = f.transport.getOutgoing();
      assert.deepEqual(outgoing.map(item => item.type), withClose ? ["text", "image", "text", "image", "text"] : ["text", "image", "text", "image"]);
      assert.deepEqual(outgoing.map(item => item.text ?? item.caption), ["Estas son algunas opciones.", "Producto de prueba 3 — 300 Gs.",
        "Producto de prueba 2 — 200 Gs.", "Producto de prueba 1 — 100 Gs.", ...(withClose ? ["¿Querés ver más opciones?"] : [])]);
      assert.deepEqual(result.productImages.textOnly, [{ productId: "product-b", caption: "Producto de prueba 2 — 200 Gs." }]);
      const before = structuredClone(outgoing);
      assert.equal((await f.world.invokeTool("responder", { ...response([...presented, "product-d"]), cierre: "Otro cierre" })).code, "ARGUMENTOS_INVALIDOS");
      assert.deepEqual(f.transport.getOutgoing(), before);
      assert.equal((await f.world.invokeTool("responder", { texto: "Solo texto", entendido: true, cierre: "Cierre fuera de lista" })).field, "cierre");
    } finally { await close(f); }
  }
});
