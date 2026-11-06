import test from "node:test";
import assert from "node:assert/strict";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";
import { packagingImagesFixtures, packagingPresentation as request } from "./helpers/packaging-images-fixtures.js";
import { createToolRegistry } from "../src/agents/consultation/tool-registry.js";
import { readyContext } from "./helpers/purchase-fixtures.js";
import { createResponder } from "../src/agents/consultation/terminal.js";
import { createFakeWhatsApp } from "./eval/fake-whatsapp.js";

const response = empaquesMostrados => ({ texto: "Podés elegir entre estas opciones de empaque.", entendido: true, empaquesMostrados });
const close = async f => { await f.agent.dispose(); f.close(); };
test("tres fotos de producto con empaque, nombre/precio del servidor y ningún cambio de carrito, pedido o stock", async () => {
  const f = await consultationFixture({ fixtures: packagingImagesFixtures() });
  try {
    const before = f.world.snapshot();
    const result = await f.world.invokeTool("responder", response([request("pack/a"), request("pack-b", "variant-b"), request("pack-d")]));
    assert.equal(result.code, "OK"); assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text", "image", "image", "image"]);
    assert.deepEqual(result.packagingImages.sent, [
      { productId: "product-a", packagingType: "pack/a", caption: "Producto Alfa con Empaque Alfa — 110 Gs." },
      { productId: "product-a", packagingType: "pack-b", caption: "Producto Alfa con Empaque Beta — 170 Gs." },
      { productId: "product-a", packagingType: "pack-d", caption: "Producto Alfa con Empaque Delta — 130 Gs." },
    ]);
    assert.deepEqual(f.transport.getOutgoing().slice(1).map(item => item.source), ["https://example.test/foto-sin-convencion.png", "https://example.test/otra-foto.png", "https://example.test/tercera.png"]);
    assert.deepEqual(f.world.snapshot(), before);
  } finally { await close(f); }
});
test("opción sin foto produce línea textual del servidor; sin variante elegida el pie dice desde", async () => {
  const f = await consultationFixture({ fixtures: packagingImagesFixtures() });
  try {
    const result = await f.world.invokeTool("responder", response([{ productId: "product-a", packagingType: "pack/a" }, request("pack-c")]));
    assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text", "text", "image"]);
    assert.equal(f.transport.getOutgoing()[1].text, "Producto Alfa con Empaque Gamma — 100 Gs.");
    assert.equal(f.transport.getOutgoing()[2].caption, "Producto Alfa con Empaque Alfa — Desde 110 Gs.");
    assert.deepEqual(result.packagingImages.textOnly, [{ productId: "product-a", packagingType: "pack-c", caption: "Producto Alfa con Empaque Gamma — 100 Gs." }]);
    assert.equal(result.packagingImages.skipped[0].reason, "SIN_IMAGENES");
  } finally { await close(f); }
});
test("enviar_imagenes incluye empaques y permite pedir uno concreto; deduplica junto con responder", async () => {
  const f = await consultationFixture({ fixtures: packagingImagesFixtures() });
  try {
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a", packagingType: "pack/a", variantId: "variant-b" }), { code: "OK", sent: 1 });
    assert.equal(f.transport.getOutgoing()[0].caption, "Producto Alfa con Empaque Alfa — 160 Gs.");
    const repeated = await f.world.invokeTool("responder", response([request("pack/a")]));
    assert.deepEqual(repeated.packagingImages.skipped, [{ productId: "product-a", packagingType: "pack/a", reason: "YA_ENVIADA" }]);
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a" }), { code: "OK", sent: 2 });
    assert.deepEqual(f.transport.getOutgoing().filter(item => item.type === "image").map(item => item.packagingType), ["pack/a", "pack-b", "pack-d"]);
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a", packagingType: "missing" }), { code: "EMPAQUE_INEXISTENTE", sent: 0 });
    assert.deepEqual(await f.world.invokeTool("enviar_imagenes", { productId: "product-a", packagingType: "pack-c" }), { code: "SIN_IMAGENES", sent: 0 });
  } finally { await close(f); }
});
test("máximo tres presentaciones en total, sin duplicados ni datos comerciales del modelo", async () => {
  const f = await consultationFixture({ fixtures: packagingImagesFixtures() });
  try {
    for (const empaquesMostrados of [[request("pack/a"), request("pack-b"), request("pack-c"), request("pack-d")],
      [request("pack/a"), request("pack/a", "variant-b")], [{ ...request("pack/a"), price: 1 }], [{ ...request("pack/a"), imageUrl: "https://example.test/forged.png" }],
      [{ ...request("pack/a"), productId: "../other" }], [null]]) {
      const result = await f.world.invokeTool("responder", response(empaquesMostrados)); assert.equal(result.code, "ARGUMENTOS_INVALIDOS");
    }
    const mixed = await f.world.invokeTool("responder", { ...response([request("pack/a"), request("pack-b"), request("pack-c")]), productosMostrados: ["product-a"] });
    assert.equal(mixed.code, "ARGUMENTOS_INVALIDOS"); assert.deepEqual(f.transport.getOutgoing(), []);
    const schema = createToolRegistry({}).definitions()[0].functionDeclarations.find(tool => tool.name === "responder").parameters.properties.empaquesMostrados;
    assert.equal(schema.maxItems, 3); assert.deepEqual(schema.items.required, ["productId", "packagingType"]);
  } finally { await close(f); }
});
test("foto fallida de empaque se registra y el turno continúa sin falla técnica, mensaje de error ni derivación", async () => {
  const f = await consultationFixture({ fixtures: packagingImagesFixtures(), model: scriptedModel([reply("responder", response([request("pack/a"), request("pack-b")]))]) });
  const send = f.transport.sendImage; f.transport.sendImage = value => value.packagingType === "pack/a" ? Promise.reject(new Error("Fallo de prueba")) : send(value);
  try {
    const result = await f.run(); assert.equal(result.guardian.outcome, "processed"); assert.deepEqual(result.diagnostics, []);
    assert.equal(f.world.getState().humanHandoffRequired, false); assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
    assert.deepEqual(f.world.getEvents()[0].result.packagingImages.failed, [{ productId: "product-a", packagingType: "pack/a", code: "PRODUCT_IMAGE_SEND_FAILED" }]);
    assert.ok(f.world.getGuardianEvents().some(event => event.code === "PRODUCT_IMAGE_SEND_FAILED" && event.packagingType === "pack/a"));
    assert.deepEqual(f.transport.getOutgoing().filter(item => item.type === "image").map(item => item.packagingType), ["pack-b"]);
  } finally { await close(f); }
});
test("contexto distingue foto del producto solo y del empaque; opciones inexistentes/variantes ajenas no envían", async () => {
  const model = scriptedModel([reply("responder", response([request("pack/a")])), messages => {
    const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
    assert.deepEqual(context.productPhotosSent, []); assert.deepEqual(context.packagingPhotosSent, [{ productId: "product-a", packagingType: "pack/a" }]);
    return reply("responder", response([request("missing"), request("pack-b", "not-this-product")]));
  }, messages => {
    assert.equal(JSON.parse(messages.at(-1).content).code, "LISTA_NO_DISPONIBLE");
    return reply("responder", { texto: "Esas opciones no están disponibles.", entendido: true });
  }]);
  const f = await consultationFixture({ fixtures: packagingImagesFixtures(), model });
  try {
    await f.run(); const result = await f.run({ user: "Otras opciones" }, 2);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(f.transport.getOutgoing().filter(item => item.type === "image").length, 1);
    const rejected = f.world.getEvents().find(event => event.result?.code === "LISTA_NO_DISPONIBLE");
    assert.deepEqual(rejected.result.packagingImages.skipped.map(item => item.reason), ["EMPAQUE_INEXISTENTE", "VARIANTE_INACTIVA"]);
  } finally { await close(f); }
});
test("cotización, políticas y estado de pedido inhiben fotos/líneas de empaque aunque el modelo incluya empaquesMostrados", async () => {
  for (const [tool, args] of [["cotizar", {}], ["consultar_politicas", {}], ["estado_pedido", { orderNumber: "test-order-a" }]]) {
    const f = await consultationFixture({ fixtures: packagingImagesFixtures(), context: readyContext(),
      model: scriptedModel([reply(tool, args), messages => { const data = JSON.parse(messages.at(-1).content);
        return reply("responder", { ...response([request("pack/a"), request("pack-c")]), ...(data.quoteId ? { quoteIdMostrado: data.quoteId } : {}) }); }, messages => {
        assert.equal(JSON.parse(messages.at(-1).content).code, "LISTA_NO_DISPONIBLE");
        assert.deepEqual(f.transport.getOutgoing(), []);
        return reply("responder", { texto: "Respuesta de la política o estado solicitado.", entendido: true });
      }]) });
    try {
      await f.run(); assert.deepEqual(f.transport.getOutgoing().map(item => item.type), ["text"]);
      if (tool === "cotizar") {
        assert.equal(f.world.getEvents().at(-1).result.packagingImages.textOnly.length, 0);
        assert.ok(f.world.getEvents().at(-1).result.packagingImages.skipped.every(item => item.reason === "CONTENIDO_NO_APLICA"));
      } else {
        assert.equal(f.world.getEvents()[1].result.code, "LISTA_NO_DISPONIBLE");
        assert.equal(f.transport.getOutgoing()[0].text, "Respuesta de la política o estado solicitado.");
      }
    } finally { await close(f); }
  }
});
test("pedido/pago y acuse de comprobante registran cierre descartado y solo envían el mensaje del servidor", async () => {
  for (const kind of ["order", "receipt"]) {
    let state = { messages: [], consecutiveMisunderstandings: 0 };
    const transport = createFakeWhatsApp(), customerMessage = "Mensaje exclusivo del servidor de prueba.";
    const runtime = { getState: () => structuredClone(state), setState: next => { state = next; }, transport,
      catalog: { getProduct: () => { throw new Error("No debe consultar fotos en estos cierres"); } },
      ...(kind === "order" ? { purchase: { orders: { receiptForTurn: () => ({ job: { receiptDelivered: true }, customerMessage }) } } }
        : { paymentReceipts: { acknowledgementForTurn: () => ({ id: "test-receipt", text: customerMessage }), markAcknowledged: () => {} } }),
    };
    try {
      const result = await createResponder(runtime)({ ...response([request("pack/a"), request("pack-c")]), cierre: "¿Querés agregar otro empaque?" });
      assert.equal(result.code, "OK"); assert.equal(result[kind === "order" ? "orderMessageAdded" : "receiptAcknowledgementAdded"], true);
      assert.deepEqual(transport.getOutgoing().map(item => [item.type, item.text]), [["text", customerMessage]]);
      assert.deepEqual(result.descartados, [{ campo: "cierre", motivo: "MENSAJE_SERVIDOR" }]);
      assert.deepEqual(result.packagingImages.sent, []); assert.deepEqual(result.packagingImages.failed, []);
      assert.deepEqual(result.packagingImages.textOnly, []);
      assert.deepEqual(result.packagingImages.skipped, ["pack/a", "pack-c"].map(packagingType => ({ productId: "product-a", packagingType, reason: "CONTENIDO_NO_APLICA" })));
      assert.equal(state.sentProductImages, undefined);
    } finally { transport.close(); }
  }
});
