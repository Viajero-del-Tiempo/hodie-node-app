import test from "node:test";
import assert from "node:assert/strict";
import { receiptFixture, receiptPng, receiptPdf } from "./helpers/receipt-fixtures.js";
import { receiptAcknowledgement } from "../src/services/payment-receipt.repository.js";
import { createPaymentReceiptConfig } from "../src/services/payment-receipt.config.js";
import { consultationFixture, scriptedModel, reply } from "./helpers/consultation-fixtures.js";

test("uno pendiente asocia imagen/PDF, alerta idempotente y acuse textual del servidor; no cambia pedido", async () => {
  for (const [data, mimeType] of [[receiptPng, "image/png"], [receiptPdf, "application/pdf"]]) {
    const f = receiptFixture();
    try {
      f.attachments.set("file", { data, mimeType }); const before = f.world.orders.list();
      const first = await f.call("registrar_comprobante", { attachmentId: "file" }); assert.equal(first.code, "OK");
      const repeated = await f.call("registrar_comprobante", { attachmentId: "file" });
      assert.equal(repeated.code, "OK"); assert.equal(repeated.comprobanteId, first.comprobanteId); assert.equal(repeated.alreadyAssociated, true);
      assert.equal(f.world.paymentReceipts.list().length, 1); assert.equal(f.world.alertRequests.list().length, 1);
      assert.equal(f.world.alertRequests.list()[0].type, "PAYMENT_RECEIPT"); assert.equal(f.world.alertRequests.list()[0].delivered, false);
      assert.deepEqual(f.world.alertRequests.list()[0].context, { orderNumber: "test-order-a", filename: mimeType === "application/pdf" ? "comprobante.pdf" : "comprobante.png" });
      await f.call("responder", { texto: "Pago confirmado, texto que no debe salir", entendido: true });
      assert.equal(f.transport.getOutgoing()[0].text, receiptAcknowledgement("test-order-a"));
      assert.deepEqual(f.world.orders.list(), before); assert.equal(JSON.stringify(first).includes("publicId"), false);
    } finally { f.close(); }
  }
});
test("cero/varios conserva privado el archivo y permite elegir en un turno posterior sin adjunto", async () => {
  for (const multiple of [false, true]) {
    const f = receiptFixture();
    try {
      const order = f.world.orders.list()[0];
      if (multiple) f.world.orders.set("test-order-b", { ...order, orderNumber: "test-order-b" });
      else f.world.orders.delete(order.orderNumber);
      const result = await f.call("registrar_comprobante", { attachmentId: "file" });
      assert.equal(result.code, multiple ? "PEDIDO_AMBIGUO" : "PEDIDO_NO_DISPONIBLE");
      assert.equal(f.world.paymentReceipts.list()[0].status, "unassigned"); assert.equal(f.world.alertRequests.list().length, 0);
      f.nextTurn(); if (!multiple) f.world.orders.set(order.orderNumber, order);
      assert.equal((await f.runtime.paymentReceipts.pending())[0].comprobanteId, result.comprobanteId);
      const selected = await f.call("registrar_comprobante", { comprobanteId: result.comprobanteId, orderNumber: order.orderNumber });
      assert.equal(selected.code, "OK"); assert.equal(selected.orderNumber, order.orderNumber); assert.equal(f.world.alertRequests.list().length, 1);
    } finally { f.close(); }
  }
});
test("el mismo teléfono verificado desde otro chat no duplica ni reinicia la alerta entregada", async () => {
  const f = receiptFixture();
  try {
    const first = await f.call("registrar_comprobante", { attachmentId: "file" });
    const alert = f.world.alertRequests.list()[0];
    f.world.alertRequests.set(alert.id, { ...alert, delivered: true });
    const state = f.world.getState(); state.whatsappChatId = "another@lid"; f.world.setState(state); f.nextTurn();
    const repeated = await f.call("registrar_comprobante", { comprobanteId: first.comprobanteId });
    assert.equal(repeated.code, "OK"); assert.equal(repeated.alreadyAssociated, true);
    assert.deepEqual(f.world.alertRequests.list(), [{ ...alert, delivered: true }]);
    assert.equal(f.world.orders.list()[0].status, "pending");
  } finally { f.close(); }
});
test("número explícito revalida dueño y pendiente: teléfono escrito no autoriza y mismo chat sí", async () => {
  for (const kind of ["foreign", "paid", "unverified", "chat", "normalized"]) {
    const f = receiptFixture({ context: kind === "unverified" || kind === "chat" ? {} : undefined });
    try {
      const order = f.world.orders.list()[0];
      f.world.orders.set(order.orderNumber, { ...order,
        ...(kind === "foreign" ? { userPhoneNumber: "595900000002", whatsappChatId: "other@lid" } : {}),
        ...(kind === "paid" ? { status: "paid" } : {}), ...(kind === "chat" ? { whatsappChatId: f.world.getState().whatsappChatId } : {}),
        ...(kind === "normalized" ? { userPhoneNumber: "0900000001" } : {}) });
      if (kind === "unverified") { const state = f.world.getState(); state.userPhoneNumber = order.userPhoneNumber; f.world.setState(state); }
      const before = f.world.orders.list(), result = await f.call("registrar_comprobante", { attachmentId: "file", orderNumber: order.orderNumber });
      assert.equal(result.code, ["chat", "normalized"].includes(kind) ? "OK" : "PEDIDO_NO_DISPONIBLE");
      assert.deepEqual(f.world.orders.list(), before); assert.equal(f.world.alertRequests.list().length, result.code === "OK" ? 1 : 0);
    } finally { f.close(); }
  }
});
test("no permite seleccionar comprobantes ajenos ni reasociar uno ya asociado", async () => {
  const f = receiptFixture();
  try {
    const first = await f.call("registrar_comprobante", { attachmentId: "file" });
    f.world.orders.set("test-b", { ...f.world.orders.list()[0], orderNumber: "test-b" });
    assert.equal((await f.call("registrar_comprobante", { comprobanteId: first.comprobanteId, orderNumber: "test-b" })).code, "COMPROBANTE_YA_ASOCIADO");
    const state = f.world.getState(); state.phoneVerified = false; state.whatsappChatId = "other@lid"; f.world.setState(state);
    assert.equal((await f.call("registrar_comprobante", { comprobanteId: first.comprobanteId, orderNumber: "test-b" })).code, "COMPROBANTE_NO_DISPONIBLE");
    assert.equal(f.world.alertRequests.list().length, 1);
  } finally { f.close(); }
});
test("retención de seis horas: antes permite elegir; al vencer elimina bytes y no purga asociados", async () => {
  const f = receiptFixture();
  try {
    const order = f.world.orders.list()[0]; f.world.orders.delete(order.orderNumber);
    const pending = await f.call("registrar_comprobante", { attachmentId: "file" });
    f.clock.advance(6 * 60 * 60 * 1000 - 1); assert.equal((await f.runtime.paymentReceipts.pending()).length, 1);
    f.clock.advance(1); await f.runtime.paymentReceipts.cleanup();
    assert.equal(f.world.receiptStorage.files.size, 0); assert.equal(f.world.paymentReceipts.list().length, 0);
    assert.equal((await f.call("registrar_comprobante", { comprobanteId: pending.comprobanteId })).code, "COMPROBANTE_NO_DISPONIBLE");
    f.world.orders.set(order.orderNumber, order);
    const associated = await f.call("registrar_comprobante", { attachmentId: "file" }); assert.equal(associated.code, "OK");
    f.clock.advance(7 * 24 * 60 * 60 * 1000); await f.runtime.paymentReceipts.cleanup();
    assert.equal(f.world.receiptStorage.files.size, 1); assert.equal(f.world.paymentReceipts.list()[0].status, "associated");
  } finally { f.close(); }
});
test("configuración de retención validada y formatos/tamaño/firma rechazados antes de subir", async () => {
  assert.equal(createPaymentReceiptConfig({}).unassignedTtlMs, 6 * 60 * 60 * 1000);
  assert.equal(createPaymentReceiptConfig({ AGENT_RECEIPT_UNASSIGNED_TTL_MS: "60000" }).unassignedTtlMs, 60000);
  for (const value of ["", 0, -1, 1.5, "nada"]) assert.throws(() => createPaymentReceiptConfig({ AGENT_RECEIPT_UNASSIGNED_TTL_MS: value }));
  const f = receiptFixture();
  try {
    for (const [data, mimeType, code] of [[Buffer.from("texto"), "application/pdf", "FIRMA_COMPROBANTE_INVALIDA"],
      [receiptPdf, "image/png", "FIRMA_COMPROBANTE_INVALIDA"], [receiptPng, "image/svg+xml", "FORMATO_COMPROBANTE_NO_ADMITIDO"],
      [Buffer.alloc(5 * 1024 * 1024 + 1), "image/png", "COMPROBANTE_DEMASIADO_GRANDE"]]) {
      f.attachments.set("bad", { data, mimeType }); assert.equal((await f.call("registrar_comprobante", { attachmentId: "bad" })).code, code);
    }
    for (const args of [{}, { attachmentId: "file", comprobanteId: "otro" }, { attachmentId: "file", amount: 100 }, { attachmentId: "file", phoneVerified: true }]) {
      assert.equal((await f.call("registrar_comprobante", args)).code, "ARGUMENTOS_INVALIDOS");
    }
    assert.equal(f.world.receiptStorage.files.size, 0); assert.equal(f.world.paymentReceipts.list().length, 0);
  } finally { f.close(); }
});
test("una limpieza atrasada no borra una nueva recepción del mismo archivo ya asociada", async () => {
  const f = receiptFixture(); let release, delayed;
  try {
    const order = f.world.orders.list()[0]; f.world.orders.delete(order.orderNumber);
    const first = await f.call("registrar_comprobante", { attachmentId: "file" });
    f.clock.advance(6 * 60 * 60 * 1000);
    let reached; const started = new Promise(resolve => { reached = resolve; }), resume = new Promise(resolve => { release = resolve; });
    const remove = f.world.receiptStorage.delete; let paused = false;
    f.world.receiptStorage.delete = async asset => { if (!paused) { paused = true; reached(); await resume; } await remove(asset); };
    delayed = f.runtime.paymentReceipts.cleanup(); await started;
    await f.runtime.paymentReceipts.cleanup();
    f.world.orders.set(order.orderNumber, order); f.nextTurn();
    f.attachments.set("file", { data: receiptPng, mimeType: "image/png" });
    const fresh = await f.call("registrar_comprobante", { attachmentId: "file" });
    assert.equal(fresh.code, "OK"); assert.equal(fresh.comprobanteId, first.comprobanteId);
    release(); await delayed;
    const saved = await f.world.receiptRepository.get(fresh.comprobanteId); assert.equal(saved.status, "associated");
    assert.deepEqual(await f.world.receiptStorage.read(saved.asset), receiptPng);
  } finally { release?.(); await delayed?.catch(() => {}); f.close(); }
});
test("PDF: modelo solo recibe metadatos, el acuse no lo redacta el modelo y no hay handoff", async () => {
  const f = await consultationFixture({ context: { telefonoCliente: "595900000001" },
    mediaResolver: async () => ({ data: receiptPdf, mimeType: "application/pdf" }),
    model: scriptedModel([messages => {
      const context = JSON.parse(messages[1].content.split("\n").slice(1).join("\n"));
      assert.deepEqual(context.attachments, [{ attachmentId: "attachment-1", type: "document", filename: "prueba.pdf" }]);
      assert.equal(JSON.stringify(messages).includes("%PDF"), false);
      return reply("registrar_comprobante", { attachmentId: "attachment-1" });
    }, reply("responder", { texto: "Nunca enviar: pago aprobado", entendido: true })]) });
  try {
    const before = f.world.orders.list(); await f.run({ user: "Te envío un comprobante", attachment: "document", filename: "prueba.pdf" });
    assert.equal(f.transport.getOutgoing()[0].text, receiptAcknowledgement("test-order-a"));
    assert.deepEqual(f.world.orders.list(), before); assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.world.alertRequests.list().length, 1);
  } finally { await f.agent.dispose(); f.close(); }
});
test("commit de asociación seguido de error recupera acuse, sin compra nueva, aviso técnico ni handoff", async () => {
  const f = await consultationFixture({ context: { telefonoCliente: "595900000001" },
    mediaResolver: async () => ({ data: receiptPng, mimeType: "image/png" }),
    model: scriptedModel([reply("registrar_comprobante", { attachmentId: "attachment-1" })]) });
  try {
    const associate = f.world.receiptRepository.associate;
    f.world.receiptRepository.associate = async (...args) => { await associate(...args); throw new Error("Interrupción después del commit"); };
    const before = f.world.orders.list(); const result = await f.run({ user: "Comprobante recibido", attachment: "image" });
    assert.equal(result.guardian.receiptRegistered, true); assert.equal(result.guardian.receiptRecovered, true);
    assert.equal(result.guardian.outcome, "technical_error");
    assert.deepEqual(f.transport.getOutgoing().map(item => item.text), [receiptAcknowledgement("test-order-a")]);
    assert.deepEqual(f.world.orders.list(), before); assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(f.world.alertRequests.list().length, 1); assert.equal(f.world.getState().consecutiveTechnicalFailures, 0);
  } finally { await f.agent.dispose(); f.close(); }
});
test("acuse sin entregar se recupera en el siguiente turno antes del modelo", async () => {
  const f = await consultationFixture({ context: { telefonoCliente: "595900000001" }, model: scriptedModel([]) });
  try {
    const config = { ...f.world.receiptStorage.descriptor("a".repeat(64), "png") };
    const id = "a".repeat(64), chatId = f.world.getState().whatsappChatId;
    const reserved = await f.world.receiptRepository.reserve({ id, ownerChatId: chatId, ownerPhone: "595900000001", status: "uploading",
      expiresAt: f.world.now() + 10000, createdAt: f.world.now(), asset: config, mimeType: "image/png", filename: "comprobante.png", size: receiptPng.length });
    await f.world.receiptStorage.put(reserved.receipt.asset, { data: receiptPng }); await f.world.receiptRepository.ready(id);
    await f.world.receiptRepository.associate(id, "test-order-a", { chatId, phone: "595900000001" });
    await f.run({ user: "Seguimos" });
    assert.equal(f.model.invocations.length, 0); assert.equal(f.transport.getOutgoing()[0].text, receiptAcknowledgement("test-order-a"));
    assert.equal((await f.world.receiptRepository.get(id)).acknowledgementDelivered, true);
  } finally { await f.agent.dispose(); f.close(); }
});
