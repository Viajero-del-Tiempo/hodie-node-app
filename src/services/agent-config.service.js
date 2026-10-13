import { cartIssue } from "./cart.service.js";

export const AGENT_CONFIG_COLLECTION = "agent_config";
export const AGENT_CONFIG_ID = "conversation";

export function validateAgentConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw cartIssue("ARGUMENTOS_INVALIDOS", "body", "Indicá la configuración del agente.");
  for (const key of Object.keys(input)) if (!["corporateQuantityThreshold", "version"].includes(key)) {
    throw cartIssue("ARGUMENTOS_INVALIDOS", key, "Campo desconocido.");
  }
  if (!Number.isSafeInteger(input.corporateQuantityThreshold) || input.corporateQuantityThreshold < 1) {
    throw cartIssue("ARGUMENTOS_INVALIDOS", "corporateQuantityThreshold", "Ingresá un número entero positivo.");
  }
  if (input.version !== null && (typeof input.version !== "string" || !/^[a-f0-9]{64}$/u.test(input.version))) {
    throw cartIssue("ARGUMENTOS_INVALIDOS", "version", "Recargá la configuración antes de guardar.");
  }
  return { corporateQuantityThreshold: input.corporateQuantityThreshold, version: input.version };
}

export function requireAgentConfig(config) {
  if (!Number.isSafeInteger(config?.corporateQuantityThreshold) || config.corporateQuantityThreshold < 1) {
    throw cartIssue("CONFIGURACION_INCOMPLETA", "corporateQuantityThreshold", "Falta configurar el umbral de cantidad corporativa. Una persona del equipo puede ayudarte.");
  }
  return config;
}

export function assertCorporateQuantity(lines, config) {
  const { corporateQuantityThreshold: threshold } = requireAgentConfig(config);
  let totalUnits = 0;
  for (const line of lines ?? []) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw cartIssue("CANTIDAD_INVALIDA", "quantity", "La cantidad debe ser un entero positivo.");
    totalUnits += line.quantity;
    if (!Number.isSafeInteger(totalUnits)) throw cartIssue("CANTIDAD_INVALIDA", "quantity", "La cantidad total excede el rango permitido.");
  }
  if (totalUnits > threshold) throw Object.assign(cartIssue("CANTIDAD_CORPORATIVA", "quantity",
    "La cantidad total requiere atención del equipo. Ofrecé hablar con una persona; derivá cuando el cliente acepte."), { totalUnits, threshold });
  return { totalUnits, threshold };
}
