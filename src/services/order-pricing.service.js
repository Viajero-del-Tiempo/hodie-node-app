export class OrderValidationError extends Error {
  constructor(message, field, statusCode = 400) {
    super(message);
    this.name = "OrderValidationError";
    this.field = field;
    this.statusCode = statusCode;
  }
}

const fail = (message, field) => { throw new OrderValidationError(message, field); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateOrderIdentifier(value, field) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("/") || value === "." || value === "..") fail(`Identificador inválido: ${field}.`, field);
  return value;
}

function text(value, field, max = 500) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || [...value].length > max) fail(`${field} debe ser texto de hasta ${max} caracteres.`, field);
  return value.trim();
}

export function validateOrderQuantity(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    fail("Cantidad inválida: debe ser un entero de 1 a 100 unidades por ítem.", "quantity");
  }
  return value;
}

// Whitelist compartida: ningún dato comercial del body forma parte de la foto.
export function sanitizeOrderItemInput(item) {
  if (!object(item)) fail("Estructura de ítem inválida.", "items");
  const customization = text(item.customization, "customization");
  const instructions = text(item.instructions, "instructions");
  if (item.packagingType !== undefined && item.packagingType !== null && (typeof item.packagingType !== "string" || !item.packagingType.trim())) fail("packagingType debe ser texto no vacío.", "packagingType");
  return {
    productId: validateOrderIdentifier(item.productId || item.id, "productId"),
    quantity: item.quantity,
    ...(item.variantId === undefined ? {} : { variantId: validateOrderIdentifier(item.variantId, "variantId") }),
    ...(item.packagingType === undefined || item.packagingType === null ? {} : { packagingType: item.packagingType.trim() }),
    // TEMPORAL hasta la entrega 6: entrada del checkout/bot con modelo viejo.
    selectedPackaging: item.selectedPackaging ?? null,
    customization: customization || instructions,
    instructions,
    customizationImageUrl: text(item.customizationImageUrl, "customizationImageUrl", 2048),
    customizationPending: item.customizationPending === true,
    customizationImagePending: item.customizationImagePending === true,
  };
}

export function variantLabel(product, variant) {
  return (product.optionNames ?? []).map(key => variant.options?.[key]).filter(value => typeof value === "string").join(" · ");
}

export function stockInsufficient(product, variant, requested) {
  return new OrderValidationError(
    `Stock insuficiente para '${product.name || product.id}', variante '${variantLabel(product, variant) || variant.id}' (SKU: ${variant.sku || variant.id}). Disponibles: ${variant.stock} unidades; solicitadas: ${requested}.`,
    "quantity",
  );
}

function money(value, field, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(`Precio inválido en ${field}.`, field);
  return value;
}

function customizationSnapshot(item, product, legacy) {
  const config = product.customization ?? {};
  if (!legacy) {
    if (item.customization && (config.allowed !== true || config.allowsText !== true)) fail("Este producto no admite personalización de texto.", "customization");
    if (item.customizationImageUrl && (config.allowed !== true || config.allowsImage !== true)) fail("Este producto no admite personalización de imagen.", "customizationImageUrl");
    if (item.customization && (!Number.isSafeInteger(config.maxChars) || [...item.customization].length > config.maxChars)) {
      fail(`La personalización admite hasta ${config.maxChars} caracteres.`, "customization");
    }
  }
  return {
    ...(item.customization ? { customization: item.customization } : {}),
    ...(item.instructions ? { instructions: item.instructions } : {}),
    ...(item.customizationImageUrl ? { customizationImageUrl: item.customizationImageUrl } : {}),
    customizationPending: legacy
      ? !item.customization || item.customizationPending
      : config.allowed === true && config.allowsText === true && !item.customization,
    customizationImagePending: legacy
      ? item.customizationImagePending
      : config.allowed === true && config.allowsImage === true && !item.customizationImageUrl,
  };
}

const normalize = value => value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().trim();

// TEMPORAL: compatibilidad del modelo viejo, se elimina en la entrega 6.
// Los tipos disponibles salen del documento; no hay nombres fijos de empaques.
function legacyPackaging(item, product) {
  const requested = item.packagingType ?? item.selectedPackaging;
  if (requested === null || requested === undefined) return null;
  const explicitType = object(requested) ? requested.type : item.packagingType;
  const raw = object(requested) ? requested.type || requested.name : requested;
  if (typeof raw !== "string" || !raw.trim()) fail("Opción de empaque inválida.", "selectedPackaging");
  const keys = Object.keys(product.packagingPrices ?? {});
  const normalized = normalize(raw);
  const exact = keys.filter(key => normalize(key) === normalized);
  const tokens = new Set(normalized.split(/\s+/u));
  const matches = exact.length ? exact : explicitType ? [] : keys.filter(key => normalize(key).split(/\s+/u).every(token => tokens.has(token)));
  if (matches.length !== 1) fail("El empaque no está configurado para este producto o es ambiguo.", "selectedPackaging");
  const type = matches[0];
  if (product.packagingPrices[type] === null || product.packagingPrices[type] === undefined) fail("El empaque no tiene un precio configurado.", "selectedPackaging");
  return { type, name: type, price: money(Number(product.packagingPrices[type]), "packagingPrices"), imageUrl: product.packagingImages?.[type] || "" };
}

