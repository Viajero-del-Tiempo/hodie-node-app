export const MAX_SHOWN_PRODUCTS = 3;

// El catálogo conserva el orden de variantes e imágenes. Una variante agotada
// sigue activa y puede representar el producto; nunca se usa una inactiva.
export function mainProductImage(product) {
  return product.variants.find(variant => variant.active === true && variant.imageUrls?.length)?.imageUrls[0] ?? null;
}

function displayedPrice(product, variantId, extra = 0) {
  const active = product.variants.filter(variant => variant.active === true);
  const variants = variantId === undefined ? active : active.filter(variant => variant.id === variantId);
  if (!variants.length) throw Object.assign(new Error("Variante no disponible"), { code: "VARIANTE_INACTIVA" });
  const prices = variants.map(variant => variant.price);
  if (!prices.length || prices.some(price => !Number.isSafeInteger(price) || price < 0)) throw new Error("Precio de catálogo inválido");
  const base = Math.min(...prices), price = base + extra, varies = prices.some(value => value !== base);
  if (!Number.isSafeInteger(extra) || extra < 0 || !Number.isSafeInteger(price)) throw new Error("Precio de catálogo inválido");
  return (varies ? "Desde " : "") + new Intl.NumberFormat("es-PY").format(price) + " Gs.";
}
export const productImageCaption = product => product.name + " — " + displayedPrice(product);
export const packagingImageCaption = (product, packaging, variantId) =>
  product.name + " con " + packaging.name + " — " + displayedPrice(product, variantId, packaging.price);

