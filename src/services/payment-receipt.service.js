import { createHash, randomUUID } from "node:crypto";
import { cartIssue, fingerprint } from "./cart.service.js";
import { normalizePurchasePhone } from "../agents/consultation/order-access.js";
import { createPaymentReceiptConfig } from "./payment-receipt.config.js";
import { validatePaymentReceipt } from "../validators/payment-receipt.validator.js";
import { receiptOwned, receiptOrderOwned, receiptAcknowledgement } from "./payment-receipt.repository.js";

export function createPaymentReceiptService({ repository, storage, getState, getAttachment, getTurn = () => null,
  now = Date.now, config = createPaymentReceiptConfig(), newReceiptId = (chatId, digest) => fingerprint([chatId, digest]) }) {
  const uploads = new Map(); let acknowledgedThisTurn = null;
  const identity = () => { const state = getState(); return { chatId: state.whatsappChatId,
    phone: state.phoneVerified === true ? normalizePurchasePhone(state.userPhoneNumber) : null }; };
  async function stage(attachmentId, options) {
    const file = validatePaymentReceipt(await getAttachment(attachmentId));
    const owner = identity(), digest = createHash("sha256").update(file.data).digest("hex");
    let id = newReceiptId(owner.chatId, digest);
    // El registro eliminado es histórico: reenviar los mismos bytes crea una
    // generación nueva, sin sobrescribir su asociación ni su alerta anterior.
    for (;;) {
      options.signal?.throwIfAborted();
      let previous = await repository.get(id);
      if (previous && previous.status !== "associated" && previous.status !== "deleted" && previous.expiresAt <= now()) {
        await service.cleanupOne(id, options); previous = await repository.get(id);
      }
      if (previous?.status !== "deleted") break;
      const nextId = newReceiptId(owner.chatId, fingerprint([digest, "after-deletion", id, previous.deletedAt, previous.asset.publicId]));
      if (nextId === id) throw new Error("El generador de comprobantes debe distinguir generaciones eliminadas");
      id = nextId;
    }
    if (uploads.has(id)) return uploads.get(id);
    const task = (async () => {
      const value = { id, ownerChatId: owner.chatId, ownerPhone: owner.phone, status: "uploading", createdAt: now(),
        expiresAt: now() + config.unassignedTtlMs, filename: file.filename, mimeType: file.mimeType, size: file.size,
        asset: storage.descriptor(fingerprint([id, randomUUID()]), file.extension) };
      const reserved = await repository.reserve(value, options);
      if (!reserved.created) {
        if (reserved.receipt.status !== "uploading") return reserved.receipt;
      }
      await storage.put(reserved.receipt.asset, file, options);
      options.signal?.throwIfAborted();
      return repository.ready(id, options);
    })();
    uploads.set(id, task);
    try { return await task; } finally { uploads.delete(id); }
  }
  const service = {
    async register({ attachmentId, comprobanteId, orderNumber }, options = {}) {
      options.signal?.throwIfAborted();
      const receipt = attachmentId ? await stage(attachmentId, options) : await repository.get(comprobanteId);
      if (!receipt || receipt.status === "deleted" || !receiptOwned(receipt, identity())) throw cartIssue("COMPROBANTE_NO_DISPONIBLE", "comprobanteId", "El comprobante no está disponible.");
      if (receipt.status !== "associated" && (receipt.expiresAt <= now() || !["unassigned"].includes(receipt.status))) {
        await service.cleanupOne(receipt.id, options);
        throw cartIssue("COMPROBANTE_VENCIDO", "comprobanteId", "El comprobante venció; volvé a enviarlo.");
      }
      let order;
      if (orderNumber) order = await repository.orderByNumber(orderNumber);
      else if (receipt.status === "associated") order = await repository.orderByNumber(receipt.orderNumber);
      else {
        const candidates = await repository.pendingOrders(identity());
        options.signal?.throwIfAborted();
        if (candidates.length !== 1) return { code: candidates.length ? "PEDIDO_AMBIGUO" : "PEDIDO_NO_DISPONIBLE",
          comprobanteId: receipt.id, field: "orderNumber", expiresAt: receipt.expiresAt,
          orders: candidates.map(item => ({ orderNumber: item.orderNumber })),
          message: candidates.length ? "¿A cuál de estos pedidos corresponde el comprobante?" : "No hay un pedido pendiente disponible. Indicá el número del pedido." };
        order = candidates[0];
      }
      if (!order || order.status !== "pending" || !receiptOrderOwned(order, identity())) throw cartIssue("PEDIDO_NO_DISPONIBLE", "orderNumber", "No hay un pedido pendiente disponible con esos datos.");
      const result = await repository.associate(receipt.id, order.id, identity(), options);
      // La relación durable permite recuperar el acuse si se corta después del commit.
      acknowledgedThisTurn = { id: receipt.id, turnId: getTurn()?.id };
      options.signal?.throwIfAborted();
      return { code: "OK", comprobanteId: result.id, orderNumber: result.orderNumber,
        alreadyAssociated: result.alreadyAssociated, acknowledgementAddedByServer: true };
    },
    async acknowledgementForTurn() {
      const current = acknowledgedThisTurn && acknowledgedThisTurn.turnId === getTurn()?.id ? await repository.get(acknowledgedThisTurn.id) : null;
      const receipt = current?.status === "associated" ? current : (await repository.unacknowledged(identity().chatId))[0];
      if (!receipt || !receiptOwned(receipt, identity())) return null;
      return { id: receipt.id, text: receiptAcknowledgement(receipt.orderNumber) };
    },
    markAcknowledged: id => repository.markAcknowledged(id),
    async pending() { return (await repository.listUnassigned(identity().chatId)).map(item => ({ comprobanteId: item.id,
      type: item.mimeType === "application/pdf" ? "document" : "image", filename: item.filename })); },
    async cleanupOne(id, options = {}) {
      const receipt = await repository.claimDelete(id, { ...options, retentionMs: config.associatedRetentionMs });
      if (receipt) { await storage.delete(receipt.asset, options); options.signal?.throwIfAborted(); await repository.finishDelete(id, receipt.asset.publicId, options); }
    },
    async cleanup() {
      const failures = [];
      for (const id of await repository.expired()) { try { await service.cleanupOne(id); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, "Quedaron comprobantes vencidos por eliminar");
    },
    async cleanupAssociated() {
      const failures = [];
      for await (const id of repository.associatedCandidates(config.associatedRetentionMs)) {
        try { await service.cleanupOne(id); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Quedaron comprobantes asociados por eliminar");
    },
    config,
  };
  return service;
}

// Cada arranque recupera borrados a medio completar. El barrido corto conserva
// las seis horas sin asignar; el diario aplica retención a los asociados.
export function startReceiptCleanup(service, { intervalMs = 60000,
  retentionIntervalMs = service.config.retentionCleanupIntervalMs, logger = console, clock = globalThis } = {}) {
  let stopped = false;
  const jobs = [ { method: "cleanup", interval: intervalMs }, { method: "cleanupAssociated", interval: retentionIntervalMs } ];
  for (const job of jobs) {
    const sweep = () => {
      if (stopped || job.running) return job.running;
      job.running = Promise.resolve().then(() => { if (!stopped) return service[job.method](); })
        .catch(() => logger.error("No se pudo limpiar comprobantes vencidos; se reintentará"))
        .finally(() => { job.running = null; }); return job.running;
    };
    job.timer = clock.setInterval(sweep, job.interval); job.timer?.unref?.(); void sweep();
  }
  return async () => { stopped = true; for (const job of jobs) clock.clearInterval(job.timer); await Promise.all(jobs.map(job => job.running)); };
}
