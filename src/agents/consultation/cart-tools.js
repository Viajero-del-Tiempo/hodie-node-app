import { cartIssue, pricingInputs } from "../../services/cart.service.js";
import { acceptsPending } from "./confirmations.js";

export function createCartTools({ runtime, carts, calculatePricing, inspectData, corporate }) {
  const customization = () => ({ text: null, textDraft: null, imageUrl: null, declined: false, pending: false });
  async function build(line, args, context) {
    const current = await carts.read(context) ?? carts.blank();
    const result = structuredClone(line);
    for (const key of ["productId", "variantId", "quantity", "packagingType"]) if (Object.hasOwn(args, key)) result[key] = args[key];
    if (Object.hasOwn(args, "packagingType")) result.packaging = { declined: args.packagingType === null };
    if (Object.hasOwn(args, "sinPersonalizacion")) {
      result.customization.declined = args.sinPersonalizacion;
      if (args.sinPersonalizacion) result.customization = { ...customization(), declined: true };
    }
    if (Object.hasOwn(args, "texto")) {
      const text = args.texto?.trim() || null;
      if (args.sinPersonalizacion && text) throw cartIssue("PERSONALIZACION_CONTRADICTORIA", "texto", "No se puede pedir texto y rechazar la personalización a la vez.");
      const unchanged = !result.customization.declined && text === (result.customization.textDraft ?? result.customization.text);
      if (!args.sinPersonalizacion && !unchanged) result.customization = { ...result.customization, text: null, textDraft: text, declined: false };
    }
    if (args.confirmarTexto !== undefined) {
      const state = runtime.getState();
      const pending = state.pendingTextConfirmation;
      if (!pending || pending.cartId !== current.id || pending.lineId !== line.id || pending.value !== args.confirmarTexto
          || line.customization.textDraft !== args.confirmarTexto
          || !acceptsPending(pending, runtime.getTurnContext(), args.confirmarTexto)) {
        throw cartIssue("CONFIRMACION_REQUERIDA", "confirmarTexto", "Primero mostrale al cliente el texto literal y esperá su confirmación.");
      }
      result.customization = { ...result.customization, text: args.confirmarTexto, textDraft: null, declined: false };
    }
    // Resolver volumen antes del pricing/stock: una solicitud corporativa
    // se ofrece al equipo aunque no haya unidades suficientes disponibles.
    // El pricing restante se valida también antes de cualquier subida.
    const candidate = { ...current, lines: [...current.lines.filter(row => row.id !== line.id), result] };
    await corporate.mutation(candidate.lines, context);
    await calculatePricing(pricingInputs(candidate, { includeDrafts: true }));
    context.signal?.throwIfAborted();
    if (args.attachmentId) {
      if (result.customization.declined) throw cartIssue("PERSONALIZACION_CONTRADICTORIA", "attachmentId", "No se puede agregar una imagen a una personalización rechazada.");
      const product = await runtime.catalog.getProductForPricing(result.productId);
      if (product?.customization?.allowed !== true || product.customization.allowsImage !== true) throw cartIssue("NO_ADMITE_IMAGEN", "attachmentId", "Este producto no admite personalización de imagen.");
      const attachment = runtime.getTurnAttachment(args.attachmentId);
      if (!attachment) throw cartIssue("ADJUNTO_NO_DISPONIBLE", "attachmentId", "La imagen no está disponible en este turno. Volvé a enviarla.");
      if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(attachment.mimeType)) throw cartIssue("FORMATO_IMAGEN_NO_ADMITIDO", "attachmentId", "La imagen de personalización debe ser JPG, PNG o WEBP.");
      const imageUrl = await runtime.uploadCustomizationImage({ base64: attachment.data.toString("base64"), mimetype: attachment.mimeType }, { signal: context.signal });
      context.signal?.throwIfAborted();
      result.customization.imageUrl = imageUrl;
    }
    return result;
  }
  const view = async context => {
    const cart = await carts.read(context);
    if (!cart) return { code: "OK", cart: null, lines: [], fields: ["lines"], pendientes: [] };
    const data = await inspectData(cart);
    context.signal?.throwIfAborted();
    return { code: "OK", cart, lines: data.lines, fields: data.fields, pendientes: data.pendientes, shipping: data.options };
  };
  return {
    carrito_ver: (_args, context) => view(context),
    async carrito_agregar(args, context) {
      if (args.confirmarTexto !== undefined) throw cartIssue("ARGUMENTOS_INVALIDOS", "confirmarTexto", "Confirmá el texto en la línea que ya existe.");
      const line = await build({ productId: args.productId, variantId: args.variantId, quantity: args.quantity,
        packagingType: null, packaging: { declined: false }, customization: customization() }, args, context);
      await carts.add(line, context);
      await corporate.clear(context);
      return view(context);
    },
    async carrito_modificar({ linea, cambios }, context) {
      const cart = await carts.read(context);
      const line = cart?.lines.find(line => line.id === linea);
      if (!line) throw cartIssue("LINEA_INEXISTENTE", "linea", "Esta línea ya no está en el carrito.");
      const change = await build(line, cambios, context);
      await carts.modify(linea, change, context);
      await corporate.clear(context);
      return view(context);
    },
    async carrito_quitar({ linea }, context) { await carts.remove(linea, context); await corporate.clear(context); return view(context); },
  };
}
