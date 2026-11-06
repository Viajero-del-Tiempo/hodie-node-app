// Paridad con el receptor actual; el filtro viejo se elimina al activar este.
// No importar config/whatsapp.js: inicia el cliente.
export const ALLOWED_MESSAGE_TYPES = new Set(["chat", "image", "document", "audio", "video", "sticker", "ptt", "location"]);
export function acceptsMessage(message) {
  if (!message || message.fromMe || typeof message.from !== "string" || !message.from
      || message.from === "0@c.us" || message.from.endsWith("@g.us") || message.from === "status@broadcast") return false;
  if (!ALLOWED_MESSAGE_TYPES.has(message.type || "chat")) return false;
  return Boolean(message.body || message.hasMedia || message.type === "location");
}
export function createMessageDeduplicator(windowMs) {
  const seen = new Map();
  return { accept(id, now) {
    for (const [key, timestamp] of seen) if (timestamp <= now - windowMs) seen.delete(key);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.set(id, now);
    return true;
  }, clear: () => seen.clear() };
}
