import { processAndSendOrder } from '../services/order.service.js';
import { sendOrderStatus } from '../services/whatsapp.service.js';

export const sendOrder = async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ error: "El pedido debe contener al menos un ítem." });
    }

    if (!body.shippingAddress || typeof body.shippingAddress !== "object") {
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

    // Validación de límites de caracteres en personalización e instrucciones (máximo 500 caracteres)
    for (const it of body.items) {
      if (it.customization && String(it.customization).length > 500) {
        return res.status(400).json({
          error: "El campo de personalización supera el límite permitido de 500 caracteres.",
        });
      }
      if (it.instructions && String(it.instructions).length > 500) {
        return res.status(400).json({
          error: "El campo de instrucciones supera el límite permitido de 500 caracteres.",
        });
      }
    }

    // Whitelist estricta para checkout web:
    // Solo se aceptan items (productId, quantity, packaging, personalización) y dirección del body.
    // Identidad viene exclusivamente de req.user del JWT.
    // id, orderNumber, status, price, subtotal, shippingMethod, total se ignoran / fuerzan por el servidor.
    const cleanItems = body.items.map((it) => ({
      productId: it.productId || it.id,
      quantity: it.quantity,
      selectedPackaging: it.selectedPackaging || null,
      customization: it.customization || it.instructions || undefined,
    }));

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

    const result = await processAndSendOrder(cleanPayload);

    // Enviar mensaje de estado inicial con datos bancarios por WhatsApp al cliente
    const targetChatId = cleanPayload.whatsappChatId || cleanPayload.userPhoneNumber;
    try {
      await sendOrderStatus(targetChatId, "pending", result.total);
    } catch (statusErr) {
      console.warn("⚠️ No se pudo enviar notificación de estado inicial por WhatsApp:", statusErr.message);
    }

    return res.json({
      success: result.success,
      message: result.message,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      file: result.file,
      shippingMethod: result.shippingMethod,
      total: result.total,
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error en sendOrder:', error);
    return res.status(500).json({ error: 'Error procesando el pedido.' });
  }
};
