import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
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
const classifyIntentWithTimeout = async (userText, timeoutMs = 4000) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  // Si no hay API key configurada todavía en el entorno, simulamos el fallo o usamos heurística segura
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY no configurada en variables de entorno");
  }

  const model = new ChatGoogleGenerativeAI({
    model: "gemini-2.0-flash",
    apiKey,
    temperature: 0,
  });

  const prompt = `Eres el clasificador de intenciones para una tienda de regalos personalizados llamada HoDie.
Clasifica el siguiente mensaje del cliente en exactamente UNA de estas categorías:

1. 'budget_quote': El cliente pregunta por precios de productos, personalizaciones (tazas, termos, remeras), catálogos o expresa intención de cotizar/comprar.
2. 'order_status': El cliente pregunta por el estado de un pedido que ya realizó o pide número de seguimiento/tracking.
3. 'payment_proof': El cliente indica que ya transfirió o envía/menciona un comprobante de pago.
4. 'customer_support': Preguntas frecuentes generales (tiempos de entrega, métodos de envío, ubicación física, dudas varias).
5. 'human_handoff': Reclamos por pedidos defectuosos/tardíos, quejas, frustración o solicitud explícita de hablar con una persona/asesor humano.

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
        humanHandoffReason: null,
        adminNotification: null,
      };
    }

    const lastText = getLatestUserText(state.messages).toLowerCase().trim();
    const hasMedia = Boolean(state.incomingMedia);

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
        "atencion humana",
        "pasame con alguien",
        "pasame con un humano",
        "comunicarme con un asesor",
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
      "estafa",
      "denuncia",
      "demanda",
      "quiero hablar con una persona",
      "hablar con alguien",
      "pasame con un humano",
      "asesor humano",
      "operador humano",
      "atencion personalizada",
      "atencion humana",
      "comunicarme con una persona",
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
    // 6. CLASIFICACIÓN DE INTENCIÓN VÍA LLM CON TIMEOUT
    // -------------------------------------------------------------
    const classification = await classifyIntentWithTimeout(lastText, 4000);

    if (!classification || !VALID_INTENTS.includes(classification.intent)) {
      throw new Error(`Clasificación ambigua o desconocida: ${JSON.stringify(classification)}`);
    }

    return {
      intent: classification.intent,
      activeAgent: classification.intent === "budget_quote" ? "budget" : null,
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
