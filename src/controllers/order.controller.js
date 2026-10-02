import { processAndSendOrder } from '../services/order.service.js';
import { sendOrderStatus } from '../services/whatsapp.service.js';
import { sanitizeOrderItemInput } from '../services/order-pricing.service.js';

export function createSendOrderController({ processOrder = processAndSendOrder, notifyStatus = sendOrderStatus } = {}) {
  return async (req, res) => {
    try {
      const user = req.user;
      const body = req.body || {};

      if (!Array.isArray(body.items) || body.items.length === 0) {
        return res.status(400).json({ error: "El pedido debe contener al menos un ítem." });
      }

      if (!body.shippingAddress || typeof body.shippingAddress !== "object" || Array.isArray(body.shippingAddress)) {
        return res.status(400).json({ error: "La dirección de envío es obligatoria." });
      }

      // Validación de límites de caracteres en campos de dirección (máximo 200 caracteres)
      for (const [key, val] of Object.entries(body.shippingAddress)) {
        if (typeof val === "string" && val.length > 200) {
          return res.status(400).json({
            error: `El campo '${key}' de la dirección de envío supera el límite permitido de 200 caracteres.`,
          });
        }
      }

      // Whitelist: referencias, cantidades y personalización. Datos comerciales
      // y estado salen del servidor; identidad exclusivamente del JWT.
      const cleanItems = body.items.map(sanitizeOrderItemInput);

      const cleanShippingAddress = {
        alias: body.shippingAddress.alias || "",
        street: body.shippingAddress.street || "",
        city: body.shippingAddress.city || "",
        department: body.shippingAddress.department || "",
        postalCode: body.shippingAddress.postalCode || "",
        instructions: body.shippingAddress.instructions || "",
      };

      const cleanPayload = {
        userId: user.uid,
        userPhoneNumber: user.phoneNumber || req.userPhone,
        userDisplayName: user.displayName || "Cliente Web",
        items: cleanItems,
        shippingAddress: cleanShippingAddress,
        status: "pending",
        whatsappChatId: user.whatsappChatId || "",
      };

      const result = await processOrder(cleanPayload);

      // Enviar mensaje de estado inicial con datos bancarios solo si el PDF fue entregado
      // (si falló el PDF, processAndSendOrder ya envió el mensaje de contingencia con datos bancarios)
      if (result.pdfDelivered) {
        const targetChatId = cleanPayload.whatsappChatId || cleanPayload.userPhoneNumber;
        try {
          await notifyStatus(targetChatId, "pending", result.total, result.shippingMethod, {
            hasPendingCustomization: Boolean(result.customizationPending),
          });
        } catch (statusErr) {
          console.warn("⚠️ No se pudo enviar notificación de estado inicial por WhatsApp:", statusErr.message);
        }
      }

      return res.json({
        success: result.success,
        status: "success",
        pdfDelivered: result.pdfDelivered,
        message: result.message,
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        file: result.file,
        shippingMethod: result.shippingMethod,
        customizationPending: result.customizationPending,
        total: result.total,
      });
    } catch (error) {
      if ((error.statusCode ?? error.status) === 400) {
        return res.status(400).json({ error: error.message, ...(error.field ? { field: error.field } : {}) });
      }
      console.error('Error en sendOrder:', error);
      return res.status(500).json({ error: 'Error procesando el pedido.' });
    }
  };
}

export const sendOrder = createSendOrderController();
