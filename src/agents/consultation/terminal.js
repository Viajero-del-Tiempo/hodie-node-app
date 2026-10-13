import { purchaseError, cartIssue } from "../../services/cart.service.js";
import { pendingTextFor } from "./confirmations.js";

export function createResponder({ getState, setState, transport, purchase = null, getTurnContext = () => null }) {
  return async ({ texto, entendido, quoteIdMostrado }, { signal } = {}) => {
    signal?.throwIfAborted();
    const turn = getTurnContext();
    let quote = null, pendingText = null, pendingRuc = null;
    const parts = [texto];
    if (purchase) {
      try {
        if (quoteIdMostrado !== undefined) {
          quote = await purchase.quotes.prepareShow(quoteIdMostrado, { signal });
          if (!turn) throw cartIssue("TURNO_NO_DISPONIBLE", "quoteIdMostrado", "Hace falta un turno del cliente para mostrar la cotización.");
          parts.push(quote.summary);
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

export async function forceTechnicalHandoff({ getState, setState, transport }, reason, { signal } = {}) {
  signal?.throwIfAborted();
  const state = getState();
  if (state.humanHandoffRequired) return;
  state.humanHandoffRequired = true;
  state.humanHandoffReason = reason;
  await setState(state);
  signal?.throwIfAborted();
  // Cierre mínimo por código: sin herramienta del modelo, índice ni alerta externa.
  await transport.sendText("No pude continuar con la consulta. Una persona del equipo te va a responder por este chat.");
}
