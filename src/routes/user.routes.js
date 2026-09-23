import express from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { getMyProfile, updateMyProfile } from "../controllers/admin.user.controller.js";

export const router = express.Router();

router.use(requireAuth); // Requiere token JWT de cliente autenticado

router.get("/me", getMyProfile);
router.put("/me", updateMyProfile);
