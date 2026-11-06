import test from "node:test";
import assert from "node:assert/strict";
import { createResponder } from "../src/agents/consultation/terminal.js";
import { productsWithImages } from "./helpers/product-images-fixtures.js";
import { deliveryFixture, FakeMessageMedia } from "./helpers/whatsapp-fixtures.js";
import { WHATSAPP_OUTBOX_COLLECTION } from "../src/services/whatsapp-delivery.repository.js";

const chat = "595900000001@c.us";
test("FIFO por chat, pausa de 500 ms, caption y registro de IDs propios sin guardar el contenido", async () => {
  const f = deliveryFixture();
  try {
    await Promise.all([f.transport.sendText(chat, "Introducción"),
      f.transport.sendImage(chat, { source: "https://example.test/image.png", caption: "Pie del servidor", productId: "product-a" }),
      f.transport.sendText(chat, "Cierre")]);
    assert.deepEqual(f.outgoing.map(row => row.content instanceof FakeMessageMedia ? row.options.caption : row.content), ["Introducción", "Pie del servidor", "Cierre"]);
    assert.deepEqual(f.pauses, [500, 500]);
    assert.equal(f.outgoing[1].at - f.outgoing[0].at, 500); assert.equal(f.outgoing[2].at - f.outgoing[1].at, 500);
    assert.ok(f.outgoing.every(row => row.options.sendSeen === false));
    const rows = [...f.db.rows.entries()].filter(([path]) => path.startsWith(WHATSAPP_OUTBOX_COLLECTION + "/")).map(([, value]) => value);
    assert.deepEqual(rows.map(row => row.whatsappMessageId), ["own-1", "own-2", "own-3"]);
    assert.ok(rows.every(row => row.own && row.status === "accepted" && row.origin === "agent"));
    for (const field of ["content", "text", "caption", "data"]) assert.ok(rows.every(row => row[field] === undefined));
  } finally { f.transport.close(); }
});

test("chats distintos no se bloquean mutuamente", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = deliveryFixture({ send: async target => { if (target === chat) { entered(); await new Promise(resolve => { release = resolve; }); } } });
  const first = f.transport.sendText(chat, "Primero");
  try {
    await waiting; await f.transport.sendText("other@lid", "Otro chat");
    assert.equal(f.outgoing[0].chatId, "other@lid"); release(); await first;
  } finally { release?.(); await first.catch(() => {}); f.transport.close(); }
});

test("fallo previo al envío de una foto mantiene orden y reemplazo textual, y continúa con las otras opciones", async () => {
  const f = deliveryFixture({ fetchImpl: async url => {
    if (url.pathname === "/b.png") throw new Error("Descarga fallida");
    return new Response(Buffer.from([1]), { headers: { "Content-Type": "image/png" } });
  } });
  const products = productsWithImages().products.map(product => ({ ...product, active: true, variants: product.variants.map(variant => ({ ...variant, active: true })) }));
  let state = { messages: [] }; const imageEvents = [];
  const respond = createResponder({ catalog: { getProduct: async id => products.find(row => row.id === id) },
    getState: () => structuredClone(state), setState: value => { state = value; }, recordImageEvent: event => imageEvents.push(event),
    transport: { sendText: text => f.transport.sendText(chat, text), sendImage: value => f.transport.sendImage(chat, value) } });
  try {
    const result = await respond({ texto: "Opciones", cierre: "¿Querés más?", entendido: true, productosMostrados: ["product-a", "product-b", "product-c"] });
    assert.equal(result.code, "OK");
    assert.deepEqual(f.outgoing.map(row => row.content instanceof FakeMessageMedia ? row.options.caption : row.content), [
      "Opciones", "Producto de prueba 1 — 100 Gs.", "Producto de prueba 2 — 200 Gs.", "Producto de prueba 3 — 300 Gs.", "¿Querés más?",
    ]);
    assert.equal(f.outgoing.filter(row => row.content instanceof FakeMessageMedia).length, 2);
    assert.deepEqual(result.productImages.failed, [{ productId: "product-b", code: "PRODUCT_IMAGE_SEND_FAILED" }]);
    assert.deepEqual(result.productImages.textOnly, [{ productId: "product-b", caption: "Producto de prueba 2 — 200 Gs." }]);
    assert.equal(imageEvents[0].code, "PRODUCT_IMAGE_SEND_FAILED");
  } finally { f.transport.close(); }
});

