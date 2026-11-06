import { catalogService } from "../services/catalog.service.js";
import { CatalogError } from "../validators/catalog.validator.js";

function numberParameter(raw, field, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) throw new CatalogError(field, "Debe ser un entero positivo");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new CatalogError(field, "Valor fuera del rango permitido");
  return value;
}

export function createCatalogController(service = catalogService) {
  const action = operation => async (req, res) => {
    try { return await operation(req, res); }
    catch (error) {
      if (error instanceof CatalogError) return res.status(error.status).json({ error: error.message, field: error.field });
      console.error("Error leyendo el catálogo:", error);
      return res.status(500).json({ error: "No se pudo cargar el catálogo" });
    }
  };
  return {
    categories: action(async (_req, res) => res.json({ categories: await service.getCategories() })),
    products: action(async (req, res) => {
      const page = numberParameter(req.query.page, "page", 1);
      const pageSize = numberParameter(req.query.pageSize, "pageSize", 12, 100);
      const sort = req.query.sort ?? "relevance";
      if (!["relevance", "price-asc", "price-desc", "name-asc"].includes(sort)) throw new CatalogError("sort", "Orden inválido");
      if (req.query.onlyAvailable !== undefined && !["true", "false"].includes(req.query.onlyAvailable)) throw new CatalogError("onlyAvailable", "Debe ser true o false");
      const products = await service.searchProducts({
        query: req.query.query ?? "", categoryId: req.query.categoryId,
        onlyAvailable: req.query.onlyAvailable === "true", limit: Number.MAX_SAFE_INTEGER,
      });
      if (sort === "price-asc") products.sort((a, b) => a.priceFrom - b.priceFrom || a.id.localeCompare(b.id));
      if (sort === "price-desc") products.sort((a, b) => b.priceFrom - a.priceFrom || a.id.localeCompare(b.id));
      if (sort === "name-asc") products.sort((a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id));
      const start = (page - 1) * pageSize;
      if (!Number.isSafeInteger(start)) throw new CatalogError("page", "Página fuera del rango permitido");
      return res.json({ products: products.slice(start, start + pageSize), total: products.length, page, pageSize });
    }),
    bySlug: action(async (req, res) => {
      const product = await service.getProductBySlug(req.params.slug);
      if (!product) return res.status(404).json({ error: "Este producto ya no está disponible", field: "slug" });
      return res.json({ product });
    }),
    byId: action(async (req, res) => {
      const product = await service.getProduct(req.params.id);
      if (!product) return res.status(404).json({ error: "Este producto ya no está disponible", field: "productId" });
      return res.json({ product });
    }),
  };
}
