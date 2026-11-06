import { existsSync, unlinkSync } from "node:fs";

export function createOrderProcessor({ persistence, db, timestampNow, generatePdf, sendPdf, notifyFailure = async () => {} }) {
  return async function processAndSendOrder(orderData, options = {}) {
    const order = await persistence.persistOrderSnapshot(orderData, { identity: options.identity });
    let pdfDelivered = false;
    let pdfPath = null;
    try {
      pdfPath = await (options.generatePdf ?? generatePdf)(order);
      pdfDelivered = Boolean(await (options.sendPdf ?? sendPdf)(order.whatsappChatId || order.userPhoneNumber, pdfPath, order));
    } catch (error) {
      console.warn(`Error generando o enviando PDF para ${order.orderNumber}:`, error.message);
    } finally {
      if (pdfPath) {
        try { if (existsSync(pdfPath)) unlinkSync(pdfPath); }
        catch (error) { console.warn("No se pudo eliminar el PDF temporal:", error.message); }
      }
    }
    try { await db.collection("orders").doc(order.id).update({ pdfDelivered, updatedAt: timestampNow() }); }
    catch (error) { console.warn("No se pudo actualizar pdfDelivered:", error.message); }
    if (!pdfDelivered) {
      try { await (options.notifyFailure ?? notifyFailure)(order); }
      catch (error) { console.warn("No se pudo notificar el PDF pendiente:", error.message); }
    }
    return { success: true, pdfDelivered, customizationPending: order.customizationPending,
      customizationImagePending: order.customizationImagePending,
      message: pdfDelivered ? `Pedido ${order.orderNumber} procesado y enviado al cliente.` : `Pedido ${order.orderNumber} procesado (PDF pendiente de envío).`,
      file: pdfPath, orderId: order.id, orderNumber: order.orderNumber,
      subtotal: order.subtotal, shippingCost: order.shippingCost, shippingMethod: order.shippingMethod, total: order.total,
    };
  };
}
