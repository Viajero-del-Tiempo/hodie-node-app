export function createAgentConfigController(repository) {
  const action = operation => async (_req, res) => {
    try { await operation(_req, res); }
    catch (error) {
      if ([400, 409].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message, code: error.code, field: error.field });
      console.error("Error de configuración del agente:", error);
      return res.status(500).json({ error: "No pudimos procesar la configuración del agente." });
    }
  };
  return {
    get: action(async (_req, res) => res.json({ success: true, config: await repository.get() })),
    save: action(async (req, res) => res.json({ success: true, config: await repository.save(req.body) })),
  };
}
