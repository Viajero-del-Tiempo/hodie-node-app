import { whatsappClient } from "../config/whatsapp.js";

export const sendVerificationCode = async (phone, code) => {
  const chatId = `${phone}@c.us`;
  const message = `Tu código de verificación es: *${code}*`;
  await whatsappClient.sendMessage(chatId, message);
  console.log(`📤 Código enviado a ${phone}: ${code}`);
};

export const sendWelcomeMessage = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message2 = `*¡Bienvenido a HoDie Tienda de Regalos.🎁!* \n Estamos aquí para ayudarte en lo que necesites. 😊`;
  await whatsappClient.sendMessage(chatId, message2);
  console.log(`📤 Mensaje de bienvenida enviado a ${phone}`);
}

export const sendErrorMessage = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message = `❌ Código inválido o expirado. Intenta de nuevo.`;
  await whatsappClient.sendMessage(chatId, message);
  console.log(`📤 Mensaje de error enviado a ${phone}`);
}

export const sendLimitError = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message = `❌ Has excedido el límite de solicitudes de código. Intenta de nuevo más tarde.`;
  await whatsappClient.sendMessage(chatId, message);
  console.log(`📤 Mensaje de limite exedido enviado a ${phone}`);
}
