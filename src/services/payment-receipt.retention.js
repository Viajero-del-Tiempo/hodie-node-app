import { COMMITTED_STOCK_STATUSES } from "./order-stock.service.js";

function milliseconds(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return typeof value === "number" ? value : NaN;
}

// La fecha de verificación nunca se deduce de updatedAt, del nombre del archivo
// ni de su contenido. Un histórico sin fecha fiable requiere revisión humana.
export function associatedReceiptRetention(receipt, order, { now, retentionMs }) {
  if (!order) return { blocked: "RETENTION_ORDER_MISSING" };
  const verifiedAt = milliseconds(order.paymentVerifiedAt);
  let base;
  if (Number.isFinite(verifiedAt)) base = verifiedAt;
  else if (order.paymentVerifiedAt != null || COMMITTED_STOCK_STATUSES.includes(order.status)) {
    return { blocked: "RETENTION_VERIFICATION_DATE_MISSING" };
  } else if (["pending", "cancelled"].includes(order.status)) base = milliseconds(receipt.createdAt);
  else return { blocked: "RETENTION_ORDER_STATUS_UNKNOWN" };
  if (!Number.isFinite(base)) return { blocked: "RETENTION_UPLOAD_DATE_MISSING" };
  return { expired: now >= base + retentionMs, expiresAt: base + retentionMs,
    basis: Number.isFinite(verifiedAt) ? "payment_verified" : "uploaded" };
}
