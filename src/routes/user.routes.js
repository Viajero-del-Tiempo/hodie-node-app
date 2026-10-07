import express from "express";
import { requireAuth, loadActiveUser } from "../middlewares/auth.middleware.js";
import { createUserController } from "../controllers/user.controller.js";
import { createCustomerOrderController } from "../controllers/customer-order.controller.js";

export function createUserRouter({ profile = createUserController(), orders = createCustomerOrderController() } = {}) {
  const router = express.Router();
  router.use(requireAuth, loadActiveUser);
  router.get("/me", profile.getMyProfile);
  router.put("/me", profile.updateMyProfile);
  router.post("/me/ruc/validate", profile.validateRuc);
  router.get("/me/orders", orders.list);
  router.get("/me/orders/:id/pdf", orders.pdf);
  router.get("/me/orders/:id", orders.get);
  return router;
}
export const router = createUserRouter();
