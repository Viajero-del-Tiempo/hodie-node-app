import { createCartService, purchaseError, cartIssue, fingerprint } from "../../services/cart.service.js";
import { createOrderPricingService } from "../../services/order-pricing.service.js";
import { createPurchaseDataService, inspectPurchaseData } from "../../services/purchase-data.service.js";
import { createOrderQuoteService } from "../../services/order-quote.service.js";
import { createCartTools } from "./cart-tools.js";
import { normalizePurchasePhone } from "./order-access.js";
import { acceptsPending, acceptsRucMismatch, wasProvided, pendingTextFor } from "./confirmations.js";
import { renderQuoteSummary } from "./quote-summary.js";
import { inspectCartProgress, subtotalVersion } from "./cart-progress.js";

export function createPurchaseTools(runtime) {
  const chatId = runtime.getState().whatsappChatId;
  // Estado efímero del turno: no se guarda en el carrito ni en el checkpoint.
  let turnDataBlocks = null;
  const blocksInProgress = cart => {
    const turn = runtime.getTurnContext();
    return turn && turnDataBlocks?.cartId === cart.id && turnDataBlocks.turnId === turn.id
      && turnDataBlocks.turnSequence === turn.sequence ? turnDataBlocks.blocks : [];
  };
  const calculatePricing = createOrderPricingService({ catalog: runtime.catalog, structuredErrors: true, includeLineSubtotals: true });
  const verifiedPhone = () => runtime.getState().phoneVerified === true ? normalizePurchasePhone(runtime.getState().userPhoneNumber) : null;
  const inspectData = cart => inspectCartProgress(cart, { catalog: runtime.catalog,
    subtotalPending: runtime.getState().subtotalPending,
    inProgressBlocks: blocksInProgress(cart),
    inspectData: value => inspectPurchaseData(value, { verifiedPhone: verifiedPhone(), normalizePhone: normalizePurchasePhone }) });
  const carts = createCartService({ repository: runtime.cartRepository, chatId, now: runtime.now, calculatePricing,
    async onUnavailable({ signal }) {
      signal?.throwIfAborted();
      turnDataBlocks = null;
      const state = runtime.getState();
      if (state.lastQuote || state.pendingTextConfirmation || state.pendingRucConfirmation || state.subtotalPending) {
        state.lastQuote = null; state.pendingTextConfirmation = null; state.pendingRucConfirmation = null;
        state.subtotalPending = null;
        await runtime.setState(state);
      }
    },
    async onChange({ cart, previous, operation, signal }) {
      signal?.throwIfAborted();
      const linesChanged = fingerprint(cart.lines) !== fingerprint(previous?.lines ?? []);
      let subtotalPending;
      if (linesChanged && ["add", "modify"].includes(operation)) {
        const progress = await inspectData(cart);
        signal?.throwIfAborted();
        const undecided = new Set(progress.pendientes.filter(item => ["personalizacion", "empaque"].includes(item.tipo)).map(item => item.linea));
        const completeChangedLine = cart.lines.some(line => !undecided.has(line.id)
          && fingerprint(line) !== fingerprint(previous?.lines.find(old => old.id === line.id) ?? null));
        if (completeChangedLine) subtotalPending = subtotalVersion(cart);
      }
      const state = runtime.getState(); state.lastQuote = null;
      if (linesChanged) state.subtotalPending = subtotalPending ?? null;
      const pendingText = pendingTextFor(cart);
      if (state.pendingTextConfirmation?.cartId !== cart.id || state.pendingTextConfirmation?.lineId !== pendingText?.lineId || state.pendingTextConfirmation?.value !== pendingText?.value) state.pendingTextConfirmation = null;
      if (state.pendingRucConfirmation?.cartId !== cart.id || state.pendingRucConfirmation?.input !== cart.billing.ruc || state.pendingRucConfirmation?.legalName !== cart.billing.legalName) state.pendingRucConfirmation = null;
      await runtime.setState(state);
      signal?.throwIfAborted();
      const changedBlocks = [["shipping", "envio"], ["billing", "facturacion"]]
        .filter(([key]) => previous ? fingerprint(cart[key]) !== fingerprint(previous[key])
          : Object.values(cart[key]).some(value => value !== null && value !== undefined))
        .map(([_key, tipo]) => tipo);
      if (changedBlocks.length) {
        const turn = runtime.getTurnContext();
        // Si ambos se modifican, el más reciente va primero. No repetir un
        // bloque ni olvidar otro incompleto que se modificó en este turno.
        turnDataBlocks = turn ? { cartId: cart.id, turnId: turn.id, turnSequence: turn.sequence,
          blocks: [...changedBlocks, ...blocksInProgress(cart).filter(tipo => !changedBlocks.includes(tipo))] } : null;
      }
    },
  });
  const quotes = createOrderQuoteService({ carts, repository: runtime.quoteRepository, chatId, calculatePricing, inspectData,
    getState: runtime.getState, setState: runtime.setState, renderSummary: renderQuoteSummary, now: runtime.now, getTurn: runtime.getTurnContext });
  const data = createPurchaseDataService({ carts, normalizePhone: normalizePurchasePhone,
    async getProfile(context) {
      if (!verifiedPhone()) return null;
      return runtime.getOwnProfile?.(verifiedPhone(), context) ?? null;
    },
    async rucAuthorization({ args, billing, cartId, previousRuc, profileSelected, ownedAcceptance }) {
      const pending = runtime.getState().pendingRucConfirmation;
      const turn = runtime.getTurnContext();
      const same = pending?.cartId === cartId && pending.legalName === billing.legalName && (pending.input === billing.ruc || pending.value === billing.ruc);
      const accepted = same && (pending.kind === "ruc_mismatch" ? acceptsRucMismatch(pending, turn) : acceptsPending(pending, turn, pending.value));
      const suppliedFull = pending?.kind === "ruc_completion" && same && billing.ruc === pending.value && wasProvided(billing.ruc, turn);
      // Un RUC completo nuevo debe estar escrito por el cliente, salir de su
      // perfil o ser la propuesta que acaba de aceptar. Pasarlo como ruc en
      // lugar de confirmedRuc no permite saltar el protocolo de completar DV.
      if (!profileSelected && args.ruc?.includes("-") && billing.ruc !== previousRuc
          && !wasProvided(billing.ruc, turn) && !(accepted && pending?.kind === "ruc_completion" && billing.ruc === pending.value)) {
        throw cartIssue("CONFIRMACION_REQUERIDA", "billing.ruc", "Copiá el RUC literal del cliente o esperá que confirme la propuesta.");
      }
      if (args.confirmedRuc !== undefined && (!accepted || args.confirmedRuc !== pending?.value)) throw cartIssue("CONFIRMACION_REQUERIDA", "confirmedRuc", "El cliente todavía no confirmó esa propuesta de RUC.");
      if (args.acknowledgeRucMismatch === true && !accepted && !ownedAcceptance) throw cartIssue("CONFIRMACION_REQUERIDA", "acknowledgeRucMismatch", "El cliente todavía no aceptó usar ese RUC con discrepancia.");
      return { confirmedRuc: accepted && pending?.kind === "ruc_completion" ? pending.value : suppliedFull ? billing.ruc : undefined,
        acknowledgeRucMismatch: ownedAcceptance || (accepted && pending?.kind === "ruc_mismatch") };
    },
  });
  const handlers = { ...createCartTools({ runtime, carts, calculatePricing, inspectData }),
    async datos_envio(args, context) { const result = await data.shipping(args, context); const progress = await inspectData(result.cart);
      context.signal?.throwIfAborted();
      return { ...result, lines: progress.lines, fields: progress.fields, pendientes: progress.pendientes }; },
    async datos_facturacion(args, context) {
      const result = await data.billing(args, context);
      context.signal?.throwIfAborted();
      const state = runtime.getState(); state.pendingRucConfirmation = result.pending ?? null;
      await runtime.setState(state);
      const { pending: _pending, ...publicResult } = result;
      const progress = await inspectData(result.cart);
      context.signal?.throwIfAborted();
      return { ...publicResult, lines: progress.lines, fields: progress.fields,
        pendientes: progress.pendientes, options: progress.options };
    },
    cotizar: (args, context) => quotes.quote(context, args),
  };
  return { carts, quotes,
    handlers: Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args, context = {}) => {
      try { return await handler(args, context); } catch (error) { context.signal?.throwIfAborted(); return purchaseError(error); }
    }])),
  };
}
