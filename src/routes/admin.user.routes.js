import express from "express";
import { requireAdmin } from "../middlewares/auth.middleware.js";
import {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  updateAdminUserRole,
  deleteAdminUser,
} from "../controllers/admin.user.controller.js";

export const router = express.Router();

router.use(requireAdmin); // Requiere rol de administrador

router.get("/users", getAdminUsers);
router.post("/users", createAdminUser);
router.put("/users/:id", updateAdminUser);
router.patch("/users/:id/role", updateAdminUserRole);
router.delete("/users/:id", deleteAdminUser);
