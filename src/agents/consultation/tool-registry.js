import { MAX_SHOWN_PRODUCTS } from "./product-images.js";

const string = description => ({ type: "string", description });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const lineChanges = {
  variantId: string("ID de variante del mismo producto."), quantity: { type: "integer", minimum: 1 },
  packagingType: { ...string("Tipo del empaque del catálogo; null solo si el cliente eligió sin empaque. Omitilo si no decidió."), nullable: true },
  texto: { ...string("Texto literal propuesto por el cliente; null para quitarlo."), nullable: true },
  confirmarTexto: string("Repetí exactamente el texto que el cliente confirmó después de verlo."),
  sinPersonalizacion: { type: "boolean", description: "true solo si el cliente eligió explícitamente sin personalización." },
  attachmentId: string("Imagen admitida del turno actual para personalización."),
};
export const CONSULTATION_SCHEMAS = Object.freeze({
  buscar_productos: object({ consulta: string("Términos de búsqueda."), categoriaId: string("ID de categoría obtenido del contexto o catálogo."),
    opciones: { type: "object", additionalProperties: { type: "string" }, description: "Ejes y valores obtenidos del catálogo." },
    soloDisponibles: { type: "boolean", description: "Por defecto false: incluye variantes agotadas." },
    limite: { type: "integer", minimum: 1, maximum: 5, description: "De uno a cinco; por defecto cinco." } }, ["consulta"]),
  ver_producto: object({ productId: string("ID obtenido del catálogo.") }, ["productId"]),
  enviar_imagenes: object({ productId: string("ID obtenido del catálogo."), variantId: string("ID de variante del producto; opcional."),
    packagingType: string("Tipo real del empaque obtenido del catálogo; si se indica, muestra solo ese empaque.") }, ["productId"]),
  consultar_politicas: object({}),
  estado_pedido: object({ orderNumber: string("Número de pedido indicado por el cliente."), phone: string("Teléfono de compra indicado por el cliente; no verifica la identidad.") }),
  carrito_ver: object({}),
  carrito_agregar: object({ productId: string("Producto del catálogo."), ...lineChanges }, ["productId", "variantId", "quantity"]),
  carrito_modificar: object({ linea: string("ID estable devuelto por carrito_ver."), cambios: object(lineChanges) }, ["linea", "cambios"]),
  carrito_quitar: object({ linea: string("ID estable de la línea." ) }, ["linea"]),
  datos_envio: object(Object.fromEntries(["recipientName", "recipientDocument", "city", "department", "street", "phone"].map(key => [key, string("Dato indicado por el cliente: " + key)]))),
  datos_facturacion: object({ invoiceRequested: { type: "boolean" }, legalName: string("Razón social indicada por el cliente."),
    ruc: string("RUC literal; no agregues ni cambies dígitos."), confirmedRuc: string("Propuesta exacta confirmada por el cliente en un turno posterior."),
    acknowledgeRucMismatch: { type: "boolean", description: "Aceptación explícita posterior del RUC con discrepancia; el servidor verifica la evidencia." },
    billingProfileId: string("Registro fiscal del perfil verificado del cliente actual.") }, ["invoiceRequested"]),
  cotizar: object({ lineas: { type: "array", minItems: 1,
    description: "Cálculo informativo sin armar ni modificar el carrito, nunca confirmable. Omití lineas para cotizar el carrito actual.",
    items: object({ productId: string("ID del producto del catálogo."), variantId: string("ID de su variante."),
      quantity: { type: "integer", minimum: 1 }, packagingType: { ...string("Tipo real del empaque; opcional."), nullable: true } },
    ["productId", "variantId", "quantity"]) } }),
  crear_pedido: object({ quoteId: string("Cotización vigente mostrada. Solo funciona con confirmación del cliente en un lote posterior; el servidor la verifica.") }, ["quoteId"]),
  registrar_comprobante: object({ attachmentId: string("Imagen o PDF admitido de este turno."),
    comprobanteId: string("Comprobante privado pendiente devuelto por el servidor, para seleccionar pedido en un turno posterior."),
    orderNumber: string("Número indicado por el cliente; el servidor comprueba dueño y estado pendiente.") }),
  derivar: object({ motivo: string("Motivo de la solicitud humana o del reclamo; sin datos inventados."),
    texto: string("Mensaje al cliente: una persona del equipo seguirá por este chat, sin promesas de tiempo.") }, ["motivo", "texto"]),
  responder: object({ texto: string("Respuesta final; con productosMostrados, solo introducción breve, sin listar productos ni precios. Para un precio puntual sin lista, podés escribir el precio de la herramienta."),
    cierre: string("Cierre opcional de la lista, después de las fotos/líneas del servidor; sin listar productos ni precios."),
    entendido: { type: "boolean", description: "Si se entendió el mensaje del cliente." },
    fueraDeAlcance: { type: "boolean", description: "true si pide algo que la tienda no ofrece, aunque lo entendiste. Stock insuficiente no implica fuera de alcance. Por defecto false." },
    quoteIdMostrado: string("ID devuelto por cotizar para que el servidor agregue y registre el resumen completo." ),
    productosMostrados: { type: "array", maxItems: MAX_SHOWN_PRODUCTS, items: string("ID de un producto a presentar, obtenido del catálogo."),
      description: "Hasta tres IDs distintos. El servidor arma la lista: introducción texto, foto o línea por producto con nombre/precio del catálogo, cierre opcional. No listes productos/precios en texto/cierre ni lo uses en cotizaciones, pedidos, estados o políticas; nunca afirmes envíos." },
    empaquesMostrados: { type: "array", maxItems: MAX_SHOWN_PRODUCTS,
      items: object({ productId: string("ID del producto del catálogo."), packagingType: string("Tipo real de opción de empaque."),
        variantId: string("Variante elegida; si se omite, el pie indica desde cuando los precios varían.") }, ["productId", "packagingType"]),
      description: "Empaques que ofrecés, hasta tres presentaciones en total junto con productosMostrados. El servidor envía foto con precio por unidad del producto con empaque; sin foto agrega una línea textual. Nunca afirmes entrega ni pases precios/URLs." } }, ["texto", "entendido"]),
});
export const CONSULTATION_TOOL_NAMES = Object.freeze(Object.keys(CONSULTATION_SCHEMAS));
const descriptions = {
  buscar_productos: "Busca productos y variantes, con priceFrom, variants[].price, stock, available y matchedTerms. Hasta cinco resultados para elegir: presentá como máximo tres por mensaje y ofrecé ver más si corresponde.",
  ver_producto: "Obtiene el producto público completo: atributos, variantes, personalización, imágenes y empaques propios.",
  enviar_imagenes: "Envía hasta tres imágenes adicionales del catálogo, incluyendo empaques; packagingType permite pedir un empaque concreto. No crea imágenes ni acepta URLs del modelo.",
  consultar_politicas: "Obtiene todas las políticas vigentes; sus temas son libres.",
  estado_pedido: "Consulta un pedido. Identidad verificada y dueño: estado y productos. Si no, exige número y teléfono coincidentes y muestra solo el estado.",
  carrito_ver: "Lee carrito, IDs y pendientes en orden: personalización, empaque, envío, facturación. No renueva su vencimiento.",
  carrito_agregar: "Agrega o suma una línea; valida stock agregado y personalización. El texto se guarda primero como borrador por confirmar.",
  carrito_modificar: "Modifica una línea sin perder otros datos. confirmarTexto solo acepta evidencia posterior del cliente.",
  carrito_quitar: "Quita una línea por su ID estable.",
  datos_envio: "Guarda borrador y devuelve carrito, pendientes y options: shippingMethod, shippingCost (cargo del pedido), requiresRecipientDocument y label (flete). Comunicá esos datos en este turno; pendientes guía la próxima pregunta. El teléfono escrito nunca verifica la identidad.",
  datos_facturacion: "Guarda decisión fiscal y borrador. Valida RUC y confirmaciones; solo permite elegir registros del perfil verificado propio.",
  cotizar: "Calcula con pricing del servidor. Con lineas: subtotales por línea y productsTotal informativos, sin carrito ni quoteId. Sin lineas: cotiza el carrito; DATO_FALTANTE da subtotal no confirmable; completo da quoteId y huellas.",
  crear_pedido: "Registra idempotentemente el pedido tras confirmación posterior. Verifica carrito, precios y stock en transacción. El servidor agrega el mensaje de pedido y pago al responder; nunca copies ni reformules datos bancarios.",
  registrar_comprobante: "Registra imagen/PDF como comprobante, sin confirmar pagos ni modificar pedidos. Acepta attachmentId O comprobanteId. Sin número: uno asocia, varios pide elegir, ninguno informa falta de pedido. El acuse lo agrega el servidor al responder.",
  derivar: "Activa el handoff, solicita una alerta durable y cierra. Pedidos explícitos y reclamos derivan directo; ante condiciones fuera de política o cantidad corporativa primero ofrecé y esperá aceptación.",
  responder: "Cierra el turno. Con productosMostrados, texto solo introduce; el servidor lista fotos o líneas con nombres/precios y luego cierre opcional. Resultados sent/skipped/failed/textOnly. empaquesMostrados presenta empaques del catálogo. quoteIdMostrado agrega el resumen del servidor y registra lastQuote solo después del envío.",
};
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = (field, message) => ({ code: "ARGUMENTOS_INVALIDOS", field, message });

