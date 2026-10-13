export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export function createPaymentReceiptConfig(env = {}) {
  const raw = env.AGENT_RECEIPT_UNASSIGNED_TTL_MS ?? 6 * 60 * 60 * 1000;
  const unassignedTtlMs = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (!Number.isSafeInteger(unassignedTtlMs) || unassignedTtlMs < 60000 || unassignedTtlMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("AGENT_RECEIPT_UNASSIGNED_TTL_MS fuera de rango (1 minuto..7 días)");
  }
  return Object.freeze({ unassignedTtlMs });
}
