import {
  sendVerificationCode,
  sendWelcomeMessage,
  sendErrorMessage,
} from "../services/whatsapp.service.js";
import {
  findUserByPhone,
  createUser,
  updateVerificationCode,
  verifyUser,
  canRequestCode,
  validateSession,
} from "../services/user.service.js";

const generateCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

export const requestCode = async (req, res) => {
  const { phone } = req.body;
  if (!phone)
    return res.status(400).json({ error: "Número de teléfono requerido" });

  try {
    const userCanRequestCode = await canRequestCode(phone);
    if (!userCanRequestCode) {
      return res.status(429).json({
        error:
          "Has excedido el límite de solicitudes de código. Intenta de nuevo más tarde.",
      });
    }

    const code = generateCode();
    const userDoc = await findUserByPhone(phone);

    if (userDoc.exists) {
      await updateVerificationCode(phone, code);
    } else {
      await createUser(phone, code);
    }

    await sendVerificationCode(phone, code);
    res.json({ success: true, message: "Código enviado por WhatsApp" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error enviando el código" });
  }
};

export const verifyCode = async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: "Faltan datos" });

  try {
    const user = await verifyUser(phone, code);
    if (!user) {
      await sendErrorMessage(phone);
      return res.status(400).json({ error: "Código inválido o expirado" });
    }
    res.json({ success: true, message: "Usuario verificado correctamente" });
    await sendWelcomeMessage(phone);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error verificando usuario" });
  }
};

export const session = async (req, res) => {
  const { phone } = req.body;
  if (!phone)
    return res.status(400).json({ error: "Número de teléfono requerido" });

  try {
    const user = await validateSession(phone);
    if (!user) {
      return res.status(401).json({ error: "Sesión no válida" });
    }
    res.json({ success: true, message: "Sesión válida", user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error validando la sesión" });
  }
};
