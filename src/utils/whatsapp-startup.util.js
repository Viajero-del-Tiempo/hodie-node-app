import { randomUUID } from "node:crypto";

export function createWhatsAppRuntimeLogger(config, { pid = process.pid, startedAt = Date.now(), bootId = randomUUID(),
  logger = value => console.info(JSON.stringify(value)) } = {}) {
  const agent = { enabled: config.enabled, maintenanceMode: config.maintenanceMode ?? "message",
    allowlistDefined: config.allowlist !== null, allowlistCount: config.allowlist === null ? null : config.allowlist.length };
  return value => logger(value.event === "whatsapp_connection" && value.code === "WHATSAPP_READY"
    ? { ...value, pid, startedAt, bootId, agent } : value);
}
