import { db } from "../config/firebase.js";
import { sendOrderStatus } from "../services/whatsapp.service.js";

export const VALID_ORDER_STATUSES = [
  "pending",
  "paid",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
];

// Estados donde el stock del pedido se considera comprometido/descontado
export const COMMITTED_STOCK_STATUSES = ["paid", "preparing", "shipped", "delivered"];

/**
 * Descuenta el stock de los productos de un pedido de forma atómica en Firestore.
 * Agrupa items por productId y valida existencias dentro de una transacción.
 *
 * @param {Array<any>} orderItems
 */
export const deductStockInTransaction = async (orderItems) => {
  if (!Array.isArray(orderItems) || orderItems.length === 0) return;

  await db.runTransaction(async (transaction) => {
    const quantityByProduct = new Map();
    for (const item of orderItems) {
      if (!item.productId) continue;
      const current = quantityByProduct.get(item.productId) || 0;
      quantityByProduct.set(item.productId, current + Number(item.quantity || 1));
    }

    const productReads = [];
    for (const [productId, qtyToDeduct] of quantityByProduct.entries()) {
      const ref = db.collection("products").doc(productId);
      const doc = await transaction.get(ref);
      productReads.push({ ref, doc, productId, qtyToDeduct });
    }

    for (const { ref, doc, productId, qtyToDeduct } of productReads) {
      if (!doc.exists) {
        throw new Error(`Producto con ID ${productId} no encontrado en Firestore`);
      }
      const data = doc.data() || {};
      const currentStock = Number(data.stock || 0);
      const newStock = currentStock - qtyToDeduct;

      if (newStock < 0) {
        throw new Error(
          `Stock insuficiente para "${data.name || productId}". Stock actual: ${currentStock}, Solicitado: ${qtyToDeduct}`
        );
      }

      transaction.update(ref, {
        stock: newStock,
        updatedAt: new Date(),
      });
    }
  });
};

/**
 * Restituye el stock de los productos de un pedido de forma atómica en Firestore.
 * Agrupa items por productId y suma las cantidades dentro de una transacción.
 *
 * @param {Array<any>} orderItems
 */
export const restoreStockInTransaction = async (orderItems) => {
  if (!Array.isArray(orderItems) || orderItems.length === 0) return;

  await db.runTransaction(async (transaction) => {
    const quantityByProduct = new Map();
    for (const item of orderItems) {
      if (!item.productId) continue;
      const current = quantityByProduct.get(item.productId) || 0;
      quantityByProduct.set(item.productId, current + Number(item.quantity || 1));
    }

    const productReads = [];
    for (const [productId, qtyToRestore] of quantityByProduct.entries()) {
      const ref = db.collection("products").doc(productId);
      const doc = await transaction.get(ref);
      productReads.push({ ref, doc, productId, qtyToRestore });
    }

    for (const { ref, doc, productId, qtyToRestore } of productReads) {
      if (!doc.exists) {
        console.warn(`⚠️ Producto con ID ${productId} no encontrado al restituir stock. Se omite.`);
        continue;
      }
      const data = doc.data() || {};
      const currentStock = Number(data.stock || 0);
      const newStock = currentStock + qtyToRestore;

      transaction.update(ref, {
        stock: newStock,
        updatedAt: new Date(),
      });
    }
  });
};

/**
 * GET /admin/orders
 * Obtiene la lista completa de pedidos para el panel admin, ordenados por fecha descendente.
 */
export const getAdminOrders = async (req, res) => {
  try {
    const snapshot = await db.collection("orders").orderBy("createdAt", "desc").get();
    const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json({ success: true, orders });
  } catch (err) {
    console.error("Error en getAdminOrders:", err);
    return res.status(500).json({ error: "Error obteniendo pedidos" });
  }
};

/**
 * GET /admin/orders/:id
 * Obtiene el detalle de un pedido específico por ID.
 */
export const getAdminOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection("orders").doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }
    return res.json({ success: true, order: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("Error en getAdminOrderById:", err);
    return res.status(500).json({ error: "Error obteniendo el pedido" });
  }
};

/**
 * PATCH /admin/orders/:id
 * Actualiza el estado de un pedido aplicando la máquina de estados y las reglas de inventario:
 * - Si currentStatus === 'cancelled' y newStatus !== 'cancelled': BLOQUEADO (400).
 * - Transición de no-comprometido (pending) -> comprometido (paid, preparing, shipped, delivered): DESCONTAR stock.
 * - Transición de comprometido (paid, preparing, etc.) -> no-comprometido (cancelled, pending): RESTITUIR stock.
 * - Transición de pending -> cancelled: NO modifica stock (nunca se descontó).
 * - Transición entre estados comprometidos: NO modifica stock.
 * - Notifica al cliente por WhatsApp con el nuevo estado.
 */
export const updateAdminOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !VALID_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Estado inválido. Valores permitidos: ${VALID_ORDER_STATUSES.join(", ")}`,
      });
    }

    const orderRef = db.collection("orders").doc(id);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    const order = orderDoc.data();
    const currentStatus = order.status || "pending";
    const newStatus = status;

    // Si el estado es idéntico, responder de inmediato sin cambios
    if (currentStatus === newStatus) {
      return res.json({
        success: true,
        message: `El pedido ya se encuentra en estado ${newStatus}`,
        orderId: id,
        status: newStatus,
      });
    }

    // 1. REGLA: Bloquear reactivación desde 'cancelled'
    if (currentStatus === "cancelled" && newStatus !== "cancelled") {
      return res.status(400).json({
        error: "No se puede reactivar un pedido cancelado desde el panel. Requiere intervención manual en base de datos.",
      });
    }

    // 2. MÁQUINA DE ESTADOS Y CONTROL DE INVENTARIO ATÓMICO
    const wasStockCommitted = COMMITTED_STOCK_STATUSES.includes(currentStatus);
    const isStockCommitted = COMMITTED_STOCK_STATUSES.includes(newStatus);

    if (!wasStockCommitted && isStockCommitted) {
      // Pasa de pending a paid/preparing/etc. -> Descontar stock atómicamente
      await deductStockInTransaction(order.items);
      console.log(`📦 Stock descontado exitosamente para pedido #${order.orderNumber} (transición ${currentStatus} -> ${newStatus})`);
    } else if (wasStockCommitted && !isStockCommitted) {
      // Pasa de paid/preparing/etc. a cancelled o pending -> Restituir stock atómicamente
      await restoreStockInTransaction(order.items);
      console.log(`🔄 Stock restituido exitosamente para pedido #${order.orderNumber} (transición ${currentStatus} -> ${newStatus})`);
    }

    // 3. Persistir nuevo estado en Firestore
    await orderRef.update({
      status: newStatus,
      updatedAt: new Date(),
    });

    // 4. Notificar al cliente por WhatsApp
    if (order.userPhoneNumber) {
      try {
        await sendOrderStatus(order.userPhoneNumber, newStatus, order.total);
      } catch (wsErr) {
        console.warn("⚠️ No se pudo enviar notificación WhatsApp:", wsErr.message);
      }
    }

    return res.json({
      success: true,
      message: `Estado actualizado a ${newStatus}`,
      orderId: id,
      previousStatus: currentStatus,
      status: newStatus,
    });
  } catch (err) {
    console.error("Error en updateAdminOrderStatus:", err);
    const isClientError =
      err.message.includes("Stock insuficiente") ||
      err.message.includes("no encontrado");
    return res.status(isClientError ? 400 : 500).json({
      error: err.message || "Error al actualizar estado del pedido",
    });
  }
};
