import { processAndSendOrder } from '../services/order.service.js';
import { sanitizeOrderItemInput } from '../services/order-pricing.service.js';
import { validateShippingAddress, getShippingOptions } from '../services/shipping.service.js';
import { validateOrderBilling } from '../validators/billing.validator.js';
import { booleanInput, sendCustomerError, CustomerDataError } from '../utils/customer-data.util.js';
import { profileService } from './user.controller.js';

export function createSendOrderController({ processOrder = processAndSendOrder,
  notifyStatus = async (...args) => (await import('../services/whatsapp.service.js')).sendOrderStatus(...args),
  profiles = profileService,
} = {}) {
  return async (req, res) => {
    try {
      const user = req.user;
      const body = req.body || {};

      if (!Array.isArray(body.items) || body.items.length === 0) {
        throw new CustomerDataError('items', 'El pedido debe contener al menos un ítem.');
      }

      // Whitelist: referencias, cantidades y personalización. Datos comerciales
      // y estado salen del servidor; identidad exclusivamente del JWT.
      const cleanItems = body.items.map(sanitizeOrderItemInput);

      const cleanShippingAddress = validateShippingAddress(body.shippingAddress);
      const billing = validateOrderBilling(body.billing);
      const saveShippingAddress = booleanInput(body.saveShippingAddress, 'saveShippingAddress', !user.addresses?.length);
      const saveBillingProfile = booleanInput(body.saveBillingProfile, 'saveBillingProfile');

      const cleanPayload = {
        userId: user.uid,
        userPhoneNumber: user.phoneNumber || req.userPhone,
        userDisplayName: user.displayName || "Cliente Web",
        items: cleanItems,
        shippingAddress: cleanShippingAddress,
        billing: { ...billing, ...(billing.rucValidation?.status === 'mismatch_confirmed' ? { acknowledgeRucMismatch: true } : {}) },
        status: "pending",
        whatsappChatId: user.whatsappChatId || "",
      };

      const result = await processOrder(cleanPayload, { identity: { origin: 'web', phone: req.userPhone } });
      // El pedido ya existe. Un fallo al guardar datos opcionales no debe crear
      // otro pedido al reintentar: se devuelve éxito y un aviso independiente.
      let profileSaved = null;
      let profileWarning;
      if (saveShippingAddress || (saveBillingProfile && billing.invoiceRequested)) {
        try {
          await profiles.saveCheckoutDetails(user.uid, { shippingAddress: cleanShippingAddress, billing,
            saveShippingAddress, saveBillingProfile });
          profileSaved = true;
        } catch (error) {
          profileSaved = false;
          profileWarning = 'El pedido está guardado, pero no pudimos guardar los datos en tu perfil. Podés guardarlos desde Mi perfil sin repetir la compra.';
          console.warn('No se pudieron guardar los datos opcionales del perfil:', error.message);
        }
      }

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
        profileSaved,
        ...(profileWarning ? { profileWarning } : {}),
      });
    } catch (error) {
      return sendCustomerError(res, error);
    }
  };
}

export const sendOrder = createSendOrderController();

export function shippingOptions(req, res) {
  try { return res.json({ success: true, ...getShippingOptions(req.query.city) }); }
  catch (error) { return sendCustomerError(res, error); }
}
