import { createOrderProcessor } from "./order-processing.service.js";
import { renderExistingOrderMessage } from "./order-payment.service.js";

const deferredCodes = new Set(["PDF_WORKER_SUSPENDED", "WHATSAPP_NOT_READY", "WHATSAPP_DISCONNECTED", "WHATSAPP_AUTH_FAILURE",
  "WHATSAPP_STOPPED", "WHATSAPP_OUTSIDE_ALLOWLIST", "TRANSPORT_CLOSED", "CHAT_CONTROL_CHANGED", "SEND_SEQUENCE_STOPPED"]);

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
  clock = { setTimeout, clearTimeout }, leaseMs = 120000, canProcess = async () => true, watchJob = () => () => {} }) {
  let polling = false, pollTimer = null, suspended = false, closed = false, pollGeneration = 0;
  let connection = new AbortController();
  const running = new Set();
  const suspendError = () => Object.assign(new Error("Trabajador PDF suspendido"), { code: "PDF_WORKER_SUSPENDED", deliveryStarted: false });
  async function defer(id, leaseToken) {
    const current = await repository.getJob(id);
    await repository.updateJob(id, { status: "pending", phase: current.receiptDelivered ? "rendering" : "queued",
      availableAt: now(), leaseUntil: 0 }, { leaseToken });
    return { status: "pending", orderId: current.orderId };
  }
  async function run(id) {
    if (closed || suspended || !await canProcess(await repository.getJob(id))) return null;
    const connectionSignal = connection.signal;
    connectionSignal.throwIfAborted();
    const claimed = await repository.claimJob(id, { leaseMs });
    if (!claimed || claimed.attention) return claimed?.attention ? { status: "attention" } : null;
    const { job, leaseToken } = claimed;
    const blocked = new AbortController(), signal = AbortSignal.any([connectionSignal, blocked.signal]);
    const canDefer = error => error.deliveryStarted === false && (signal.aborted || deferredCodes.has(error.code));
    let finished = false, timer, deferred = false, uncertainSend = false, unwatch;
    const beforeSend = phase => async () => {
      signal.throwIfAborted();
      await repository.updateJob(id, { phase }, { leaseToken });
      signal.throwIfAborted();
    };
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
      unwatch = watchJob(job, () => blocked.abort(suspendError()));
      signal.throwIfAborted();
      if (!job.receiptDelivered) {
        const order = await repository.getOrder(job.orderId);
        if (!order) throw new Error("El trabajo tiene un pedido inexistente.");
        const text = order.status === "pending" ? job.customerMessage : renderExistingOrderMessage(order, job.currency);
        if (!transport.handlesDeliveryStart) await beforeSend("receipt_sending")();
        await transport.sendText(text, { job, signal, beforeSend: beforeSend("receipt_sending") });
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
          signal.throwIfAborted();
          await repository.updateJob(id, { phase: "rendering" }, { leaseToken });
          return generatePdf(order);
        },
        sendPdf: async (recipient, path, order) => {
          try {
            if (!transport.handlesDeliveryStart) await beforeSend("sending")();
            return await transport.sendPdf(recipient, path, order, { signal, beforeSend: beforeSend("sending") });
          } catch (error) { deferred = canDefer(error); uncertainSend = error.deliveryStarted !== false; throw error; }
        },
        notifyFailure: () => deferred || signal.aborted && !uncertainSend ? undefined : repository.requestAttention(id,
          uncertainSend ? "PDF_DELIVERY_UNCERTAIN" : "PDF_DELIVERY_FAILED", { leaseToken }),
      });
      const result = await processor({ id: job.orderId });
      if (deferred || signal.aborted && !uncertainSend && !result.pdfDelivered) return await defer(id, leaseToken);
      const stored = await repository.getOrder(job.orderId);
      if (result.pdfDelivered && stored.pdfDelivered) {
        await repository.updateJob(id, { status: "done", phase: "complete", leaseUntil: 0 }, { leaseToken });
        return { status: "done", orderId: job.orderId };
      }
      const current = await repository.getJob(id);
      if (current.status !== "attention") await repository.requestAttention(id, "PDF_DELIVERY_STATE_UNCERTAIN", { leaseToken });
      return { status: "attention", orderId: job.orderId };
    } catch (error) {
      if (canDefer(error)) return await defer(id, leaseToken);
      if (error.code !== "JOB_LEASE_LOST") {
        try { const current = await repository.getJob(id);
          await repository.requestAttention(id, current.phase === "receipt_sending" ? "ORDER_RECEIPT_UNCERTAIN" : "PDF_JOB_FAILED", { leaseToken }); }
        catch { return { status: "unknown", orderId: job.orderId, code: "PDF_ALERT_NOT_PERSISTED" }; }
      }
      return { status: error.code === "JOB_LEASE_LOST" ? "lease_lost" : "attention", orderId: job.orderId };
    } finally { finished = true; clock.clearTimeout(timer); unwatch?.(); }
  }
  const service = { run(id) {
    const task = run(id); running.add(task);
    task.finally(() => running.delete(task)).catch(() => {}); return task;
  }, async drain() {
    const results = [];
    if (closed || suspended) return results;
    for (const id of await repository.readyJobs()) { if (closed || suspended) break; results.push(await service.run(id)); }
    return results;
  }, start({ pollMs = 5000, logger = () => {} } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 1000) throw new Error("Intervalo de trabajos inválido.");
    if (polling || closed) return;
    polling = true; suspended = false;
    if (connection.signal.aborted) connection = new AbortController();
    const generation = ++pollGeneration;
    const poll = async () => {
      try {
        for (const result of await service.drain()) if (result?.status === "unknown") logger({ code: result.code, orderId: result.orderId });
      } catch (error) { logger({ code: "PDF_WORKER_ERROR", message: error.code ?? "STORAGE_ERROR" }); }
      if (polling && generation === pollGeneration) { pollTimer = clock.setTimeout(poll, pollMs); pollTimer?.unref?.(); }
    };
    pollTimer = clock.setTimeout(poll, 0);
  }, suspend() { polling = false; suspended = true; pollGeneration++; clock.clearTimeout(pollTimer); connection.abort(suspendError()); },
  async stop() { closed = true; service.suspend(); await Promise.allSettled([...running]); } };
  return service;
}
