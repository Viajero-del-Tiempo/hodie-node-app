import { CustomerDataError } from "../utils/customer-data.util.js";

// Solo se llama desde código de servidor. El controlador web nunca toma estos
// datos, el origen ni el chat del body. El agente nuevo debe pasar evidencia
// resuelta por su transporte, nunca valores elegidos por el LLM.
export async function resolveOrderIdentity(db, order, identity) {
  if (identity?.origin === "web") {
    if (!identity.phone || identity.phone !== order.userPhoneNumber) {
      throw new CustomerDataError("userPhoneNumber", "El teléfono no coincide con la sesión.");
    }
    return { origin: "web", phoneVerification: { verified: true, source: "web_session" } };
  }
  if (identity?.origin === "whatsapp") {
    const verified = typeof identity.resolvedPhone === "string" && Boolean(identity.resolvedPhone)
      && identity.resolvedPhone === order.userPhoneNumber;
    return { origin: "whatsapp", phoneVerification: {
      verified, source: verified ? "whatsapp_resolved" : "customer_supplied",
    } };
  }
  // BudgetAgent actual: no se modifica. Recuperamos evidencia del chat PN o
  // del mapa LID escrito por el transporte. Sin evidencia, no se verifica.
  const chat = typeof order.whatsappChatId === "string" ? order.whatsappChatId : "";
  let resolvedPhone = "";
  if (/^\d+@c\.us$/.test(chat)) resolvedPhone = chat.slice(0, -5);
  else if (/^\d+@lid$/.test(chat)) {
    const snapshot = await db.collection("lid_phone_map").doc(chat.slice(0, -4)).get();
    if (snapshot.exists && typeof snapshot.data().phoneNumber === "string") resolvedPhone = snapshot.data().phoneNumber;
  }
  const verified = Boolean(resolvedPhone) && resolvedPhone === order.userPhoneNumber;
  return { origin: chat ? "whatsapp" : "unknown", phoneVerification: {
    verified, source: verified ? "whatsapp_resolved" : chat ? "customer_supplied" : "unknown",
  } };
}

export function canReadCustomerOrder(order, phone) {
  if (order.userPhoneNumber !== phone) return false;
  const verification = order.phoneVerification;
  if (verification !== undefined) {
    return verification?.verified === true
      && ((order.origin === "web" && verification.source === "web_session")
        || (order.origin === "whatsapp" && verification.source === "whatsapp_resolved"));
  }
  // Decisión 4b-1: ningún histórico sin origen explícito. Tampoco se infiere
  // verificación histórica usando IDs, el perfil actual o el mapa LID actual.
  return order.origin === "web";
}
