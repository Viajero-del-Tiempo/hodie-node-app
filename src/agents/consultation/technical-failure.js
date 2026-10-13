import { randomUUID } from "node:crypto";

export const TECHNICAL_FAILURE_NOTICE = "Perdón, tuve un inconveniente para responderte. ¿Me lo escribís de nuevo?";
export const TECHNICAL_HANDOFF_MESSAGE = "No pude continuar con la consulta. Una persona del equipo te va a responder por este chat.";

export async function resetTechnicalFailures({ getState, setState }, { signal } = {}) {
  signal?.throwIfAborted();
  const state = getState();
  if (!(state.consecutiveTechnicalFailures > 0) && !state.lastTechnicalFailure) return;
  state.consecutiveTechnicalFailures = 0;
  state.lastTechnicalFailure = null;
  await setState(state);
  signal?.throwIfAborted();
}

// Una falla se registra antes del envío. Agente y guardián comparten el ID del
// lote: un error al cerrar no cuenta dos veces ni duplica aviso/alerta.
export async function handleTechnicalFailure(runtime, code, { signal, turnId, lastMessage,
  now = runtime.now?.() ?? Date.now() } = {}) {
  signal?.throwIfAborted();
  const state = runtime.getState();
  if (typeof turnId !== "string" || !turnId) throw new Error("La falla técnica necesita el ID del lote.");
  if (state.humanHandoffRequired || (state.lastTechnicalFailure && state.lastTechnicalFailure.turnId === turnId)) return { alreadyHandled: true };
  const previous = Number.isSafeInteger(state.consecutiveTechnicalFailures) && state.consecutiveTechnicalFailures > 0
    ? state.consecutiveTechnicalFailures : 0;
  state.consecutiveTechnicalFailures = Math.min(previous + 1, 2);
  const escalate = state.consecutiveTechnicalFailures === 2;
  state.lastTechnicalFailure = { turnId, code, createdAt: now, escalated: escalate };
  // El aviso pregunta por otro mensaje, no por la compra ni por texto/RUC.
  // Se preservan los borradores; se invalida solamente la autorización.
  state.lastQuote = null;
  state.pendingOrderConfirmation = null;
  if (state.pendingTextConfirmation) state.pendingTextConfirmation.shown = false;
  if (state.pendingRucConfirmation) state.pendingRucConfirmation.shown = false;
  const reason = "Falla técnica: " + code;
  if (escalate) {
    state.humanHandoffRequired = true;
    state.humanHandoffReason = reason;
    state.guardianAlerts = [...(state.guardianAlerts ?? []), { id: randomUUID(), type: "TECHNICAL_FAILURE",
      chatId: state.whatsappChatId, reason, createdAt: now, consecutiveFailures: 2, delivered: false }];
  }
  await runtime.setState(state);
  signal?.throwIfAborted();
  if (escalate) await runtime.handoffs?.upsert?.(state.whatsappChatId, { active: true,
    thread_id: state.whatsappChatId, whatsappChatId: state.whatsappChatId,
    userPhoneNumber: state.userPhoneNumber ?? "", pushname: state.pushname ?? "", motivo: reason,
    lastCustomerMessage: (lastMessage ?? runtime.getTurnContext?.()?.messages?.at(-1)?.text ?? "").slice(0, 200), updatedAt: now });
  signal?.throwIfAborted();
  // Solo whatsapp.js despachará guardianAlerts y marcará delivered.
  await runtime.transport.sendText(escalate ? TECHNICAL_HANDOFF_MESSAGE : TECHNICAL_FAILURE_NOTICE);
  signal?.throwIfAborted();
  return { escalated: escalate };
}
