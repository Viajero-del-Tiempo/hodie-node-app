// Configuración exclusiva del agente nuevo. No modifica juez, audio ni grafo.
export const DEFAULT_AGENT_THINKING_BUDGET = 512;
export function parseAgentThinkingBudget(raw, source = "AGENT_THINKING_BUDGET") {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw
    : typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(source + " debe ser un entero no negativo seguro; omitilo para usar el valor por defecto de 512."),
      { code: "INVALID_AGENT_THINKING_BUDGET" });
  }
  // No se inventa un máximo común: el proveedor valida el rango del modelo.
  return value;
}

export function resolveAgentModelConfig({ env = process.env, thinkingBudget } = {}) {
  const override = thinkingBudget !== undefined;
  const source = override ? "override" : env.AGENT_THINKING_BUDGET !== undefined ? "env" : "default";
  const budget = parseAgentThinkingBudget(override ? thinkingBudget : env.AGENT_THINKING_BUDGET) ?? DEFAULT_AGENT_THINKING_BUDGET;
  return { options: { thinkingBudget: budget },
    thinking: { mode: "budget", thinkingBudget: budget, source } };
}
