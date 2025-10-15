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
} from "../services/user.service.js";

const generateCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

export const requestCode = async (req, res) => {
  const { phone } = req.body;
  if (!phone)
    return res.status(400).json({ error: "Número de teléfono requerido" });

  const code = generateCode();

  try {
    let user = await findUserByPhone(phone);
    if (user) {
      await updateVerificationCode(phone, code);
    } else {
      user = await createUser(phone, code);
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
      return res.status(400).json({ error: "Código inválido" });
    }
    res.json({ success: true, message: "Usuario verificado correctamente" });
    await sendWelcomeMessage(phone);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error verificando usuario" });
  }
};
