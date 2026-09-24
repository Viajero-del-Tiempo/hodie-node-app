import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "../../config/firebase.js";
import { whatsappClient } from "../../config/whatsapp.js";

/**
 * Base de conocimiento estática de HoDie Tienda de Regalos
 */
const HODIE_KNOWLEDGE_BASE = `
INFORMACIÓN DE HODIE TIENDA DE REGALOS:
- Ubicación física: Chaco Boreal 1021 casi Capitán Dominguez, Caacupé, Paraguay.
- Sitio web oficial: https://hodie.com.py
- Tipos de productos: Regalos personalizados (tazas personalizadas, termos, indumentaria, cajas y empaques de regalo premium).
- Envíos: Se realizan a todo el país a través de transportadora. El costo de envío es "Pago contra entrega" (el cliente abona el flete al retirar o recibir).
- Tiempos de entrega y despacho:
  * Si el comprobante de pago ingresa antes del mediodía, el pedido se prepara y despacha en el día.
  * Si ingresa después del mediodía, se despacha al día hábil siguiente.
  * Tiempo de entrega de la transportadora: 24 a 48 horas hábiles.
- Formas de pago: Transferencia bancaria o depósito. Los datos bancarios se entregan en el comprobante en PDF al confirmar el pedido.
  * IMPORTANTE: La confirmación de pagos es 100% manual por parte del equipo humano. No existe cobro por QR ni pasarela automática.
`;

/**
 * Consulta el pedido más reciente de un cliente.
 *
 * [LIMITACIÓN CONSCIENTE V1]:
 * Esta versión consulta únicamente el pedido más reciente del usuario
 * (filtrando por 'userPhoneNumber' y ordenando por 'createdAt' descendente, limit 1).
 * No soporta la consulta de pedidos históricos específicos ni selección múltiple en esta versión.
/**
 * Consulta el pedido más reciente de un cliente.
 *
 * [LIMITACIÓN CONSCIENTE V1]:
 * Esta versión consulta únicamente el pedido más reciente del usuario
 * (filtrando por 'userPhoneNumber' y ordenando por 'createdAt' descendente con limit 1).
 * No soporta la consulta de pedidos históricos específicos ni selección múltiple en esta versión.
 *
 * [ÍNDICE COMPUESTO EN FIRESTORE]:
 * En Firestore, la combinación de .where("userPhoneNumber", "==") con .orderBy("createdAt", "desc")
 * requiere un índice compuesto:
 * Colección: 'orders' | Campos: userPhoneNumber (ASC), createdAt (DESC)
 * Definición para firestore.indexes.json:
 * { "collectionGroup": "orders", "queryScope": "COLLECTION", "fields": [{ "fieldPath": "userPhoneNumber", "order": "ASCENDING" }, { "fieldPath": "createdAt", "order": "DESCENDING" }] }
 *
 * [FALLBACK DEFENSIVO LIMITADO]:
 * Si el índice compuesto aún no ha sido desplegado en Firebase Console (error 9 FAILED_PRECONDITION),
 * se aplica un fallback defensivo que limita la lectura a máximo 10 pedidos (limit(10), evitando lecturas ilimitadas)
 * y ordena en memoria para no interrumpir el servicio.
 *
 * @param {string} userPhoneNumber
 * @returns {Promise<any | null>}
 */
