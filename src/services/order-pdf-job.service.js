import { createOrderProcessor } from "./order-processing.service.js";
import { renderExistingOrderMessage } from "./order-payment.service.js";

export function pdfJobAdmission(job, now) {
  if (!job || ["done", "attention"].includes(job.status)
      || (job.status === "running" && job.leaseUntil > now)
      || (job.status === "pending" && job.availableAt > now)) return { mode: "wait" };
  if (["sending", "receipt_sending"].includes(job.phase)) return { mode: "attention",
    type: job.phase === "sending" ? "PDF_DELIVERY_UNCERTAIN" : "ORDER_RECEIPT_UNCERTAIN" };
  return { mode: "run" };
}

// Fuera del plazo del turno. No importa WhatsApp ni envía alertas al equipo.
export function createOrderPdfJobService({ repository, transport, generatePdf, now = Date.now,
  clock = { setTimeout, clearTimeout }, leaseMs = 120000 }) {
  let polling = false, pollTimer = null;
  async function run(id) {
    const claimed = await repository.claimJob(id, { leaseMs });
    if (!claimed || claimed.attention) return claimed?.attention ? { status: "attention" } : null;
    const { job, leaseToken } = claimed;
    let finished = false, timer;
    const renew = () => {
      timer = clock.setTimeout(async () => {
        if (finished) return;
        try { await repository.updateJob(id, { leaseUntil: now() + leaseMs }, { leaseToken }); }
        catch { return; } // Una ejecución sin lease no autoriza un envío nuevo.
        if (!finished) renew();
      }, Math.floor(leaseMs / 3));
      timer?.unref?.();
    };
    renew();
    try {
      if (!job.receiptDelivered) {
        const order = await repository.getOrder(job.orderId);
        if (!order) throw new Error("El trabajo tiene un pedido inexistente.");
        const text = order.status === "pending" ? job.customerMessage : renderExistingOrderMessage(order, job.currency);
        await repository.updateJob(id, { phase: "receipt_sending" }, { leaseToken });
        await transport.sendText(text);
        await repository.updateJob(id, { receiptDelivered: true, phase: "rendering" }, { leaseToken });
      }
      const processor = createOrderProcessor({
        persistence: { persistOrderSnapshot: () => repository.getOrder(job.orderId) },
        db: { collection(name) {
          if (name !== "orders") throw new Error("Colección de entrega inválida.");
          return { doc(orderId) { return { update: patch => repository.updateOrderDelivery(orderId, patch, { jobId: id, leaseToken }) }; } };
        } },
        timestampNow: repository.timestampNow,
        generatePdf: async order => {
          await repository.updateJob(id, { phase: "rendering" }, { leaseToken });
          return generatePdf(order);
        },
        sendPdf: async (recipient, path, order) => {
          // Este marcador se confirma ANTES de iniciar la operación externa.
          await repository.updateJob(id, { phase: "sending" }, { leaseToken });
          return transport.sendPdf(recipient, path, order);
        },
        notifyFailure: () => repository.requestAttention(id, "PDF_DELIVERY_FAILED", { leaseToken }),
      });
      const result = await processor({ id: job.orderId });
      const stored = await repository.getOrder(job.orderId);
      if (result.pdfDelivered && stored.pdfDelivered) {
        await repository.updateJob(id, { status: "done", phase: "complete", leaseUntil: 0 }, { leaseToken });
        return { status: "done", orderId: job.orderId };
      }
      const current = await repository.getJob(id);
      if (current.status !== "attention") await repository.requestAttention(id, "PDF_DELIVERY_STATE_UNCERTAIN", { leaseToken });
      return { status: "attention", orderId: job.orderId };
    } catch (error) {
      if (error.code !== "JOB_LEASE_LOST") {
        try { await repository.requestAttention(id, "PDF_JOB_FAILED", { leaseToken }); }
        catch { return { status: "unknown", orderId: job.orderId, code: "PDF_ALERT_NOT_PERSISTED" }; }
      }
      return { status: error.code === "JOB_LEASE_LOST" ? "lease_lost" : "attention", orderId: job.orderId };
    } finally { finished = true; clock.clearTimeout(timer); }
  }
  const service = { run, async drain() {
    const results = [];
    for (const id of await repository.readyJobs()) results.push(await run(id));
    return results;
  }, start({ pollMs = 5000, logger = () => {} } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 1000) throw new Error("Intervalo de trabajos inválido.");
    if (polling) return;
    polling = true;
    const poll = async () => {
      try {
        for (const result of await service.drain()) if (result?.status === "unknown") logger({ code: result.code, orderId: result.orderId });
      } catch (error) { logger({ code: "PDF_WORKER_ERROR", message: error.code ?? "STORAGE_ERROR" }); }
      if (polling) { pollTimer = clock.setTimeout(poll, pollMs); pollTimer?.unref?.(); }
    };
    pollTimer = clock.setTimeout(poll, 0);
  }, stop() { polling = false; clock.clearTimeout(pollTimer); } };
  return service;
}
