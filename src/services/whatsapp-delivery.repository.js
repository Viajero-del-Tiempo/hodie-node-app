import { createHash, randomUUID } from "node:crypto";
import { MESSAGE_ID_TTL_MS, MAINTENANCE_INTERVAL_MS } from "../config/agent-whatsapp.config.js";

const key = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const millis = value => value instanceof Date ? value.getTime() : value?.toMillis?.();
export const WHATSAPP_INBOX_COLLECTION = "agent_whatsapp_messages";
export const WHATSAPP_OUTBOX_COLLECTION = "agent_whatsapp_deliveries";
export const WHATSAPP_MAINTENANCE_COLLECTION = "agent_whatsapp_maintenance";

// Solo metadatos: no persiste texto, bytes, teléfonos escritos ni prompts.
export function createWhatsAppDeliveryRepository({ db, timestampFromMillis, now = Date.now, newId = randomUUID }) {
  const ref = (collection, id) => db.collection(collection).doc(id);
  return {
    async claimMessage(chatId, messageId) {
      if (typeof chatId !== "string" || !chatId || typeof messageId !== "string" || !messageId) throw Object.assign(new Error("Mensaje sin ID estable"), { code: "MESSAGE_ID_REQUIRED" });
      const id = key([chatId, messageId]), doc = ref(WHATSAPP_INBOX_COLLECTION, id);
      return db.runTransaction(async tx => {
        const snapshot = await tx.get(doc), time = now();
        if (snapshot.exists) {
          const expiry = millis(snapshot.data().expiresAt);
          if (!Number.isFinite(expiry)) throw Object.assign(new Error("Registro de mensaje sin vencimiento válido"), { code: "MESSAGE_RECORD_INVALID" });
          if (expiry > time) return null;
        }
        tx.set(doc, { chatId, messageId, status: "received", receivedAt: timestampFromMillis(time),
          expiresAt: timestampFromMillis(time + MESSAGE_ID_TTL_MS) });
        return id;
      });
    },
    async finishMessage(id, status) { await ref(WHATSAPP_INBOX_COLLECTION, id).update({ status, finishedAt: timestampFromMillis(now()) }); },
    async claimMaintenance(chatId) {
      const doc = ref(WHATSAPP_MAINTENANCE_COLLECTION, key([chatId]));
      return db.runTransaction(async tx => {
        const snapshot = await tx.get(doc), time = now();
        if (snapshot.exists) {
          const next = millis(snapshot.data().nextAllowedAt);
          if (!Number.isFinite(next)) throw Object.assign(new Error("Reserva de mantenimiento inválida"), { code: "MAINTENANCE_RECORD_INVALID" });
          if (next > time) return false;
        }
        // Reserva antes de enviar: una entrega incierta no abre otro intento.
        tx.set(doc, { chatId, attemptedAt: timestampFromMillis(time), nextAllowedAt: timestampFromMillis(time + MAINTENANCE_INTERVAL_MS) });
        return true;
      });
    },
    async beginOutgoing(chatId, { type, origin }) {
      const id = newId(), time = now();
      await ref(WHATSAPP_OUTBOX_COLLECTION, id).create({ chatId, type, origin, own: true, status: "sending",
        whatsappMessageId: null, createdAt: timestampFromMillis(time), expiresAt: timestampFromMillis(time + MESSAGE_ID_TTL_MS) });
      return id;
    },
    async finishOutgoing(id, { status, whatsappMessageId = null, code = null }) {
      await ref(WHATSAPP_OUTBOX_COLLECTION, id).update({ status, whatsappMessageId, code, updatedAt: timestampFromMillis(now()) });
    },
  };
}
