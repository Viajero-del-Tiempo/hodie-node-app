const string = description => ({ type: "string", description });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const CONSULTATION_SCHEMAS = Object.freeze({
  buscar_productos: object({ consulta: string("Términos de búsqueda."), categoriaId: string("ID de categoría obtenido del contexto o catálogo."),
    opciones: { type: "object", additionalProperties: { type: "string" }, description: "Ejes y valores obtenidos del catálogo." },
    soloDisponibles: { type: "boolean", description: "Por defecto false: incluye variantes agotadas." },
    limite: { type: "integer", minimum: 1, maximum: 5, description: "De uno a cinco; por defecto cinco." } }, ["consulta"]),
  ver_producto: object({ productId: string("ID obtenido del catálogo.") }, ["productId"]),
  enviar_imagenes: object({ productId: string("ID obtenido del catálogo."), variantId: string("ID de variante del producto; opcional.") }, ["productId"]),
  consultar_politicas: object({}),
  estado_pedido: object({ orderNumber: string("Número de pedido indicado por el cliente."), phone: string("Teléfono de compra indicado por el cliente; no verifica la identidad.") }),
  responder: object({ texto: string("Respuesta final al cliente."), entendido: { type: "boolean", description: "Si se entendió el mensaje del cliente." },
    quoteIdMostrado: string("Identificador de cotización; todavía no disponible.") }, ["texto", "entendido"]),
});
export const CONSULTATION_TOOL_NAMES = Object.freeze(Object.keys(CONSULTATION_SCHEMAS));
const descriptions = {
  buscar_productos: "Busca productos y variantes, con precios, stock, available y matchedTerms. Máximo cinco productos.",
  ver_producto: "Obtiene el producto público completo: atributos, variantes, personalización, imágenes y empaques propios.",
  enviar_imagenes: "Envía hasta tres imágenes existentes del producto o variante. No crea imágenes ni acepta URLs del modelo.",
  consultar_politicas: "Obtiene todas las políticas vigentes; sus temas son libres.",
  estado_pedido: "Consulta un pedido. Identidad verificada y dueño: estado y productos. Si no, exige número y teléfono coincidentes y muestra solo el estado.",
  responder: "Envía la única respuesta de texto y termina el turno. No habilita cotizaciones todavía.",
};
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = (field, message) => ({ code: "ARGUMENTOS_INVALIDOS", field, message });

function validate(schema, value, path = "") {
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
    for (const field of ["productId", "variantId", "categoriaId", "orderNumber"]) {
      if (args[field] !== undefined && (args[field] !== args[field].trim() || args[field].includes("/")
          || [".", ".."].includes(args[field]) || args[field].length > 200)) return invalid(field, "Identificador inválido.");
    }
    // TEMPORAL ENTREGA 4: retirar al registrar cotizar/lastQuote.
    if (name === "responder" && args.quoteIdMostrado !== undefined) return { code: "FUNCION_NO_DISPONIBLE", field: "quoteIdMostrado" };
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
      const names = onlyTerminal ? ["responder"] : CONSULTATION_TOOL_NAMES;
      const declarations = names.map(name => {
        const schema = structuredClone(CONSULTATION_SCHEMAS[name]);
        if (name === "responder") delete schema.properties.quoteIdMostrado;
        if (name === "buscar_productos") {
          if (!optionNames.length) delete schema.properties.opciones;
          else schema.properties.opciones = object(Object.fromEntries(optionNames.map(axis => [axis, string("Valor del eje obtenido del catálogo.")])));
        }
        function providerSchema(item) {
          const clean = { type: item.type };
          if (item.description) clean.description = item.description;
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
