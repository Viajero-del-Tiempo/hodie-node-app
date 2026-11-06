import { randomUUID } from "node:crypto";
export const RATE_LIMIT_NOTICE = "Estoy recibiendo muchos mensajes seguidos y tengo que hacer una pausa. Escribime de nuevo en un rato y seguimos.";
export function admitBatch(state, now, config) {
  const next = structuredClone(state);
  const previous = next.guardianRateLimit ?? { admittedAt: [], blocked: false, episodeId: null };
  const admittedAt = previous.admittedAt.filter(time => Number.isFinite(time) && time > now - config.windowMs);
  if (admittedAt.length >= config.turnsPerHour) {
    const firstBlocked = !previous.blocked;
    const episodeId = previous.episodeId ?? randomUUID();
    next.guardianRateLimit = { admittedAt, blocked: true, episodeId };
    if (firstBlocked) {
      next.guardianAlerts = [...(next.guardianAlerts ?? []), {
        id: episodeId, type: "TURN_LIMIT", createdAt: now, limit: config.turnsPerHour,
        windowMs: config.windowMs, delivered: false,
      }];
    }
    return { state: next, allowed: false, sendNotice: firstBlocked, episodeId };
  }
  next.guardianRateLimit = { admittedAt: [...admittedAt, now], blocked: false, episodeId: null };
  return { state: next, allowed: true, sendNotice: false, episodeId: null };
}
// Solo el futuro receptor whatsapp.js acusa entrega tras enviar la alerta.
export function acknowledgeGuardianAlert(state, id) {
  return { ...structuredClone(state), guardianAlerts: (state.guardianAlerts ?? []).map(alert =>
    alert.id === id ? { ...alert, delivered: true } : structuredClone(alert)) };
}
