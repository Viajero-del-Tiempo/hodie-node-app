import { catalogService } from "../services/catalog.service.js";
import { CatalogError } from "../validators/catalog.validator.js";

export function createProductController(service = catalogService) {
  const action = operation => async (req, res) => {
    try { return await operation(req, res); }
    catch (error) {
      if (error instanceof CatalogError) return res.status(error.status).json({
        error: error.message, field: error.field,
        ...(error.code ? { code: error.code } : {}),
        ...(error.changes ? { changes: error.changes } : {}),
      });
      console.error("Error en CRUD de productos:", error);
      return res.status(500).json({ error: "Error procesando el producto" });
    }
  };
  return {
    list: action(async (_req, res) => res.json({ success: true, products: await service.listAdminProducts() })),
    get: action(async (req, res) => {
      const product = await service.getAdminProduct(req.params.id);
      if (!product) throw new CatalogError("id", "Producto no encontrado", 404);
      return res.json({ success: true, product });
    }),
    create: action(async (req, res) => res.status(201).json({ success: true, product: await service.createProduct(req.body) })),
    update: action(async (req, res) => res.json({
      success: true, product: await service.updateProduct(req.params.id, req.body, { patch: req.method === "PATCH" }),
    })),
    deactivate: action(async (req, res) => {
      if (req.query.force === "true") throw new CatalogError("force", "Los productos se desactivan; no se eliminan");
      return res.json({ success: true, softDeleted: true, product: await service.deactivateProduct(req.params.id, req.body) });
    }),
    reactivate: action(async (req, res) => res.json({
      success: true, product: await service.reactivateProduct(req.params.id, req.body),
    })),
  };
}
export const productController = createProductController();
