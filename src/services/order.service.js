import fs from "fs";
import { Timestamp } from "firebase-admin/firestore";
import { generateOrderPDF } from "./pdf.service.js";
import { sendOrderPDF } from "./whatsapp.service.js";
import { db } from "../config/firebase.js";
import { catalogService } from "./catalog.service.js";
import { createOrderPricingService } from "./order-pricing.service.js";

/**
 * Determina el método de envío a partir de la ciudad de destino:
 * - "local_gratis" si la ciudad es Minga Guazú (sede física de la tienda).
 * - "transportadora_contra_entrega" para cualquier otra localidad del país.
 * Normaliza sin tildes, minúsculas y espacios colapsados.
 *
 * @param {string} city
 * @returns {"local_gratis" | "transportadora_contra_entrega"}
 */
export const determineShippingMethod = (city) => {
  if (!city || typeof city !== "string") {
    return "transportadora_contra_entrega";
  }
  const normalized = city
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

  if (normalized.includes("minga guazu")) {
    return "local_gratis";
  }
  return "transportadora_contra_entrega";
};

/**
 * Calcula subtotal, costo de envío y total para un ítem o cotización.
 * Regla de negocio unificada (compartida con hodie-tienda y BudgetAgent):
 *   unitPrice = safeUnitPrice + safePackagingPrice (el packaging se cobra por unidad)
 *   subtotal = unitPrice * safeQuantity
 *   shippingCost = 0 (Hodie no cobra costo de flete en la orden: envío local gratuito en Minga Guazú,
 *                     o flete con pago contra entrega a la transportadora en el resto del país)
 *   total = subtotal + shippingCost
 *
 * @param {number} unitPrice - Precio unitario base del producto
 * @param {number} packagingPrice - Precio del empaque por unidad
 * @param {number} quantity - Cantidad solicitada (mínimo 1, máximo 100)
 * @returns {{ subtotal: number, shippingCost: number, total: number }}
 */
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

/**
 * Calcula y valida los precios oficiales de cada ítem contra el catálogo de Firestore.
 * Ignora cualquier precio enviado por el cliente o agente, garantizando una única fuente de verdad.
 *
 * @param {Array<any>} rawItems
 * @returns {Promise<{
 *   sanitizedItems: Array<any>,
 *   subtotal: number,
 *   shippingCost: number,
 *   total: number
 * }>}
 */
export const calculateOrderPricing = createOrderPricingService({ catalog: catalogService });

/**
 * Valida que los datos del pedido cumplan con todos los campos obligatorios
 * @param {any} order
 * @returns {{ valid: boolean, error?: string }}
 */
export const validateOrderPayload = (order) => {
  if (!order || typeof order !== "object") {
    return { valid: false, error: "Datos del pedido inválidos." };
  }

  const requiredFields = [
    "userId",
    "userDisplayName",
    "userPhoneNumber",
    "items",
    "shippingAddress",
  ];

  for (const field of requiredFields) {
    if (order[field] === undefined || order[field] === null || order[field] === "") {
      return { valid: false, error: `Falta el campo obligatorio: ${field}` };
    }
  }

  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { valid: false, error: "El pedido debe contener al menos un ítem." };
  }

  if (!order.shippingAddress || typeof order.shippingAddress !== "object") {
    return { valid: false, error: "La dirección de envío es obligatoria." };
  }

  if (!order.shippingAddress.street || !order.shippingAddress.city) {
    return { valid: false, error: "La dirección de envío debe incluir al menos calle y ciudad." };
  }

  // Validación de límites de caracteres en cada campo de shippingAddress (máximo 200 caracteres)
  for (const [key, val] of Object.entries(order.shippingAddress)) {
    if (typeof val === "string" && val.length > 200) {
      return {
        valid: false,
        error: `El campo '${key}' de la dirección de envío supera el límite permitido de 200 caracteres.`,
      };
    }
  }

  return { valid: true };
};

// La foto comercial se escribe una sola vez. Reprocesar un ID existente usa
// sus datos persistidos, aunque cambien precios, nombres, empaques o stock.
export const persistOrderSnapshot = async (orderData) => {
  const validation = validateOrderPayload(orderData);
  if (!validation.valid) {
    const error = new Error(validation.error);
    error.statusCode = 400;
    throw error;
  }
  const orderId = orderData.id || db.collection("orders").doc().id;
  const ref = db.collection("orders").doc(orderId);
  if (orderData.id) {
    const existing = await ref.get();
    if (existing.exists) return { ...existing.data(), id: orderId };
  }
  const pricing = await calculateOrderPricing(orderData.items);
  const orderNumber = orderData.orderNumber || await generateUniqueOrderNumber();
  const order = {
    ...orderData, id: orderId, orderNumber,
    items: pricing.sanitizedItems, subtotal: pricing.subtotal,
    shippingCost: 0, total: pricing.total,
    shippingMethod: determineShippingMethod(orderData.shippingAddress?.city),
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), status: "pending",
    whatsappChatId: orderData.whatsappChatId || "", pdfDelivered: false,
    customizationPending: pricing.sanitizedItems.some(item => item.customizationPending === true),
    customizationImagePending: pricing.sanitizedItems.some(item => item.customizationImagePending === true),
  };
  try {
    await ref.create(order);
    return order;
  } catch (error) {
    // Dos reintentos del mismo ID no sobrescriben la primera foto ni el estado.
    if (error.code !== 6 && error.code !== "already-exists") throw error;
    const existing = await ref.get();
    if (!existing.exists) throw error;
    return { ...existing.data(), id: orderId };
  }
};

