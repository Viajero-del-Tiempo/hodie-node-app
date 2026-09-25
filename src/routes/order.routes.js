import express from 'express';
import { sendOrder } from '../controllers/order.controller.js';
import { requireAuth, loadActiveUser } from '../middlewares/auth.middleware.js';

export const router = express.Router();

router.post('/order/send', requireAuth, loadActiveUser, sendOrder);

