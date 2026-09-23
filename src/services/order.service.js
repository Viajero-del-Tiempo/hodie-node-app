import fs from "fs";
import { generateOrderPDF } from "./pdf.service.js";
import { sendOrderPDF, sendOrderStatus } from "./whatsapp.service.js";
import { db } from "../config/firebase.js";

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
    "subtotal",
    "total",
  ];

  for (const field of requiredFields) {
    if (order[field] === undefined || order[field] === null || order[field] === "") {
      return { valid: false, error: `Falta el campo obligatorio: ${field}` };
    }
  }

  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { valid: false, error: "El pedido debe contener al menos un ítem." };
  }

  return { valid: true };
};

/**
 * Procesa un pedido: valida campos, genera orderNumber atómico, persiste en Firestore con estado pending,
 * genera el comprobante PDF con PDFKit, lo envía por WhatsApp y programa la limpieza del archivo temporal.
 *
 * Esta función desacopla y centraliza la lógica para ser consumida tanto por el endpoint
 * POST /orders/order/send como por el agente Presupuestador de LangGraph.
 *
 * @param {any} orderData - Datos completos del pedido
 * @returns {Promise<{ success: boolean, message: string, file: string, orderId: string, orderNumber: string }>}
 */
export const processAndSendOrder = async (orderData) => {
  // 1. Validar payload
  const validation = validateOrderPayload(orderData);
  if (!validation.valid) {
    const error = new Error(validation.error);
    error.statusCode = 400;
    throw error;
  }

  // 2. Generar id y orderNumber atómico
  const orderId = orderData.id || db.collection("orders").doc().id;
  const orderNumber = orderData.orderNumber || (await generateUniqueOrderNumber());

  // 3. Normalizar createdAt para compatibilidad con Firestore y PDFKit
  const createdAtSeconds =
    orderData.createdAt?.seconds ||
    Math.floor((orderData.createdAt ? new Date(orderData.createdAt).getTime() : Date.now()) / 1000);
  const createdAt = { seconds: createdAtSeconds };

  // 4. Persistir o actualizar en Firestore con status 'pending' (si no tiene status previo)
  const orderToSave = {
    ...orderData,
    id: orderId,
    orderNumber,
    createdAt,
    status: orderData.status || "pending",
    updatedAt: new Date(),
  };

  try {
    await db.collection("orders").doc(orderToSave.id).set(orderToSave, { merge: true });
    console.log(`💾 Pedido ${orderToSave.orderNumber} guardado en Firestore (status: ${orderToSave.status})`);
  } catch (dbErr) {
    console.warn("⚠️ No se pudo persistir pedido en Firestore (se continúa con PDF):", dbErr.message);
  }

  // 5. Generar PDF premium con PDFKit
  const pdfPath = await generateOrderPDF(orderToSave);

  // 6. Enviar PDF por WhatsApp al número del cliente
  const sent = await sendOrderPDF(orderToSave.userPhoneNumber, pdfPath);

  if (!sent) {
    const error = new Error("El PDF se generó, pero no se pudo enviar por WhatsApp.");
    error.statusCode = 500;
    throw error;
  }

  // 7. Programar limpieza del archivo temporal (30 segundos)
  setTimeout(() => {
    try {
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
    } catch (err) {
      console.error("Error eliminando archivo temporal:", err);
    }
  }, 30000);

  return {
    success: true,
    message: `Pedido ${orderNumber} procesado y enviado al cliente.`,
    file: pdfPath,
    orderId: orderToSave.id,
    orderNumber: orderNumber,
  };
};

/**
 * Actualiza el estado de un pedido y notifica al cliente por WhatsApp
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.status
 * @param {number} [params.amount]
 * @param {string} [params.orderId]
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export const updateOrderStatusAndNotify = async ({ phone, status, amount, orderId }) => {
  if (!phone || !status) {
    const error = new Error("Los campos 'phone' y 'status' son requeridos");
    error.statusCode = 400;
    throw error;
  }

  // Si se proporciona orderId, actualizar el estado en Firestore
  if (orderId) {
    try {
      await db.collection("orders").doc(orderId).update({
        status,
        updatedAt: new Date(),
      });
      console.log(`💾 Estado de pedido ${orderId} actualizado a ${status} en Firestore`);
    } catch (dbErr) {
      console.warn(`⚠️ No se pudo actualizar estado en Firestore para ${orderId}:`, dbErr.message);
    }
  }

  // Enviar mensaje por WhatsApp
  await sendOrderStatus(phone, status, amount);

  return {
    success: true,
    message: "Estado enviado correctamente por WhatsApp",
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
          updatedAt: new Date(),
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
