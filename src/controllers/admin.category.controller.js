import { catalogService } from "../services/catalog.service.js";
import { CatalogError } from "../validators/catalog.validator.js";

function handleError(res, error) {
  if (error instanceof CatalogError) return res.status(error.status).json({ error: error.message, field: error.field });
  console.error("Error en CRUD de categorías:", error);
  return res.status(500).json({ error: "Error procesando la categoría" });
}

export function createCategoryController(service = catalogService) {
  const action = operation => async (req, res) => {
    try { return await operation(req, res); } catch (error) { return handleError(res, error); }
  };
  return {
    list: action(async (_req, res) => res.json({ success: true, categories: await service.listCategories() })),
    get: action(async (req, res) => {
      const category = await service.getCategory(req.params.id);
      if (!category) throw new CatalogError("id", "Categoría no encontrada", 404);
      return res.json({ success: true, category });
    }),
    create: action(async (req, res) => res.status(201).json({ success: true, category: await service.createCategory(req.body) })),
    update: action(async (req, res) => res.json({ success: true, category: await service.updateCategory(req.params.id, req.body) })),
    deactivate: action(async (req, res) => res.json({ success: true, category: await service.deactivateCategory(req.params.id), softDeleted: true })),
  };
}

export const categoryController = createCategoryController();
