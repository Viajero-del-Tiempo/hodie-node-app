import { purchaseError, cartIssue } from "../../services/cart.service.js";
import { pendingTextFor, clientAskedQuestion } from "./confirmations.js";
import { ORDER_CONFIRMATION_QUESTION } from "../../services/order-quote.service.js";

export function createResponder({ getState, setState, transport, purchase = null, getTurnContext = () => null }) {
  return async ({ texto, entendido, quoteIdMostrado }, { signal } = {}) => {
    signal?.throwIfAborted();
    const turn = getTurnContext();
    const receipt = await purchase?.orders.receiptForTurn();
    signal?.throwIfAborted();
    if (receipt) {
      // Mensaje exclusivo del servidor: el modelo no recibe datos bancarios y
      // su texto no puede reformularlos ni agregar instrucciones alternativas.
      if (receipt.job.receiptDelivered) {
        await transport.sendText(receipt.customerMessage);
      } else if (await purchase.orders.beginReceipt(receipt, { signal })) {
        await transport.sendText(receipt.customerMessage);
        await purchase.orders.receiptDelivered(receipt);
      }
      signal?.throwIfAborted();
      const state = getState();
      state.consecutiveMisunderstandings = entendido ? 0 : (state.consecutiveMisunderstandings ?? 0) + 1;
      await setState(state);
      return { code: "OK", entendido, orderMessageAdded: true };
    }
    let quote = null, pendingText = null, pendingRuc = null;
    const parts = [texto];
    if (purchase) {
      try {
        const effectiveQuoteId = quoteIdMostrado ?? (clientAskedQuestion(turn) ? getState().lastQuote?.quoteId : undefined);
        if (effectiveQuoteId !== undefined) {
          const previous = getState().lastQuote;
          quote = await purchase.quotes.prepareShow(effectiveQuoteId, { signal });
          if (!turn) throw cartIssue("TURNO_NO_DISPONIBLE", "quoteIdMostrado", "Hace falta un turno del cliente para mostrar la cotización.");
          if (/[¿?❓❔]/u.test(texto)) throw cartIssue("CONFIRMACION_AMBIGUA", "texto", "El servidor agrega la pregunta final; respondé sin otra pregunta.");
          const repeated = previous?.quoteId === quote.quoteId && previous.cartFingerprint === quote.cartFingerprint
            && previous.pricingFingerprint === quote.pricingFingerprint;
          if (!repeated) parts.push(quote.summary);
          parts.push(ORDER_CONFIRMATION_QUESTION);
        } else {
          const partial = await purchase.quotes.partialForTurn({ signal });
          if (partial) parts.push(partial.summary);
        }
        const cart = await purchase.carts.read({ signal });
        pendingText = pendingTextFor(cart);
        pendingRuc = getState().pendingRucConfirmation;
        if (pendingRuc && (pendingRuc.cartId !== cart?.id || pendingRuc.input !== cart?.billing.ruc || pendingRuc.legalName !== cart?.billing.legalName)) pendingRuc = null;
        if (pendingText) parts.push("¿Confirmás que el texto sea exactamente “" + pendingText.value + "”?" );
        else if (pendingRuc && pendingRuc.input === cart?.billing.ruc) parts.push(pendingRuc.kind === "ruc_completion"
          ? "¿Tu RUC es " + pendingRuc.value + "? Confirmalo antes de guardarlo completo."
          : "El dígito verificador no coincide. ¿Querés corregir el RUC “" + pendingRuc.input + "” o continuar con él como lo ingresaste?");
      } catch (error) { signal?.throwIfAborted(); return purchaseError(error); }
      // Desactivar antes de enviar: incluso si no podemos registrar después
      // del envío, un sí a otra pregunta no autoriza crear el pedido anterior.
      await purchase.quotes.clearConfirmation({ signal });
    }
    await transport.sendText(parts.join("\n\n"));
    signal?.throwIfAborted();
    const state = getState();
    state.consecutiveMisunderstandings = entendido ? 0 : (state.consecutiveMisunderstandings ?? 0) + 1;
    if (turn && pendingText) {
      state.pendingTextConfirmation = { ...pendingText, shown: true, shownSequence: turn.sequence, shownBatchId: turn.id };
      // Una afirmación al texto no confirma también una propuesta fiscal anterior.
      if (state.pendingRucConfirmation) state.pendingRucConfirmation = { ...state.pendingRucConfirmation, shown: false };
    }
    if (turn && !pendingText && pendingRuc) state.pendingRucConfirmation = { ...pendingRuc, shown: true, shownSequence: turn.sequence, shownBatchId: turn.id };
    // La escalada y derivar como herramienta se implementan en la entrega 5.
    await setState(state);
    signal?.throwIfAborted();
    if (quote) await purchase.quotes.markShown(quote, turn, { signal });
    return { code: "OK", entendido };
  };
}
