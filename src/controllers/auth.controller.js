import { JWT_SECRET, JWT_EXPIRATION } from '../config/jwt.js';
import { tokenBlacklist } from '../services/auth-session.service.js';
import { createAuthSessionController } from './auth-session.controller.js';
import { createAuthCodeController } from './auth-code.controller.js';

// Se conservan los exports usados por suites y consumidores existentes.
export { tokenBlacklist };
export const inMemoryStorage = {};
const sessionController = createAuthSessionController({ jwtSecret: JWT_SECRET, tokenBlacklist });
export const session = sessionController.session;
export const logout = sessionController.logout;

let codeController;
async function getCodeController() {
  if (!codeController) {
    codeController = Promise.all([
      import('../config/firebase.js'), import('firebase-admin/firestore'),
      import('../services/whatsapp.service.js'),
    ]).then(([{ db }, { Timestamp }, transport]) => createAuthCodeController({
      db, timestampNow: () => Timestamp.now(), jwtSecret: JWT_SECRET,
      jwtExpiration: JWT_EXPIRATION, inMemoryStorage, ...transport,
    })).catch(error => { codeController = undefined; throw error; });
  }
  return codeController;
}
export const requestCode = async (req, res) => (await getCodeController()).requestCode(req, res);
export const verifyCode = async (req, res) => (await getCodeController()).verifyCode(req, res);
