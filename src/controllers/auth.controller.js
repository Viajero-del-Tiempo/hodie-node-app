import jwt from 'jsonwebtoken';
import {
  sendVerificationCode,
  sendErrorMessage,
  sendLimitError,
} from '../services/whatsapp.service.js';
import {
  CODE_EXPIRATION_MINUTES,
  RATE_LIMIT_WINDOW_MINUTES,
  MAX_CODE_REQUESTS,
} from '../config/auth.js';
import { JWT_SECRET, JWT_EXPIRATION } from '../config/jwt.js';

const inMemoryStorage = {};
const tokenBlacklist = new Set();

const generateCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

export const requestCode = async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Número de teléfono requerido' });
  }

  const now = Date.now();
  const phoneData = inMemoryStorage[phone] || { requests: [] };

  // Filtrar las solicitudes que están dentro de la ventana de tiempo
  phoneData.requests = phoneData.requests.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MINUTES * 60 * 1000
  );

  if (phoneData.requests.length >= MAX_CODE_REQUESTS) {
    await sendLimitError(phone);
    return res.status(429).json({
      error:
        'Has excedido el límite de solicitudes de código. Intenta de nuevo más tarde.',
    });
  }

  try {
    const code = generateCode();
    phoneData.code = code;
    phoneData.timestamp = now;
    phoneData.requests.push(now);
    inMemoryStorage[phone] = phoneData;

    await sendVerificationCode(phone, code);
    res.json({ success: true, message: 'Código enviado por WhatsApp' });
  } catch (err) {
    console.error('Error en requestCode:', err);
    res.status(500).json({ error: 'Error enviando el código' });
  }
};

export const verifyCode = async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    const storedData = inMemoryStorage[phone];
    if (storedData && storedData.code === code) {
      const now = Date.now();
      const elapsedTime = now - storedData.timestamp;
      if (elapsedTime < CODE_EXPIRATION_MINUTES * 60 * 1000) {
        const token = jwt.sign({ phone }, JWT_SECRET, { expiresIn: JWT_EXPIRATION });
        res.json({ success: true, message: 'Usuario verificado correctamente', token });
      } else {
        await sendErrorMessage(phone);
        res.status(400).json({ error: 'Código expirado' });
      }
    } else {
      await sendErrorMessage(phone);
      res.status(400).json({ error: 'Código inválido' });
    }
  } catch (err) {
    console.error('Error en verifyCode:', err);
    res.status(500).json({ error: 'Error verificando usuario' });
  }
};

export const session = async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: 'Token inválido (cerrado)' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, message: 'Sesión válida', phone: decoded.phone });
  } catch (err) {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

export const logout = async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (token) {
    tokenBlacklist.add(token);
  }

  res.json({ success: true, message: 'Sesión cerrada correctamente' });
};

