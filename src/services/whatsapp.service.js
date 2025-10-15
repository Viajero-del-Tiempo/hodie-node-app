import { whatsappClient } from "../config/whatsapp.js";

export const sendVerificationCode = async (phone, code) => {
  const chatId = `${phone}@c.us`;
  const message = `Tu código de verificación es: *${code}*`;
  await whatsappClient.sendMessage(chatId, message);
  console.log(`📤 Código enviado a ${phone}: ${code}`);
};

export const sendWelcomeMessage = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message1 = `¡Hola! 👋 Gracias por registrarte en HoDie Tienda de Regalos.🎁​`;
  const message2 = `*¡Bienvenido!* \n Estamos aquí para ayudarte en lo que necesites. 😊`;
  await whatsappClient.sendMessage(chatId, message1);
  await whatsappClient.sendMessage(chatId, message2);
  console.log(`📤 Mensaje de bienvenida enviado a ${phone}`);
}

export const sendErrorMessage = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message = `❌ Ha ocurrido un error. Por favor, intenta nuevamente`;
  await whatsappClient.sendMessage(chatId, message);
  console.log(`📤 Mensaje de error enviado a ${phone}`);
}
