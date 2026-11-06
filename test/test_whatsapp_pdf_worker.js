import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createOrderPdfJobService } from "../src/services/order-pdf-job.service.js";
import { createOrderConfirmationRepository } from "../src/services/order-confirmation.repository.js";
import { createWhatsAppTransport, createWhatsAppSendQueue } from "../src/services/whatsapp-transport.service.js";
import { createWhatsAppPilotInfrastructure } from "../src/services/whatsapp-agent.bootstrap.js";
import { createAgentWhatsAppConfig } from "../src/config/agent-whatsapp.config.js";
import { whatsappMemoryDatabase, FakeMessageMedia, incoming } from "./helpers/whatsapp-fixtures.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

const chat = "595900000001@c.us";
async function fixture({ send, jobPatch = {} } = {}) {
  const db = whatsappMemoryDatabase(), clock = createVirtualClock(100000), directory = await mkdtemp(join(tmpdir(), "whatsapp-pdf-"));
  const path = join(directory, "synthetic.pdf"), outgoing = [], pauses = [];
  const job = { id: "order-a", orderId: "order-a", chatId: chat, status: "pending", phase: "queued", availableAt: 0,
    receiptDelivered: true, leaseUntil: 0, currency: "Gs", customerMessage: "Mensaje del servidor" };
  await db.collection("orders").doc(job.id).set({ id: job.id, orderNumber: "hodie000001", whatsappChatId: chat, status: "pending", total: 100, pdfDelivered: false });
  await db.collection("order_pdf_jobs").doc(job.id).set({ ...job, ...jobPatch });
  const repository = createOrderConfirmationRepository({ db, now: clock.now, timestampNow: () => new Date(clock.now()) });
  const client = { async sendMessage(to, content, options) {
    await send?.(to, content, options); outgoing.push({ to, content, options }); return { id: { _serialized: "own-" + outgoing.length } };
  } };
  const shared = { client, repository: (await import("../src/services/whatsapp-delivery.repository.js")).createWhatsAppDeliveryRepository({ db,
    now: clock.now, timestampFromMillis: value => new Date(value) }), MessageMedia: FakeMessageMedia,
    now: clock.now, pause: async ms => { pauses.push(ms); clock.advance(ms); }, sendQueue: createWhatsAppSendQueue() };
  const transport = createWhatsAppTransport(shared), other = createWhatsAppTransport(shared);
  let generated = 0, notifyGeneration;
  const generationStarted = new Promise(resolve => { notifyGeneration = resolve; });
  const options = { repository, now: clock.now, clock,
    generatePdf: async () => { generated++; notifyGeneration(); await writeFile(path, "%PDF-synthetic"); return path; },
    transport: { handlesDeliveryStart: true, sendText: (text, { job: current, ...options }) => transport.sendText(current.chatId, text, options),
      sendPdf: (...args) => transport.sendPdf(...args) } };
  const worker = createOrderPdfJobService(options);
  return { db, clock, path, worker, options, transport, other, outgoing, pauses, generationStarted, generated: () => generated, repository,
    async close() { await worker.stop(); transport.close(); other.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("PDF real por transporte común: FIFO con texto, pausa compartida, ID durable, sin cambiar pago y temporal eliminado", async () => {
  const f = await fixture();
  try {
    await f.other.sendText(chat, "Antes");
    const [a, b] = await Promise.all([f.worker.run("order-a"), createOrderPdfJobService(f.options).run("order-a")]);
    assert.equal([a, b].filter(item => item?.status === "done").length, 1);
    await f.other.sendText(chat, "Después");
    assert.deepEqual(f.outgoing.map(row => row.content instanceof FakeMessageMedia ? row.content.mimetype : row.content), ["Antes", "application/pdf", "Después"]);
    assert.deepEqual(f.pauses, [500, 500]);
    assert.equal(f.outgoing[1].options.sendMediaAsDocument, true);
    const delivery = (await f.db.collection("agent_whatsapp_deliveries").get()).docs.find(row => row.data().type === "pdf").data();
    assert.equal(delivery.status, "accepted"); assert.equal(delivery.whatsappMessageId, "own-2");
    assert.equal((await f.repository.getOrder("order-a")).status, "pending");
    assert.equal((await f.repository.getOrder("order-a")).pdfDelivered, true);
    await assert.rejects(access(f.path));
  } finally { await f.close(); }
});
test("PDF en cola al suspender no inicia envío: vuelve a pending y se recupera con ready", async () => {
  let release, entered;
  const sending = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ send: async (_to, content) => {
    if (content === "En curso") { entered(); await new Promise(resolve => { release = resolve; }); }
  } });
  const first = f.other.sendText(chat, "En curso");
  try {
    await sending;
    const work = f.worker.run("order-a");
    // Dar lugar a las operaciones de archivo sin usar una espera temporal.
    await Promise.race([f.generationStarted, work.then(() => assert.fail("El trabajador debía generar el PDF"))]);
    await readFile(f.path).catch(() => {});
    assert.notEqual((await f.repository.getJob("order-a")).phase, "sending");
    f.worker.suspend(); release(); await first;
    assert.equal((await work).status, "pending");
    assert.equal(f.outgoing.length, 1); assert.equal((await f.repository.getJob("order-a")).status, "pending");
    assert.equal((await f.db.collection("order_alerts").get()).docs.length, 0);
    f.worker.start(); assert.equal((await f.worker.run("order-a")).status, "done");
    assert.equal(f.outgoing.filter(row => row.content instanceof FakeMessageMedia).length, 1);
  } finally { release?.(); await first.catch(() => {}); await f.close(); }
});
test("desconexión durante envío PDF incierto deja alerta y no reenvía al reanudar ni reiniciar", async () => {
  let f;
  f = await fixture({ send: async (_to, content) => {
    if (content instanceof FakeMessageMedia) { f.worker.suspend(); throw new Error("Resultado desconocido"); }
  } });
  try {
    assert.equal((await f.worker.run("order-a")).status, "attention");
    const job = await f.repository.getJob("order-a");
    assert.equal(job.failureCode, "PDF_DELIVERY_UNCERTAIN");
    assert.equal((await f.repository.getOrder("order-a")).pdfDelivered, false);
    assert.equal((await f.db.collection("order_alerts").get()).docs.length, 1);
    f.worker.start(); await f.worker.drain();
    const restarted = createOrderPdfJobService(f.options); await restarted.drain(); await restarted.stop();
    assert.equal(f.generated(), 1); assert.equal(f.outgoing.length, 0);
    await assert.rejects(access(f.path));
  } finally { await f.close(); }
});
test("reinicio recupera rendering; sending y receipt_sending vencidos requieren revisión sin envío", async () => {
  for (const phase of ["rendering", "sending", "receipt_sending"]) {
    const f = await fixture({ jobPatch: { status: "running", phase, leaseUntil: 1, leaseToken: "old" } });
    try {
      const result = await f.worker.run("order-a");
      assert.equal(result.status, phase === "rendering" ? "done" : "attention");
      assert.equal(f.generated(), phase === "rendering" ? 1 : 0);
      await f.worker.drain();
      assert.equal((await f.db.collection("order_alerts").get()).docs.length, phase === "rendering" ? 0 : 1);
    } finally { await f.close(); }
  }
});
test("PDF generado inválido alerta una vez y no se confunde con suspensión recuperable", async () => {
  const f = await fixture();
  const worker = createOrderPdfJobService({ ...f.options, generatePdf: async () => { await writeFile(f.path, "archivo inválido"); return f.path; } });
  try {
    assert.equal((await worker.run("order-a")).status, "attention");
    assert.equal((await f.repository.getJob("order-a")).failureCode, "PDF_DELIVERY_FAILED");
    assert.equal(f.outgoing.length, 0); await worker.drain();
    assert.equal((await f.db.collection("order_alerts").get()).docs.length, 1);
    await assert.rejects(access(f.path));
  } finally { await worker.stop(); await f.close(); }
});
test("toma humana mientras se prepara PDF cancela lo no iniciado y conserva trabajo y pedido", async () => {
  const f = await fixture();
  let block, unsubscribed = false;
  const worker = createOrderPdfJobService({ ...f.options,
    watchJob: (_job, cancel) => { block = cancel; return () => { unsubscribed = true; }; },
    generatePdf: async () => { await writeFile(f.path, "%PDF-synthetic"); block(); return f.path; } });
  try {
    assert.equal((await worker.run("order-a")).status, "pending");
    assert.equal(f.outgoing.length, 0); assert.equal(unsubscribed, true);
    assert.equal((await f.repository.getOrder("order-a")).status, "pending");
    assert.equal((await f.repository.getJob("order-a")).phase, "rendering");
    assert.equal((await f.db.collection("order_alerts").get()).docs.length, 0);
    await assert.rejects(access(f.path));
  } finally { await worker.stop(); await f.close(); }
});
test("composición real: ready habilita trabajadores, silent conserva jobs excluidos y auth_failure corta admisión", { timeout: 5000 }, async () => {
  const db = whatsappMemoryDatabase(), clock = createVirtualClock(100000), client = new EventEmitter(), outgoing = [];
  const directory = await mkdtemp(join(tmpdir(), "pilot-pdf-")), path = join(directory, "synthetic.pdf");
  await writeFile(path, "%PDF-synthetic");
  let pdfDelivered;
  const delivered = new Promise(resolve => { pdfDelivered = resolve; });
  client.initialize = async () => { client.emit("authenticated"); client.emit("ready"); };
  client.destroy = async () => {};
  client.sendMessage = async (to, content) => { outgoing.push({ to, content });
    if (content instanceof FakeMessageMedia) pdfDelivered();
    return { id: { _serialized: "own-" + outgoing.length } }; };
  const config = createAgentWhatsAppConfig({ AGENT_ENABLED: "true", AGENT_ALLOWLIST: "595900000001", AGENT_MAINTENANCE_MODE: "silent" });
  await db.collection("agent_alerts").doc("alert").set({ id: "alert", type: "HANDOFF", delivered: false });
  const excluded = { id: "excluded", orderId: "excluded", chatId: "595900000002@c.us", status: "pending", phase: "queued", availableAt: 0 };
  await db.collection("order_pdf_jobs").doc("excluded").set(excluded);
  await db.collection("order_pdf_jobs").doc("included").set({ ...excluded, id: "included", orderId: "included", chatId: chat,
    receiptDelivered: true, leaseUntil: 0 });
  await db.collection("orders").doc("included").set({ id: "included", orderNumber: "hodie000001", status: "pending", pdfDelivered: false,
    whatsappChatId: chat, total: 100 });
  const pilot = await createWhatsAppPilotInfrastructure({ config, client, MessageMedia: FakeMessageMedia, db, now: clock.now, clock,
    timestampNow: () => new Date(clock.now()), timestampFromMillis: value => new Date(value),
    resolvePhone: async id => id.replace("@c.us", ""), alertsPhone: "595900000009", generatePdf: async order => {
      assert.equal(order.id, "included"); return path;
    },
    agentOptions: { modelFactory: () => assert.fail("No llamar al modelo sin ready") } });
  try {
    const before = structuredClone(db.rows); await pilot.handle(incoming("before-ready"));
    assert.deepEqual(db.rows, before); assert.equal(outgoing.length, 0);
    await pilot.start(); await clock.advanceAsync(0); await delivered; await flushMicrotasks();
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.some(row => row.to === "595900000009@c.us"));
    assert.ok(outgoing.some(row => row.to === chat && row.content instanceof FakeMessageMedia));
    assert.equal((await db.collection("orders").doc("included").get()).data().pdfDelivered, true);
    assert.equal((await db.collection("agent_whatsapp_own_messages").get()).docs.length, 2);
    assert.deepEqual((await db.collection("order_pdf_jobs").doc("excluded").get()).data(), excluded);
    client.emit("disconnected", "TIMEOUT");
    await db.collection("agent_alerts").doc("later").set({ id: "later", type: "HANDOFF", delivered: false });
    await clock.advanceAsync(1000); assert.equal(outgoing.length, 2);
    client.emit("auth_failure", "privado");
    const snapshot = structuredClone(db.rows); await pilot.handle(incoming("after-failure"));
    // La única escritura admisible del fallo es su solicitud durable de alerta.
    assert.equal([...db.rows.keys()].some(key => key.startsWith("agent_whatsapp_messages/")), false);
    assert.equal((await db.collection("order_pdf_jobs").doc("excluded").get()).data().status, "pending");
    assert.ok(snapshot.size <= db.rows.size);
  } finally { await pilot.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
