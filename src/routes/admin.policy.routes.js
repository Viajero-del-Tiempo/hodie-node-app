import express from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";
import { policyController } from "../controllers/admin.policy.controller.js";

export const router = express.Router();
router.use("/policies", requireAuth, requireAdmin);
router.get("/policies", policyController.list);
router.get("/policies/:id", policyController.get);
router.post("/policies", policyController.create);
router.put("/policies/:id", policyController.update);
router.patch("/policies/:id", policyController.update);
router.delete("/policies/:id", policyController.delete);
