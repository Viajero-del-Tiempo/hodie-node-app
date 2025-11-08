import express from 'express';
import { requestCode, verifyCode, session } from '../controllers/auth.controller.js';

export const router = express.Router();

router.post('/request', requestCode);
router.post('/verify', verifyCode);
router.post('/session', session);