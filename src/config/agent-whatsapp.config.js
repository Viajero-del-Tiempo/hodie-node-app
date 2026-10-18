import { normalizePurchasePhone } from "../agents/consultation/order-access.js";

export const MESSAGE_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const WHATSAPP_SEND_PAUSE_MS = 500;
export const DEFAULT_MAINTENANCE_MESSAGE = "¡Hola! Estamos renovando nuestra tienda y volvemos muy pronto. Gracias por escribirnos 🎁";

export function createAgentWhatsAppConfig(env = {}) {
  const raw = env.AGENT_ENABLED ?? "false";
  if (![true, false, "true", "false", "1", "0"].includes(raw)) throw new Error("AGENT_ENABLED debe ser true o false");
  const enabled = [true, "true", "1"].includes(raw);
  const maintenanceMode = env.AGENT_MAINTENANCE_MODE === undefined ? "message" : env.AGENT_MAINTENANCE_MODE;
  if (!["message", "silent"].includes(maintenanceMode)) throw new Error("AGENT_MAINTENANCE_MODE debe ser message o silent");
  if (maintenanceMode === "silent" && !enabled) throw new Error("AGENT_MAINTENANCE_MODE=silent exige AGENT_ENABLED=true y AGENT_ALLOWLIST definida y no vacía");
  // Apagado: salvo la validación del modo, las otras variables no alteran el camino legacy.
  if (!enabled) return Object.freeze({ enabled: false, allowlist: null });
  let allowlist = null;
  if (Object.hasOwn(env, "AGENT_ALLOWLIST")) {
    if (typeof env.AGENT_ALLOWLIST !== "string") throw new Error("AGENT_ALLOWLIST debe ser una lista de teléfonos");
    const entries = env.AGENT_ALLOWLIST.trim() ? env.AGENT_ALLOWLIST.split(",").map(value => value.trim()) : [];
    const phones = entries.map(value => normalizePurchasePhone(value));
    if (phones.some(value => value === null)) throw new Error("AGENT_ALLOWLIST contiene un teléfono inválido; no acepta LID");
    allowlist = Object.freeze([...new Set(phones)]);
  }
  if (maintenanceMode === "silent" && !allowlist?.length) throw new Error("AGENT_MAINTENANCE_MODE=silent exige AGENT_ENABLED=true y AGENT_ALLOWLIST definida y no vacía");
  const maintenanceMessage = env.AGENT_MAINTENANCE_MESSAGE ?? DEFAULT_MAINTENANCE_MESSAGE;
  if (typeof maintenanceMessage !== "string" || !maintenanceMessage.trim() || maintenanceMessage.length > 4000) {
    throw new Error("AGENT_MAINTENANCE_MESSAGE debe ser texto no vacío de hasta 4000 caracteres");
  }
  return Object.freeze({ enabled, allowlist, maintenanceMode, maintenanceMessage });
}

export function allowsAgentPhone(config, phone) {
  return config.enabled && (config.allowlist === null || config.allowlist.includes(normalizePurchasePhone(phone)));
}
