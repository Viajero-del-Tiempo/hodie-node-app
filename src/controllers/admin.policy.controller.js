import { catalogService } from "../services/catalog.service.js";
import { CatalogError } from "../validators/catalog.validator.js";

function handleError(res, error) {
  if (error instanceof CatalogError) return res.status(error.status).json({ error: error.message, field: error.field });
  console.error("Error en CRUD de políticas:", error);
  return res.status(500).json({ error: "Error procesando la política" });
}

export function createPolicyController(service = catalogService) {
  const action = operation => async (req, res) => {
    try { return await operation(req, res); } catch (error) { return handleError(res, error); }
  };
  return {
    list: action(async (_req, res) => res.json({ success: true, policies: await service.listPolicies() })),
    get: action(async (req, res) => {
      const policy = await service.getPolicy(req.params.id);
      if (!policy) throw new CatalogError("id", "Política no encontrada", 404);
      return res.json({ success: true, policy });
    }),
    create: action(async (req, res) => res.status(201).json({ success: true, policy: await service.createPolicy(req.body) })),
    update: action(async (req, res) => res.json({ success: true, policy: await service.updatePolicy(req.params.id, req.body) })),
    delete: action(async (req, res) => {
      await service.deletePolicy(req.params.id);
      return res.json({ success: true });
    }),
  };
}

export const policyController = createPolicyController();
