import { randomUUID } from "node:crypto";
import { normalizeCartSnapshot, timestampMillis } from "./cart.service.js";
import { pdfJobAdmission } from "./order-pdf-job.service.js";
import { AGENT_CONFIG_COLLECTION, AGENT_CONFIG_ID } from "./agent-config.service.js";
import { prepareDurableAlert } from "./agent-alert.service.js";

// Puerto dormido: conexión explícita del llamador, nunca inicializa Firebase.
export function createOrderConfirmationRepository({ db, timestampNow, now = Date.now, counterId = "orderNumber", agentConfigId = AGENT_CONFIG_ID, beforeTransaction,
  generateOrderId = () => db.collection("orders").doc().id }) {
  const ref = (collection, id) => db.collection(collection).doc(id);
  const data = snapshot => snapshot.exists ? snapshot.data() : null;
  const jobRef = id => ref("order_pdf_jobs", id);
  const alertRef = id => ref("order_alerts", id);
  const assertLease = (job, token) => {
    if (token && (job?.leaseToken !== token || job.status !== "running")) {
      throw Object.assign(new Error("El trabajo perdió su permiso de ejecución."), { code: "JOB_LEASE_LOST" });
    }
  };
  async function attention(tx, job, type) {
    const id = job.id + "-" + type;
    const commit = await prepareDurableAlert(tx, alertRef(id), { id, type, orderId: job.orderId,
      orderNumber: job.orderNumber, chatId: job.chatId, createdAt: timestampNow(), delivered: false });
    // Leer la solicitud antes de escribir. Un reinicio no duplica la alerta.
    commit();
    tx.update(jobRef(job.id), { status: "attention", failureCode: type, updatedAt: timestampNow(), leaseUntil: 0 });
  }
  const repository = {
    timestampNow,
    generateOrderId,
    async transact(action) {
      return db.runTransaction(async tx => {
        await beforeTransaction?.(tx);
        return action({
          readQuote: async id => data(await tx.get(ref("order_quotes", id))),
          readConfirmation: async chatId => data(await tx.get(ref("order_confirmations", chatId))),
          async readCart(chatId) {
            const cart = data(await tx.get(ref("carts", chatId)));
            return cart ? normalizeCartSnapshot({ ...cart, updatedAt: timestampMillis(cart.updatedAt),
              expiresAt: timestampMillis(cart.expiresAt) }, chatId) : null;
          },
          readOrder: async id => data(await tx.get(ref("orders", id))),
          readJob: async id => data(await tx.get(jobRef(id))),
          readCounter: async () => data(await tx.get(ref("counters", counterId))),
          readAgentConfig: async () => data(await tx.get(ref(AGENT_CONFIG_COLLECTION, agentConfigId))),
          catalog: {
            async getProductForPricing(id) { const product = data(await tx.get(ref("products", id))); return product ? { ...product, id } : null; },
            async getCategoryForPricing(id) { const category = data(await tx.get(ref("categories", id))); return category ? { ...category, id } : null; },
          },
          createOrder: (id, order) => tx.create(ref("orders", id), order),
          linkQuote: (id, orderId) => tx.update(ref("order_quotes", id), { orderId, committedAt: timestampNow() }),
          writeCounter: counter => tx.set(ref("counters", counterId), counter, { merge: true }),
          deleteCart: chatId => tx.delete(ref("carts", chatId)),
          deleteConfirmation: chatId => tx.delete(ref("order_confirmations", chatId)),
          createJob: job => tx.create(jobRef(job.id), job),
        });
      });
    },
    async saveConfirmation(chatId, value, { signal } = {}) {
      signal?.throwIfAborted();
      await db.runTransaction(async tx => {
        await beforeTransaction?.(tx); signal?.throwIfAborted();
        tx.set(ref("order_confirmations", chatId), value);
      });
    },
    async clearConfirmation(chatId, { signal } = {}) {
      signal?.throwIfAborted();
      await ref("order_confirmations", chatId).delete();
    },
    async getLinkedOrder(chatId, quoteId) {
      return repository.transact(async tx => {
        const quote = await tx.readQuote(quoteId);
        if (quote?.chatId !== chatId || !quote.orderId) return null;
        const order = await tx.readOrder(quote.orderId), job = await tx.readJob(quote.orderId);
        return order?.whatsappChatId === chatId ? { order, job, quote } : null;
      });
    },
    async getOrder(id) { return data(await ref("orders", id).get()); },
    async getJob(id) { return data(await jobRef(id).get()); },
    async beginReceiptDelivery(id, { signal } = {}) {
      signal?.throwIfAborted();
      return db.runTransaction(async tx => {
        const job = data(await tx.get(jobRef(id)));
        if (!job || job.receiptDelivered || job.status === "attention") return false;
        if (job.status === "running" || job.phase === "receipt_sending") return false;
        signal?.throwIfAborted();
        tx.update(jobRef(id), { phase: "receipt_sending", updatedAt: timestampNow() });
        return true;
      });
    },
    async markReceiptDelivered(id) {
      await jobRef(id).update({ receiptDelivered: true, phase: "queued", availableAt: now(), updatedAt: timestampNow() });
    },
    async readyJobs(limit = 20) {
      const [pending, abandoned] = await Promise.all([
        db.collection("order_pdf_jobs").where("status", "==", "pending").where("availableAt", "<=", now()).orderBy("availableAt").limit(limit).get(),
        db.collection("order_pdf_jobs").where("status", "==", "running").where("leaseUntil", "<=", now()).orderBy("leaseUntil").limit(limit).get(),
      ]);
      return [...new Set([...pending.docs, ...abandoned.docs].map(doc => doc.id))];
    },
    async claimJob(id, { leaseMs = 120000 } = {}) {
      return db.runTransaction(async tx => {
        const job = data(await tx.get(jobRef(id)));
        const admission = pdfJobAdmission(job, now());
        if (admission.mode === "wait") return null;
        if (admission.mode === "attention") {
          await attention(tx, job, admission.type);
          return { attention: true };
        }
        const leaseToken = randomUUID();
        tx.update(jobRef(id), { status: "running", leaseToken, leaseUntil: now() + leaseMs, updatedAt: timestampNow() });
        return { job: { ...job, status: "running", leaseToken, leaseUntil: now() + leaseMs }, leaseToken };
      });
    },
    async updateJob(id, patch, { leaseToken } = {}) {
      await db.runTransaction(async tx => {
        const job = data(await tx.get(jobRef(id)));
        if (!job) throw new Error("Trabajo inexistente.");
        assertLease(job, leaseToken);
        tx.update(jobRef(id), { ...patch, updatedAt: timestampNow() });
      });
    },
    async updateOrderDelivery(id, patch, { jobId, leaseToken }) {
      await db.runTransaction(async tx => {
        const job = data(await tx.get(jobRef(jobId))), order = data(await tx.get(ref("orders", id)));
        assertLease(job, leaseToken);
        if (!order || job.orderId !== id || Object.keys(patch).some(key => !["pdfDelivered", "updatedAt"].includes(key))) throw new Error("Actualización de entrega inválida.");
        tx.update(ref("orders", id), patch);
      });
    },
    async requestAttention(id, type, { leaseToken } = {}) {
      await db.runTransaction(async tx => {
        const job = data(await tx.get(jobRef(id)));
        if (!job) throw new Error("Trabajo inexistente.");
        assertLease(job, leaseToken);
        await attention(tx, job, type);
      });
    },
  };
  return repository;
}
