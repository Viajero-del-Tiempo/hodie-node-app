import express from 'express';
import { sendOrder, updateOrderStatus } from '../controllers/order.controller.js';

export const router = express.Router();

router.post('/order/send', sendOrder);
router.post('/order/status', updateOrderStatus);

