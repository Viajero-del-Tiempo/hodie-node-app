import express from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";
import { createAdminImageController } from "../controllers/admin.image.controller.js";

export function createAdminImageRouter(uploadImage) {
  const router = express.Router();
  router.post("/images", requireAuth, requireAdmin, express.json({ limit: "14mb" }), createAdminImageController(uploadImage));
  router.use("/images", (error, _req, res, next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "La imagen supera el tamaño admitido", field: "base64" });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "El body debe ser JSON válido", field: "body" });
    return next(error);
  });
  return router;
}
export const router = createAdminImageRouter();
