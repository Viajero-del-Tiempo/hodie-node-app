export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
function duration(env, name, fallback, min, max) {
  const raw = env[name] === undefined ? fallback : env[name], value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + " fuera de rango (" + min + ".." + max + " ms)");
  return value;
}
export function createPaymentReceiptConfig(env = {}) {
  return Object.freeze({
    unassignedTtlMs: duration(env, "AGENT_RECEIPT_UNASSIGNED_TTL_MS", 6 * 60 * 60 * 1000, 60000, 7 * DAY_MS),
    associatedRetentionMs: duration(env, "AGENT_RECEIPT_ASSOCIATED_RETENTION_MS", 30 * DAY_MS, DAY_MS, 365 * DAY_MS),
    retentionCleanupIntervalMs: duration(env, "AGENT_RECEIPT_RETENTION_CLEANUP_INTERVAL_MS", DAY_MS, 60000, 7 * DAY_MS),
  });
}
