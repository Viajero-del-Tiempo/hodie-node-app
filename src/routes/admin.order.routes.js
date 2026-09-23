import express from "express";
import { requireAdmin } from "../middlewares/auth.middleware.js";
import {
  getAdminOrders,
  getAdminOrderById,
  updateAdminOrderStatus,
} from "../controllers/admin.order.controller.js";

export const router = express.Router();

// Todas las rutas de administración de pedidos requieren rol de administrador
router.use(requireAdmin);

router.get("/orders", getAdminOrders);
router.get("/orders/:id", getAdminOrderById);
router.patch("/orders/:id", updateAdminOrderStatus);
