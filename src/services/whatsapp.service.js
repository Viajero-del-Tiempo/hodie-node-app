import { whatsappClient, MessageMedia } from "../config/whatsapp.js";
import fs from "fs";

/**
 * Normaliza y resuelve el identificador de chat para WhatsApp.
 * Si recibe un whatsappChatId que ya contiene '@' (@c.us o @lid), lo usa directamente sin alterar.
 * Si recibe un número de teléfono o string sin '@', aplica el fallback reconstruyendo
 * `${target}@c.us` y emite una advertencia clara para trazabilidad de registros antiguos.
 *
 * @param {string} target - whatsappChatId (@c.us o @lid), o número de teléfono fallback
 * @param {string} caller - Nombre de la función para el registro de advertencias
 * @returns {string} Identificador de chat listo para whatsappClient.sendMessage
 */
export const resolveChatId = (target, caller = "whatsapp.service") => {
  if (!target) {
    throw new Error(`[${caller}] Destinatario no proporcionado (se requiere whatsappChatId o phone)`);
  }

  const cleaned = String(target).trim();
  if (cleaned.includes("@")) {
    return cleaned;
  }

  console.warn(
    `⚠️ [FALLBACK ${caller}] Destinatario '${cleaned}' no incluye '@'. Reconstruyendo '${cleaned}@c.us'. ` +
    `Si este usuario opera con @lid en WhatsApp, el mensaje podría fallar en silencio.`
  );
  return `${cleaned}@c.us`;
};

export const sendVerificationCode = async (whatsappChatId, code) => {
  try {
    const chatId = resolveChatId(whatsappChatId, "sendVerificationCode");
    const message = `Tu código de verificación es: *${code}*`;
    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
    console.log(`📤 Código enviado a ${chatId}: ${code}`);
  } catch (error) {
    console.error(`Error enviando código de verificación a ${whatsappChatId}:`, error);
  }
};

export const sendWelcomeMessage = async (whatsappChatId) => {
  try {
    const chatId = resolveChatId(whatsappChatId, "sendWelcomeMessage");
    const message2 = `*¡Bienvenido a HoDie Tienda de Regalos.🎁!* \n Estamos aquí para ayudarte en lo que necesites. 😊`;
    await whatsappClient.sendMessage(chatId, message2, { sendSeen: false });
    console.log(`📤 Mensaje de bienvenida enviado a ${chatId}`);
  } catch (error) {
    console.error(`Error enviando mensaje de bienvenida a ${whatsappChatId}:`, error);
  }
};

export const sendErrorMessage = async (whatsappChatId) => {
  try {
    const chatId = resolveChatId(whatsappChatId, "sendErrorMessage");
    const message = `❌ Código inválido o expirado. Intenta de nuevo.`;
    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
    console.log(`📤 Mensaje de error enviado a ${chatId}`);
  } catch (error) {
    console.error(`Error enviando mensaje de error a ${whatsappChatId}:`, error);
  }
};

export const sendLimitError = async (whatsappChatId) => {
  try {
    const chatId = resolveChatId(whatsappChatId, "sendLimitError");
    const message = `❌ Has excedido el límite de solicitudes de código. Intenta de nuevo más tarde.`;
    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
    console.log(`📤 Mensaje de límite excedido enviado a ${chatId}`);
  } catch (error) {
    console.error(`Error enviando mensaje de límite a ${whatsappChatId}:`, error);
  }
};

export const sendOrderPDF = async (whatsappChatId, pdfPath) => {
  try {
    const chatId = resolveChatId(whatsappChatId, "sendOrderPDF");
    const pdfBuffer = fs.readFileSync(pdfPath);
    const base64 = pdfBuffer.toString("base64");

    const media = new MessageMedia(
      "application/pdf",
      base64,
      `pedido-${Date.now()}.pdf`
    );

    await whatsappClient.sendMessage(chatId, media, { sendSeen: false });

    return true;
  } catch (err) {
    console.error("Error enviando PDF por WhatsApp:", err);
    return false;
  }
};

/**
 * Envía un mensaje con el estado del pedido al cliente por WhatsApp.
 *
 * @param {string} whatsappChatId - Identificador de chat (@c.us o @lid) o teléfono fallback
 * @param {string} status - Estado del pedido
 * @param {number | null} amount - Monto total a pagar del pedido
 */
export const sendOrderStatus = async (whatsappChatId, status, amount) => {
  try {
    if (!whatsappChatId) throw new Error("Identificador de destinatario (whatsappChatId) requerido");
    if (!status) throw new Error("Estado requerido");

    const chatId = resolveChatId(whatsappChatId, "sendOrderStatus");

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
      await sendWelcomeMessage(whatsappChatId);
    }

    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });

    return { success: true };
  } catch (err) {
    console.error("Error enviando estado del pedido:", err);
    throw err;
  }
};
