import { fingerprint } from "../../services/cart.service.js";

export const subtotalVersion = cart => ({ cartId: cart.id, linesFingerprint: fingerprint(cart.lines), contentRevision: cart.revision });

// El orden de preguntas es del servidor, independiente del texto del modelo.
export async function inspectCartProgress(cart, { catalog, inspectData, subtotalPending = null, inProgressBlocks = [] }) {
  const data = inspectData(cart);
  const lines = await Promise.all(cart.lines.map(async line => {
    const product = await catalog.getProductForPricing(line.productId);
    return { ...line, productName: product?.name ?? null, optionNames: product?.optionNames ?? [],
      options: product?.variants?.find(variant => variant.id === line.variantId)?.options ?? {},
      customizationConfig: product?.customization ?? null, packagingOptions: product?.packagingOptions ?? [] };
  }));
  const personalizacion = [], empaque = [];
  for (const line of lines) {
    const custom = line.customization, config = line.customizationConfig;
    if (config?.allowed && !custom.declined && (custom.textDraft !== null || custom.pending
        || (!config.allowsText && config.allowsImage && !custom.imageUrl))) {
      personalizacion.push({ tipo: "personalizacion", linea: line.id,
        field: "lines." + line.id + ".customization", accion: custom.textDraft !== null ? "confirmar_texto" : "elegir" });
    }
    if (line.packagingOptions.length && !line.packagingType && !line.packaging.declined) {
      empaque.push({ tipo: "empaque", linea: line.id, field: "lines." + line.id + ".packagingType",
        opciones: line.packagingOptions.map(({ type, name, price }) => ({ type, name, price })) });
    }
  }
  const fields = [...new Set([...data.fields, ...empaque.map(item => item.field)])];
  const group = (tipo, prefix) => {
    const missing = fields.filter(field => field.startsWith(prefix));
    return missing.length ? [{ tipo, fields: missing }] : [];
  };
  const version = subtotalVersion(cart);
  const informar = subtotalPending?.cartId === version.cartId && subtotalPending.linesFingerprint === version.linesFingerprint
    ? [{ tipo: "informar_subtotal" }] : [];
  const groups = [...group("envio", "shipping."), ...group("facturacion", "billing.")];
  // Adelantar solo bloques incompletos modificados en este turno, conservando
  // el orden de sus campos. Los completos desaparecen y el resto sigue igual.
  const prioritizedTypes = new Set(inProgressBlocks);
  const prioritized = [...prioritizedTypes].flatMap(tipo => groups.filter(item => item.tipo === tipo));
  return { ...data, fields, lines,
    pendientes: [...informar, ...prioritized, ...personalizacion, ...empaque,
      ...groups.filter(item => !prioritizedTypes.has(item.tipo))] };
}
