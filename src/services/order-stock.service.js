import { OrderValidationError, stockInsufficient, validateOrderIdentifier, validateOrderQuantity } from "./order-pricing.service.js";

export const VALID_ORDER_STATUSES = ["pending", "paid", "preparing", "shipped", "delivered", "cancelled"];
export const COMMITTED_STOCK_STATUSES = ["paid", "preparing", "shipped", "delivered"];

// Se conserva para pedidos históricos incluso tras retirar el pricing viejo en entrega 6.
export function getStockWarnings(items = []) {
  return (Array.isArray(items) ? items : []).flatMap((item, itemIndex) => !item?.variantId ? [{
    code: "LEGACY_ITEM_WITHOUT_VARIANT", itemIndex, productId: item?.productId || "",
    message: `El ítem ${itemIndex + 1} no tiene variantId: no se modifica su stock.`,
  }] : []);
}

function groupVariants(items) {
  if (items !== undefined && !Array.isArray(items)) throw new OrderValidationError("Ítems inválidos en el pedido.", "items");
  const grouped = new Map();
  for (const item of items ?? []) {
    if (!item?.variantId) continue; // Sin lectura del producto ni fallback al stock raíz.
    validateOrderIdentifier(item.productId, "productId");
    validateOrderIdentifier(item.variantId, "variantId");
    const quantity = validateOrderQuantity(item.quantity);
    if (!grouped.has(item.productId)) grouped.set(item.productId, new Map());
    const variants = grouped.get(item.productId);
    const sum = (variants.get(item.variantId) ?? 0) + quantity;
    if (!Number.isSafeInteger(sum)) throw new OrderValidationError("Cantidad acumulada inválida.", "quantity");
    variants.set(item.variantId, sum);
  }
  return grouped;
}

export function createOrderStockService({ db, catalog, timestampNow, warn = message => console.warn(message) }) {
  async function applyStock(transaction, items, direction) {
    const warnings = getStockWarnings(items);
    const groups = groupVariants(items);
    const products = [];
    // Firestore exige todas las lecturas antes de las escrituras.
    for (const [productId, quantities] of groups) {
      const product = await catalog.getProductForPricing(productId, { transaction });
      if (!product || product.schemaVersion !== 2 || !Array.isArray(product.variants)) {
        throw new OrderValidationError(`Producto '${productId}' inexistente o sin modelo de variantes.`, "productId");
      }
      products.push({ productId, product, quantities });
    }
    const updates = products.map(({ productId, product, quantities }) => {
      for (const id of quantities.keys()) {
        if (!product.variants.some(variant => variant.id === id)) {
          throw new OrderValidationError(`Variante '${id}' no encontrada en '${productId}'.`, "variantId");
        }
      }
      const variants = product.variants.map(variant => {
        const quantity = quantities.get(variant.id);
        if (quantity === undefined) return variant;
        if (!Number.isSafeInteger(variant.stock) || variant.stock < 0) throw new OrderValidationError(`Stock inválido en '${variant.id}'.`, "variants.stock");
        if (direction === -1) {
          if (product.active !== true || variant.active !== true) throw new OrderValidationError(`Producto o variante '${variant.id}' inactivos.`, "variantId");
          if (variant.stock < quantity) throw stockInsufficient(product, variant, quantity);
        }
        const stock = variant.stock + direction * quantity;
        if (!Number.isSafeInteger(stock)) throw new OrderValidationError("Stock fuera del rango numérico permitido.", "variants.stock");
        // Al cancelar se restaura incluso si producto/variante fueron desactivados.
        return { ...variant, stock };
      });
      return { productId, variants };
    });
    for (const { productId, variants } of updates) await catalog.setProductVariants(transaction, productId, variants);
    return { stockWarnings: warnings, stockChanged: updates.length > 0 };
  }

  function afterCommit(result) {
    if (result.stockChanged) catalog.invalidateCache();
    for (const warning of result.stockWarnings) warn(warning.message);
    return result;
  }

  async function move(items, direction, transaction) {
    if (transaction) return applyStock(transaction, items, direction);
    const result = await db.runTransaction(tx => applyStock(tx, items, direction));
    return afterCommit(result);
  }

  return {
    // Si se inyecta una transacción, el caller confirma e invalida tras el commit.
    deductStockInTransaction: (items, transaction) => move(items, -1, transaction),
    restoreStockInTransaction: (items, transaction) => move(items, 1, transaction),
    async transitionOrderStatus(orderId, status) {
      validateOrderIdentifier(orderId, "orderId");
      if (!VALID_ORDER_STATUSES.includes(status)) throw new OrderValidationError(`Estado inválido. Valores permitidos: ${VALID_ORDER_STATUSES.join(", ")}`, "status");
      const ref = db.collection("orders").doc(orderId);
      const result = await db.runTransaction(async transaction => {
        const document = await transaction.get(ref);
        if (!document.exists) throw new OrderValidationError("Pedido no encontrado", "orderId", 404);
        const order = document.data();
        const previousStatus = order.status || "pending";
        const stockWarnings = getStockWarnings(order.items);
        if (previousStatus === status) return { order, previousStatus, status, changed: false, stockChanged: false, stockWarnings };
        if (previousStatus === "cancelled") throw new OrderValidationError("No se puede reactivar un pedido cancelado desde el panel. Requiere intervención manual en base de datos.", "status");
        const wasCommitted = COMMITTED_STOCK_STATUSES.includes(previousStatus);
        const isCommitted = COMMITTED_STOCK_STATUSES.includes(status);
        let stockChanged = false;
        if (wasCommitted !== isCommitted) {
          ({ stockChanged } = await applyStock(transaction, order.items, isCommitted ? -1 : 1));
        }
        transaction.update(ref, { status, updatedAt: timestampNow() });
        return { order, previousStatus, status, changed: true, stockChanged, stockWarnings };
      });
      // Sin mensajes ni efectos externos dentro del callback que Firestore reintenta.
      return afterCommit(result);
    },
  };
}
