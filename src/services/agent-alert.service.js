import { fingerprint } from "./cart.service.js";

export function agentAlertId(chatId, type, episodeId) { return fingerprint([chatId, type, episodeId]); }

// Compartido también con las alertas de PDF. Se lee antes de escribir y nunca
// se reinicia una solicitud ya acusada como entregada por el transporte.
export async function prepareDurableAlert(tx, ref, alert) {
  const existing = await tx.get(ref);
  return () => { if (!existing.exists) tx.create(ref, alert); return existing.exists ? existing.data() : alert; };
}

export function createAgentAlertService({ repository }) {
  if (typeof repository?.request !== "function") throw new Error("Falta el repositorio durable de alertas.");
  return {
    async request(alert, { signal } = {}) {
      signal?.throwIfAborted();
      if (!alert?.id || !alert.type || !alert.chatId) throw new Error("Solicitud de alerta incompleta.");
      const result = await repository.request({ ...structuredClone(alert), delivered: false }, { signal });
      signal?.throwIfAborted();
      return result;
    },
  };
}

// El checkpoint es también una bandeja de recuperación: se guarda antes del
// repositorio. Repetir la solicitud no duplica ni reinicia una alerta entregada.
export async function synchronizeAgentAlerts(runtime, { signal } = {}) {
  for (const entry of runtime.getState().guardianAlerts ?? []) {
    signal?.throwIfAborted();
    const alert = { ...entry, chatId: entry.chatId ?? runtime.getState().whatsappChatId };
    if (!entry.delivered) {
      if (!runtime.alerts?.request) throw new Error("Falta el puerto durable de alertas.");
      await runtime.alerts.request(alert, { signal });
    }
    const state = runtime.getState();
    if (alert.handoff && state.humanHandoffRequired && state.handoffEpisodeId === alert.episodeId && runtime.handoffs?.upsert) {
      const current = await runtime.handoffs.get?.(alert.chatId);
      signal?.throwIfAborted();
      // Una reactivación del mismo episodio o un mensaje más reciente no se
      // sobrescriben al recuperar la bandeja. Solo reparar el índice ausente.
      if (!current || current.episodeId !== alert.episodeId) await runtime.handoffs.upsert(alert.chatId, alert.handoff);
    }
  }
}
