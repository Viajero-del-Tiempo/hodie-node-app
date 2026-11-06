import { randomUUID } from "node:crypto";
import { agentAlertId, synchronizeAgentAlerts } from "./agent-alert.service.js";
import { normalizePurchasePhone } from "../agents/consultation/order-access.js";
import { variantLabel } from "./order-pricing.service.js";
import { determineShippingMethod } from "./shipping.service.js";

export const MISUNDERSTANDING_HANDOFF_MESSAGE = "No pude entender bien lo que necesitás. Una persona del equipo te va a responder por este chat.";

// DTO para una persona del equipo. Los IDs, huellas, TTL y borradores siguen
// en sus repositorios; no forman parte del contexto de la solicitud humana.
async function readHandoffContext(runtime, state, { signal, now }) {
  let contextUnavailable = false;
  async function read(action, fallback) {
    try { const result = await action(); signal?.throwIfAborted(); return result ?? fallback; }
    catch { signal?.throwIfAborted(); contextUnavailable = true; return fallback; }
  }
  const verified = state.phoneVerified === true ? normalizePurchasePhone(state.userPhoneNumber) : null;
  const cart = await read(() => runtime.getCart?.({ signal }) ?? null, null);
  const byPhone = verified ? await read(() => runtime.orders?.listByPhone?.(verified) ?? [], []) : [];
  const byChat = await read(() => runtime.orders?.listByChat?.(state.whatsappChatId) ?? [], []);
  const products = new Map();
  async function lineDto(line) {
    if (!products.has(line.productId)) products.set(line.productId,
      read(() => runtime.catalog.getProductForPricing(line.productId, { signal }), null));
    const product = await products.get(line.productId);
    if (!product) contextUnavailable = true;
    const variant = product?.variants?.find(item => item.id === line.variantId);
    return {
      productName: product?.name ?? line.productName ?? null,
      variantLabel: (variant ? variantLabel(product, variant) : Object.values(line.options ?? {}).join(" · ")) || null,
      quantity: line.quantity,
      customizationText: line.customization?.text ?? null,
      packagingName: line.packagingType ? product?.packagingOptions?.find(item => item.type === line.packagingType)?.name ?? null : null,
    };
  }
  const shipping = cart?.shipping;
  const billing = cart?.billing;
  const cartDto = cart ? {
    lines: await Promise.all(cart.lines.map(lineDto)),
    shipping: {
      recipientName: shipping?.recipientName ?? null,
      recipientDocument: shipping?.city && determineShippingMethod(shipping.city) === "transportadora_contra_entrega"
        ? shipping.recipientDocument ?? null : null,
      city: shipping?.city ?? null, department: shipping?.department ?? null,
      street: shipping?.street ?? null, phone: shipping?.phone ?? null,
    },
    billing: {
      invoiceRequested: billing?.invoiceRequested ?? null,
      legalName: billing?.invoiceRequested === true ? billing.legalName ?? null : null,
      // No presentar como confirmado un RUC que todavía necesita aceptación.
      ruc: billing?.invoiceRequested === true && ["valid", "mismatch_confirmed"].includes(billing.rucValidation?.status)
        ? billing.ruc ?? null : null,
    },
  } : null;
  const request = state.pendingCorporateRequest?.expiresAt > now ? state.pendingCorporateRequest : null;
  const corporateRequest = request ? { totalUnits: request.totalUnits, lines: await Promise.all(request.lines.map(lineDto)) } : null;
  const shown = state.lastQuote;
  const quote = shown && Number.isFinite(shown.shownAt)
    ? await read(() => runtime.quoteRepository?.get(shown.quoteId, { signal }) ?? null, null) : null;
  const lastQuoteTotal = quote?.chatId === state.whatsappChatId && quote.confirmable === true
    && quote.cartFingerprint === shown?.cartFingerprint && quote.pricingFingerprint === shown?.pricingFingerprint
    && Number.isFinite(quote.total) ? quote.total : null;
  const own = [...byPhone, ...byChat];
  const messages = [...(state.messages ?? []), ...(runtime.getTurnContext?.()?.messages ?? []).map(message => ({ role: "user", content: message.text }))]
    .filter(message => ["user", "assistant"].includes(message.role) && typeof message.content === "string")
    .slice(-20).map(message => ({ role: message.role, content: message.content }));
  return { contextUnavailable, context: {
    cart: cartDto, lastQuoteTotal, corporateRequest,
    identity: { name: state.pushname ?? null, userPhoneNumber: verified },
    orders: own.filter(order => (verified && normalizePurchasePhone(order.userPhoneNumber) === verified)
      || order.whatsappChatId === state.whatsappChatId)
      .filter((order, index, all) => all.findIndex(item => item.orderNumber === order.orderNumber) === index)
      .slice(0, 2).map(order => ({ orderNumber: order.orderNumber, status: order.status })),
    messages,
  } };
}

export async function activateAgentHandoff(runtime, { motivo, texto, type = "HANDOFF", episodeId,
  lastMessage, signal, now = runtime.now?.() ?? Date.now() }) {
  signal?.throwIfAborted();
  if (runtime.getState().humanHandoffRequired) { await synchronizeAgentAlerts(runtime, { signal }); return { code: "OK", handoff: true, alreadyActive: true }; }
  const { context, contextUnavailable } = await readHandoffContext(runtime, runtime.getState(), { signal, now });
  signal?.throwIfAborted();
  const state = runtime.getState();
  if (state.humanHandoffRequired) { await synchronizeAgentAlerts(runtime, { signal }); return { code: "OK", handoff: true, alreadyActive: true }; }
  const episode = episodeId ?? runtime.getTurnContext?.()?.id ?? randomUUID();
  const handoff = { active: true, thread_id: state.whatsappChatId, whatsappChatId: state.whatsappChatId,
    episodeId: episode, userPhoneNumber: state.userPhoneNumber ?? "", pushname: state.pushname ?? "", motivo,
    lastCustomerMessage: (lastMessage ?? runtime.getTurnContext?.()?.messages?.at(-1)?.text ?? "").slice(0, 200), updatedAt: now };
  const alert = { id: agentAlertId(state.whatsappChatId, type, episode), type, chatId: state.whatsappChatId,
    episodeId: episode, reason: motivo, createdAt: now, delivered: false, contextUnavailable, context, handoff };
  state.humanHandoffRequired = true; state.humanHandoffReason = motivo; state.handoffEpisodeId = episode;
  state.lastQuote = null; state.pendingOrderConfirmation = null;
  if (state.pendingTextConfirmation) state.pendingTextConfirmation.shown = false;
  if (state.pendingRucConfirmation) state.pendingRucConfirmation.shown = false;
  state.guardianAlerts = [...(state.guardianAlerts ?? []), alert];
  await runtime.setState(state);
  await synchronizeAgentAlerts(runtime, { signal });
  signal?.throwIfAborted();
  await runtime.transport.sendText(texto);
  signal?.throwIfAborted();
  return { code: "OK", handoff: true, episodeId: episode };
}