function currentPackaging(item, product) {
  if (!item.packagingType) {
    if (item.selectedPackaging !== null) fail("Para seleccionar un empaque debe enviar packagingType.", "packagingType");
    return null; // Estándar sin costo, no se almacena en el catálogo.
  }
  const packaging = Array.isArray(product.packagingOptions) ? product.packagingOptions.find(option => option.type === item.packagingType) : null;
  if (!packaging) fail("El empaque no está configurado para este producto.", "packagingType");
  return { type: packaging.type, name: packaging.name, price: money(packaging.price, "packagingOptions.price"), imageUrl: packaging.imageUrl || "" };
}

// No importa Firebase: lectura directa del servicio de catálogo inyectado.
export function createOrderPricingService({ catalog }) {
  return async function calculateOrderPricing(rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) fail("El pedido debe contener al menos un ítem.", "items");
    const items = rawItems.map(sanitizeOrderItemInput);
    const products = new Map();
    const categories = new Map();
    const requestedVariants = new Map();
    const sanitizedItems = [];
    let subtotal = 0;

    for (const item of items) {
      const { productId } = item;
      if (!products.has(productId)) products.set(productId, await catalog.getProductForPricing(productId));
      const product = products.get(productId);
      if (!product) fail(`El producto '${productId}' no existe en el catálogo.`, "productId");
      if (product.active === false) fail(`El producto '${product.name || productId}' está inactivo.`, "productId");

      const legacy = product.schemaVersion === undefined || product.schemaVersion === 1;
      if (!legacy && product.schemaVersion !== 2) fail("Modelo de producto no soportado.", "productId");
      let variant;
      let price;
      if (legacy) {
        // TEMPORAL hasta entrega 6: CRUD de productos todavía guarda el modelo viejo.
        if (item.variantId !== undefined) fail("Este producto del modelo viejo no admite variantId.", "variantId");
        price = money(Number(product.price), "price");
      } else {
        if (product.active !== true) fail("El producto está inactivo.", "productId");
        if (!categories.has(product.categoryId)) categories.set(product.categoryId, await catalog.getCategoryForPricing(product.categoryId));
        if (categories.get(product.categoryId)?.active !== true) fail("La categoría del producto está inactiva o no existe.", "categoryId");
        if (!item.variantId) fail("Falta variantId; no se elige una variante automáticamente.", "variantId");
        variant = Array.isArray(product.variants) ? product.variants.find(candidate => candidate.id === item.variantId) : null;
        if (!variant || variant.active !== true) fail(`Variante '${item.variantId}' inexistente o inactiva.`, "variantId");
        price = money(variant.price, "variants.price", 1);
        if (!Number.isSafeInteger(variant.stock) || variant.stock < 0) fail("Stock inválido en la variante.", "variants.stock");
      }
      // Solo el esquema viejo acepta cantidades numéricas serializadas como texto.
      const quantity = validateOrderQuantity(legacy && typeof item.quantity === "string" ? Number(item.quantity) : item.quantity);
      if (variant) {
        const key = JSON.stringify([productId, variant.id]);
        const entry = requestedVariants.get(key) ?? { product, variant, quantity: 0 };
        entry.quantity += quantity;
        requestedVariants.set(key, entry);
      }
      const selectedPackaging = legacy ? legacyPackaging(item, product) : currentPackaging(item, product);
      const lineTotal = (price + (selectedPackaging?.price ?? 0)) * quantity;
      subtotal += lineTotal;
      if (!Number.isSafeInteger(subtotal)) fail("El total excede el rango numérico permitido.", "total");
      const sku = variant ? variant.sku : product.sku || "";
      sanitizedItems.push({
        productId, productName: product.name || productId,
        ...(variant ? { variantId: variant.id, variantLabel: variantLabel(product, variant) } : {}),
        sku, productSku: sku, // Alias temporal para consumidores actuales del pedido/PDF.
        quantity, price, selectedPackaging,
        imageUrl: (variant ? variant.imageUrls?.[0] : product.imageUrls?.[0]) || "",
        ...customizationSnapshot(item, product, legacy),
      });
    }
    for (const { product, variant, quantity } of requestedVariants.values()) {
      if (variant.stock < quantity) throw stockInsufficient(product, variant, quantity);
    }
    // Es una comprobación fresca, NO una reserva. Se vuelve a validar al pagar.
    return { sanitizedItems, subtotal, shippingCost: 0, total: subtotal };
  };
}
