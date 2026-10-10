export const CART_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Formato v2 del encabezado de conversations.yaml. No interpreta lenguaje libre.
export function validateContext(context, fixtures, issue, root = ["context"]) {
  const at = (path, message, code = "INVALID_CONTEXT") => issue(path, message, code);
  function object(value, keys, path) {
    if (!isObject(value)) { at(path, "Debe ser un objeto"); return false; }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) at([...path, key], "Clave de contexto desconocida: " + key, "UNKNOWN_CONTEXT_KEY");
    }
    return true;
  }
  function text(value, path, nullable = false) {
    if (nullable && value === null) return;
    if (typeof value !== "string" || !value.trim()) at(path, "Debe ser texto no vacío");
  }
  function bool(value, path) {
    if (typeof value !== "boolean") at(path, "Debe ser booleano");
  }
  function hours(value, path) {
    if (!Number.isFinite(value) || value < 0) at(path, "Debe ser una cantidad de horas no negativa");
  }
  function messages(value, path) {
    if (!Array.isArray(value)) { at(path, "Debe ser una lista de mensajes"); return; }
    value.forEach((message, index) => {
      const child = [...path, index];
      if (!object(message, ["cliente", "agente"], child)) return;
      const roles = Object.keys(message);
      if (roles.length !== 1) at(child, "Cada mensaje debe tener solo cliente o agente");
      for (const role of roles) text(message[role], [...child, role]);
    });
  }
  if (!object(context, ["telefonoCliente", "sesionNueva", "historialPrevio", "conversacion", "carrito", "cotizacionMostrada"], root)) return;
  if (Object.hasOwn(context, "telefonoCliente")) {
    text(context.telefonoCliente, [...root, "telefonoCliente"]);
    if (typeof context.telefonoCliente === "string" && !/^\d+$/.test(context.telefonoCliente)) {
      at([...root, "telefonoCliente"], "Debe ser un teléfono numérico, nunca un LID");
    }
  }
  for (const key of ["sesionNueva", "cotizacionMostrada"]) {
    if (Object.hasOwn(context, key)) bool(context[key], [...root, key]);
  }
  if (Object.hasOwn(context, "conversacion")) messages(context.conversacion, [...root, "conversacion"]);
  if (Object.hasOwn(context, "historialPrevio")) {
    const history = context.historialPrevio;
    const path = [...root, "historialPrevio"];
    if (object(history, ["haceHoras", "duranteHandoff", "mensajes"], path)) {
      if (Object.hasOwn(history, "haceHoras")) hours(history.haceHoras, [...path, "haceHoras"]);
      if (Object.hasOwn(history, "duranteHandoff")) bool(history.duranteHandoff, [...path, "duranteHandoff"]);
      if (Object.hasOwn(history, "mensajes")) messages(history.mensajes, [...path, "mensajes"]);
    }
  }
  if (Object.hasOwn(context, "carrito")) {
    const cart = context.carrito;
    const path = [...root, "carrito"];
    if (object(cart, ["actualizadoHaceHoras", "lineas", "envio", "facturacion"], path)) {
      if (Object.hasOwn(cart, "actualizadoHaceHoras")) hours(cart.actualizadoHaceHoras, [...path, "actualizadoHaceHoras"]);
      if (Object.hasOwn(cart, "lineas")) {
        if (!Array.isArray(cart.lineas)) at([...path, "lineas"], "Debe ser una lista de líneas");
        else cart.lineas.forEach((line, index) => {
          const child = [...path, "lineas", index];
          if (!object(line, ["producto", "variante", "cantidad", "texto", "empaque"], child)) return;
          text(line.producto, [...child, "producto"]);
          text(line.variante, [...child, "variante"]);
          if (!Number.isSafeInteger(line.cantidad) || line.cantidad < 1) at([...child, "cantidad"], "Debe ser un entero positivo");
          if (Object.hasOwn(line, "texto") && line.texto !== null && typeof line.texto !== "string") at([...child, "texto"], "Debe ser texto o null");
          if (Object.hasOwn(line, "empaque")) text(line.empaque, [...child, "empaque"], true);
          const product = fixtures.products?.find(item => item.id === line.producto);
          if (!product) at([...child, "producto"], "Producto inexistente en los fixtures: " + String(line.producto), "UNKNOWN_PRODUCT");
          else {
            if (!product.variants?.some(variant => variant.id === line.variante)) {
              at([...child, "variante"], "Variante inexistente en ese producto: " + String(line.variante), "UNKNOWN_VARIANT");
            }
            if (typeof line.empaque === "string" && !product.packagingOptions?.some(pack => pack.type === line.empaque)) {
              at([...child, "empaque"], "Empaque inexistente en ese producto: " + line.empaque, "UNKNOWN_PACKAGING");
            }
          }
        });
      }
      if (Object.hasOwn(cart, "envio")) {
        const child = [...path, "envio"];
        if (object(cart.envio, ["destinatario", "documento", "ciudad", "departamento", "direccion", "telefono"], child)) {
          for (const key of Object.keys(cart.envio)) text(cart.envio[key], [...child, key]);
        }
      }
      if (Object.hasOwn(cart, "facturacion")) {
        const child = [...path, "facturacion"];
        if (object(cart.facturacion, ["requiere", "razonSocial", "ruc"], child)) {
          bool(cart.facturacion.requiere, [...child, "requiere"]);
          for (const key of ["razonSocial", "ruc"]) {
            if (Object.hasOwn(cart.facturacion, key)) {
              text(cart.facturacion[key], [...child, key]);
              if (cart.facturacion.requiere === false) at([...child, key], "Consumidor final solo admite requiere: false");
            }
          }
        }
      }
    }
  }
  if (context.cotizacionMostrada === true && !isObject(context.carrito)) {
    at([...root, "cotizacionMostrada"], "Requiere un carrito inicial", "MISSING_INITIAL_CART");
  }
}

