import { Timestamp } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { catalogService } from "./catalog.service.js";
import { createOrderPricingService } from "./order-pricing.service.js";
import { createOrderPersistence } from "./order-persistence.service.js";
import { createOrderProcessor } from "./order-processing.service.js";
export { determineShippingMethod } from "./shipping.service.js";
export { validateOrderPayload } from "./order-persistence.service.js";

export const calculateQuoteTotals = (unitPrice, packagingPrice, quantity) => {
  const safeUnitPrice = Number(unitPrice) || 0;
  const safePackagingPrice = Number(packagingPrice) || 0;
  const safeQuantity = Math.max(1, Number(quantity) || 1);

  const pricePerItem = safeUnitPrice + safePackagingPrice;
  const subtotal = pricePerItem * safeQuantity;
  const shippingCost = 0; // La tienda no cobra flete en la orden
  const total = subtotal + shippingCost;

  return { subtotal, shippingCost, total };
};


export const calculateOrderPricing = createOrderPricingService({ catalog: catalogService });
const persistence = createOrderPersistence({ db, timestampNow: () => Timestamp.now(), calculatePricing: calculateOrderPricing });
export const persistOrderSnapshot = persistence.persistOrderSnapshot;
export const generateUniqueOrderNumber = persistence.generateUniqueOrderNumber;

async function notifyFailure(orderToSave) {
  const recipient = orderToSave.whatsappChatId || orderToSave.userPhoneNumber;
  // Si el PDF no se pudo entregar, activar contingencia: texto al cliente y alerta al admin
  {
    console.warn(`⚠️ PDF no entregado para el pedido #${orderToSave.orderNumber}. Activando flujo de contingencia.`);

    // Mensaje de texto al cliente con número, total, datos bancarios y aviso de PDF posterior
    try {
      const { whatsappClient } = await import("../config/whatsapp.js");
      const { resolveChatId } = await import("./whatsapp.service.js");
      const { BANK_CONFIG } = await import("../config/bank.config.js");
      const targetChatId = resolveChatId(recipient, "orderFallbackText");

      const shippingLabel =
        orderToSave.shippingMethod === "local_gratis"
          ? "Gratis (Minga Guazú)"
          : "Pago contra entrega (transportadora)";

      let pendingCustomizationText = "";
      if (orderToSave.customizationPending) {
        pendingCustomizationText = `\n\n✨ *Personalización:* Notamos que tenés productos con grabado pendiente. Respondé a este mensaje con el texto, dedicatoria o foto/logo que quieras grabar. ✍️🎁`;
      }

      const fallbackCustomerMessage =
        `📝 *Tu pedido #${orderToSave.orderNumber} ha sido generado con éxito*\n\n` +
        `• *Total:* *${orderToSave.total.toLocaleString()} Gs.*\n` +
        `• *Modalidad de entrega:* ${shippingLabel}\n` +
        `• *Alias para el pago:* ${BANK_CONFIG.alias}${pendingCustomizationText}\n\n` +
        `📄 Tu comprobante oficial en PDF está siendo procesado y te lo haremos llegar a la brevedad por este medio.\n` +
        `Aguardamos tu comprobante de transferencia para iniciar la preparación. ¡Muchas gracias! 🎁✨`;

      await whatsappClient.sendMessage(targetChatId, fallbackCustomerMessage, { sendSeen: false });
    } catch (clientMsgErr) {
      console.warn("⚠️ No se pudo enviar mensaje de texto de contingencia al cliente:", clientMsgErr.message);
    }

    // Alertar al admin: "Pedido <número> creado, falta enviar el PDF"
    try {
      const { notifyAdminViaWhatsApp } = await import("./whatsapp.service.js");
      const clientDisplay = orderToSave.userPhoneNumber
        ? `+${orderToSave.userPhoneNumber}`
        : `${orderToSave.userDisplayName || "Cliente"} (${orderToSave.whatsappChatId || "sin chat"})`;

      await notifyAdminViaWhatsApp(
        `⚠️ *Pedido #${orderToSave.orderNumber} creado, falta enviar el PDF*\n\n` +
        `• *Cliente:* ${clientDisplay}\n` +
        `• *Total:* ${orderToSave.total.toLocaleString()} Gs.\n` +
        `• *Estado:* Guardado en Firestore con pdfDelivered: false.\n\n` +
        `👉 Por favor verificar y enviar el comprobante PDF manualmente al cliente.`
      );
    } catch (adminAlertErr) {
      console.warn("⚠️ No se pudo alertar al admin sobre PDF pendiente:", adminAlertErr.message);
    }
  }

}

// Los imports del transporte son diferidos. El emulador inyecta entrega local.
export const processAndSendOrder = createOrderProcessor({
  persistence, db, timestampNow: () => Timestamp.now(),
  generatePdf: async order => (await import("./pdf.service.js")).generateOrderPDF(order),
  sendPdf: async (recipient, path) => (await import("./whatsapp.service.js")).sendOrderPDF(recipient, path),
  notifyFailure,
});
