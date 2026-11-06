import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { CustomerDataError } from "../utils/customer-data.util.js";
import { canReadCustomerOrder } from "./order-identity.service.js";

const pick = (input, keys) => Object.fromEntries(keys.filter(key => input?.[key] !== undefined).map(key => [key, input[key]]));
export function customerOrderDto(id, order, { summary = false } = {}) {
  const result = { id, ...pick(order, ["orderNumber", "createdAt", "updatedAt", "total", "status"]) };
  for (const field of ["createdAt", "updatedAt"]) {
    if (typeof result[field]?.toDate === "function") result[field] = result[field].toDate().toISOString();
    else if (result[field] instanceof Date) result[field] = result[field].toISOString();
  }
  if (summary) return result;
  const address = pick(order.shippingAddress, ["alias", "recipientName", "recipientDocument", "city", "department", "street", "postalCode", "instructions"]);
  const billing = order.billing == null ? null : { invoiceRequested: order.billing.invoiceRequested === true,
    ...(order.billing.invoiceRequested === true ? pick(order.billing, ["legalName", "ruc", "rucValidation"]) : {}) };
  return { ...result, ...pick(order, ["subtotal", "shippingCost", "shippingMethod", "trackingNumber", "pdfDelivered", "customizationPending", "customizationImagePending"]),
    shippingAddress: address, billing,
    items: (order.items ?? []).map(item => ({ ...pick(item, ["productId", "variantId", "variantLabel", "sku", "productName", "productSku",
      "quantity", "price", "imageUrl", "customization", "customizationPending", "customizationImageUrl", "customizationImagePending", "instructions"]),
      selectedPackaging: item.selectedPackaging ? pick(item.selectedPackaging, ["type", "name", "price", "imageUrl"]) : null,
    })),
  };
}

export function createCustomerOrderService({ db, documentId, timestampFromParts, cursorSecret }) {
  const key = createHash("sha256").update(cursorSecret).digest();
  function encodeCursor(phone, snapshot) {
    const data = snapshot.data();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encoded = Buffer.concat([cipher.update(JSON.stringify({ phone, id: snapshot.id,
      seconds: data.createdAt.seconds, nanos: data.createdAt.nanoseconds }), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encoded]).toString("base64url");
  }
  function decodeCursor(phone, cursor) {
    try {
      if (typeof cursor !== "string" || cursor.length > 2000 || !/^[\w-]+$/.test(cursor)) throw new Error();
      const bytes = Buffer.from(cursor, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const position = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      if (position.phone !== phone || typeof position.id !== "string" || position.id.includes("/")
          || !Number.isSafeInteger(position.seconds) || !Number.isInteger(position.nanos) || position.nanos < 0 || position.nanos >= 1e9) throw new Error();
      return position;
    } catch { throw new CustomerDataError("cursor", "El cursor de pedidos no es válido para tu sesión."); }
  }
  async function list(phone, { limit = 20, cursor } = {}) {
    const count = typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : limit;
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new CustomerDataError("limit", "El límite debe ser de 1 a 50 pedidos.");
    let position = cursor ? decodeCursor(phone, cursor) : null;
    let last;
    const orders = [];
    let exhausted = false;
    let scanned = 0;
    // Lectura acotada por dueño; no se lee el catálogo ni pedidos de otros.
    // Un bloque de históricos ocultos puede producir una página vacía con cursor.
    while (orders.length < count && scanned < 500) {
      let query = db.collection("orders").where("userPhoneNumber", "==", phone)
        .orderBy("createdAt", "desc").orderBy(documentId(), "desc");
      if (position) query = query.startAfter(timestampFromParts(position.seconds, position.nanos), position.id);
      const readLimit = Math.min(100, 500 - scanned);
      const snapshot = await query.limit(readLimit).get();
      if (snapshot.empty) { exhausted = true; break; }
      for (const doc of snapshot.docs) {
        scanned++;
        last = doc;
        const data = doc.data();
        position = { seconds: data.createdAt.seconds, nanos: data.createdAt.nanoseconds, id: doc.id };
        if (canReadCustomerOrder(data, phone)) orders.push(customerOrderDto(doc.id, data, { summary: true }));
        if (orders.length === count) break;
      }
      if (orders.length < count && snapshot.size < readLimit) exhausted = true;
      if (exhausted) break;
    }
    return { orders, nextCursor: exhausted || !last ? null : encodeCursor(phone, last) };
  }
  async function getSnapshot(phone, id) {
    if (typeof id !== "string" || !id || id.length > 200 || id.includes("/")) throw new CustomerDataError("orderId", "Pedido no encontrado.", 404);
    const snapshot = await db.collection("orders").doc(id).get();
    if (!snapshot.exists || !canReadCustomerOrder(snapshot.data(), phone)) throw new CustomerDataError("orderId", "Pedido no encontrado.", 404);
    return { ...snapshot.data(), id: snapshot.id };
  }
  return { list, getSnapshot, async get(phone, id) { const order = await getSnapshot(phone, id); return customerOrderDto(id, order); } };
}
