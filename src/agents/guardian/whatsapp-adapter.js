import { randomUUID } from "node:crypto";
import { acceptsMessage } from "./filters.js";
import { normalizePurchasePhone } from "../consultation/order-access.js";

// Adaptador dormido: no importa el cliente, no registra listeners de mensajes
// y no cambia el receptor actual. whatsapp.js lo conectará en la puesta en marcha.
export function createWhatsAppAdapter({ chatId, resolvePhone, sendText, sendImage, processEvents = null }) {
  if (!chatId || typeof resolvePhone !== "function" || typeof sendText !== "function") throw new Error("Adaptador WhatsApp incompleto");
  const attachments = new Map();
  let guardian = null;
  let lastContactMessage = null;
  let closed = false;
  const shutdown = () => {
    closed = true;
    guardian?.shutdown();
    attachments.clear();
    processEvents?.off("SIGINT", shutdown);
    processEvents?.off("SIGTERM", shutdown);
  };
  return {
    bindGuardian(value) {
      if (guardian) throw new Error("Guardián ya conectado");
      guardian = value;
      processEvents?.on("SIGINT", shutdown);
      processEvents?.on("SIGTERM", shutdown);
    },
    async resolveIdentity({ signal } = {}) {
      signal?.throwIfAborted();
      const resolved = await resolvePhone(chatId);
      signal?.throwIfAborted();
      let pushname = lastContactMessage?._data?.notifyName ?? "";
      try {
        const contact = await lastContactMessage?.getContact?.();
        signal?.throwIfAborted();
        pushname = contact?.pushname ?? contact?.name ?? pushname;
      } catch { signal?.throwIfAborted(); }
      const phone = normalizePurchasePhone(resolved);
      return { userPhoneNumber: phone, phoneVerified: phone !== null, pushname: typeof pushname === "string" ? pushname : "" };
    },
    receive(message) {
      if (closed || !guardian) throw new Error("Adaptador no disponible");
      if (!acceptsMessage(message)) return Promise.resolve({ guardian: { outcome: "filtered" } });
      if (message.from !== chatId) throw new Error("Mensaje de otro chat");
      lastContactMessage = message;
      let attachment;
      if (message.hasMedia) {
        const id = randomUUID();
        attachment = { id, type: message.type, mode: "file", filename: message._data?.filename ?? null,
          mimeType: message._data?.mimetype ?? "", durationSeconds: message.duration ?? null,
          size: message._data?.size ?? message._data?.fileLength ?? null };
        attachments.set(id, { metadata: attachment, message });
      }
      const result = guardian.receive({ from: chatId, fromMe: message.fromMe,
        id: message.id?._serialized ?? null, type: message.type || "chat", body: message.body || "[" + message.type + " adjunto]",
        hasMedia: message.hasMedia, attachment });
      return Promise.resolve(result).finally(() => { if (attachment) attachments.delete(attachment.id); });
    },
    getAttachment(id) {
      const entry = attachments.get(id);
      if (closed || !entry) return null;
      return { ...entry.metadata, load: async ({ signal } = {}) => {
        signal?.throwIfAborted();
        const media = await entry.message.downloadMedia();
        signal?.throwIfAborted();
        if (closed || !attachments.has(id)) throw new Error("Adjunto fuera del turno");
        return media?.data ? { data: Buffer.from(media.data, "base64"), mimeType: media.mimetype } : null;
      } };
    },
    sendText: text => { if (closed) throw new Error("Transporte cerrado"); return sendText(chatId, text); },
    sendImage: value => { if (closed) throw new Error("Transporte cerrado"); return sendImage(chatId, value); },
    shutdown,
  };
}
