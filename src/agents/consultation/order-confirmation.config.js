// Vocabulario del idioma. No contiene datos ni condiciones del negocio.
export const DEFAULT_ORDER_AFFIRMATIONS = Object.freeze([
  "sí", "sí confirmo", "confirmo", "dale", "listo", "ok", "okay", "de acuerdo",
  "sí está bien", "está bien", "acepto", "correcto", "tal cual",
]);
export const DEFAULT_ORDER_NEUTRAL_ADDITIONS = Object.freeze(["gracias", "por favor", "perfecto", "genial", "el pedido"]);
export const normalizeConfirmationWords = text => text.normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
  .toLowerCase().replace(/\p{P}/gu, " ").replace(/\s+/gu, " ").trim();

function phrases(raw, fallback, source) {
  let values = raw === undefined ? fallback : raw;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch { values = null; }
  }
  if (!Array.isArray(values) || !values.length || values.length > 100
      || values.some(value => typeof value !== "string" || value.length > 100
        || !/^[\p{L}\p{M}\s]+$/u.test(value) || !normalizeConfirmationWords(value))) {
    throw Object.assign(new Error(source + " debe ser un arreglo JSON de afirmaciones o agregados completos, sin patrones ni signos."),
      { code: "INVALID_ORDER_CONFIRMATION_CONFIG" });
  }
  return [...new Set(values.map(normalizeConfirmationWords))];
}

export function createOrderConfirmationConfig(env = process.env) {
  return Object.freeze({
    affirmations: phrases(env.AGENT_ORDER_AFFIRMATIONS, DEFAULT_ORDER_AFFIRMATIONS, "AGENT_ORDER_AFFIRMATIONS"),
    neutralAdditions: phrases(env.AGENT_ORDER_NEUTRAL_ADDITIONS, DEFAULT_ORDER_NEUTRAL_ADDITIONS, "AGENT_ORDER_NEUTRAL_ADDITIONS"),
  });
}