test("envío incierto corta la secuencia sin reintentar ni enviar el cierre; otro turno no repite la lista", async () => {
  let fail = true;
  const f = deliveryFixture({ send: async (_chat, content) => { if (content instanceof FakeMessageMedia && fail) throw new Error("Conexión cortada"); } });
  try {
    await f.transport.sendText(chat, "Introducción");
    await assert.rejects(f.transport.sendImage(chat, { source: "https://example.test/image.png", caption: "Foto" }), { code: "SEND_UNCERTAIN" });
    await assert.rejects(f.transport.sendText(chat, "Cierre"), { code: "SEND_SEQUENCE_STOPPED" });
    assert.deepEqual(f.outgoing.map(row => row.content), ["Introducción"]);
    assert.ok([...f.db.rows.values()].some(row => row.status === "uncertain"));
    fail = false; f.transport.beginTurn(chat);
    await f.transport.sendText(chat, "Nueva respuesta");
    assert.deepEqual(f.outgoing.map(row => row.content), ["Introducción", "Nueva respuesta"]);
  } finally { f.transport.close(); }
});

test("foto con entrega incierta conserva su reserva; las siguientes no intentadas se liberan y otro turno no la reenvía", async () => {
  const f = deliveryFixture({ send: async (_chat, content) => { if (content instanceof FakeMessageMedia) throw new Error("Resultado incierto"); } });
  const products = productsWithImages().products.map(product => ({ ...product, variants: product.variants.map(variant => ({ ...variant, active: true })) }));
  let state = { messages: [] }; const events = [];
  const respond = createResponder({ getState: () => structuredClone(state), setState: value => { state = value; },
    catalog: { getProduct: async id => products.find(row => row.id === id) }, recordImageEvent: value => events.push(value),
    transport: { sendText: text => f.transport.sendText(chat, text), sendImage: value => f.transport.sendImage(chat, value) } });
  try {
    await assert.rejects(respond({ texto: "Opciones", cierre: "Cierre", entendido: true, productosMostrados: ["product-a", "product-b"] }), { code: "SEND_SEQUENCE_STOPPED" });
    assert.deepEqual(state.sentProductImages.map(row => [row.productId, row.delivery]), [["product-a", "pending"]]);
    assert.ok(events.some(row => row.code === "PRODUCT_IMAGE_DELIVERY_UNCERTAIN"));
    f.transport.beginTurn(chat);
    const result = await respond({ texto: "La misma opción", entendido: true, productosMostrados: ["product-a"] });
    assert.deepEqual(result.productImages.skipped, [{ productId: "product-a", reason: "YA_ENVIADA" }]);
    assert.ok(f.outgoing.every(row => !(row.content instanceof FakeMessageMedia)));
  } finally { f.transport.close(); }
});

test("cancelar o cerrar durante la pausa impide el siguiente envío sin esperas reales", async () => {
  for (const close of [true, false]) {
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const f = deliveryFixture({ pause: (_ms, signal) => new Promise((_resolve, reject) => {
      entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
    const controller = new AbortController();
    try {
      await f.transport.sendText(chat, "Primero");
      const second = f.transport.sendText(chat, "Segundo", { signal: controller.signal });
      const rejected = assert.rejects(second);
      await waiting; if (close) f.transport.close(); else controller.abort(new Error("Cancelado"));
      await rejected; assert.equal(f.outgoing.length, 1);
    } finally { f.transport.close(); }
  }
});

test("no inicia envío si falla el registro durable propio", async () => {
  const f = deliveryFixture(); f.repository.beginOutgoing = async () => { throw new Error("Firestore no disponible"); };
  try { await assert.rejects(f.transport.sendText(chat, "No enviar"), /Firestore no disponible/); assert.deepEqual(f.outgoing, []); }
  finally { f.transport.close(); }
});
