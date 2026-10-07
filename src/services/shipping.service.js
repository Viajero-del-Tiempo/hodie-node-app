import { objectInput, textInput } from "../utils/customer-data.util.js";

// Regla existente: misma normalización y comparación que order.service.js.
export function determineShippingMethod(city) {
  if (!city || typeof city !== "string") return "transportadora_contra_entrega";
  const normalized = city.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
  return normalized.includes("minga guazu") ? "local_gratis" : "transportadora_contra_entrega";
}

export function getShippingOptions(city) {
  const cleanCity = textInput(city, "shippingAddress.city", { required: true });
  const shippingMethod = determineShippingMethod(cleanCity);
  return { city: cleanCity, shippingMethod, shippingCost: 0,
    requiresRecipientDocument: shippingMethod === "transportadora_contra_entrega",
    label: shippingMethod === "local_gratis" ? "Envío local gratuito" : "Transportadora: flete a pagar contra entrega",
  };
}

export function validateShippingAddress(value, { field = "shippingAddress", legacy = false } = {}) {
  const input = objectInput(value, field);
  const result = {};
  for (const key of ["alias", "recipientName", "street", "city", "department", "postalCode", "instructions"]) {
    result[key] = textInput(input[key], `${field}.${key}`, {
      required: key === "street" || key === "city" || (!legacy && ["recipientName", "department"].includes(key)),
    });
  }
  if (determineShippingMethod(result.city) === "transportadora_contra_entrega") {
    result.recipientDocument = textInput(input.recipientDocument, `${field}.recipientDocument`, { required: !legacy });
  }
  return result;
}
