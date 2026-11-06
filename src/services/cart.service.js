import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const CART_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const timestampMillis = value => typeof value?.toMillis === "function" ? value.toMillis()
  : value instanceof Date ? value.getTime() : value;
export function stableJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJSON).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ":" + stableJSON(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
export const fingerprint = value => createHash("sha256").update(stableJSON(value)).digest("hex");
export const cartContent = cart => ({ lines: cart.lines, shipping: cart.shipping, billing: cart.billing });
export function normalizeCartSnapshot(cart, chatId) {
  const copy = structuredClone(cart);
  copy.id ??= fingerprint([chatId, timestampMillis(cart.updatedAt)]);
  copy.revision ??= 0;
  copy.lines = copy.lines.map((line, index) => ({ ...line, id: line.id ?? fingerprint([copy.id, index]),
    // Los carritos anteriores no registraban la decisión: null sigue pendiente.
    packaging: { declined: false, ...line.packaging },
    customization: { text: null, imageUrl: null, pending: false, declined: false, textDraft: null, ...line.customization } }));
  return copy;
}
export function pricingInputs(cart, { includeDrafts = false } = {}) {
  return cart.lines.map(line => ({ productId: line.productId, variantId: line.variantId, quantity: line.quantity,
    packagingType: line.packagingType, customization: (includeDrafts ? line.customization.textDraft : null) ?? line.customization.text ?? "",
    customizationImageUrl: line.customization.imageUrl ?? "", customizationDeclined: line.customization.declined === true }));
}
export function purchaseError(error) {
  if (![error.statusCode, error.status].some(status => status >= 400 && status < 500)) throw error;
  return { code: error.code ?? "ARGUMENTOS_INVALIDOS", message: error.message,
    ...Object.fromEntries(["field", "productId", "variantId", "categoryId", "available", "requested", "limit", "packagingType", "suggestedRuc", "expectedDigit", "requiresConfirmation", "totalUnits", "threshold"]
      .filter(key => error[key] !== undefined).map(key => [key, error[key]])) };
}
export function cartIssue(code, field, message) {
  return Object.assign(new Error(message), { code, field, statusCode: 400 });
}

// Repositorio y reloj inyectados. No importa Firebase ni contiene precios.
export function createCartService({ repository, chatId, now = Date.now, newId = randomUUID, calculatePricing, onChange = async () => {}, onUnavailable = async () => {} }) {
  if (!repository?.get || !repository?.set || !chatId || !calculatePricing) throw new Error("Puerto de carrito incompleto");
  const blank = () => ({ id: newId(), revision: 0, lines: [],
    shipping: { recipientName: null, recipientDocument: null, city: null, department: null, street: null, phone: null },
    billing: { invoiceRequested: null, legalName: null, ruc: null, rucValidation: null }, updatedAt: now(), expiresAt: now() + CART_TTL_MS });
  async function read({ signal } = {}) {
    signal?.throwIfAborted();
    const cart = await repository.get(chatId);
    signal?.throwIfAborted();
    if (!cart || timestampMillis(cart.expiresAt) <= now()) { await onUnavailable({ signal }); return null; }
    return normalizeCartSnapshot(cart, chatId);
  }
  async function commit(candidate, { signal, operation } = {}) {
    signal?.throwIfAborted();
    const old = await read({ signal });
    if (old && (old.id !== candidate.id || old.revision !== candidate.revision)) {
      throw cartIssue("CARRITO_CAMBIO", "cart", "El carrito cambió durante esta operación. Volvé a consultarlo antes de modificarlo.");
    }
    if (old && isDeepStrictEqual(cartContent(old), cartContent(candidate))) return old;
    const next = { ...candidate, revision: (old?.revision ?? 0) + 1, updatedAt: now(), expiresAt: now() + CART_TTL_MS };
    signal?.throwIfAborted();
    await repository.set(chatId, next, { expectedRevision: old?.revision ?? null, signal });
    signal?.throwIfAborted();
    await onChange({ cart: next, previous: old, operation, signal });
    return structuredClone(next);
  }
  const identity = line => stableJSON([line.productId, line.variantId, line.packagingType ?? null,
    (line.customization.textDraft ?? line.customization.text ?? "").trim()]);
  function merge(lines) {
    const result = [];
    for (const line of lines) {
      const previous = result.find(row => identity(row) === identity(line));
      if (!previous) result.push(line);
      else {
        // Imágenes diferentes no se descartan al fusionar una identidad igual.
        if (previous.customization.imageUrl && line.customization.imageUrl && previous.customization.imageUrl !== line.customization.imageUrl) {
          throw cartIssue("IMAGENES_DISTINTAS", "attachmentId", "Las líneas coinciden, pero tienen imágenes distintas. Modificá una línea antes de sumarlas.");
        }
        previous.quantity += line.quantity;
        // Sumar una línea sin decisión no deshace una elección explícita previa.
        previous.packaging.declined ||= line.packaging.declined;
        previous.customization.imageUrl ||= line.customization.imageUrl;
        if (line.customization.declined) previous.customization = { ...line.customization };
      }
    }
    return result;
  }
  async function saveLines(candidate, context) {
    candidate.lines = merge(candidate.lines);
    if (candidate.lines.length) {
      const pricing = await calculatePricing(pricingInputs(candidate, { includeDrafts: true }));
      context.signal?.throwIfAborted();
      candidate.lines.forEach((line, index) => { line.customization.pending = line.customization.textDraft !== null || pricing.sanitizedItems[index].customizationPending; });
    }
    return commit(candidate, context);
  }
  return { read, commit, blank,
    async add(line, context = {}) {
      const cart = await read(context) ?? blank();
      const next = { ...line, id: newId() };
      cart.lines.push(next);
      return saveLines(cart, { ...context, operation: "add" });
    },
    async modify(id, change, context = {}) {
      const cart = await read(context);
      const index = cart?.lines.findIndex(line => line.id === id) ?? -1;
      if (index < 0) throw cartIssue("LINEA_INEXISTENTE", "linea", "Esta línea ya no está en el carrito.");
      cart.lines[index] = { ...cart.lines[index], ...change, id };
      return saveLines(cart, { ...context, operation: "modify" });
    },
    async remove(id, context = {}) {
      const cart = await read(context);
      if (!cart?.lines.some(line => line.id === id)) throw cartIssue("LINEA_INEXISTENTE", "linea", "Esta línea ya no está en el carrito.");
      cart.lines = cart.lines.filter(line => line.id !== id);
      // Quitar permite reparar un carrito con referencias/stock obsoletos.
      return commit(cart, context);
    },
  };
}
