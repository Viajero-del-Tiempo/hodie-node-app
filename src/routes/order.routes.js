import express from 'express';
import { sendOrder, shippingOptions } from '../controllers/order.controller.js';
import { requireAuth, loadActiveUser } from '../middlewares/auth.middleware.js';

export function createOrderRouter(checkout = sendOrder) {
  const router = express.Router();
  router.use(requireAuth, loadActiveUser);
  router.get('/shipping-options', shippingOptions);
  router.post('/order/send', checkout);
  return router;
}
export const router = createOrderRouter();

