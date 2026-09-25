import fs from "fs";
import { Timestamp } from "firebase-admin/firestore";
import { generateOrderPDF } from "./pdf.service.js";
import { sendOrderPDF, sendOrderStatus } from "./whatsapp.service.js";
import { db } from "../config/firebase.js";
import { toFirestoreTimestamp } from "../utils/date.util.js";

export const ALLOWED_PACKAGING_TYPES = ["caja", "bolsa", "envoltorio"];

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
export const calculateOrderPricing = async (rawItems) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const error = new Error("El pedido debe contener al menos un ítem.");
    error.statusCode = 400;
    throw error;
  }

  let subtotal = 0;
  const sanitizedItems = [];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") {
      const error = new Error("Estructura de ítem inválida.");
      error.statusCode = 400;
      throw error;
    }

    const productId = item.productId || item.id;
    if (!productId || typeof productId !== "string") {
      const error = new Error("Falta el identificador 'productId' del ítem.");
      error.statusCode = 400;
      throw error;
    }

    // Validación de cantidad: entero estricto, > 0, tope 100
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      const error = new Error(`Cantidad inválida para el ítem '${productId}': debe ser un número entero mayor a 0.`);
      error.statusCode = 400;
      throw error;
    }

    if (qty > 100) {
      const error = new Error(`Cantidad excesiva para el producto '${productId}': el tope máximo permitido es de 100 unidades por ítem.`);
      error.statusCode = 400;
      throw error;
    }

    // Consulta en Firestore
    const prodDoc = await db.collection("products").doc(productId).get();
    if (!prodDoc.exists) {
      const error = new Error(`El producto con ID '${productId}' no existe en el catálogo.`);
      error.statusCode = 400;
      throw error;
    }

    const prodData = prodDoc.data() || {};
    if (prodData.active === false) {
      const error = new Error(`El producto '${prodData.name || productId}' no se encuentra disponible actualmente (inactivo).`);
      error.statusCode = 400;
      throw error;
    }

    const basePrice = Number(prodData.price);
    if (isNaN(basePrice) || basePrice < 0) {
      const error = new Error(`El producto '${prodData.name || productId}' no tiene un precio válido registrado.`);
      error.statusCode = 400;
      throw error;
    }

    // Validación de límites de caracteres en personalización e instrucciones (máximo 500 caracteres)
    if (item.customization && String(item.customization).length > 500) {
      const error = new Error("El campo de personalización supera el límite permitido de 500 caracteres.");
      error.statusCode = 400;
      throw error;
    }
    if (item.instructions && String(item.instructions).length > 500) {
      const error = new Error("El campo de instrucciones supera el límite permitido de 500 caracteres.");
      error.statusCode = 400;
      throw error;
    }

    // Packaging
    let packagingPrice = 0;
    let sanitizedPackaging = null;

    if (item.selectedPackaging) {
      let rawType = "";
      if (typeof item.selectedPackaging === "string") {
        rawType = item.selectedPackaging.toLowerCase().trim();
      } else if (typeof item.selectedPackaging === "object") {
        rawType = (item.selectedPackaging.type || item.selectedPackaging.name || "").toLowerCase().trim();
      }

      let canonicalType = "";
      if (rawType.includes("caja")) canonicalType = "caja";
      else if (rawType.includes("bolsa")) canonicalType = "bolsa";
      else if (rawType.includes("envoltorio") || rawType.includes("papel")) canonicalType = "envoltorio";

      if (!canonicalType || !ALLOWED_PACKAGING_TYPES.includes(canonicalType)) {
        const error = new Error(
          `Opción de empaque inválida ('${rawType}') para el producto '${prodData.name}'. Opciones permitidas: ${ALLOWED_PACKAGING_TYPES.join(", ")}.`
        );
        error.statusCode = 400;
        throw error;
      }

      const availablePackaging = prodData.packagingPrices || {};
      if (availablePackaging[canonicalType] === undefined || availablePackaging[canonicalType] === null) {
        const error = new Error(
          `El empaque '${canonicalType}' no está configurado para el producto '${prodData.name}'.`
        );
        error.statusCode = 400;
        throw error;
      }

      packagingPrice = Number(availablePackaging[canonicalType]);
      if (isNaN(packagingPrice) || packagingPrice < 0) {
        const error = new Error(`Precio de empaque inválido para '${canonicalType}'.`);
        error.statusCode = 400;
        throw error;
      }

      const displayNames = {
        caja: "Caja de Regalo",
        bolsa: "Bolsa Decorativa",
        envoltorio: "Envoltorio Especial",
      };

      // Imagen de packaging: tomada estrictamente de la configuración de catálogo en Firestore (o vacío), NUNCA del body
      const packagingImageUrl =
        (prodData.packagingImages && typeof prodData.packagingImages === "object" && prodData.packagingImages[canonicalType]) || "";

      sanitizedPackaging = {
        type: canonicalType,
        name: displayNames[canonicalType] || canonicalType,
        price: packagingPrice,
        imageUrl: packagingImageUrl,
      };
    }

    const { subtotal: itemSubtotal } = calculateQuoteTotals(basePrice, packagingPrice, qty);
    subtotal += itemSubtotal;

    // Imagen del producto: tomada estrictamente de prodData.imageUrls en Firestore, NUNCA del body
    const itemImageUrl =
      (Array.isArray(prodData.imageUrls) && prodData.imageUrls[0]) || "";

    sanitizedItems.push({
      productId,
      productName: prodData.name || item.productName || "Producto",
      productSku: prodData.sku || item.productSku || "",
      quantity: qty,
      price: basePrice, // Precio oficial de catálogo ignorando el recibido
      selectedPackaging: sanitizedPackaging,
      imageUrl: itemImageUrl,
      ...(item.customization ? { customization: String(item.customization).trim() } : {}),
      ...(item.instructions ? { instructions: String(item.instructions).trim() } : {}),
    });
  }

  const shippingCost = 0; // La tienda no cobra flete en la orden (gratis en Minga Guazú o contra entrega en el resto del país)
  const total = subtotal + shippingCost;

  return {
    sanitizedItems,
    subtotal,
    shippingCost,
    total,
  };
};

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

