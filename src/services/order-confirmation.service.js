import { createOrderPricingService } from "./order-pricing.service.js";
import { cartIssue, timestampMillis } from "./cart.service.js";
import { evaluateCartPricing, cartQuoteFingerprint } from "./order-quote.service.js";
import { inspectPurchaseData } from "./purchase-data.service.js";
import { buildOrderSnapshot, prepareOrderNumber, validateOrderPayload } from "./order-persistence.service.js";
import { resolveOrderIdentity } from "./order-identity.service.js";
import { validateShippingAddress } from "./shipping.service.js";
import { validateOrderBilling } from "../validators/billing.validator.js";
import { renderOrderPaymentMessage, validateOrderBankConfig } from "./order-payment.service.js";
import { assertCorporateQuantity } from "./agent-config.service.js";

export function createOrderConfirmationService({ repository, chatId, now, getTurn, getState, setState,
  normalizePhone, acceptsConfirmation, inspectProgress, renderSummary, bankConfig }) {
  const bank = validateOrderBankConfig(bankConfig);
  let attempted = null;
  const linked = quoteId => repository.getLinkedOrder(chatId, quoteId);
  const publicResult = ({ order, job, created }) => ({ code: "OK", orderId: order.id, orderNumber: order.orderNumber,
    subtotal: order.subtotal, shippingCost: order.shippingCost, total: order.total, status: order.status,
    created, pdfDelivered: order.pdfDelivered, pdfStatus: job?.status ?? "pending", messageAddedByServer: true });
  return {
    async create(quoteId, { signal } = {}) {
      signal?.throwIfAborted();
      const turn = getTurn(), state = getState();
      const resolvedPhone = state.phoneVerified === true ? normalizePhone(state.userPhoneNumber) : null;
      const verifiedPhone = resolvedPhone;
      attempted = { quoteId, turnId: turn?.id, sequence: turn?.sequence };
      const id = repository.generateOrderId(); // Estable ante reintentos del callback Firestore.
      const result = await repository.transact(async tx => {
        const stored = await tx.readQuote(quoteId);
        if (stored?.chatId !== chatId || !stored.confirmable) throw cartIssue("COTIZACION_INEXISTENTE", "quoteId", "Esta cotización no está disponible en este chat.");
        if (stored.orderId) {
          const order = await tx.readOrder(stored.orderId), job = await tx.readJob(stored.orderId);
          if (!order) throw new Error("La relación de cotización tiene un pedido inexistente.");
          if (order.whatsappChatId !== chatId) throw cartIssue("COTIZACION_INEXISTENTE", "quoteId", "Esta cotización no está disponible en este chat.");
          return { order, job, created: false };
        }
        const cart = await tx.readCart(chatId), pending = await tx.readConfirmation(chatId);
        if (!cart || timestampMillis(cart.expiresAt) <= now()) throw cartIssue("CARRITO_CAMBIO", "quoteId", "El carrito ya no está vigente; hace falta una cotización nueva.");
        const agentConfig = await tx.readAgentConfig();
        assertCorporateQuantity(cart.lines, agentConfig);
        if (state.pendingCorporateRequest?.expiresAt > now()) assertCorporateQuantity(state.pendingCorporateRequest.lines, agentConfig);
        if (cartQuoteFingerprint(cart, verifiedPhone ?? normalizePhone(cart.shipping.phone)) !== stored.cartFingerprint) {
          throw cartIssue("CARRITO_CAMBIO", "quoteId", "El carrito cambió; hace falta una cotización nueva.");
        }
        if (state.lastQuote?.quoteId !== quoteId || pending?.quoteId !== quoteId || !acceptsConfirmation(pending, turn)) {
          throw cartIssue("CONFIRMACION_REQUERIDA", "quoteId", "Mostrá la cotización vigente y esperá una confirmación del cliente en un lote posterior.");
        }
        const counter = await tx.readCounter();
        const calculatePricing = createOrderPricingService({ catalog: tx.catalog, structuredErrors: true, includeLineSubtotals: true });
        const { quote: current, pricing } = await evaluateCartPricing(cart, { calculatePricing,
          inspectData: value => inspectProgress(value, { catalog: tx.catalog,
            inspectData: value => inspectPurchaseData(value, { verifiedPhone, normalizePhone }) }), renderSummary, signal });
        if (current.cartFingerprint !== stored.cartFingerprint || pending.cartFingerprint !== stored.cartFingerprint) {
          throw cartIssue("CARRITO_CAMBIO", "quoteId", "El carrito cambió; hace falta una cotización nueva.");
        }
        if (!current.confirmable) throw cartIssue("DATO_FALTANTE", current.fields[0] ?? "cart", "Faltan datos o confirmaciones para crear el pedido.");
        if (current.pricingFingerprint !== stored.pricingFingerprint || pending.pricingFingerprint !== stored.pricingFingerprint) {
          throw cartIssue("PRECIO_CAMBIO", "quoteId", "Cambió la información usada para cotizar; mostrale al cliente el resumen nuevo.");
        }
        const orderData = { userId: state.user?.uid || chatId, userDisplayName: state.user?.displayName || state.pushname || "Cliente",
          userPhoneNumber: current.contactPhone, items: current.items, shippingAddress: current.shippingAddress,
          billing: current.billing, whatsappChatId: chatId };
        const validation = validateOrderPayload(orderData);
        if (!validation.valid) throw cartIssue("DATO_FALTANTE", validation.field, validation.error);
        const metadata = await resolveOrderIdentity(null, orderData, { origin: "whatsapp", resolvedPhone: resolvedPhone ?? "" });
        const shippingAddress = validateShippingAddress(orderData.shippingAddress);
        const billing = validateOrderBilling({ ...orderData.billing,
          acknowledgeRucMismatch: orderData.billing.rucValidation?.status === "mismatch_confirmed" });
        const prepared = prepareOrderNumber(counter, repository.timestampNow);
        const order = buildOrderSnapshot(orderData, { id, orderNumber: prepared.orderNumber, pricing, metadata,
          shippingAddress, billing, timestampNow: repository.timestampNow });
        const job = { id, orderId: id, orderNumber: order.orderNumber, chatId, quoteId,
          customerMessage: renderOrderPaymentMessage(order, bank), currency: bank.currency, receiptDelivered: false,
          availableAt: turn?.deadlineEpoch ?? now() + 60000, createdAt: repository.timestampNow(), updatedAt: repository.timestampNow(),
          status: "pending", phase: "queued", leaseUntil: 0 };
        signal?.throwIfAborted();
        tx.createOrder(id, order); tx.linkQuote(quoteId, id); tx.writeCounter(prepared.counter);
        tx.deleteCart(chatId); tx.deleteConfirmation(chatId); tx.createJob(job);
        return { order, job, created: true };
      });
      // El commit puede terminar pese a una cancelación: el trabajo durable lo
      // recupera. No sobrescribir el checkpoint desde un turno cancelado.
      signal?.throwIfAborted();
      const latest = getState();
      if (result.created || latest.lastQuote?.quoteId === quoteId) {
        latest.lastQuote = null; latest.pendingOrderConfirmation = null;
        latest.pendingTextConfirmation = null; latest.pendingRucConfirmation = null; latest.subtotalPending = null;
      }
      latest.pendingOrderReceipt = { quoteId, orderId: result.order.id, turnId: turn?.id ?? "setup", sequence: turn?.sequence ?? 0 };
      await setState(latest);
      return publicResult(result);
    },
    async receiptForTurn() {
      const turn = getTurn();
      if (!turn) return null;
      const pending = getState().pendingOrderReceipt;
      const current = pending && pending.turnId === turn.id && !pending.shown ? pending
        : attempted && attempted.turnId === turn.id ? attempted : null;
      if (!current) return null;
      const result = await linked(current.quoteId);
      if (!result?.job) return null;
      return { ...result, customerMessage: result.order.status === "pending" ? result.job.customerMessage
        : renderOrderPaymentMessage(result.order, bank) };
    },
    async beginReceipt(result, context) { return repository.beginReceiptDelivery(result.order.id, context); },
    async receiptDelivered(result) {
      await repository.markReceiptDelivered(result.order.id);
      const state = getState();
      if (state.pendingOrderReceipt?.orderId === result.order.id) {
        state.pendingOrderReceipt.shown = true; await setState(state);
      }
    },
  };
}
