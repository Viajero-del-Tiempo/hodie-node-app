import express from "express";
import { createAgentConfigController } from "../controllers/admin.agent-config.controller.js";

export function createAdminAgentConfigRouter({ repository, requireAuth, requireAdmin }) {
  const router = express.Router(), controller = createAgentConfigController(repository);
  router.use("/agent-config", requireAuth, requireAdmin);
  router.get("/agent-config", controller.get);
  router.put("/agent-config", controller.save);
  return router;
}
