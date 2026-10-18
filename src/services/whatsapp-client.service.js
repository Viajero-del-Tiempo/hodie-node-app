import { createHash } from "node:crypto";
import { normalizePurchasePhone } from "../agents/consultation/order-access.js";
import { allowsAgentPhone, MESSAGE_ID_TTL_MS } from "../config/agent-whatsapp.config.js";

export const WHATSAPP_OWN_MESSAGES = "agent_whatsapp_own_messages";
const installed = new WeakMap();
export function readAlertsPhone(env = {}) {
  if (env.ALERTS_PHONE === undefined || env.ALERTS_PHONE === "") return null;
  const phone = normalizePurchasePhone(env.ALERTS_PHONE);
  if (!phone) throw new Error("ALERTS_PHONE debe ser un teléfono válido");
  return phone;
}
export function createOwnMessageRepository({ db, now = Date.now, timestampFromMillis = value => new Date(value) }) {
  const ref = id => db.collection(WHATSAPP_OWN_MESSAGES).doc(createHash("sha256").update(id).digest("hex"));
  return {
    async record(chatId, id) {
      await ref(id).set({ chatId, messageId: id, expiresAt: timestampFromMillis(now() + MESSAGE_ID_TTL_MS) });
    },
    async owns(chatId, id) {
      const doc = await ref(id).get(), value = doc.data();
      const expiry = value?.expiresAt?.toMillis?.() ?? new Date(value?.expiresAt).getTime();
      if (doc.exists && (!Number.isFinite(expiry) || typeof value.chatId !== "string" || value.messageId !== id)) {
        throw Object.assign(new Error("Registro propio inválido"), { code: "OWN_MESSAGE_RECORD_INVALID" });
      }
      // El mismo ID global puede llegar con PN o LID; no atribuir por dirección/texto.
      return doc.exists && expiry > now();
    },
  };
}

// Único punto de entrada a sendMessage, incluso para OTP/legacy. Nunca compara texto.
export function installWhatsAppClient({ client, repository, config, resolvePhone, alertsPhone }) {
  if (installed.has(client)) return installed.get(client);
  const original = client.sendMessage.bind(client), pending = new Map();
  client.sendMessage = function (chatId, content, options = {}) {
    let release;
    const settled = new Promise(resolve => { release = resolve; });
    const inFlight = pending.get(chatId) ?? new Set();
    const entry = { settled, error: null, phone: null }; inFlight.add(entry); pending.set(chatId, inFlight);
    let deliveryStarted = false;
    const send = (async () => {
      const { appOrigin, appSignal, ...providerOptions } = options;
      appSignal?.throwIfAborted();
      if (config.enabled) {
        const alert = appOrigin === "alert" && chatId === alertsPhone + "@c.us";
        if (alert) entry.phone = alertsPhone;
        else {
          try { entry.phone = normalizePurchasePhone(await resolvePhone(chatId, { sideEffectFree: true })); }
          catch (error) { if (config.maintenanceMode === "silent") throw error; }
          if (config.maintenanceMode === "silent" && !allowsAgentPhone(config, entry.phone)) throw Object.assign(new Error("Destino fuera de la lista del piloto"), { code: "WHATSAPP_OUTSIDE_ALLOWLIST", deliveryStarted: false });
        }
      }
      appSignal?.throwIfAborted();
      let result;
      try { deliveryStarted = true; result = await original(chatId, content, providerOptions); }
      catch (error) { throw Object.assign(new Error("Envío WhatsApp incierto"), { code: "SEND_UNCERTAIN", deliveryStarted: true, cause: error }); }
      const id = result?.id?._serialized;
      if (!id) throw Object.assign(new Error("Envío sin identificador"), { code: "SEND_UNCERTAIN", deliveryStarted: true });
      try { await repository.record(chatId, id); }
      catch (error) { throw Object.assign(new Error("Correlación de envío incierta"), { code: "OWN_MESSAGE_RECORD_FAILED", deliveryStarted: true, cause: error }); }
      return result;
    })();
    return send.catch(error => {
      if (error.deliveryStarted === undefined) error.deliveryStarted = deliveryStarted;
      entry.error = error; throw error;
    }).finally(() => {
      release(); inFlight.delete(entry); if (!inFlight.size) pending.delete(chatId);
    });
  };
  const control = {
    async owns(chatId, id, { phone = normalizePurchasePhone(chatId.replace(/@c\.us$/u, "")) } = {}) {
      if (!id) throw new Error("Saliente sin ID");
      const inFlight = [...new Set([...(pending.get(chatId) ?? []),
        ...[...pending.values()].flatMap(entries => [...entries].filter(entry => phone && entry.phone === phone))])];
      await Promise.all(inFlight.map(entry => entry.settled));
      if (await repository.owns(chatId, id)) return true;
      if (inFlight.some(entry => entry.error?.deliveryStarted !== false && entry.error)) {
        throw Object.assign(new Error("No se pudo decidir la autoría del saliente"), { code: "OWN_MESSAGE_CORRELATION_UNCERTAIN" });
      }
      return false;
    },
  };
  installed.set(client, control); return control;
}
