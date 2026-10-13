import { assertCorporateQuantity } from "../../services/agent-config.service.js";
import { cartIssue, CART_TTL_MS } from "../../services/cart.service.js";

export function createCorporateQuantityGuard(runtime) {
  async function check(lines, context = {}) {
    const config = await runtime.agentConfig?.get(context) ?? null;
    context.signal?.throwIfAborted();
    return assertCorporateQuantity(lines, config);
  }
  async function remember(error, lines, context) {
    // Resolver referencias antes de registrar la solicitud humana; nunca
    // conservar IDs inventados ni precios/nombres aportados por el modelo.
    const requested = [];
    for (const line of lines) {
      const product = await runtime.catalog.getProduct(line.productId);
      const variant = product?.variants.find(item => item.id === line.variantId);
      if (!product) throw cartIssue("PRODUCTO_INEXISTENTE", "productId", "El producto no está disponible.");
      if (!variant) throw cartIssue("VARIANTE_INACTIVA", "variantId", "La variante no está disponible.");
      if (line.packagingType && !product.packagingOptions.some(option => option.type === line.packagingType)) {
        throw cartIssue("EMPAQUE_INEXISTENTE", "packagingType", "El empaque no está disponible para este producto.");
      }
      requested.push({ productId: product.id, variantId: variant.id, productName: product.name,
        options: variant.options, quantity: line.quantity, packagingType: line.packagingType ?? null,
        customization: structuredClone(line.customization ?? {}) });
    }
    context.signal?.throwIfAborted();
    const state = runtime.getState();
    const now = runtime.now();
    state.pendingCorporateRequest = { totalUnits: error.totalUnits, threshold: error.threshold, lines: requested,
      createdAt: now, expiresAt: now + CART_TTL_MS };
    state.lastQuote = null; state.pendingOrderConfirmation = null;
    if (state.pendingTextConfirmation) state.pendingTextConfirmation.shown = false;
    if (state.pendingRucConfirmation) state.pendingRucConfirmation.shown = false;
    await runtime.setState(state);
    await runtime.orderRepository.clearConfirmation(state.whatsappChatId, context);
  }
  return {
    check,
    async mutation(lines, context) {
      try { return await check(lines, context); }
      catch (error) { if (error.code === "CANTIDAD_CORPORATIVA") await remember(error, lines, context); throw error; }
    },
    async quote(lines, context) {
      const pending = runtime.getState().pendingCorporateRequest;
      // No cotizar el carrito anterior como si el cliente hubiera aceptado
      // abandonar la solicitud rechazada. Una modificación válida la limpia.
      if (pending && pending.expiresAt > runtime.now()) {
        await check(pending.lines, context);
        throw cartIssue("SOLICITUD_PENDIENTE", "quantity", "La solicitud anterior todavía no se aplicó al carrito. Actualizá sus líneas antes de volver a cotizar.");
      }
      return check(lines, context);
    },
    async clear(context) {
      context.signal?.throwIfAborted();
      const state = runtime.getState();
      if (state.pendingCorporateRequest) { state.pendingCorporateRequest = null; await runtime.setState(state); }
    },
  };
}