function validate(schema, value, path = "") {
  if (schema.nullable && value === null) return null;
  if (schema.type === "object") {
    if (!isObject(value)) return invalid(path || "arguments", "Debe ser un objeto.");
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return invalid(path ? path + "." + key : key, "Falta este campo.");
    for (const [key, item] of Object.entries(value)) {
      const field = path ? path + "." + key : key;
      if (["__proto__", "constructor", "prototype"].includes(key)) return invalid(field, "Clave no permitida.");
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : schema.additionalProperties;
      if (!child) return invalid(field, "Campo desconocido.");
      const error = validate(child, item, field);
      if (error) return error;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return invalid(path, "Arreglo fuera del tamaño permitido.");
    for (const [index, item] of value.entries()) {
      const error = validate(schema.items, item, path + "[" + index + "]");
      if (error) return error;
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string" || !value.trim() || value.length > 4000) return invalid(path, "Debe ser texto no vacío de hasta 4000 caracteres.");
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return invalid(path, "Debe ser booleano.");
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) return invalid(path, "Entero fuera del intervalo permitido.");
  }
  return null;
}

export function createToolRegistry(handlers) {
  function check(name, args) {
    if (!Object.hasOwn(CONSULTATION_SCHEMAS, name)) return { code: "HERRAMIENTA_NO_DISPONIBLE", message: "Esta herramienta no está disponible." };
    const error = validate(CONSULTATION_SCHEMAS[name], args);
    if (error) return error;
    if (args.cierre !== undefined && !(args.productosMostrados?.length || args.empaquesMostrados?.length)) return {
      code: "LISTA_FALTANTE", field: "cierre",
      message: "El cierre corresponde a una lista: pasá productosMostrados o empaquesMostrados. Para responder un precio puntual sin lista, escribí la respuesta completa en texto.",
    };
    if (name === "registrar_comprobante" && Number(Object.hasOwn(args, "attachmentId")) + Number(Object.hasOwn(args, "comprobanteId")) !== 1) return invalid("attachmentId", "Indicá attachmentId o comprobanteId, uno solo.");
    if ((args.productosMostrados?.length ?? 0) + (args.empaquesMostrados?.length ?? 0) > MAX_SHOWN_PRODUCTS) return invalid("empaquesMostrados", "Mostrá hasta tres productos o empaques en total.");
    const packagingKeys = new Set();
    for (const [index, item] of (args.empaquesMostrados ?? []).entries()) {
      for (const key of ["productId", "variantId"]) if (item[key] !== undefined
          && (item[key] !== item[key].trim() || item[key].includes("/") || [".", ".."].includes(item[key]) || item[key].length > 200)) return invalid("empaquesMostrados[" + index + "]." + key, "Identificador inválido.");
      if (item.packagingType !== item.packagingType.trim()) return invalid("empaquesMostrados[" + index + "].packagingType", "Tipo de empaque inválido.");
      const key = JSON.stringify([item.productId, item.packagingType]);
      if (packagingKeys.has(key)) return invalid("empaquesMostrados[" + index + "]", "Empaque repetido.");
      packagingKeys.add(key);
    }
    for (const [index, id] of (args.productosMostrados ?? []).entries()) {
      if (id !== id.trim() || id.includes("/") || [".", ".."].includes(id) || id.length > 200) return invalid("productosMostrados[" + index + "]", "Identificador inválido.");
      if (args.productosMostrados.indexOf(id) !== index) return invalid("productosMostrados[" + index + "]", "Producto duplicado.");
    }
    for (const field of ["productId", "variantId", "categoriaId", "orderNumber", "linea", "billingProfileId", "quoteIdMostrado", "quoteId", "attachmentId", "comprobanteId"]) {
      if (args[field] !== undefined && (args[field] !== args[field].trim() || args[field].includes("/")
          || [".", ".."].includes(args[field]) || args[field].length > 200)) return invalid(field, "Identificador inválido.");
    }
    if (name === "carrito_modificar" && !Object.keys(args.cambios).length) return invalid("cambios", "Indicá qué dato querés modificar.");
    for (const [index, line] of (args.lineas ?? []).entries()) {
      for (const key of ["productId", "variantId"]) {
        if (line[key] !== line[key].trim() || line[key].includes("/") || [".", ".."].includes(line[key]) || line[key].length > 200) {
          return invalid("lineas[" + index + "]." + key, "Identificador inválido.");
        }
      }
    }
    return null;
  }
  return {
    names: CONSULTATION_TOOL_NAMES, check,
    async dispatch(name, args, context = {}) {
      const error = check(name, args);
      if (error) return error;
      context.signal?.throwIfAborted();
      try {
        const result = await handlers[name](structuredClone(args), context);
        context.signal?.throwIfAborted();
        return result;
      } catch (error) {
        if (error.status === 400 && typeof error.field === "string") return invalid(error.field, error.message);
        throw error;
      }
    },
    definitions({ onlyTerminal = false, optionNames = [] } = {}) {
      // Gemini exige propiedades explícitas en objetos. Los ejes se aprenden
      // de resultados reales, nunca de una lista fija ni precargando productos.
      const names = onlyTerminal ? ["responder", "derivar"] : CONSULTATION_TOOL_NAMES;
      const declarations = names.map(name => {
        const schema = structuredClone(CONSULTATION_SCHEMAS[name]);
        if (name === "buscar_productos") {
          if (!optionNames.length) delete schema.properties.opciones;
          else schema.properties.opciones = object(Object.fromEntries(optionNames.map(axis => [axis, string("Valor del eje obtenido del catálogo.")])));
        }
        function providerSchema(item) {
          const clean = { type: item.type };
          if (item.description) clean.description = item.description;
          if (item.nullable) clean.nullable = true;
          if (item.items) clean.items = providerSchema(item.items);
          if (item.minItems !== undefined) clean.minItems = item.minItems;
          if (item.maxItems !== undefined) clean.maxItems = item.maxItems;
          if (item.properties) clean.properties = Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [key, providerSchema(value)]));
          if (item.required?.length) clean.required = item.required;
          return clean;
        }
        return { name, description: descriptions[name],
          ...(Object.keys(schema.properties).length ? { parameters: providerSchema(schema) } : {}) };
      });
      return [{ functionDeclarations: declarations }];
    },
  };
}
