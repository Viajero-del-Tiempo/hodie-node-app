export function prepareSession(state, now, config, { newSession = false } = {}) {
  if (!Number.isFinite(now)) throw new Error("Hora del turno inválida");
  const next = structuredClone(state);
  const resumeRequested = Number.isFinite(next.resumeRequestedAt) && next.resumeRequestedAt !== next.resumeAppliedAt;
  // Un flag de sesión o el tiempo nunca reactiva una derivación.
  if (next.humanHandoffRequired) return { state: next, newSession: false };
  const expired = Number.isFinite(next.lastActivityAt) && now - next.lastActivityAt > config.sessionMs;
  const starts = newSession || resumeRequested || expired;
  if (starts) {
    next.sessionCutoff = next.messages.length;
    next.consecutiveMisunderstandings = 0;
    next.lastQuote = null;
    if (resumeRequested) next.resumeAppliedAt = next.resumeRequestedAt;
  }
  return { state: next, newSession: starts };
}
export function sessionHistory(state) {
  return state.messages.slice(state.sessionCutoff ?? 0).filter(message =>
    ["user", "assistant"].includes(message.role) && typeof message.content === "string").slice(-20);
}
