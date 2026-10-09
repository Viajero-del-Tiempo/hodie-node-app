import { normalizePurchasePhone } from "./order-access.js";

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]));
export async function prepareConsultationTurn({ runtime, history, now, turn, signal }) {
  signal?.throwIfAborted();
  const state = runtime.getState();
  if (state.humanHandoffRequired) return { silent: true };
  if (!Number.isFinite(now) || !Array.isArray(turn?.messages) || !turn.messages.length
      || turn.messages.some(message => typeof message.text !== "string")) throw Object.assign(new Error("Turno inválido"), { code: "INVALID_TURN" });
  const verified = state.phoneVerified === true && normalizePurchasePhone(state.userPhoneNumber) !== null;
  const categories = await runtime.catalog.getCategories();
  signal?.throwIfAborted();
  const cart = await runtime.getCart();
  signal?.throwIfAborted();
  const orders = verified ? await runtime.orders.listByPhone(normalizePurchasePhone(state.userPhoneNumber)) : [];
  signal?.throwIfAborted();
  return {
    silent: false,
    context: {
      currentTime: new Date(now).toISOString(), timezone: "America/Asuncion",
      localTime: new Intl.DateTimeFormat("es-PY", { timeZone: "America/Asuncion", dateStyle: "full", timeStyle: "long" }).format(new Date(now)),
      categories: categories.map(category => pick(category, ["id", "name"])),
      identity: { phoneVerified: verified, userPhoneNumber: verified ? normalizePurchasePhone(state.userPhoneNumber) : null,
        contactName: state.pushname ?? null },
      consecutiveMisunderstandings: state.consecutiveMisunderstandings ?? 0,
      cart: cart ? { lines: (cart.lines ?? []).map(line => ({ ...pick(line, ["productId", "variantId", "quantity", "packagingType"]),
        customization: pick(line.customization, ["text", "imageUrl", "pending"]) })),
        shipping: pick(cart.shipping, ["recipientName", "recipientDocument", "city", "department", "street", "phone"]),
        billing: pick(cart.billing, ["invoiceRequested", "legalName", "ruc", "rucValidation"]) } : null,
      // Sin fecha no se presenta esta lista como ordenada por antigüedad.
      orders: orders.filter(order => normalizePurchasePhone(order.userPhoneNumber) === normalizePurchasePhone(state.userPhoneNumber))
        .slice(0, 2).map(order => pick(order, ["orderNumber", "status", "createdAt"])),
      attachments: (turn.attachments ?? []).map(attachment => pick(attachment, ["type", "mode", "description", "filename"])),
    },
    history: (history ?? []).filter(message => ["user", "assistant"].includes(message.role) && typeof message.content === "string").slice(-20),
    input: turn.messages.map(message => message.text).join("\n"),
  };
}
