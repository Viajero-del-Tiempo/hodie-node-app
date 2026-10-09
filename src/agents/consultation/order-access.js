// La identidad nunca procede de argumentos del modelo. Un teléfono de compra
// solo autoriza la respuesta reducida; no modifica phoneVerified ni el perfil.
export function normalizePurchasePhone(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s()+.\-]/g, "");
  if (/^5959\d{8}$/.test(digits)) return digits;
  if (/^09\d{8}$/.test(digits)) return "595" + digits.slice(1);
  if (/^9\d{8}$/.test(digits)) return "595" + digits;
  return null;
}
const notFound = () => ({ code: "PEDIDO_NO_ENCONTRADO", message: "No encontramos un pedido con esos datos." });
const stateOnly = order => ({ code: "OK", order: { orderNumber: order.orderNumber, status: order.status } });
const owned = order => ({ ...stateOnly(order), order: { ...stateOnly(order).order,
  items: (order.items ?? []).map(item => Object.fromEntries(["productId", "variantId", "productName", "variantLabel", "quantity"]
    .filter(field => item[field] !== undefined).map(field => [field, item[field]]))) } });

export function createOrderAccess({ repository, getIdentity }) {
  return async function estadoPedido({ orderNumber, phone }, { signal } = {}) {
    signal?.throwIfAborted();
    const identity = getIdentity();
    const verifiedPhone = identity.phoneVerified === true ? normalizePurchasePhone(identity.userPhoneNumber) : null;
    if (!orderNumber) {
      if (!verifiedPhone) return { code: "DATO_FALTANTE", fields: ["orderNumber", "phone"] };
      const orders = await repository.listByPhone(verifiedPhone);
      signal?.throwIfAborted();
      // Defensa adicional al contrato del repositorio: nunca confiar en una lista ajena.
      const own = orders.filter(order => normalizePurchasePhone(order.userPhoneNumber) === verifiedPhone);
      if (!own.length) return notFound();
      if (own.length === 1) return owned(own[0]);
      // No se inventan fechas ni se deduce antigüedad a partir del número.
      return { code: "DATO_FALTANTE", fields: ["orderNumber"],
        orders: own.map(order => ({ orderNumber: order.orderNumber, status: order.status })) };
    }
    const order = await repository.getByNumber(orderNumber);
    signal?.throwIfAborted();
    if (order && verifiedPhone && normalizePurchasePhone(order.userPhoneNumber) === verifiedPhone) return owned(order);
    // Ajuste aprobado: si el pedido no es del teléfono verificado del chat,
    // se aplica la misma vía reducida que para un cliente sin verificar.
    if (!phone) return { code: "DATO_FALTANTE", fields: ["phone"], message: "Verificá el pedido con el teléfono de compra." };
    const purchasePhone = normalizePurchasePhone(phone);
    if (!order || !purchasePhone || normalizePurchasePhone(order.userPhoneNumber) !== purchasePhone) return notFound();
    return stateOnly(order);
  };
}
