import { CustomerDataError, textInput } from "../utils/customer-data.util.js";
import { determineShippingMethod, validateShippingAddress } from "./shipping.service.js";
import { validateOrderBilling } from "../validators/billing.validator.js";
import { resolveOrderIdentity } from "./order-identity.service.js";

export function validateOrderPayload(order) {
  if (!order || typeof order !== "object" || Array.isArray(order)) {
    return { valid: false, error: "Datos del pedido inválidos.", field: "order" };
  }
  for (const field of ["userId", "userDisplayName", "userPhoneNumber", "items", "shippingAddress"]) {
    if (order[field] === undefined || order[field] === null || order[field] === "") {
      return { valid: false, error: `Falta el campo obligatorio: ${field}`, field };
    }
  }
  if (!Array.isArray(order.items) || !order.items.length) return { valid: false, error: "El pedido debe contener al menos un ítem.", field: "items" };
  try {
    for (const field of ["userId", "userDisplayName", "userPhoneNumber"]) textInput(order[field], field, { required: true });
    validateShippingAddress(order.shippingAddress, { legacy: true });
  }
  catch (error) { return { valid: false, error: error.message, field: error.field }; }
  return { valid: true };
}

export function createOrderPersistence({ db, timestampNow, calculatePricing,
  generateOrderId = () => db.collection("orders").doc().id, generateNumber,
}) {
  async function generateUniqueOrderNumber() {
    if (generateNumber) return generateNumber();
    const ref = db.collection("counters").doc("orderNumber");
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const last = snapshot.exists ? snapshot.data().lastOrderNumber : 0;
      const next = (Number.isSafeInteger(last) ? last : 0) + 1;
      transaction.set(ref, { lastOrderNumber: next, updatedAt: timestampNow() }, { merge: true });
      return "hodie" + String(next).padStart(6, "0");
    });
  }
  async function persistOrderSnapshot(orderData, { identity } = {}) {
    const validation = validateOrderPayload(orderData);
    if (!validation.valid) throw new CustomerDataError(validation.field, validation.error);
    const id = orderData.id || generateOrderId();
    const ref = db.collection("orders").doc(id);
    if (orderData.id) {
      const existing = await ref.get();
      if (existing.exists) return { ...existing.data(), id };
    }
    const pricing = await calculatePricing(orderData.items);
    const metadata = await resolveOrderIdentity(db, orderData, identity);
    // Compatibilidad del BudgetAgent actual: sus direcciones no tienen todos
    // los campos del nuevo checkout. Se elimina al reemplazar el BudgetAgent.
    const shippingAddress = validateShippingAddress(orderData.shippingAddress, { legacy: identity === undefined });
    const billing = validateOrderBilling(orderData.billing);
    const orderNumber = orderData.orderNumber || await generateUniqueOrderNumber();
    const order = {
      id, orderNumber, userId: orderData.userId, userPhoneNumber: orderData.userPhoneNumber,
      userDisplayName: orderData.userDisplayName, ...metadata,
      items: pricing.sanitizedItems, subtotal: pricing.subtotal, shippingCost: 0, total: pricing.total,
      shippingAddress, billing, shippingMethod: determineShippingMethod(shippingAddress.city),
      createdAt: timestampNow(), updatedAt: timestampNow(), status: "pending",
      whatsappChatId: orderData.whatsappChatId || "", pdfDelivered: false,
      customizationPending: pricing.sanitizedItems.some(item => item.customizationPending === true),
      customizationImagePending: pricing.sanitizedItems.some(item => item.customizationImagePending === true),
    };
    try { await ref.create(order); return order; }
    catch (error) {
      if (error.code !== 6 && error.code !== "already-exists") throw error;
      const existing = await ref.get();
      if (!existing.exists) throw error;
      return { ...existing.data(), id };
    }
  }
  return { persistOrderSnapshot, generateUniqueOrderNumber };
}
