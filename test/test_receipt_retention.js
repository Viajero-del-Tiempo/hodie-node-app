import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentReceiptConfig } from "../src/services/payment-receipt.config.js";
import { createPaymentReceiptRepository } from "../src/services/payment-receipt.repository.js";
import { createPaymentReceiptService, startReceiptCleanup } from "../src/services/payment-receipt.service.js";
import { associatedReceiptRetention } from "../src/services/payment-receipt.retention.js";
import { receiptMemoryDatabase, memoryPrivateReceiptStorage } from "./helpers/receipt-memory.js";
import { receiptPng } from "./helpers/receipt-fixtures.js";
import { createVirtualClock, flushMicrotasks } from "./helpers/virtual-clock.js";

const DAY = 24 * 60 * 60 * 1000, START = Date.parse("2026-01-01T00:00:00Z");
function rows() {
  const data = new Map();
  return { get: id => structuredClone(data.get(id)), list: () => structuredClone([...data.values()]),
    set: (id, value) => data.set(id, structuredClone(value)), delete: id => data.delete(id) };
}
function fixture(config = createPaymentReceiptConfig({})) {
  const orders = rows(), receipts = rows(), alerts = rows(), faults = {}, logs = [], clock = createVirtualClock(START);
  const db = receiptMemoryDatabase({ orders, receipts, alerts, faults }), storage = memoryPrivateReceiptStorage();
  const repository = createPaymentReceiptRepository({ db, now: clock.now, logger: { warn: value => logs.push(value) } });
  const restart = () => createPaymentReceiptService({ repository, storage, now: clock.now, config });
  async function seed(id = "test-receipt", order = { status: "pending" }) {
    const orderId = "order-" + id, asset = storage.descriptor(id, "png");
    orders.set(orderId, { id: orderId, orderNumber: orderId, ...order });
    const value = { id, ownerChatId: "test@lid", status: "associated", orderId, orderNumber: orderId,
      createdAt: START, associatedAt: START + 1, expiresAt: null, filename: "sintetico.png", mimeType: "image/png",
      size: receiptPng.length, asset, acknowledgementDelivered: true };
    receipts.set(id, value); alerts.set("alert-" + id, { id: "alert-" + id, receiptId: id, orderId, delivered: true });
    await storage.put(asset, { data: receiptPng }); return value;
  }
  return { orders, receipts, alerts, faults, logs, clock, storage, repository, restart, seed, service: restart() };
}

test("retención: treinta días desde verificación, incluso si luego se cancela; conserva pedido, asociación y alerta", async () => {
  for (const status of ["paid", "cancelled"]) {
    const f = fixture(), receipt = await f.seed("test-receipt", { status, paymentVerifiedAt: START + 20 * DAY });
    const beforeOrders = f.orders.list(), beforeAlerts = f.alerts.list();
    f.clock.advance(30 * DAY); await f.service.cleanupAssociated();
    assert.equal(f.receipts.get(receipt.id).status, "associated"); assert.equal(f.storage.files.size, 1);
    f.clock.advance(20 * DAY - 1); await f.service.cleanupAssociated(); assert.equal(f.storage.files.size, 1);
    f.clock.advance(1); await f.service.cleanupAssociated();
    const deleted = f.receipts.get(receipt.id);
    assert.equal(deleted.status, "deleted"); assert.equal(deleted.deletedAt, START + 50 * DAY); assert.equal(deleted.retentionBasis, "payment_verified");
    assert.equal(deleted.orderId, receipt.orderId); assert.equal(deleted.orderNumber, receipt.orderNumber);
    assert.equal(deleted.acknowledgementDelivered, true); assert.equal(f.storage.files.size, 0);
    assert.deepEqual(f.orders.list(), beforeOrders); assert.deepEqual(f.alerts.list(), beforeAlerts);
    f.clock.advance(DAY); await f.service.cleanupAssociated(); await f.service.cleanup();
    assert.deepEqual(f.receipts.get(receipt.id), deleted);
  }
});