/** Persiste la foto del pedido antes del PDF; un fallo de entrega no la revierte.
 * La entrega se inyecta en tests para evitar archivos y mensajes externos.
 */
export const processAndSendOrder = async (orderData, {
  generatePdf = generateOrderPDF, sendPdf = sendOrderPDF,
} = {}) => {
  const orderToSave = await persistOrderSnapshot(orderData);
  const orderNumber = orderToSave.orderNumber;
  let pdfDelivered = false;

  // 7 y 8. Generar PDF premium con PDFKit y enviarlo por WhatsApp
  let pdfPath = null;
  const recipient = orderToSave.whatsappChatId || orderToSave.userPhoneNumber;

  try {
    pdfPath = await generatePdf(orderToSave);
    const sent = await sendPdf(recipient, pdfPath);
    pdfDelivered = Boolean(sent);
  } catch (err) {
    console.warn(`⚠️ Error generando o enviando PDF para el pedido ${orderNumber}:`, err.message);
    pdfDelivered = false;
  } finally {
    if (pdfPath) {
      try {
        if (fs.existsSync(pdfPath)) {
          fs.unlinkSync(pdfPath);
        }
      } catch (unlinkErr) {
        console.warn("⚠️ Error eliminando PDF temporal en finally:", unlinkErr.message);
      }
    }
  }

  // Actualizar pdfDelivered en el documento de Firestore
  try {
    await db.collection("orders").doc(orderToSave.id).update({
      pdfDelivered,
      updatedAt: Timestamp.now(),
    });
  } catch (updateErr) {
    console.warn(`⚠️ Error actualizando pdfDelivered en Firestore para ${orderToSave.id}:`, updateErr.message);
  }

  // Si el PDF no se pudo entregar, activar contingencia: texto al cliente y alerta al admin
  if (!pdfDelivered) {
    console.warn(`⚠️ PDF no entregado para el pedido #${orderNumber}. Activando flujo de contingencia.`);

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
        `📝 *Tu pedido #${orderNumber} ha sido generado con éxito*\n\n` +
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
        `⚠️ *Pedido #${orderNumber} creado, falta enviar el PDF*\n\n` +
        `• *Cliente:* ${clientDisplay}\n` +
        `• *Total:* ${orderToSave.total.toLocaleString()} Gs.\n` +
        `• *Estado:* Guardado en Firestore con pdfDelivered: false.\n\n` +
        `👉 Por favor verificar y enviar el comprobante PDF manualmente al cliente.`
      );
    } catch (adminAlertErr) {
      console.warn("⚠️ No se pudo alertar al admin sobre PDF pendiente:", adminAlertErr.message);
    }
  }

  return {
    success: true,
    pdfDelivered,
    customizationPending: orderToSave.customizationPending,
    customizationImagePending: orderToSave.customizationImagePending,
    message: pdfDelivered
      ? `Pedido ${orderNumber} procesado y enviado al cliente.`
      : `Pedido ${orderNumber} procesado (PDF pendiente de envío).`,
    file: pdfPath,
    orderId: orderToSave.id,
    orderNumber: orderNumber,
    subtotal: orderToSave.subtotal,
    shippingCost: orderToSave.shippingCost,
    shippingMethod: orderToSave.shippingMethod,
    total: orderToSave.total,
  };
};

/**
 * Genera un número de pedido secuencial y único de forma atómica mediante una transacción en Firestore.
 * Utiliza el documento 'counters/orderNumber' y el campo 'lastOrderNumber'.
 * Garantiza cero colisiones entre pedidos concurrentes.
 * Formato resultante: "hodie" + 6 dígitos secuenciales (ej. "hodie000001", "hodie000002").
 *
 * @returns {Promise<string>} Número de orden secuencial único (ej. "hodie000001")
 */
export const generateUniqueOrderNumber = async () => {
  const counterRef = db.collection("counters").doc("orderNumber");

  try {
    const orderNumber = await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      let nextNumber = 1;

      if (counterDoc.exists) {
        const data = counterDoc.data() || {};
        const last = typeof data.lastOrderNumber === "number" ? data.lastOrderNumber : 0;
        nextNumber = last + 1;
      }

      transaction.set(
        counterRef,
        {
          lastOrderNumber: nextNumber,
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );

      const paddedNumber = String(nextNumber).padStart(6, "0");
      return `hodie${paddedNumber}`;
    });

    return orderNumber;
  } catch (err) {
    console.error("❌ Error generando número de orden atómico en Firestore:", err.message);
    throw err;
  }
};
