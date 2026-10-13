import { randomUUID } from "node:crypto";
import { normalizeCartSnapshot, fingerprint } from "../../src/services/cart.service.js";
import { pdfJobAdmission } from "../../src/services/order-pdf-job.service.js";

// Adaptador de almacenamiento, no otro pricing ni otro creador de pedidos.
export function createMemoryOrderConfirmationRepository({ catalog, cartRepository, quoteRepository, orders,
  now, assertOpen = () => {}, generateOrderId = randomUUID, faults = {} }) {
  const confirmations = new Map(), jobs = new Map(), alerts = new Map();
  let counter = { lastOrderNumber: Math.max(0, ...orders.list().map(order => {
    const match = /^hodie(\d+)$/u.exec(order.orderNumber); return match ? Number(match[1]) : 0;
  })) };
  let queue = Promise.resolve();
  const traces = [];
  const clone = value => value == null ? null : structuredClone(value);
  function atomic(action) {
    const task = queue.catch(() => {}).then(() => { assertOpen(); return action(); });
    queue = task.catch(() => {});
    return task;
  }
  const orderById = id => orders.list().find(order => order.id === id) ?? null;
  const storeOrder = order => orders.set(order.orderNumber, order);
  const lease = (job, token) => {
    if (token && (job?.leaseToken !== token || job.status !== "running")) throw Object.assign(new Error("Lease perdido"), { code: "JOB_LEASE_LOST" });
  };
  function attention(job, type) {
    const id = job.id + "-" + type;
    if (!alerts.has(id)) alerts.set(id, { id, type, orderId: job.orderId, orderNumber: job.orderNumber,
      chatId: job.chatId, createdAt: new Date(now()), delivered: false });
    jobs.set(job.id, { ...job, status: "attention", failureCode: type, updatedAt: new Date(now()), leaseUntil: 0 });
  }
  const repository = {
    timestampNow: () => new Date(now()), generateOrderId,
    transact(action) {
      return atomic(async () => {
        const writes = [], trace = [], readCarts = new Map();
        const read = async (name, getter) => {
          if (writes.length) throw new Error("Lectura después de escribir en la transacción");
          trace.push({ operation: "read", name }); return clone(await getter());
        };
        const write = (name, effect) => { trace.push({ operation: "write", name }); writes.push(effect); };
        const result = await action({
          readQuote: id => read("quote", () => quoteRepository.get(id)),
          readConfirmation: id => read("confirmation", () => confirmations.get(id)),
          async readCart(chatId) {
            const cart = await read("cart", () => cartRepository.get(chatId));
            readCarts.set(chatId, fingerprint(cart));
            return cart ? normalizeCartSnapshot(cart, chatId) : null;
          },
          readOrder: id => read("order", () => orderById(id)), readJob: id => read("job", () => jobs.get(id)),
          readCounter: () => read("counter", () => counter),
          catalog: {
            getProductForPricing: id => read("product", () => catalog.getProductForPricing(id)),
            getCategoryForPricing: id => read("category", () => catalog.getCategoryForPricing(id)),
          },
          createOrder: (_id, order) => write("order", () => storeOrder(order)),
          linkQuote: (id, orderId) => write("quote", () => quoteRepository.set(id, { ...quoteRepository.get(id), orderId, committedAt: new Date(now()) })),
          writeCounter: value => write("counter", () => { counter = clone(value); }),
          deleteCart: id => write("cart", () => cartRepository.delete(id)),
          deleteConfirmation: id => write("confirmation", () => confirmations.delete(id)),
          createJob: job => write("job", () => jobs.set(job.id, clone(job))),
        });
        assertOpen();
        for (const [id, expected] of readCarts) if (fingerprint(await cartRepository.get(id)) !== expected) {
          throw Object.assign(new Error("El carrito cambió durante la transacción"), { code: "CARRITO_CAMBIO", field: "cart", statusCode: 400 });
        }
        traces.push(trace);
        if (faults.beforeCommit && writes.length) { const error = faults.beforeCommit; faults.beforeCommit = null; throw error; }
        // Todos los efectos son sincrónicos: ningún observador ve una parte del commit.
        for (const effect of writes) effect();
        if (faults.afterCommit && writes.length) { const error = faults.afterCommit; faults.afterCommit = null; throw error; }
        return clone(result);
      });
    },
    async saveConfirmation(id, value, { signal } = {}) { signal?.throwIfAborted(); await atomic(() => confirmations.set(id, clone(value))); },
    async clearConfirmation(id, { signal } = {}) { signal?.throwIfAborted(); await atomic(() => confirmations.delete(id)); },
    getLinkedOrder(chatId, quoteId) {
      return repository.transact(async tx => {
        const quote = await tx.readQuote(quoteId);
        if (quote?.chatId !== chatId || !quote.orderId) return null;
        const order = await tx.readOrder(quote.orderId), job = await tx.readJob(quote.orderId);
        return order?.whatsappChatId === chatId ? { order, job, quote } : null;
      });
    },
    async getOrder(id) { assertOpen(); return clone(orderById(id)); },
    async getJob(id) { assertOpen(); return clone(jobs.get(id)); },
    async beginReceiptDelivery(id, { signal } = {}) {
      signal?.throwIfAborted();
      return atomic(() => {
        const job = jobs.get(id);
        if (!job || job.receiptDelivered || ["running", "attention"].includes(job.status) || job.phase === "receipt_sending") return false;
        jobs.set(id, { ...job, phase: "receipt_sending", updatedAt: new Date(now()) }); return true;
      });
    },
    async markReceiptDelivered(id) {
      await atomic(() => jobs.set(id, { ...jobs.get(id), receiptDelivered: true, phase: "queued", availableAt: now(), updatedAt: new Date(now()) }));
    },
    async readyJobs() { assertOpen(); return [...jobs.values()].filter(job => pdfJobAdmission(job, now()).mode !== "wait").map(job => job.id); },
    async claimJob(id, { leaseMs = 120000 } = {}) {
      return atomic(() => {
        const job = jobs.get(id), admission = pdfJobAdmission(job, now());
        if (admission.mode === "wait") return null;
        if (admission.mode === "attention") { attention(job, admission.type); return { attention: true }; }
        const leaseToken = randomUUID();
        const claimed = { ...job, status: "running", leaseToken, leaseUntil: now() + leaseMs, updatedAt: new Date(now()) };
        jobs.set(id, claimed); return { job: clone(claimed), leaseToken };
      });
    },
    async updateJob(id, patch, { leaseToken } = {}) {
      await atomic(() => { const job = jobs.get(id); lease(job, leaseToken); jobs.set(id, { ...job, ...clone(patch), updatedAt: new Date(now()) }); });
    },
    async updateOrderDelivery(id, patch, { jobId, leaseToken }) {
      await atomic(() => {
        const job = jobs.get(jobId), order = orderById(id); lease(job, leaseToken);
        if (!order || job.orderId !== id || Object.keys(patch).some(key => !["pdfDelivered", "updatedAt"].includes(key))) throw new Error("Actualización de entrega inválida");
        storeOrder({ ...order, ...clone(patch) });
      });
    },
    async requestAttention(id, type, { leaseToken } = {}) { await atomic(() => { const job = jobs.get(id); lease(job, leaseToken); attention(job, type); }); },
    inspect: () => ({ counter: clone(counter), confirmations: clone([...confirmations.values()]), jobs: clone([...jobs.values()]),
      alerts: clone([...alerts.values()]), traces: clone(traces) }),
    faults,
  };
  return repository;
}
