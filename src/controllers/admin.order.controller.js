import { Timestamp } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { sendOrderStatus } from "../services/whatsapp.service.js";

import { catalogService, invalidateCatalogCache } from "../services/catalog.service.js";
import { createOrderStockService, getStockWarnings } from "../services/order-stock.service.js";
export { VALID_ORDER_STATUSES, COMMITTED_STOCK_STATUSES } from "../services/order-stock.service.js";

const stockService = createOrderStockService({
  db, catalog: { ...catalogService, invalidateCache: invalidateCatalogCache },
  timestampNow: () => Timestamp.now(),
});
export const deductStockInTransaction = stockService.deductStockInTransaction;
export const restoreStockInTransaction = stockService.restoreStockInTransaction;

const withStockWarnings = order => ({ ...order, stockWarnings: getStockWarnings(order.items) });

/**
 * GET /admin/orders
 * Obtiene la lista completa de pedidos para el panel admin, ordenados por fecha descendente.
 */
export const getAdminOrders = async (req, res) => {
  try {
    const snapshot = await db.collection("orders").orderBy("createdAt", "desc").get();
    const orders = snapshot.docs.map((doc) => withStockWarnings({ id: doc.id, ...doc.data() }));
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
    return res.json({ success: true, order: withStockWarnings({ id: doc.id, ...doc.data() }) });
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
export function createUpdateAdminOrderStatus({ stock = stockService, notify = sendOrderStatus } = {}) {
  return async (req, res) => {
    try {
      const { id } = req.params;
      const result = await stock.transitionOrderStatus(id, req.body?.status);
      const { order, previousStatus, status, changed, stockWarnings } = result;
      // Notificación después del commit; una solicitud repetida no vuelve a enviar.
      const recipient = order.whatsappChatId || order.userPhoneNumber;
      if (changed && recipient) {
        try {
          await notify(recipient, status, order.total, order.shippingMethod);
        } catch (error) {
          console.warn("⚠️ No se pudo enviar notificación WhatsApp:", error.message);
        }
      }
      const notice = stockWarnings.length ? " Aviso: hay ítems sin variantId; su stock no se modifica." : "";
      return res.json({
        success: true,
        message: (changed ? `Estado actualizado a ${status}` : `El pedido ya se encuentra en estado ${status}`) + notice,
        orderId: id, previousStatus, status, stockWarnings,
      });
    } catch (error) {
      console.error("Error en updateAdminOrderStatus:", error);
      return res.status(error.statusCode || 500).json({ error: error.message || "Error al actualizar estado del pedido", ...(error.field ? { field: error.field } : {}) });
    }
  };
}

export const updateAdminOrderStatus = createUpdateAdminOrderStatus();

/**
 * PATCH /admin/orders/:id/customization
 * Permite al administrador cargar o editar la personalización de un ítem del pedido,
 * limpiando la bandera 'customizationPending'.
 */
export const updateAdminOrderCustomization = async (req, res) => {
  try {
    const { id } = req.params;
    const { itemIndex, customization } = req.body;

    if (itemIndex === undefined || itemIndex === null || isNaN(Number(itemIndex))) {
      return res.status(400).json({ error: "Índice de ítem (itemIndex) requerido." });
    }

    const idx = Number(itemIndex);
    const orderRef = db.collection("orders").doc(id);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: "Pedido no encontrado." });
    }

    const orderData = orderDoc.data() || {};
    const items = [...(orderData.items || [])];

    if (idx < 0 || idx >= items.length) {
      return res.status(400).json({ error: `Índice de ítem ${idx} fuera de rango.` });
    }

    const updatedText = typeof customization === "string" ? customization.trim() : "";
    items[idx] = {
      ...items[idx],
      customization: updatedText,
      customizationPending: false,
    };

    // Si ningún ítem tiene customizationPending, marcar la orden como customizationPending: false
    const stillHasPending = items.some((it) => it.customizationPending === true);

    await orderRef.update({
      items,
      customizationPending: stillHasPending,
      updatedAt: Timestamp.now(),
    });

    console.log(`✍️ Personalización actualizada para pedido #${orderData.orderNumber}, ítem ${idx}: "${updatedText}"`);

    const updatedDoc = await orderRef.get();
    return res.json({
      success: true,
      message: "Personalización actualizada exitosamente.",
      order: withStockWarnings({ id: updatedDoc.id, ...updatedDoc.data() }),
    });
  } catch (err) {
    console.error("Error en updateAdminOrderCustomization:", err);
    return res.status(500).json({ error: err.message || "Error al actualizar personalización." });
  }
};
