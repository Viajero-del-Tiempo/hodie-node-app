import jwt from "jsonwebtoken";
import { CODE_EXPIRATION_MINUTES, RATE_LIMIT_WINDOW_MINUTES, MAX_CODE_REQUESTS } from "../config/auth.js";

export function createAuthCodeController({ db, timestampNow, jwtSecret, jwtExpiration, sendVerificationCode, sendErrorMessage, sendLimitError, inMemoryStorage = {}, now = Date.now }) {
  const generateCode = () =>
    Math.floor(100000 + Math.random() * 900000).toString();

  const requestCode = async (req, res) => {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Número de teléfono requerido' });
    }

    const currentTime = now();
    const phoneData = inMemoryStorage[phone] || { requests: [] };

    // Filtrar las solicitudes que están dentro de la ventana de tiempo
    phoneData.requests = phoneData.requests.filter(
      (timestamp) => currentTime - timestamp < RATE_LIMIT_WINDOW_MINUTES * 60 * 1000
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
      phoneData.timestamp = currentTime;
      phoneData.requests.push(currentTime);
      inMemoryStorage[phone] = phoneData;

      await sendVerificationCode(phone, code);
      res.json({ success: true, message: 'Código enviado por WhatsApp' });
    } catch (err) {
      console.error('Error en requestCode:', err);
      res.status(500).json({ error: 'Error enviando el código' });
    }
  };

  const verifyCode = async (req, res) => {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
      const storedData = inMemoryStorage[phone];
      if (storedData && storedData.code === code) {
        const currentTime = now();
        const elapsedTime = currentTime - storedData.timestamp;
        if (elapsedTime < CODE_EXPIRATION_MINUTES * 60 * 1000) {
          // Asegurar que el usuario existe en Firestore con Admin SDK
          const snapshot = await db
            .collection("users")
            .where("phoneNumber", "==", phone)
            .limit(1)
            .get();

          let userData;
          if (snapshot.empty) {
            const newDocRef = db.collection("users").doc();
            userData = {
              uid: newDocRef.id,
              phoneNumber: phone,
              displayName: "",
              role: "customer",
              whatsapp_verified: true,
              profile_status: "incomplete",
              addresses: [],
              billingAddress: null,
              active: true,
              createdAt: timestampNow(),
              updatedAt: timestampNow(),
            };
            await newDocRef.set(userData);
          } else {
            const userDoc = snapshot.docs[0];
            userData = { uid: userDoc.id, ...userDoc.data(), whatsapp_verified: true };
            await userDoc.ref.update({
              whatsapp_verified: true,
              updatedAt: timestampNow(),
            });
          }

          const token = jwt.sign({ phone }, jwtSecret, { expiresIn: jwtExpiration });
          res.json({
            success: true,
            message: 'Usuario verificado correctamente',
            token,
            user: userData,
          });
        } else {
          try { await sendErrorMessage(phone); } catch (e) { console.warn("No se pudo enviar mensaje de error WhatsApp:", e.message); }
          res.status(400).json({ error: 'Código expirado' });
        }
      } else {
        try { await sendErrorMessage(phone); } catch (e) { console.warn("No se pudo enviar mensaje de error WhatsApp:", e.message); }
        res.status(400).json({ error: 'Código inválido' });
      }
    } catch (err) {
      console.error('Error en verifyCode:', err);
      res.status(500).json({ error: 'Error verificando usuario' });
    }
  };

  return { requestCode, verifyCode };
}
