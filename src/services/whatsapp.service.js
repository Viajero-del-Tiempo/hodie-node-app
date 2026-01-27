import { whatsappClient, MessageMedia } from "../config/whatsapp.js";
import fs from "fs";

export const sendVerificationCode = async (phone, code) => {
  try {
    const chatId = `${phone}@c.us`;
    const message = `Tu código de verificación es: *${code}*`;
    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
    console.log(`📤 Código enviado a ${phone}: ${code}`);
  } catch (error) {
    console.error(`Error enviando código de verificación a ${phone}:`, error);
  }
};

export const sendWelcomeMessage = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message2 = `*¡Bienvenido a HoDie Tienda de Regalos.🎁!* \n Estamos aquí para ayudarte en lo que necesites. 😊`;
  await whatsappClient.sendMessage(chatId, message2, { sendSeen: false });
  console.log(`📤 Mensaje de bienvenida enviado a ${phone}`);
};

export const sendErrorMessage = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message = `❌ Código inválido o expirado. Intenta de nuevo.`;
  await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
  console.log(`📤 Mensaje de error enviado a ${phone}`);
};

export const sendLimitError = async (phone) => {
  const chatId = `${phone}@c.us`;
  const message = `❌ Has excedido el límite de solicitudes de código. Intenta de nuevo más tarde.`;
  await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
  console.log(`📤 Mensaje de limite exedido enviado a ${phone}`);
};

export const sendOrderPDF = async (phone, pdfPath) => {
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const base64 = pdfBuffer.toString("base64");

    const media = new MessageMedia(
      "application/pdf",
      base64,
      `pedido-${Date.now()}.pdf`
    );

    await whatsappClient.sendMessage(`${phone}@c.us`, media, { sendSeen: false });

    return true;
  } catch (err) {
    console.error("Error enviando PDF por WhatsApp:", err);
    return false;
  }
};

/**
 * Envía un mensaje con el estado del pedido al cliente por WhatsApp.
 *
 * @param {string} phone - Número del cliente sin @c.us (ej: 595981234567)
 * @param {string} status - Estado del pedido
 * @param {number | null} amount - Monto total a pagar del pedido
 */
export const sendOrderStatus = async (phone, status, amount) => {
  try {
    if (!phone) throw new Error("Número de teléfono requerido");
    if (!status) throw new Error("Estado requerido");

    // Normalizar número
    const chatId = `${phone}@c.us`;

    // Textos por estado
    const statusMessages = {
      pending: `📝 *Tu pedido ha sido recibido con éxito*\nAguardamos tu comprobante de pago para procesarlo!\nSi tu pago ingresa después del medio día, el mismo será enviado al día siguiente\n*Monto:* ${
        amount ? amount.toLocaleString() : "N/A"
      } Gs.\n*Costo de envío:* Pago contra entrega\n*Alias para el pago:* +595987305945 (celular)\nMás abajo los detalles completos 👇`,
      paid: `💳 *Hemos recibido tu pago*\nTu pedido ahora está confirmado y te vamos a estar actualizando sobre el estado del mismo.\n¡Muchas gracias!`,
      preparing:
        "⚙️ *Estamos preparando tu pedido*\nMuy pronto estará listo para ser enviado.",
      shipped:
        "🚚 *Tu pedido ha sido enviado*\nLa transportadora se estará comunicando con vos para pasar a retirar.",
      delivered:
        "📦 *Compra culminada con éxito*\nAgradecemos tu preferencia y esperamos servirte nuevamente muy pronto!",
      cancelled: "❌ *Tu pedido fue cancelado*",
    };

    const message = statusMessages[status];

    if (status === "pending") {
      await sendWelcomeMessage(phone);
    }

    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });

    return { success: true };
  } catch (err) {
    console.error("Error enviando estado del pedido:", err);
    throw err;
  }
};
