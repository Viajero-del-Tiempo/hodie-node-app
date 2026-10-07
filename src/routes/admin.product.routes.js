import express from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";
import { createProductController } from "../controllers/admin.product.controller.js";

export function createAdminProductRouter(service) {
  const router = express.Router();
  const controller = createProductController(service);
  router.use("/products", requireAuth, requireAdmin, express.json({ limit: "2mb" }));
  router.get("/products", controller.list);
  router.get("/products/:id", controller.get);
  router.post("/products", controller.create);
  router.put("/products/:id", controller.update);
  router.patch("/products/:id/reactivate", controller.reactivate);
  router.patch("/products/:id", controller.update);
  router.delete("/products/:id", controller.deactivate);
  router.use("/products", (error, _req, res, next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "El producto supera el tamaño admitido", field: "body" });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "El body debe ser JSON válido", field: "body" });
    return next(error);
  });
  return router;
}
export const router = createAdminProductRouter();
