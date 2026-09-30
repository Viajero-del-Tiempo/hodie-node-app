import { createGeminiModel } from "../../config/llm.js";
import { db } from "../../config/firebase.js";

export const VALID_INTENTS = [
  "budget_quote",
  "customer_support",
  "payment_proof",
  "order_status",
  "ambiguous_media",
  "human_handoff",
  "handoff_active_silence",
];

/**
 * Obtiene el último mensaje en formato de texto
 * @param {any[]} messages
 * @returns {string}
 */
const getLatestUserText = (messages) => {
  if (!messages || messages.length === 0) return "";
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    const textPart = last.content.find((p) => p.type === "text");
    return textPart ? textPart.text : "";
  }
  return "";
};

/**
 * Clasifica la intención del usuario mediante LLM con un timeout estricto.
 * @param {string} userText
 * @param {number} timeoutMs
 * @returns {Promise<{ intent: string, reason?: string }>}
 */
const classifyIntentWithTimeout = async (userText, timeoutMs = 10000) => {
  const model = createGeminiModel({
    temperature: 0,
    thinkingBudget: 0,
  });

  const prompt = `Eres el clasificador de intenciones para una tienda de regalos personalizados llamada HoDie.
Clasifica el siguiente mensaje del cliente en exactamente UNA de estas categorías:

1. 'budget_quote': El cliente pregunta por productos (termos, vasos, billeteras, tazas, mates, joyeros, neceseres), precios, personalizaciones, catálogos, cantidades o expresa intención de cotizar/comprar.
2. 'order_status': El cliente pregunta por el estado de un pedido que ya realizó o pide número de seguimiento/tracking.
3. 'payment_proof': El cliente indica que ya transfirió o envía/menciona un comprobante de pago.
4. 'customer_support': Saludos, preguntas frecuentes generales (tiempos de entrega, métodos de envío, ubicación física en Minga Guazú, formas de pago, dudas varias).
5. 'human_handoff': Reclamos por pedidos defectuosos/tardíos, quejas, frustración o solicitud explícita de hablar con una persona/asesor humano.

IMPORTANTE: Enfócate exclusivamente en el MENSAJE ACTUAL del cliente.

Mensaje del cliente: "${userText}"

Responde ÚNICAMENTE en formato JSON válido con las claves "intent" y "reason", sin explicaciones adicionales ni bloques de código markdown:
{"intent": "budget_quote", "reason": "..."}`;

  // Usamos AbortController para cancelar de forma efectiva la petición HTTP subyacente
  // y no dejar conexiones de red colgadas si se supera el timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout de clasificación (${timeoutMs}ms) excedido`));
  }, timeoutMs);

  try {
    const response = await model.invoke(prompt, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    let text = response.content;
    if (typeof text !== "string") {
      text = JSON.stringify(text);
    }
    // Limpiar posibles bloques ```json ... ```
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(text);
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
};

/**
 * Nodo Router / Orquestador
 * Clasifica la intención del mensaje entrante o continúa el flujo activo
 *
 * @param {import("../state.js").AgentState} state
 * @returns {Promise<Partial<import("../state.js").AgentState>>}
 */
export const routerNode = async (state) => {
  try {
    // -------------------------------------------------------------
    // 1. ESTADO DE HANDOFF HUMANO BLOQUEANTE
    // Si la conversación ya está bajo atención humana y no fue cerrada
    // manualmente por el operador desde el dashboard, no responder automáticamente.
    // Retorna intent explícito "handoff_active_silence" y limpia disparadores secundarios
    // para garantizar silencio total sin depender de lo que otros nodos hayan dejado en el estado.
    // -------------------------------------------------------------
    if (state.humanHandoffRequired) {
      console.log(`🔒 Handoff humano activo para ${state.userPhoneNumber}. Manteniendo intervención.`);
      return {
        intent: "handoff_active_silence",
        adminNotification: null,
      };
    }

    const lastText = getLatestUserText(state.messages).toLowerCase().trim();
    const hasMedia = Boolean(state.incomingMedia);

    // -------------------------------------------------------------
    // 1.b MANEJO DE MENÚ DE ESCALADA NUMERADO (awaitingMenuChoice)
    // El router interpreta "1", "2", "3" hacia el menú general de opciones
    // ÚNICAMENTE cuando awaitingMenuChoice está activo (pasos 2 y 3 de SupportAgent).
    // -------------------------------------------------------------
    if (state.awaitingMenuChoice) {
      if (lastText === "1" || lastText.startsWith("1 ") || lastText === "1." || lastText.includes("catalogo") || lastText.includes("catálogo")) {
        return {
          intent: "budget_quote",
          activeAgent: "budget",
          awaitingMenuChoice: false,
          consecutiveMisunderstandings: 0,
        };
      }
      if (lastText === "2" || lastText.startsWith("2 ") || lastText === "2." || lastText.includes("cotizar")) {
        return {
          intent: "budget_quote",
          activeAgent: "budget",
          awaitingMenuChoice: false,
          consecutiveMisunderstandings: 0,
        };
      }
      if (lastText === "3" || lastText.startsWith("3 ") || lastText === "3." || lastText.includes("estado") || lastText.includes("pedido")) {
        return {
          intent: "order_status",
          activeAgent: null,
          awaitingMenuChoice: false,
          consecutiveMisunderstandings: 0,
        };
      }
    }

    // -------------------------------------------------------------
    // 2. DESAMBIGUACIÓN DE ARCHIVOS ADJUNTOS (FOTO DE REFERENCIA VS COMPROBANTE)
    // Regla determinística: Si el usuario está cotizando y en el paso de
    // personalización o selección de producto, la imagen es para el producto.
    // -------------------------------------------------------------
    if (
      state.activeAgent === "budget" &&
      ["customization", "product_selection"].includes(state.quoteContext?.step) &&
      hasMedia
    ) {
      console.log(`🖼️ Imagen recibida durante cotización (${state.quoteContext.step}). Guardando como foto de referencia.`);
      return {
        intent: "budget_quote",
        activeAgent: "budget",
        quoteContext: {
          ...state.quoteContext,
          customizationMedia: state.incomingMedia,
        },
      };
    }

    // -------------------------------------------------------------
    // 3. PERSISTENCIA DE FLUJO MULTI-TURNO (PRESUPUESTADOR)
    // Si el cliente está en medio de una cotización y no pide cancelar ni un humano
    // -------------------------------------------------------------
    const cancelKeywords = ["cancelar", "ya no quiero", "salir", "reiniciar", "empezar de nuevo"];
    const isCancelling = cancelKeywords.some((kw) => lastText.includes(kw));

    if (state.activeAgent === "budget" && !isCancelling) {
      // Verificar si solicita humano expresamente con frases compuestas precisas
      // Evitamos palabras sueltas como 'persona' o 'atencion' para no tener falsos positivos
      // como "regalo para una persona especial" o "gracias por la atencion".
      const humanPhrases = [
        "hablar con un asesor",
        "hablar con una persona",
        "hablar con alguien",
        "asesor humano",
        "operador humano",
        "atencion personalizada",
        "atención personalizada",
        "atencion humana",
        "pasame con alguien",
        "pasame con un humano",
        "pasame con un asesor",
        "pasame con el asesor",
        "pasame con atención al cliente",
        "pasame con atencion al cliente",
        "comunicarme con un asesor",
        "asesor por favor",
      ];
      const wantsHuman = humanPhrases.some((phrase) => lastText.includes(phrase));
      if (wantsHuman) {
        return {
          intent: "human_handoff",
          humanHandoffRequired: true,
          humanHandoffReason: "Cliente solicitó asesor humano durante la cotización",
          activeAgent: null,
        };
      }

      return {
        intent: "budget_quote",
        activeAgent: "budget",
      };
    }

    // Si estaba en budget y canceló, resetear flujo de cotización limpiando todo el contexto (Bug 2)
    if (state.activeAgent === "budget" && isCancelling) {
      return {
        intent: "customer_support",
        activeAgent: null,
        quoteContext: {
          reset: true,
        },
      };
    }

    // -------------------------------------------------------------
    // 4. ADJUNTO FUERA DE COTIZACIÓN (COMPROBANTE O AMBIGUO)
    // -------------------------------------------------------------
    if (hasMedia) {
      const paymentTerms = ["comprobante", "transferencia", "pago", "boleta", "ticket", "deposito", "transferi", "pagado"];
      const mentionsPayment = paymentTerms.some((term) => lastText.includes(term));

      // Verificar si el cliente tiene un pedido en estado 'pending' en Firestore
      let hasPendingOrder = false;
      try {
        const orderSnap = await db
          .collection("orders")
          .where("userPhoneNumber", "==", state.userPhoneNumber)
          .where("status", "==", "pending")
          .limit(1)
          .get();

        hasPendingOrder = !orderSnap.empty;
      } catch (err) {
        console.warn("⚠️ No se pudo verificar pedidos pendientes en Firestore:", err.message);
      }

      if (mentionsPayment || hasPendingOrder) {
        return {
          intent: "payment_proof",
          activeAgent: null,
        };
      }

      // Caso ambigüo: mandó imagen sin texto y sin pedido pendiente
      return {
        intent: "ambiguous_media",
        activeAgent: null,
      };
    }

    // -------------------------------------------------------------
    // 5. PALABRAS CLAVE DIRECTAS DE ESCALACIÓN HUMANA O QUEJAS
    // Frases compuestas para evitar falsos positivos
    // -------------------------------------------------------------
    const directHandoffKeywords = [
      "reclamo",
      "vino roto",
      "estafa",
      "denuncia",
      "demanda",
      "quiero hablar con una persona",
      "hablar con una persona",
      "hablar con un asesor",
      "hablar con alguien",
      "pasame con un humano",
      "pasame con un asesor",
      "pasame con el asesor",
      "pasame con atención al cliente",
      "pasame con atencion al cliente",
      "asesor humano",
      "operador humano",
      "atencion personalizada",
      "atención personalizada",
      "atencion humana",
      "comunicarme con una persona",
      "comunicarme con un asesor",
      "asesor por favor",
    ];
    if (directHandoffKeywords.some((kw) => lastText.includes(kw))) {
      return {
        intent: "human_handoff",
        humanHandoffRequired: true,
        humanHandoffReason: "Reclamo o solicitud explícita de atención humana",
        activeAgent: null,
      };
    }

    // -------------------------------------------------------------
    // 6. ENLACES EXTERNOS Y MULTIMEDIA (Punto 6)
    // No se derivan a humano. Se canalizan a support para indicar amablemente
    // que no es posible abrir enlaces y consultar qué producto le interesó.
    // -------------------------------------------------------------
    const urlPattern = /(?:https?:\/\/|www\.)[^\s]+|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be/i;
    const isVideo = state.incomingMedia?.mimetype?.startsWith("video/") || state.incomingMedia?.mimetype?.startsWith("audio/");

    if (urlPattern.test(lastText) || isVideo) {
      return {
        intent: "customer_support",
        activeAgent: null,
      };
    }

    // -------------------------------------------------------------
    // 7. PRIORIDAD DE CATÁLOGO / COTIZACIÓN / PRODUCTOS (Punto 6)
    // Cualquier mención de producto, precio, catálogo o intención de compra
    // va al BudgetAgent, incluso con saludos en el mismo mensaje.
    // -------------------------------------------------------------
    const productKeywords = /\b(billeteras?|vasos?|termos?|mates?|kit(?:s)?\s*(?:para|de)?\s*mates?|neceser(?:es)?|joyeros?|tazas?|remeras?|chopps?|champañeras?|cuadros?)\b/i;
    const purchaseKeywords = /\b(catalogos?|catálogos?|precios?|cotizar|cotizacion|cotización|presupuesto|comprar|cuanto\s+cuesta|cuánto\s+cuesta|cuanto\s+sale|cuánto\s+sale|costo)\b/i;
    const quantityIntent = /\b(?:quiero|necesito|pedir|dame|mandame)\s+\d+\b/i;

    if (productKeywords.test(lastText) || purchaseKeywords.test(lastText) || quantityIntent.test(lastText)) {
      return {
        intent: "budget_quote",
        activeAgent: "budget",
        consecutiveMisunderstandings: 0,
      };
    }

    // Saludo puro sin producto ni intención de compra
    const greetingPattern = /^(?:hola|buenas|buenos dias|buenos días|buenas tardes|buenas noches|hola que tal|hola qué tal|que tal|qué tal)[\s!.]*$/i;
    if (greetingPattern.test(lastText)) {
      return {
        intent: "customer_support",
        activeAgent: null,
      };
    }

    // -------------------------------------------------------------
    // 8. CLASIFICACIÓN DE INTENCIÓN VÍA LLM CON TIMEOUT
    // -------------------------------------------------------------
    const classification = await classifyIntentWithTimeout(lastText, 10000);

    if (!classification || !VALID_INTENTS.includes(classification.intent)) {
      throw new Error(`Clasificación ambigua o desconocida: ${JSON.stringify(classification)}`);
    }

    return {
      intent: classification.intent,
      activeAgent: classification.intent === "budget_quote" ? "budget" : null,
      ...(classification.intent === "budget_quote" ? { consecutiveMisunderstandings: 0 } : {}),
    };
  } catch (error) {
    // -------------------------------------------------------------
    // 7. FAIL-SAFE OBLIGATORIO A HUMAN HANDOFF
    // En caso de cualquier error (timeout, LLM sin API key, fallo de red,
    // JSON malformado), NUNCA dejamos el mensaje sin responder ni adivinamos.
    // -------------------------------------------------------------
    console.error("⚠️ Fallo en RouterNode. Aplicando fallback fail-safe a HumanHandoff:", error.message);

    return {
      intent: "human_handoff",
      humanHandoffRequired: true,
      humanHandoffReason: `Fallback por fallo de clasificación: ${error.message || "Error desconocido"}`,
      activeAgent: null,
      adminNotification: {
        type: "human_handoff",
        summary: `Derivación automática por fallo técnico en router para ${state.userPhoneNumber || "cliente"}`,
        details: { error: error.message },
      },
    };
  }
};

/**
 * Función de enrutamiento condicional para los Edges del grafo
 * Decide el nodo de destino a partir del estado clasificado
 *
 * @param {import("../state.js").AgentState} state
 * @returns {"human_handoff_node" | "budget_agent_node" | "support_agent_node"}
 */
export const routeMessage = (state) => {
  // Prioridad 1: Handoff humano activo o derivado por fail-safe
  if (state.humanHandoffRequired || state.intent === "human_handoff") {
    return "human_handoff_node";
  }

  // Prioridad 2: Cotización y presupuestación
  if (state.activeAgent === "budget" || state.intent === "budget_quote") {
    return "budget_agent_node";
  }

  // Prioridad 3: Atención al cliente (soporte, estado de pedido, comprobantes)
  if (["customer_support", "payment_proof", "order_status", "ambiguous_media"].includes(state.intent || "")) {
    return "support_agent_node";
  }

  // Fail-safe por defecto
  return "human_handoff_node";
};