test("cancelado o abandonado sin verificación vence treinta días después de la subida", async () => {
  for (const status of ["pending", "cancelled"]) {
    const f = fixture(), receipt = await f.seed("test-receipt", { status });
    f.clock.advance(30 * DAY - 1); await f.service.cleanupAssociated(); assert.equal(f.storage.files.size, 1);
    f.clock.advance(1); await f.service.cleanupAssociated();
    assert.equal(f.storage.files.size, 0); assert.equal(f.receipts.get(receipt.id).status, "deleted");
    assert.equal(f.receipts.get(receipt.id).retentionBasis, "uploaded");
    assert.equal(f.orders.get(receipt.orderId).status, status);
  }
});

test("sin asignar conserva seis horas y deja registro eliminado; no usa el plazo de asociados", async () => {
  const f = fixture(), receipt = await f.seed();
  f.receipts.set(receipt.id, { ...receipt, status: "unassigned", orderId: null, expiresAt: START + 6 * 60 * 60 * 1000 });
  f.clock.advance(6 * 60 * 60 * 1000 - 1); await f.service.cleanup(); assert.equal(f.storage.files.size, 1);
  f.clock.advance(1); await f.service.cleanup();
  assert.equal(f.storage.files.size, 0); assert.equal(f.receipts.get(receipt.id).status, "deleted");
  assert.equal(f.receipts.get(receipt.id).deletedAt, f.clock.now());
});

test("fallo de almacenamiento y reinicio recuperan deleting sin perder asociación ni alerta", async () => {
  const f = fixture(), receipt = await f.seed(), remove = f.storage.delete;
  f.clock.advance(30 * DAY); f.storage.delete = async () => { throw new Error("Proveedor temporalmente inaccesible"); };
  await assert.rejects(f.service.cleanupAssociated(), AggregateError);
  assert.equal(f.receipts.get(receipt.id).status, "deleting"); assert.equal(f.storage.files.size, 1);
  f.storage.delete = remove; await f.restart().cleanup();
  assert.equal(f.storage.files.size, 0); assert.equal(f.receipts.get(receipt.id).status, "deleted");
  assert.equal(f.receipts.get(receipt.id).orderId, receipt.orderId); assert.equal(f.alerts.list().length, 1);
});

test("caída tras borrar bytes y antes de marcar eliminado se recupera idempotentemente tras reinicio", async () => {
  const f = fixture(), receipt = await f.seed(), remove = f.storage.delete;
  f.clock.advance(30 * DAY); let first = true;
  f.storage.delete = async asset => { await remove(asset); if (first) { first = false; f.faults.beforeCommit = new Error("Interrupción de prueba"); } };
  await assert.rejects(f.service.cleanupAssociated(), AggregateError);
  assert.equal(f.storage.files.size, 0); assert.equal(f.receipts.get(receipt.id).status, "deleting");
  await f.restart().cleanup(); const deleted = f.receipts.get(receipt.id);
  assert.equal(deleted.status, "deleted"); await f.restart().cleanup(); assert.deepEqual(f.receipts.get(receipt.id), deleted);
});

test("limpiezas concurrentes no duplican historia ni modifican el pedido", async () => {
  const f = fixture(), receipt = await f.seed(), beforeOrders = f.orders.list(), beforeAlerts = f.alerts.list();
  f.clock.advance(30 * DAY);
  await Promise.all([f.service.cleanupAssociated(), f.restart().cleanupAssociated()]);
  assert.equal(f.receipts.get(receipt.id).status, "deleted"); assert.equal(f.receipts.list().length, 1); assert.equal(f.storage.files.size, 0);
  assert.deepEqual(f.orders.list(), beforeOrders); assert.deepEqual(f.alerts.list(), beforeAlerts);
});

