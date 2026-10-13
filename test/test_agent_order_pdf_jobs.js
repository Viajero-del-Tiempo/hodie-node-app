import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shownPurchaseFixture } from "./helpers/purchase-fixtures.js";
import { createOrderPdfJobService } from "../src/services/order-pdf-job.service.js";
import { flushMicrotasks } from "./helpers/virtual-clock.js";

async function registered(options) {
  const f = await shownPurchaseFixture(options);
  try {
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    await f.call("responder", { texto: "Cierre.", entendido: true });
    return { ...f, result };
  } catch (error) { f.close(); throw error; }
}
test("PDF continúa fuera del turno, actualiza entrega y limpia archivo temporal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hodie-pdf-test-"));
  const path = join(directory, "synthetic.pdf");
  let release;
  const f = await registered({ generatePdf: async () => {
    await new Promise(resolve => { release = resolve; }); await writeFile(path, "%PDF-synthetic"); return path;
  } });
  try {
    const work = f.world.orderJobs.run(f.result.orderId);
    await flushMicrotasks(); assert.equal(typeof release, "function");
    await f.clock.advanceAsync(60001);
    assert.equal((await f.world.orderRepository.getOrder(f.result.orderId)).pdfDelivered, false);
    assert.equal((await f.world.orderRepository.getJob(f.result.orderId)).status, "running");
    release(); assert.equal((await work).status, "done");
    assert.equal((await f.world.orderRepository.getOrder(f.result.orderId)).pdfDelivered, true);
    assert.equal((await f.world.orderRepository.getOrder(f.result.orderId)).status, "pending");
    await assert.rejects(access(path));
    assert.equal(f.transport.getOutgoing().filter(message => message.type === "document").length, 1);
    assert.equal(f.world.orderRepository.inspect().alerts.length, 0);
  } finally { f.close(); await rm(directory, { recursive: true, force: true }); }
});
test("falla de PDF deja pedido válido, pago comunicado y una solicitud de alerta sin handoff ni reintento de compra", async () => {
  const f = await registered({ generatePdf: async () => { throw new Error("Fallo sintético de PDF"); } });
  try {
    const messages = f.transport.getOutgoing().filter(message => message.type === "text");
    assert.ok(messages.at(-1).text.includes(f.world.bankConfig.accountNumber));
    const result = await f.world.orderJobs.run(f.result.orderId);
    assert.equal(result.status, "attention");
    const order = await f.world.orderRepository.getOrder(f.result.orderId);
    assert.equal(order.pdfDelivered, false); assert.equal(order.status, "pending");
    const state = f.world.orderRepository.inspect();
    assert.equal(state.alerts.length, 1); assert.equal(state.alerts[0].delivered, false);
    assert.equal(state.alerts[0].type, "PDF_DELIVERY_FAILED");
    assert.equal(f.world.getState().humanHandoffRequired, false);
    assert.equal(state.counter.lastOrderNumber, 1);
    await f.world.orderJobs.drain();
    assert.equal(f.world.orderRepository.inspect().alerts.length, 1);
    assert.deepEqual(f.transport.getOutgoing().filter(message => message.type === "text"), messages);
  } finally { f.close(); }
});
test("reinicio durante envío incierto pide alerta y revisión humana sin reenviar PDF", async () => {
  const f = await registered();
  let generated = 0, sent = 0;
  const worker = createOrderPdfJobService({ repository: f.world.orderRepository, now: f.clock.now, clock: f.clock,
    generatePdf: async () => { generated++; return null; }, transport: { sendText: async () => { throw new Error("No debe enviar texto"); }, sendPdf: async () => { sent++; return true; } } });
  try {
    await f.world.orderRepository.updateJob(f.result.orderId, { status: "running", phase: "sending", leaseToken: "abandoned", leaseUntil: f.clock.now() - 1 });
    await worker.drain(); await worker.drain();
    assert.equal(generated, 0); assert.equal(sent, 0);
    const state = f.world.orderRepository.inspect();
    assert.equal(state.jobs[0].status, "attention"); assert.equal(state.alerts.length, 1);
    assert.equal(state.alerts[0].type, "PDF_DELIVERY_UNCERTAIN"); assert.equal(state.alerts[0].delivered, false);
    assert.equal((await f.world.orderRepository.getOrder(f.result.orderId)).pdfDelivered, false);
  } finally { f.close(); }
});
test("reinicio antes de enviar recupera trabajo y dos workers no duplican el envío", async () => {
  const f = await registered();
  try {
    await f.world.orderRepository.updateJob(f.result.orderId, { status: "running", phase: "rendering", leaseToken: "abandoned", leaseUntil: f.clock.now() - 1 });
    const results = await Promise.all([f.world.orderJobs.run(f.result.orderId), f.world.orderJobs.run(f.result.orderId)]);
    assert.equal(results.filter(result => result?.status === "done").length, 1);
    assert.equal(f.transport.getOutgoing().filter(message => message.type === "document").length, 1);
    assert.equal(f.world.orderRepository.inspect().alerts.length, 0);
    assert.equal((await f.world.orderRepository.getOrder(f.result.orderId)).pdfDelivered, true);
  } finally { f.close(); }
});
test("reinicio con mensaje de pago incierto requiere revisión humana y no duplica el mensaje ni el PDF", async () => {
  const f = await shownPurchaseFixture();
  try {
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    await f.world.orderRepository.beginReceiptDelivery(result.orderId);
    const before = f.transport.getOutgoing();
    await f.clock.advanceAsync(60001); await f.world.orderJobs.drain();
    assert.deepEqual(f.transport.getOutgoing(), before);
    const persisted = f.world.orderRepository.inspect();
    assert.equal(persisted.jobs[0].status, "attention");
    assert.equal(persisted.alerts.length, 1); assert.equal(persisted.alerts[0].type, "ORDER_RECEIPT_UNCERTAIN");
    assert.equal(persisted.alerts[0].delivered, false);
    assert.equal((await f.world.orderRepository.getOrder(result.orderId)).pdfDelivered, false);
  } finally { f.close(); }
});
test("recuperar un pedido cuyo estado ya avanzó no vuelve a pedir que lo pague", async () => {
  const f = await shownPurchaseFixture();
  try {
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    const order = await f.world.orderRepository.getOrder(result.orderId);
    f.world.orders.set(order.orderNumber, { ...order, status: "paid" });
    await f.clock.advanceAsync(60001); await f.world.orderJobs.drain();
    const text = f.transport.getOutgoing().filter(message => message.type === "text").at(-1).text;
    assert.ok(text.includes(order.orderNumber)); assert.ok(text.includes("Estado actual: paid"));
    assert.equal(text.includes(f.world.bankConfig.accountNumber), false);
    assert.equal(text.includes("transferí"), false);
    assert.equal((await f.world.orderRepository.getOrder(result.orderId)).status, "paid");
    assert.equal((await f.world.orderRepository.getOrder(result.orderId)).pdfDelivered, true);
  } finally { f.close(); }
});
test("commit sin respuesta del turno se recupera con el mensaje de pago y PDF, sin recrear pedido", async () => {
  const f = await shownPurchaseFixture();
  try {
    const result = await f.call("crear_pedido", { quoteId: f.quote.quoteId });
    assert.equal((await f.world.orderRepository.getJob(result.orderId)).receiptDelivered, false);
    await f.clock.advanceAsync(60001);
    await f.world.orderJobs.drain();
    const text = f.transport.getOutgoing().filter(message => message.type === "text").at(-1).text;
    assert.ok(text.includes(result.orderNumber)); assert.ok(text.includes(f.world.bankConfig.accountNumber));
    assert.equal(f.world.orderRepository.inspect().counter.lastOrderNumber, 1);
    assert.equal(f.world.orderRepository.inspect().jobs.length, 1);
    assert.equal((await f.world.orderRepository.getOrder(result.orderId)).pdfDelivered, true);
  } finally { f.close(); }
});
