import express from 'express';
import * as authController from '../controllers/auth.controller.js';

export function createAuthRouter(controller = authController) {
  const router = express.Router();
  router.post('/request', controller.requestCode);
  router.post('/verify', controller.verifyCode);
  router.post('/session', controller.session);
  router.post('/logout', controller.logout);
  return router;
}
export const router = createAuthRouter();
