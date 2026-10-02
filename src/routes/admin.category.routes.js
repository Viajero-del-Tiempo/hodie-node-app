import express from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";
import { categoryController } from "../controllers/admin.category.controller.js";

export const router = express.Router();
// Acotado a estas rutas: no agrega middlewares a otros routers montados en /admin.
router.use("/categories", requireAuth, requireAdmin);
router.get("/categories", categoryController.list);
router.get("/categories/:id", categoryController.get);
router.post("/categories", categoryController.create);
router.put("/categories/:id", categoryController.update);
router.patch("/categories/:id", categoryController.update);
router.delete("/categories/:id", categoryController.deactivate);
