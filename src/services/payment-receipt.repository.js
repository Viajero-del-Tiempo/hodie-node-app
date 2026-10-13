import { normalizePurchasePhone } from "../agents/consultation/order-access.js";
import { agentAlertId, prepareDurableAlert } from "./agent-alert.service.js";
import { cartIssue } from "./cart.service.js";

export const receiptOwned = (receipt, identity) => receipt.ownerChatId === identity.chatId
  || Boolean(identity.phone && normalizePurchasePhone(receipt.ownerPhone) === identity.phone);
export const receiptOrderOwned = (order, identity) => order.whatsappChatId === identity.chatId
  || Boolean(identity.phone && normalizePurchasePhone(order.userPhoneNumber) === identity.phone);
const unavailable = () => cartIssue("PEDIDO_NO_DISPONIBLE", "orderNumber", "No hay un pedido pendiente disponible con esos datos.");
export const receiptAcknowledgement = number => "Gracias, recibimos el comprobante del pedido #" + number + ". El equipo va a verificar el pago; el envío del comprobante no confirma el pago.";

export function createPaymentReceiptRepository({ db, now = Date.now, receiptsCollection = "payment_receipts", alertsCollection = "agent_alerts", newAlertId = agentAlertId }) {
  const receipts = db.collection(receiptsCollection), orders = db.collection("orders");
  const get = async id => { const doc = await receipts.doc(id).get(); return doc.exists ? { ...doc.data(), id } : null; };
  return {
    get,
    async reserve(value, { signal } = {}) {
      return db.runTransaction(async tx => {
        const ref = receipts.doc(value.id), doc = await tx.get(ref);
        signal?.throwIfAborted();
        if (doc.exists) return { receipt: { ...doc.data(), id: ref.id }, created: false };
        tx.create(ref, value); return { receipt: value, created: true };
      });
    },
    async ready(id, { signal } = {}) {
      return db.runTransaction(async tx => {
        const ref = receipts.doc(id), doc = await tx.get(ref), receipt = doc.data();
        signal?.throwIfAborted();
        if (doc.exists && ["unassigned", "associated"].includes(receipt.status)) return { ...receipt, id };
        if (!doc.exists || receipt.status !== "uploading" || receipt.expiresAt <= now()) throw cartIssue("COMPROBANTE_VENCIDO", "comprobanteId", "El comprobante venció; volvé a enviarlo.");
        tx.set(ref, { ...receipt, status: "unassigned" });
        return { ...receipt, status: "unassigned", id };
      });
    },
    async pendingOrders(identity) {
      const snapshots = [await orders.where("whatsappChatId", "==", identity.chatId).get()];
      if (identity.phone) snapshots.push(await orders.where("userPhoneNumber", "in", [identity.phone, "0" + identity.phone.slice(3), identity.phone.slice(3)]).get());
      return [...new Map(snapshots.flatMap(snapshot => snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })))
        .filter(order => order.status === "pending" && receiptOrderOwned(order, identity)).map(order => [order.id, order])).values()];
    },
    async orderByNumber(number) {
      const snapshot = await orders.where("orderNumber", "==", number).limit(2).get();
      return snapshot.docs.length === 1 ? { ...snapshot.docs[0].data(), id: snapshot.docs[0].id } : null;
    },
    async associate(id, orderId, identity, { signal } = {}) {
      return db.runTransaction(async tx => {
        const ref = receipts.doc(id), orderRef = orders.doc(orderId);
        const receiptDoc = await tx.get(ref), orderDoc = await tx.get(orderRef);
        const receipt = receiptDoc.data(), order = orderDoc.data();
        if (!receiptDoc.exists || !receiptOwned(receipt, identity)) throw cartIssue("COMPROBANTE_NO_DISPONIBLE", "comprobanteId", "El comprobante no está disponible.");
        if (!orderDoc.exists || order.status !== "pending" || !receiptOrderOwned(order, identity)) throw unavailable();
        if (receipt.status === "associated" && receipt.orderId !== orderId) throw cartIssue("COMPROBANTE_YA_ASOCIADO", "comprobanteId", "Ese comprobante ya está asociado a otro pedido.");
        if (!["unassigned", "associated"].includes(receipt.status) || (receipt.status !== "associated" && receipt.expiresAt <= now())) {
          throw cartIssue("COMPROBANTE_VENCIDO", "comprobanteId", "El comprobante no está disponible; volvé a enviarlo.");
        }
        // Una selección desde otro chat del mismo teléfono no abre otro episodio.
        const alertChatId = receipt.acknowledgementChatId ?? identity.chatId;
        const alertId = newAlertId(alertChatId, "PAYMENT_RECEIPT", id);
        const commitAlert = await prepareDurableAlert(tx, db.collection(alertsCollection).doc(alertId), {
          id: alertId, type: "PAYMENT_RECEIPT", chatId: alertChatId, episodeId: id,
          receiptId: id, orderId,
          createdAt: now(), delivered: false, reason: "Comprobante pendiente de verificación manual",
          context: { orderNumber: order.orderNumber, filename: receipt.filename },
        });
        signal?.throwIfAborted();
        if (receipt.status !== "associated") tx.set(ref, { ...receipt, status: "associated", orderId,
          orderNumber: order.orderNumber, associatedAt: now(), expiresAt: null, acknowledgementChatId: identity.chatId, acknowledgementDelivered: false });
        commitAlert(); // El documento del pedido nunca se escribe.
        return { id, orderId, orderNumber: order.orderNumber, alreadyAssociated: receipt.status === "associated" };
      });
    },
    async listUnassigned(chatId) {
      const snapshot = await receipts.where("ownerChatId", "==", chatId).where("status", "==", "unassigned").get();
      return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter(value => value.expiresAt > now());
    },
    async unacknowledged(chatId) {
      const snapshot = await receipts.where("acknowledgementChatId", "==", chatId).where("status", "==", "associated").where("acknowledgementDelivered", "==", false).get();
      return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })).sort((a, b) => a.associatedAt - b.associatedAt || a.id.localeCompare(b.id));
    },
    async markAcknowledged(id) {
      await db.runTransaction(async tx => { const ref = receipts.doc(id), doc = await tx.get(ref);
        if (doc.exists && doc.data().status === "associated") tx.set(ref, { ...doc.data(), acknowledgementDelivered: true }); });
    },
    async listForOrder(orderId) {
      const snapshot = await receipts.where("orderId", "==", orderId).where("status", "==", "associated").get();
      return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })).sort((a, b) => b.associatedAt - a.associatedAt || a.id.localeCompare(b.id));
    },
    async expired() {
      const snapshot = await receipts.where("status", "in", ["uploading", "unassigned", "deleting"]).where("expiresAt", "<=", now()).limit(100).get();
      return snapshot.docs.map(doc => doc.id);
    },
    async claimDelete(id, { signal } = {}) {
      return db.runTransaction(async tx => { const ref = receipts.doc(id), doc = await tx.get(ref), receipt = doc.data();
        if (!doc.exists || !["uploading", "unassigned", "deleting"].includes(receipt.status) || receipt.expiresAt > now()) return null;
        signal?.throwIfAborted(); tx.set(ref, { ...receipt, status: "deleting" }); return { ...receipt, id }; });
    },
    async finishDelete(id, publicId, { signal } = {}) {
      await db.runTransaction(async tx => { const ref = receipts.doc(id), doc = await tx.get(ref);
        signal?.throwIfAborted(); if (doc.exists && doc.data().status === "deleting" && doc.data().asset.publicId === publicId) tx.delete(ref); });
    },
  };
}
