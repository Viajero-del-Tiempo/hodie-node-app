import { randomUUID } from "node:crypto";
import { cartContent, fingerprint, pricingInputs, cartIssue } from "./cart.service.js";

export const ORDER_CONFIRMATION_QUESTION = "¿Confirmás este pedido?";
export const cartQuoteFingerprint = (cart, contactPhone) => fingerprint({ id: cart.id, revision: cart.revision,
  ...cartContent(cart), contactPhone });

// Misma evaluación y mismas huellas para mostrar y para confirmar dentro de una transacción.
export async function evaluateCartPricing(cart, { calculatePricing, inspectData, renderSummary, signal }) {
  if (!cart?.lines.length) return { pricing: null,
    quote: { code: "DATO_FALTANTE", confirmable: false, fields: ["lines"], summary: renderSummary({}) } };
  const pricing = await calculatePricing(pricingInputs(cart));
  signal?.throwIfAborted();
  const data = await inspectData(cart);
  const quote = { code: data.fields.length ? "DATO_FALTANTE" : "OK", confirmable: data.fields.length === 0,
    fields: data.fields, pendientes: data.pendientes, items: pricing.sanitizedItems, subtotal: pricing.subtotal,
    shippingCost: pricing.shippingCost, ...(data.fields.length ? {} : { total: pricing.total }),
    shipping: data.options, shippingAddress: data.shippingAddress, contactPhone: data.phone, billing: data.billing ?? cart.billing,
    cartFingerprint: cartQuoteFingerprint(cart, data.phone),
    pricingFingerprint: fingerprint(pricing), cartId: cart.id, revision: cart.revision };
  quote.summary = renderSummary(quote);
  return { quote, pricing };
}

export function createOrderQuoteService({ carts, repository, chatId, calculatePricing, inspectData, getState, setState,
  renderSummary, now = Date.now, newId = randomUUID, getTurn, confirmationRepository = null }) {
  let lastResult = null;
  async function invalidate(context) {
    context.signal?.throwIfAborted();
    const state = getState();
    if (state.lastQuote || state.pendingOrderConfirmation) {
      state.lastQuote = null; state.pendingOrderConfirmation = null; await setState(state);
    }
    await confirmationRepository?.clearConfirmation(chatId, context);
  }
  async function acknowledgeSubtotal(expected, context) {
    context.signal?.throwIfAborted();
    const state = getState();
    // No limpiar el pendiente de un cambio ocurrido mientras se calculaba.
    if (expected && state.subtotalPending && fingerprint(expected) === fingerprint(state.subtotalPending)) {
      state.subtotalPending = null;
      await setState(state);
    }
  }
  async function evaluate(context = {}) {
    const cart = await carts.read(context);
    return (await evaluateCartPricing(cart, { calculatePricing, inspectData, renderSummary, signal: context.signal })).quote;
  }
  async function informative(lineas, context) {
    // Pricing del servidor, sin leer/escribir el carrito ni invalidar lastQuote.
    const pricing = await calculatePricing(lineas);
    context.signal?.throwIfAborted();
    const result = { code: "OK", mode: "informative", confirmable: false,
      items: pricing.sanitizedItems.map((item, index) => ({ ...item, subtotal: pricing.lineSubtotals[index] })),
      subtotal: pricing.subtotal, productsTotal: pricing.subtotal };
    result.summary = renderSummary(result);
    return result;
  }
  const service = {
    async quote(context = {}, args = {}) {
      const pendingAtStart = structuredClone(getState().subtotalPending ?? null);
      if (Object.hasOwn(args, "lineas")) {
        lastResult = null;
        const result = await informative(args.lineas, context);
        await acknowledgeSubtotal(pendingAtStart, context);
        lastResult = { result: structuredClone(result), lineas: structuredClone(args.lineas), turnId: getTurn()?.id ?? "setup" };
        return result;
      }
      let result;
      try { result = await evaluate(context); }
      catch (error) { await invalidate(context); throw error; }
      const previous = getState().lastQuote;
      if (previous && (previous.cartFingerprint !== result.cartFingerprint || previous.pricingFingerprint !== result.pricingFingerprint)) await invalidate(context);
      if (result.pendientes) result.pendientes = result.pendientes.filter(item => item.tipo !== "informar_subtotal");
      if (result.confirmable) {
        result.quoteId = fingerprint([chatId, result.cartId, result.cartFingerprint, result.pricingFingerprint, newId()]);
        await repository.set(result.quoteId, { ...result, chatId, issuedAt: now() });
        context.signal?.throwIfAborted();
      }
      await acknowledgeSubtotal(pendingAtStart, context);
      lastResult = { result: structuredClone(result), turnId: getTurn()?.id ?? "setup" };
      return result;
    },
    async prepareShow(quoteId, context = {}) {
      const stored = await repository.get(quoteId);
      context.signal?.throwIfAborted();
      if (!stored || stored.chatId !== chatId || !stored.confirmable) throw cartIssue("COTIZACION_INEXISTENTE", "quoteIdMostrado", "Esta cotización no está disponible en este chat.");
      let current;
      try { current = await evaluate(context); }
      catch (error) { await invalidate(context); throw error; }
      if (stored.cartFingerprint !== current.cartFingerprint) { await invalidate(context); throw cartIssue("CARRITO_CAMBIO", "quoteIdMostrado", "El carrito cambió; hace falta una cotización nueva."); }
      if (stored.pricingFingerprint !== current.pricingFingerprint) { await invalidate(context); throw cartIssue("PRECIO_CAMBIO", "quoteIdMostrado", "Cambió la información usada para cotizar; hace falta una cotización nueva."); }
      return stored;
    },
    async markShown(quote, turn, context = {}) {
      context.signal?.throwIfAborted();
      // No se marca por cotizar ni por recibir un ID del modelo: el llamador
      // confirma que el único envío del resumen ya terminó correctamente.
      const state = getState();
      state.lastQuote = { quoteId: quote.quoteId, cartFingerprint: quote.cartFingerprint,
        pricingFingerprint: quote.pricingFingerprint, shownAt: now(), shownTurn: turn.sequence, shownBatchId: turn.id };
      state.pendingOrderConfirmation = { quoteId: quote.quoteId, cartId: quote.cartId,
        cartFingerprint: quote.cartFingerprint, pricingFingerprint: quote.pricingFingerprint,
        shownAt: now(), shownSequence: turn.sequence, shownBatchId: turn.id };
      await confirmationRepository?.saveConfirmation(chatId, state.pendingOrderConfirmation, context);
      context.signal?.throwIfAborted();
      await setState(state);
    },
    async clearConfirmation(context = {}) {
      context.signal?.throwIfAborted();
      await confirmationRepository?.clearConfirmation(chatId, context);
      const state = getState();
      if (state.pendingOrderConfirmation) { state.pendingOrderConfirmation = null; await setState(state); }
    },
    async partialForTurn(context = {}) {
      const turn = getTurn();
      if (!turn || !lastResult || lastResult.turnId !== turn.id || lastResult.result.confirmable) return null;
      if (lastResult.result.mode === "informative") return informative(lastResult.lineas, context);
      const current = await evaluate(context);
      return lastResult.result.cartFingerprint === current.cartFingerprint ? current : null;
    },
  };
  return service;
}