export function createProductImages(runtime) {
  const { catalog, getState, setState, transport, getTurnContext = () => null } = runtime;
  let excludedTurn = undefined;
  const turnId = () => getTurnContext()?.id ?? null;
  const entries = () => {
    const rows = getState().sentProductImages;
    return Array.isArray(rows) ? rows : [];
  };
  const record = (code, productId, metadata = {}) => {
    const event = { event: "product_image", code, productId, ...metadata, turn: getTurnContext()?.sequence ?? null };
    try { (runtime.recordImageEvent ?? (value => console.warn(JSON.stringify(value))))(event); } catch { /* El log no corta el cierre. */ }
  };
  const save = async (update, signal) => {
    signal?.throwIfAborted();
    const state = getState(); state.sentProductImages = update(Array.isArray(state.sentProductImages) ? state.sentProductImages : []);
    await setState(state); signal?.throwIfAborted();
  };
  async function sendOne(productId, source, caption, signal, metadata = {}) {
    signal?.throwIfAborted();
    if (entries().some(entry => entry.source === source)) return { skipped: { productId, ...metadata, reason: "YA_ENVIADA" } };
    // Reservar antes del envío evita repetir una entrega incierta tras reinicio.
    // Un error explícito libera la reserva; no se reintenta dentro del turno.
    try { await save(rows => [...rows, { productId, ...metadata, source, caption, delivery: "pending" }], signal); }
    catch { signal?.throwIfAborted(); record("PRODUCT_IMAGE_CHECKPOINT_FAILED", productId, metadata);
      return { failed: { productId, ...metadata, code: "PRODUCT_IMAGE_CHECKPOINT_FAILED" } }; }
    try { await transport.sendImage({ source, caption, productId, ...metadata, signal }); signal?.throwIfAborted(); }
    catch {
      signal?.throwIfAborted();
      try { await save(rows => rows.filter(entry => entry.source !== source), signal); }
      catch { signal?.throwIfAborted(); record("PRODUCT_IMAGE_CHECKPOINT_FAILED", productId, metadata); }
      record("PRODUCT_IMAGE_SEND_FAILED", productId, metadata);
      return { failed: { productId, ...metadata, code: "PRODUCT_IMAGE_SEND_FAILED" } };
    }
    try { await save(rows => rows.map(entry => entry.source === source ? { ...entry, delivery: "sent" } : entry), signal); }
    catch { signal?.throwIfAborted(); record("PRODUCT_IMAGE_CHECKPOINT_FAILED", productId, metadata); }
    return { sent: { productId, ...metadata, caption } };
  }
  const service = {
    excludeForTurn() { excludedTurn = turnId(); },
    allowForTurn() { excludedTurn = undefined; },
    canPresent(allowed = true) { return allowed && excludedTurn !== turnId(); },
    async show(productIds, { signal, allowed = true, beforePresentation } = {}) {
      const result = { sent: [], skipped: [], failed: [], textOnly: [] };
      for (const productId of productIds.slice(0, MAX_SHOWN_PRODUCTS)) {
        signal?.throwIfAborted();
        if (!allowed || excludedTurn === turnId()) { result.skipped.push({ productId, reason: "CONTENIDO_NO_APLICA" }); continue; }
        let product, source, caption;
        try {
          product = await catalog.getProduct(productId); signal?.throwIfAborted();
          if (!product) { result.skipped.push({ productId, reason: "PRODUCTO_NO_ENCONTRADO" }); continue; }
          source = mainProductImage(product);
          caption = productImageCaption(product);
        } catch { signal?.throwIfAborted(); record("PRODUCT_IMAGE_LOOKUP_FAILED", productId);
          result.failed.push({ productId, code: "PRODUCT_IMAGE_LOOKUP_FAILED" }); continue; }
        // El cierre envía la introducción recién cuando hay una fila válida.
        await beforePresentation?.(); signal?.throwIfAborted();
        if (source) {
          const outcome = await sendOne(productId, source, caption, signal);
          for (const key of ["sent", "skipped", "failed"]) if (outcome[key]) result[key].push(outcome[key]);
          if (outcome.sent) continue;
        } else result.skipped.push({ productId, reason: "SIN_IMAGENES" });
        // La lista sigue siendo completa si falta la foto, ya se envió o falló.
        try { await transport.sendText(caption); signal?.throwIfAborted(); result.textOnly.push({ productId, caption }); }
        catch { signal?.throwIfAborted(); record("PRODUCT_IMAGE_TEXT_FAILED", productId);
          result.failed.push({ productId, code: "PRODUCT_IMAGE_TEXT_FAILED" }); }
      }
      return result;
    },
    async showPackaging(requests, { signal, allowed = true, beforePresentation } = {}) {
      const result = { sent: [], skipped: [], failed: [], textOnly: [] }, pictures = [];
      for (const request of requests.slice(0, MAX_SHOWN_PRODUCTS)) {
        signal?.throwIfAborted();
        const { productId, packagingType, variantId } = request, metadata = { packagingType };
        if (!allowed || excludedTurn === turnId()) { result.skipped.push({ productId, ...metadata, reason: "CONTENIDO_NO_APLICA" }); continue; }
        try {
          const product = await catalog.getProduct(productId); signal?.throwIfAborted();
          if (!product) { result.skipped.push({ productId, ...metadata, reason: "PRODUCTO_NO_ENCONTRADO" }); continue; }
          const packaging = product.packagingOptions?.find(option => option.type === packagingType);
          if (!packaging) { result.skipped.push({ productId, ...metadata, reason: "EMPAQUE_INEXISTENTE" }); continue; }
          const caption = packagingImageCaption(product, packaging, variantId);
          if (!packaging.imageUrl) { result.textOnly.push({ productId, ...metadata, caption }); result.skipped.push({ productId, ...metadata, reason: "SIN_IMAGENES" }); }
          else pictures.push({ productId, metadata, source: packaging.imageUrl, caption });
        } catch (error) { signal?.throwIfAborted();
          if (error?.code === "VARIANTE_INACTIVA") result.skipped.push({ productId, ...metadata, reason: error.code });
          else { record("PACKAGING_IMAGE_LOOKUP_FAILED", productId, metadata); result.failed.push({ productId, ...metadata, code: "PACKAGING_IMAGE_LOOKUP_FAILED" }); }
        }
      }
      if (result.textOnly.length || pictures.length) { await beforePresentation?.(); signal?.throwIfAborted(); }
      if (result.textOnly.length) {
        try { await transport.sendText(result.textOnly.map(row => row.caption).join("\n")); signal?.throwIfAborted(); }
        catch { signal?.throwIfAborted();
          for (const row of result.textOnly) { record("PACKAGING_IMAGE_TEXT_FAILED", row.productId, { packagingType: row.packagingType });
            result.failed.push({ productId: row.productId, packagingType: row.packagingType, code: "PACKAGING_IMAGE_TEXT_FAILED" }); }
          result.textOnly = [];
        }
      }
      for (const picture of pictures) {
        const outcome = await sendOne(picture.productId, picture.source, picture.caption, signal, picture.metadata);
        for (const key of ["sent", "skipped", "failed"]) if (outcome[key]) result[key].push(outcome[key]);
      }
      return result;
    },
    async sendRequested(product, variant, { signal, packagingType } = {}) {
      let presentations;
      if (packagingType !== undefined) {
        const packaging = product.packagingOptions?.find(option => option.type === packagingType);
        if (!packaging) return { code: "EMPAQUE_INEXISTENTE", sent: 0 };
        if (!packaging.imageUrl) return { code: "SIN_IMAGENES", sent: 0 };
        presentations = [{ source: packaging.imageUrl, caption: packagingImageCaption(product, packaging, variant?.id), metadata: { packagingType } }];
      } else {
        presentations = [...(variant ? variant.imageUrls ?? [] : product.variants.flatMap(row => row.imageUrls ?? [])),
          ...(product.imageUrls ?? [])].map(source => ({ source, caption: product.name, metadata: {} }));
        for (const packaging of product.packagingOptions ?? []) if (packaging.imageUrl) presentations.push({ source: packaging.imageUrl,
          caption: packagingImageCaption(product, packaging, variant?.id), metadata: { packagingType: packaging.type } });
      }
      const unique = [...new Map(presentations.map(row => [row.source, row])).values()];
      const sources = unique.filter(row => !entries().some(entry => entry.source === row.source)).slice(0, 3);
      let sent = 0, failed = 0;
      for (const picture of sources) {
        const outcome = await sendOne(product.id, picture.source, picture.caption, signal, picture.metadata);
        if (outcome.sent) sent++; if (outcome.failed) failed++;
      }
      return { code: sent ? "OK" : failed ? "PRODUCT_IMAGE_SEND_FAILED" : unique.length ? "YA_ENVIADAS" : "SIN_IMAGENES", sent };
    },
  };
  return service;
}