/**
 * Procesa un pedido: valida campos, recalcula precios contra catálogo en Firestore,
 * genera orderNumber atómico, persiste en Firestore con estado pending,
 * genera el comprobante PDF con PDFKit, lo envía por WhatsApp y programa la limpieza del archivo temporal.
 *
 * @param {any} orderData - Datos del pedido
 * @returns {Promise<{ success: boolean, message: string, file: string, orderId: string, orderNumber: string, subtotal: number, shippingCost: number, shippingMethod: string, total: number }>}
 */
export const processAndSendOrder = async (orderData) => {
  // 1. Validar payload base
  const validation = validateOrderPayload(orderData);
  if (!validation.valid) {
    const error = new Error(validation.error);
    error.statusCode = 400;
    throw error;
  }

  // 2. Recalcular precios, empaques y totales contra el catálogo oficial en Firestore
  const pricing = await calculateOrderPricing(orderData.items);

  // 3. Determinar método de envío en el servidor según la ciudad (nunca del body)
  const shippingMethod = determineShippingMethod(orderData.shippingAddress?.city);

  // 4. Generar id y orderNumber atómico
  const isExistingId = Boolean(orderData.id);
  const orderId = orderData.id || db.collection("orders").doc().id;

  let existingCreatedAt = null;
  let existingOrderNumber = null;

  if (isExistingId) {
    try {
      const existingDoc = await db.collection("orders").doc(orderId).get();
      if (existingDoc.exists) {
        const existingData = existingDoc.data() || {};
        if (existingData.createdAt) {
          existingCreatedAt = toFirestoreTimestamp(existingData.createdAt);
        }
        if (existingData.orderNumber) {
          existingOrderNumber = existingData.orderNumber;
        }
      }
    } catch (readErr) {
      console.warn(`⚠️ Error leyendo orden existente ${orderId}:`, readErr.message);
    }
  }

  const orderNumber =
    orderData.orderNumber || existingOrderNumber || (await generateUniqueOrderNumber());

  // 5. Normalizar createdAt: nunca se toma de orderData para evitar manipulación en checkout web.
  //    - Si el pedido ya existe en Firestore, se conserva el createdAt original guardado.
  //    - Si es un pedido nuevo, siempre se asigna Timestamp.now().
  const createdAt = existingCreatedAt || Timestamp.now();
  const updatedAt = Timestamp.now();

  // 6. Persistir o actualizar en Firestore con status 'pending' (si no tiene status previo)
  const orderToSave = {
    ...orderData,
    id: orderId,
    orderNumber,
    items: pricing.sanitizedItems,
    subtotal: pricing.subtotal,
    shippingCost: pricing.shippingCost, // 0 Gs. siempre
    shippingMethod, // "local_gratis" si Minga Guazú, "transportadora_contra_entrega" otro caso
    total: pricing.total,
    createdAt,
    status: orderData.status || "pending",
    whatsappChatId: orderData.whatsappChatId || "",
    updatedAt,
  };

  try {
    await db.collection("orders").doc(orderToSave.id).set(orderToSave, { merge: true });
    console.log(`💾 Pedido ${orderToSave.orderNumber} guardado en Firestore (status: ${orderToSave.status}, shippingMethod: ${orderToSave.shippingMethod})`);
  } catch (dbErr) {
    console.warn("⚠️ No se pudo persistir pedido en Firestore (se continúa con PDF):", dbErr.message);
  }

  // 7. Generar PDF premium con PDFKit
  const pdfPath = await generateOrderPDF(orderToSave);

  // 8. Enviar PDF por WhatsApp al chat del cliente (preferir whatsappChatId sobre userPhoneNumber)
  const recipient = orderToSave.whatsappChatId || orderToSave.userPhoneNumber;
  const sent = await sendOrderPDF(recipient, pdfPath);

  if (!sent) {
    const error = new Error("El PDF se generó, pero no se pudo enviar por WhatsApp.");
    error.statusCode = 500;
    throw error;
  }

  // 9. Programar limpieza del archivo temporal (30 segundos)
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
    subtotal: orderToSave.subtotal,
    shippingCost: orderToSave.shippingCost,
    shippingMethod: orderToSave.shippingMethod,
    total: orderToSave.total,
  };
};