export const getLatestOrderForUser = async (userPhoneNumber) => {
  try {
    // Consulta nativa optimizada (costo: 1 sola lectura en Firestore)
    const snapshot = await db
      .collection("orders")
      .where("userPhoneNumber", "==", userPhoneNumber)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (err) {
    // Si el índice compuesto no existe aún en Firebase Console, usamos fallback con limit(10)
    if (err.message?.includes("index") || err.code === 9) {
      console.warn(
        "⚠️ Falta índice compuesto en Firestore para 'orders' (userPhoneNumber + createdAt desc). Usando fallback con limit(10):",
        err.message
      );
      try {
        const fallbackSnap = await db
          .collection("orders")
          .where("userPhoneNumber", "==", userPhoneNumber)
          .limit(10)
          .get();

        if (fallbackSnap.empty) return null;

        const orders = fallbackSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        orders.sort((a, b) => {
          const timeA =
            a.createdAt?.seconds ||
            (a.createdAt instanceof Date ? a.createdAt.getTime() / 1000 : 0);
          const timeB =
            b.createdAt?.seconds ||
            (b.createdAt instanceof Date ? b.createdAt.getTime() / 1000 : 0);
          return timeB - timeA;
        });

        return orders[0];
      } catch (fallbackErr) {
        console.error("Error en fallback de consulta de pedidos:", fallbackErr.message);
        return null;
      }
    }

    console.error(`⚠️ Error consultando último pedido de ${userPhoneNumber}:`, err.message);
    return null;
  }
};

/**
 * Notifica al administrador por WhatsApp sobre un evento relevante (comprobante recibido, handoff).
 *
 * NOTA / TAREA 6: A diferencia de los clientes finales que cambian dinámicamente de identificador
 * entre @c.us y @lid según el dispositivo vinculado, el número del administrador es estático y
 * proviene de la variable de entorno ADMIN_WHATSAPP_PHONE. Por consistencia, si ADMIN_WHATSAPP_PHONE
 * ya incluye un identificador completo (con '@'), se utiliza directamente; de lo contrario, se mantiene
 * `${adminPhone}@c.us` como destino predeterminado.
 *
 * @param {string} message
 */
const notifyAdminViaWhatsApp = async (message) => {
  const adminPhone = process.env.ADMIN_WHATSAPP_PHONE;
  if (!adminPhone) return;

  try {
    const chatId = adminPhone.includes("@") ? adminPhone : `${adminPhone}@c.us`;
    await whatsappClient.sendMessage(chatId, message, { sendSeen: false });
    console.log(`📢 Alerta enviada al WhatsApp del admin (${adminPhone})`);
  } catch (err) {
    console.warn("⚠️ No se pudo enviar notificación WhatsApp al admin:", err.message);
  }
};

/**
 * Normaliza el texto eliminando acentos y diacríticos para comparaciones robustas
 * @param {string} text
 * @returns {string}
 */
const normalizeText = (text) =>
  (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/**
 * Formatea el estado legible de un pedido en español
 * @param {string} status
 * @returns {string}
 */
const formatOrderStatus = (status) => {
  switch (status) {
    case "pending":
      return "📝 Pendiente de pago (aguardando verificación de comprobante)";
    case "paid":
      return "💳 Pagado y verificado (en cola de preparación)";
    case "preparing":
      return "⚙️ En preparación en nuestro taller";
    case "shipped":
      return "🚚 Enviado por transportadora";
    case "delivered":
      return "📦 Entregado exitosamente";
    case "cancelled":
      return "❌ Cancelado";
    default:
      return status;
  }
};

/**
 * Nodo de Atención al Cliente (SupportAgent)
 *
 * Gestiona:
 * 1. Consultas de estado de pedidos (OrderStatus)
 * 2. Recepción de comprobantes de pago (sin alterar status, notificando al admin)
 * 3. Respuestas a preguntas frecuentes sobre envíos, personalización y tienda
 * 4. Detección de reclamos y derivación a handoff humano
 *
 * @param {import("../state.js").AgentState} state
 * @returns {Promise<Partial<import("../state.js").AgentState>>}
 */
export const supportAgentNode = async (state) => {
  const userPhone = state.userPhoneNumber;
  const intent = state.intent;
  const lastMessage = state.messages[state.messages.length - 1]?.content || "";
  const lastText = typeof lastMessage === "string" ? normalizeText(lastMessage) : "";

  // -------------------------------------------------------------
  // CASO 1: RECEPCIÓN DE COMPROBANTE DE PAGO
  // El agente NO cambia el OrderStatus (se mantiene en 'pending').
  // Alerta al administrador y envía acuse de recibo al cliente.
  // -------------------------------------------------------------
  if (intent === "payment_proof") {
    console.log(`📄 Procesando recepción de comprobante de pago de ${userPhone}`);
    const latestOrder = await getLatestOrderForUser(userPhone);

    const orderNumber = latestOrder ? `#${latestOrder.orderNumber}` : "(sin número vinculado)";
    const orderTotal = latestOrder?.total ? `${latestOrder.total.toLocaleString()} Gs.` : "N/A";

    const adminSummary = `Comprobante de pago recibido de ${userPhone} para el pedido ${orderNumber} (Monto: ${orderTotal}).`;

    // Notificar al administrador
    await notifyAdminViaWhatsApp(`🔔 *Nuevo Comprobante de Pago*\n\nCliente: +${userPhone}\nPedido: ${orderNumber}\nMonto: ${orderTotal}\n\n👉 Por favor verificar la acreditación bancaria y confirmar el pago manualmente en el dashboard.`);

    const clientResponse =
      `¡Muchas gracias! Hemos recibido tu comprobante de pago 📄✨\n\n` +
      `Nuestro equipo verificará la acreditación en la cuenta bancaria. Ten en cuenta que la confirmación se realiza de forma manual.\n\n` +
      `En cuanto el pago esté confirmado, actualizaremos tu pedido ${orderNumber} y te enviaremos una notificación para comenzar la preparación. 😊`;

    return {
      messages: [new AIMessage(clientResponse)],
      activeAgent: null,
      adminNotification: {
        type: "payment_proof",
        summary: adminSummary,
        details: {
          phone: userPhone,
          orderId: latestOrder?.id || null,
          orderNumber: latestOrder?.orderNumber || null,
          total: latestOrder?.total || null,
          media: state.incomingMedia ? { mimetype: state.incomingMedia.mimetype, filename: state.incomingMedia.filename } : null,
          receivedAt: new Date().toISOString(),
        },
      },
    };
  }

  // -------------------------------------------------------------
  // CASO 2: ARCHIVO ADJUNTO AMBIGUO
  // -------------------------------------------------------------
  if (intent === "ambiguous_media") {
    const clarifyingResponse =
      `¡Hola! Recibimos tu archivo adjunto 📎\n\n` +
      `¿Deseas cotizar un regalo personalizado con esta imagen o se trata del comprobante de pago de un pedido existente?\n\n` +
      `Respondeme *"Cotizar"* si querés un presupuesto, o *"Comprobante"* si es el pago de tu compra. ¡Gracias! 😊`;

    return {
      messages: [new AIMessage(clarifyingResponse)],
      activeAgent: null,
    };
  }

  // -------------------------------------------------------------
  // CASO 3: CONSULTA DE ESTADO DE PEDIDO
  // -------------------------------------------------------------
  if (intent === "order_status" || lastText.includes("estado") || lastText.includes("seguimiento") || lastText.includes("tracking")) {
    console.log(`🔍 Consultando estado del pedido para ${userPhone}`);
    const latestOrder = await getLatestOrderForUser(userPhone);

    if (!latestOrder) {
      const notFoundResponse =
        `No encontramos ningún pedido registrado con tu número (+${userPhone}) en nuestro sistema.\n\n` +
        `Si deseás realizar una compra o solicitar un presupuesto, escribinos qué producto te interesa y te ayudamos con gusto. 🛍️`;

      return {
        messages: [new AIMessage(notFoundResponse)],
        activeAgent: null,
      };
    }

    const itemsSummary = Array.isArray(latestOrder.items)
      ? latestOrder.items.map((it) => `• ${it.quantity}x ${it.productName}`).join("\n")
      : "Ítems no detallados";

    let statusText =
      `📦 *Estado de tu Pedido #${latestOrder.orderNumber}*\n\n` +
      `• *Estado actual:* ${formatOrderStatus(latestOrder.status)}\n` +
      `• *Total:* ${(latestOrder.total || 0).toLocaleString()} Gs.\n` +
      `• *Ítems:*\n${itemsSummary}\n`;

    if (latestOrder.trackingNumber) {
      statusText += `• *Número de guía / tracking:* ${latestOrder.trackingNumber}\n`;
    }

    if (latestOrder.status === "pending") {
      statusText += `\n💡 *Recuerda:* Tu pedido está esperando el comprobante de transferencia bancaria para ser procesado.`;
    } else if (latestOrder.status === "shipped") {
      statusText += `\n🚚 *En camino:* La transportadora se estará comunicando contigo al llegar a destino.`;
    }

    return {
      messages: [new AIMessage(statusText)],
      activeAgent: null,
    };
  }

  // -------------------------------------------------------------
  // CASO 4: DETECCIÓN DE RECLAMOS DIRECTOS (ESCALACIÓN A HANDOFF)
  // -------------------------------------------------------------
  const complaintWords = [
    "reclamo",
    "vino roto",
    "roto",
    "defectuoso",
    "no llego",
    "no me llego",
    "estafa",
    "problema",
    "equivocado",
    "devolucion",
    "queja",
    "tardaron mucho",
  ];

  const hasComplaint = complaintWords.some((w) => lastText.includes(w));
  if (hasComplaint) {
    console.log(`⚠️ Reclamo detectado en SupportAgent para ${userPhone}. Escalando a HumanHandoff.`);
    return {
      humanHandoffRequired: true,
      humanHandoffReason: `Reclamo del cliente: "${lastText.slice(0, 100)}"`,
      intent: "human_handoff",
      activeAgent: null,
    };
  }

  // -------------------------------------------------------------
  // CASO 5: PREGUNTAS FRECUENTES (FAQ) MEDIANTE LLM O RESPUESTAS DETERMINÍSTICAS
  // -------------------------------------------------------------
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (apiKey) {
    try {
      const model = new ChatGoogleGenerativeAI({
        model: "gemini-2.0-flash",
        apiKey,
        temperature: 0.2,
      });

      const systemPrompt = new SystemMessage(
        `Eres el asistente oficial de Atención al Cliente de HoDie Tienda de Regalos.
Tu objetivo es responder de manera muy amable, concisa y profesional en español de Paraguay a las consultas de los clientes.

${HODIE_KNOWLEDGE_BASE}

DIRECTRICES ESTRICTAS:
1. Responde de forma breve, precisa y directa basándote ÚNICAMENTE en la base de conocimiento oficial de HoDie provista arriba.
2. Si el cliente pregunta por cotizaciones o precios de productos específicos, indícale amablemente que puede decirte qué producto busca y lo ayudamos a cotizar.
3. Si el cliente manifiesta una queja, insatisfacción o reclamo de cualquier tipo, responde diciendo amablemente que lo transferirás con un asesor humano y agrega al final exacto de tu respuesta la etiqueta especial: [HANDOFF_REQUIRED].
4. REGLA ANTI-ALUCINACIÓN (ESTRICTA): Si la información solicitada NO está explícitamente en la base de conocimiento de arriba (por ejemplo, si preguntan si tenemos sucursal en Asunción u otra ciudad, si aceptamos tarjetas de crédito o cuotas, o políticas no descritas), NUNCA inventes, asumas ni adivines una respuesta. En su lugar, responde honestamente explicando que no tienes esa información y que derivas la consulta a un asesor humano de nuestro equipo para que le asista con certeza, agregando al final exacto de tu respuesta la etiqueta: [HANDOFF_REQUIRED].
5. Utiliza emojis con moderación para mantener un tono cálido y cercano.`
      );

      const conversationHistory = state.messages.slice(-4);
      const response = await model.invoke([systemPrompt, ...conversationHistory]);
      let content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

      if (content.includes("[HANDOFF_REQUIRED]")) {
        const cleanContent = content.replace("[HANDOFF_REQUIRED]", "").trim();
        return {
          messages: [new AIMessage(cleanContent)],
          humanHandoffRequired: true,
          humanHandoffReason: "Consulta fuera de base de conocimiento o reclamo detectado en FAQ",
          activeAgent: null,
          adminNotification: {
            type: "human_handoff",
            summary: `Derivación por consulta fuera de base de conocimiento para ${userPhone}: "${lastText.slice(0, 100)}"`,
            details: { phone: userPhone, question: lastText },
          },
        };
      }

      return {
        messages: [new AIMessage(content)],
        activeAgent: null,
      };
    } catch (llmErr) {
      console.warn("⚠️ Fallo en LLM para FAQ, usando respuestas estándar:", llmErr.message);
    }
  }

  // Fallback determinístico si no hay API key o si el LLM falla
  let fallbackText =
    "¡Hola! No estoy seguro de tener la respuesta exacta a tu consulta. 🤔\n\n" +
    "• Si querés que te atienda una persona de nuestro equipo, escribí *'Asesor'* o *'Humano'* y te transfiero enseguida.\n" +
    "• Si deseás cotizar un regalo personalizado, contame qué producto te interesa (tazas, termos, etc.). 😊";

  if (lastText.includes("envio") || lastText.includes("entrega") || lastText.includes("costo de envio")) {
    fallbackText =
      "🚚 *Envíos en HoDie:*\n\n" +
      "• Enviamos a todo el país vía transportadora con pago contra entrega.\n" +
      "• Si tu pago ingresa antes del mediodía, se despacha en el día; si ingresa después, al día hábil siguiente.\n" +
      "• Tiempo de entrega: 24 a 48 hs hábiles.";
  } else if (lastText.includes("donde") || lastText.includes("ubicacion") || lastText.includes("direccion")) {
    fallbackText = "📍 Nos encontramos en Chaco Boreal 1021 casi Capitán Dominguez, Caacupé, Paraguay.";
  } else if (lastText.includes("pago") || lastText.includes("transferencia") || lastText.includes("cuenta")) {
    fallbackText =
      "💳 *Métodos de pago:*\n\n" +
      "Aceptamos transferencias bancarias. Los datos de la cuenta se envían en el PDF oficial al confirmar el pedido. La confirmación es 100% manual por nuestro equipo.";
  }

  return {
    messages: [new AIMessage(fallbackText)],
    activeAgent: null,
  };
};