test("relee pago al reclamar el archivo: verificación posterior al barrido conserva sus treinta días", async () => {
  const f = fixture(), receipt = await f.seed(); f.clock.advance(30 * DAY);
  const claim = f.repository.claimDelete;
  f.repository.claimDelete = (id, options) => {
    f.orders.set(receipt.orderId, { ...f.orders.get(receipt.orderId), status: "paid", paymentVerifiedAt: f.clock.now() });
    return claim(id, options);
  };
  await f.service.cleanupAssociated();
  assert.equal(f.receipts.get(receipt.id).status, "associated"); assert.equal(f.storage.files.size, 1);
});

test("paginación recorre más de cien archivos aunque los primeros tengan pago histórico sin fecha fiable", async () => {
  const f = fixture();
  for (let index = 0; index < 101; index++) await f.seed("test-" + String(index).padStart(3, "0"), { status: index < 100 ? "paid" : "pending" });
  f.clock.advance(30 * DAY); await f.service.cleanupAssociated();
  assert.equal(f.storage.files.size, 100); assert.equal(f.receipts.get("test-100").status, "deleted");
  assert.equal(f.receipts.get("test-000").status, "associated");
  assert.equal(f.logs.length, 100); assert.ok(f.logs.every(value => value.code === "RETENTION_VERIFICATION_DATE_MISSING"));
});

test("fecha de verificación admite Timestamp/Date/ISO/número; nunca se deduce de updatedAt", () => {
  const receipt = { createdAt: START }, verified = START + DAY;
  for (const paymentVerifiedAt of [verified, new Date(verified), new Date(verified).toISOString(), { toMillis: () => verified }]) {
    assert.deepEqual(associatedReceiptRetention(receipt, { status: "paid", paymentVerifiedAt }, { now: verified + 30 * DAY, retentionMs: 30 * DAY }),
      { expired: true, expiresAt: verified + 30 * DAY, basis: "payment_verified" });
  }
  assert.equal(associatedReceiptRetention(receipt, { status: "paid", updatedAt: START }, { now: START + 31 * DAY, retentionMs: 30 * DAY }).blocked,
    "RETENTION_VERIFICATION_DATE_MISSING");
});

test("plazos configurables validados: treinta días y barrido diario por defecto", async () => {
  const defaults = createPaymentReceiptConfig({}); assert.equal(defaults.associatedRetentionMs, 30 * DAY); assert.equal(defaults.retentionCleanupIntervalMs, DAY);
  const config = createPaymentReceiptConfig({ AGENT_RECEIPT_ASSOCIATED_RETENTION_MS: String(DAY), AGENT_RECEIPT_RETENTION_CLEANUP_INTERVAL_MS: "60000" });
  const f = fixture(config), receipt = await f.seed(); f.clock.advance(DAY); await f.service.cleanupAssociated();
  assert.equal(f.receipts.get(receipt.id).status, "deleted");
  for (const key of ["AGENT_RECEIPT_ASSOCIATED_RETENTION_MS", "AGENT_RECEIPT_RETENTION_CLEANUP_INTERVAL_MS"]) {
    for (const value of ["", " ", "no", null, false, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => createPaymentReceiptConfig({ [key]: value }));
  }
});

test("worker ejecuta al iniciar, programa barrido diario separado de seis horas y se detiene sin dejar tareas", async () => {
  const intervals = new Map(); let sequence = 0, short = 0, daily = 0;
  const clock = { setInterval(fn, milliseconds) { const id = ++sequence; intervals.set(id, { fn, milliseconds }); return id; }, clearInterval: id => intervals.delete(id) };
  const service = { config: createPaymentReceiptConfig({}), cleanup: async () => { short++; }, cleanupAssociated: async () => { daily++; } };
  const stop = startReceiptCleanup(service, { clock }); await flushMicrotasks();
  assert.deepEqual([...intervals.values()].map(value => value.milliseconds), [60000, DAY]); assert.equal(short, 1); assert.equal(daily, 1);
  const tick = [...intervals.values()].find(value => value.milliseconds === DAY).fn;
  tick(); tick(); await flushMicrotasks(); assert.equal(daily, 2); // No solapa la misma tarea.
  await stop(); tick(); await flushMicrotasks(); assert.equal(daily, 2); assert.equal(intervals.size, 0);
});