const convertMessages = messages => (messages ?? []).map(message => ({
  role: Object.hasOwn(message, "cliente") ? "user" : "assistant",
  content: message.cliente ?? message.agente,
}));

export function buildInitialState(context = {}, fixtures, { chatId, now }) {
  const diagnostics = [];
  validateContext(context, fixtures, (path, message, code) => diagnostics.push({ path, message, code }));
  if (diagnostics.length) {
    const error = new Error("Contexto inválido");
    error.code = "INVALID_CONTEXT";
    error.diagnostics = diagnostics;
    throw error;
  }
  const oldMessages = convertMessages(context.historialPrevio?.mensajes);
  const currentMessages = convertMessages(context.conversacion);
  const lastActivityAt = currentMessages.length ? now - 1
    : oldMessages.length ? now - (context.historialPrevio.haceHoras ?? 0) * HOUR_MS : null;
  const state = {
    messages: [...oldMessages, ...currentMessages], whatsappChatId: chatId,
    userPhoneNumber: context.telefonoCliente ?? null, phoneVerified: Object.hasOwn(context, "telefonoCliente"),
    pushname: null, sessionCutoff: oldMessages.length, lastActivityAt,
    consecutiveMisunderstandings: 0, humanHandoffRequired: false, humanHandoffReason: null, lastQuote: null,
    guardianRateLimit: { admittedAt: [], blocked: false, episodeId: null }, guardianAlerts: [],
    resumeRequestedAt: null, resumeAppliedAt: null,
  };
  let cart = null;
  if (context.carrito) {
    const source = context.carrito;
    const updatedAt = now - (source.actualizadoHaceHoras ?? 0) * HOUR_MS;
    cart = {
      lines: (source.lineas ?? []).map(line => {
        const product = fixtures.products.find(item => item.id === line.producto);
        return {
          productId: line.producto, variantId: line.variante, quantity: line.cantidad,
          packagingType: line.empaque ?? null,
          customization: {
            text: line.texto ?? null, imageUrl: null,
            pending: product.customization?.allowed === true && product.customization?.allowsText === true && !line.texto,
          },
        };
      }),
      shipping: {
        recipientName: source.envio?.destinatario ?? null, recipientDocument: source.envio?.documento ?? null,
        city: source.envio?.ciudad ?? null, department: source.envio?.departamento ?? null,
        street: source.envio?.direccion ?? null, phone: source.envio?.telefono ?? null,
      },
      billing: {
        invoiceRequested: source.facturacion?.requiere ?? null,
        legalName: source.facturacion?.razonSocial ?? null, ruc: source.facturacion?.ruc ?? null,
        // El servidor/herramienta real calcula la validación fiscal; el fixture no la afirma.
        rucValidation: null,
      },
      updatedAt, expiresAt: updatedAt + CART_TTL_MS,
    };
    if (cart.expiresAt <= now) cart = null;
  }
  return {
    state, cart,
    scenario: {
      newSession: context.sesionNueva === true,
      previousSession: context.historialPrevio ? {
        happenedAt: now - (context.historialPrevio.haceHoras ?? 0) * HOUR_MS,
        duringHandoff: context.historialPrevio.duranteHandoff === true,
      } : null,
    },
  };
}

export async function prepareShownQuote(context, world, signal) {
  if (!context?.cotizacionMostrada) return;
  if (!world.isRealTool("cotizar")) {
    const error = new Error("cotizacionMostrada requiere la herramienta real cotizar; todavía no está disponible");
    error.code = "QUOTE_TOOL_UNAVAILABLE";
    throw error;
  }
  if (!world.getCart()) {
    const error = new Error("El carrito inicial no existe o está vencido");
    error.code = "INITIAL_CART_UNAVAILABLE";
    throw error;
  }
  const quote = await world.invokeTool("cotizar", {}, { phase: "setup", turn: 0, signal });
  if (quote?.code !== "OK" || typeof quote.quoteId !== "string" || !quote.quoteId
      || typeof quote.cartFingerprint !== "string" || !quote.cartFingerprint) {
    const error = new Error("La herramienta real no devolvió una cotización válida: " + String(quote?.code ?? "INVALID_QUOTE"));
    error.code = "INITIAL_QUOTE_FAILED";
    throw error;
  }
  const state = world.getState();
  state.lastQuote = {
    quoteId: quote.quoteId, cartFingerprint: quote.cartFingerprint, shownAt: world.now() - 1, shownTurn: 0,
  };
  state.messages.push({
    role: "assistant",
    content: typeof quote.summary === "string" ? quote.summary : "Cotización mostrada: " + JSON.stringify(quote),
  });
  world.setState(state);
}