/**
 * Actualiza el estado de un pedido y notifica al cliente por WhatsApp
 * @param {Object} params
 * @param {string} [params.phone] - Número telefónico (fallback)
 * @param {string} [params.whatsappChatId] - Identificador de chat de WhatsApp (@c.us o @lid)
 * @param {string} params.status
 * @param {number} [params.amount]
 * @param {string} [params.orderId]
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export const updateOrderStatusAndNotify = async ({ phone, status, amount, orderId, whatsappChatId }) => {
  if (!phone && !whatsappChatId && !orderId) {
    const error = new Error("Se requiere 'whatsappChatId', 'phone' o 'orderId'");
    error.statusCode = 400;
    throw error;
  }
  if (!status) {
    const error = new Error("El campo 'status' es requerido");
    error.statusCode = 400;
    throw error;
  }

  let recipient = whatsappChatId;

  // Si se proporciona orderId, actualizar el estado en Firestore y rescatar whatsappChatId si no se proveyó
  if (orderId) {
    try {
      const orderDoc = await db.collection("orders").doc(orderId).get();
      if (orderDoc.exists) {
        const orderData = orderDoc.data();
        if (!recipient && orderData?.whatsappChatId) {
          recipient = orderData.whatsappChatId;
        }
        if (!recipient && orderData?.userPhoneNumber) {
          recipient = orderData.userPhoneNumber;
        }
      }
      await db.collection("orders").doc(orderId).update({
        status,
        updatedAt: Timestamp.now(),
      });
      console.log(`💾 Estado de pedido ${orderId} actualizado a ${status} en Firestore`);
    } catch (dbErr) {
      console.warn(`⚠️ No se pudo actualizar estado en Firestore para ${orderId}:`, dbErr.message);
    }
  }

  // Fallback a phone si no se pudo determinar recipient
  if (!recipient) {
    recipient = phone;
  }

  if (!recipient) {
    const error = new Error("No se pudo determinar el destinatario para notificar el estado del pedido");
    error.statusCode = 400;
    throw error;
  }

  // Enviar mensaje por WhatsApp
  await sendOrderStatus(recipient, status, amount);

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
