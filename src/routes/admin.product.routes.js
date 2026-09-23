import express from "express";
import { requireAdmin } from "../middlewares/auth.middleware.js";
import {
  getAdminProducts,
  getAdminProductById,
  createAdminProduct,
  updateAdminProduct,
  deleteAdminProduct,
  reactivateAdminProduct,
} from "../controllers/admin.product.controller.js";

export const router = express.Router();

router.use(requireAdmin);

router.get("/products", getAdminProducts);
router.get("/products/:id", getAdminProductById);
router.post("/products", createAdminProduct);
router.put("/products/:id", updateAdminProduct);
router.delete("/products/:id", deleteAdminProduct);
router.patch("/products/:id/reactivate", reactivateAdminProduct);
