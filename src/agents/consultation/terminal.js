import { purchaseError, cartIssue } from "../../services/cart.service.js";
import { pendingTextFor, clientAskedQuestion } from "./confirmations.js";
import { ORDER_CONFIRMATION_QUESTION } from "../../services/order-quote.service.js";
import { activateAgentHandoff, MISUNDERSTANDING_HANDOFF_MESSAGE } from "../../services/agent-handoff.service.js";
import { createProductImages } from "./product-images.js";

export function createResponder(runtime) {
  const { getState, setState, transport, purchase = null, getTurnContext = () => null } = runtime;
  const images = runtime.productImages ??= createProductImages(runtime);
  return async ({ texto, cierre, entendido, fueraDeAlcance = false, quoteIdMostrado, productosMostrados, empaquesMostrados }, { signal } = {}) => {
    signal?.throwIfAborted();
    // Se mantiene el nombre persistido del contador; ambas causas forman la
    // misma racha. Un cierre normal (entendido y dentro del alcance) la reinicia.
    const nextCounter = state => entendido === false || fueraDeAlcance === true
      ? (state.consecutiveMisunderstandings ?? 0) + 1 : 0;
    const turn = getTurnContext();
    const imageResults = async allowed => ({
      ...(productosMostrados === undefined ? {} : { productImages: await images.show(productosMostrados, { signal, allowed }) }),
      ...(empaquesMostrados === undefined ? {} : { packagingImages: await images.showPackaging(empaquesMostrados, { signal, allowed }) }),
    });
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
      state.consecutiveMisunderstandings = nextCounter(state);
      await setState(state);
      return { code: "OK", entendido, fueraDeAlcance, orderMessageAdded: true, ...await imageResults(false) };
    }
    const receiptAck = await runtime.paymentReceipts?.acknowledgementForTurn();
    signal?.throwIfAborted();
    if (receiptAck) {
      await transport.sendText(receiptAck.text);
      signal?.throwIfAborted();
      await runtime.paymentReceipts.markAcknowledged(receiptAck.id);
      signal?.throwIfAborted();
      const state = getState(); state.consecutiveMisunderstandings = nextCounter(state); await setState(state);
      signal?.throwIfAborted();
      return { code: "OK", entendido, fueraDeAlcance, receiptAcknowledgementAdded: true, ...await imageResults(false) };
    }
    if (nextCounter(getState()) >= 4) {
      const state = getState(); state.consecutiveMisunderstandings = 4;
      await setState(state);
      return activateAgentHandoff(runtime, { motivo: "4 intentos sin encauzar la consulta", texto: MISUNDERSTANDING_HANDOFF_MESSAGE,
        type: "MISUNDERSTANDING", signal });
    }
    let quote = null, pendingText = null, pendingRuc = null, hasQuoteSummary = false;
    const parts = [texto];
    const corporatePending = getState().pendingCorporateRequest?.expiresAt > (runtime.now?.() ?? Date.now());
    if (purchase && !corporatePending) {
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
          if (partial) { parts.push(partial.summary); hasQuoteSummary = true; }
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
    state.consecutiveMisunderstandings = nextCounter(state);
    if (turn && pendingText) {
      state.pendingTextConfirmation = { ...pendingText, shown: true, shownSequence: turn.sequence, shownBatchId: turn.id };
      // Una afirmación al texto no confirma también una propuesta fiscal anterior.
      if (state.pendingRucConfirmation) state.pendingRucConfirmation = { ...state.pendingRucConfirmation, shown: false };
    }
    if (turn && !pendingText && pendingRuc) state.pendingRucConfirmation = { ...pendingRuc, shown: true, shownSequence: turn.sequence, shownBatchId: turn.id };
    await setState(state);
    signal?.throwIfAborted();
    if (quote) await purchase.quotes.markShown(quote, turn, { signal });
    const allowed = images.canPresent(quoteIdMostrado === undefined && !quote && !hasQuoteSummary);
    const presented = await imageResults(allowed);
    if (allowed && cierre) { signal?.throwIfAborted(); await transport.sendText(cierre); signal?.throwIfAborted(); }
    return { code: "OK", entendido, fueraDeAlcance,
      ...presented };
  };
}
