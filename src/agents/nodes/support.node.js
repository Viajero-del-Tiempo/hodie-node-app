import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { db } from "../../config/firebase.js";
import { toDate } from "../../utils/date.util.js";
import { createGeminiModel } from "../../config/llm.js";
import { handleMisunderstanding } from "../escalation.service.js";

/**
 * Base de conocimiento estática de HoDie Tienda de Regalos
 */
const HODIE_KNOWLEDGE_BASE = `
INFORMACIÓN DE HODIE TIENDA DE REGALOS:
- Ubicación física de la tienda: Barrio Centro, Minga Guazú, Alto Paraná, Paraguay.
- Sitio web oficial: https://hodie.com.py
- Catálogo oficial de productos personalizados:
  * Termos de acero inoxidable de 650 ml personalizados (grabado láser / color).
  * Vasos térmicos con abridor de botellas incorporado personalizados.
  * Billeteras de cuero genuino y cuero sintético (modelos masculinos y femeninos) grabadas/personalizadas.
  * Kits completos para mate (en colores verde, negro, blanco, rosa, azul, lila).
  * Neceseres de cuero sintético y joyeros organizadores cuadrados personalizados.
  * Tazas personalizadas y empaques especiales de regalo (cajas premium, bolsas decorativas, envoltorios).
- Regla de productos: Si el cliente consulta si disponemos de estos productos o pregunta por modelos y precios, responde amablemente confirmando que sí los tenemos en nuestro catálogo y que con gusto le ayudamos a cotizar. NO derives a asesor humano por consultas sobre productos del catálogo.
- Políticas y Costos de Envío:
  * Cliente en Minga Guazú (donde está la tienda): Envío local gratuito (costo 0 Gs.).
  * Resto del país: Se envían a cualquier localidad del país mediante empresas transportadoras. El cliente paga el flete con la modalidad "Pago contra entrega", abonando el importe del envío directamente a la transportadora al recibir o retirar su paquete.
  * Costo en el pedido de Hodie: Siempre figura 0 Gs. de envío en la orden, ya que Hodie no cobra ni recarga costo de flete.
  * REGLA ANTI-ALUCINACIÓN (ESTRICTA): No inventes montos o tarifas de flete de transportadoras ni plazos de entrega que no figuren aquí. Si el cliente consulta cuánto le cobrará la transportadora para su ciudad, responde amablemente que el monto exacto lo establece la empresa de encomiendas de acuerdo al peso/volumen y la localidad de destino, o que puede coordinar con un asesor humano.
- Tiempos de entrega y despacho:
  * Si el comprobante de pago ingresa antes del mediodía, el pedido se prepara y despacha en el día.
  * Si ingresa después del mediodía, se despacha al día hábil siguiente.
  * Tiempo estimado de entrega de la transportadora: 24 a 48 horas hábiles.
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
          const timeA = toDate(a.createdAt)?.getTime() || 0;
          const timeB = toDate(b.createdAt)?.getTime() || 0;
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
    const { whatsappClient } = await import("../../config/whatsapp.js");
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
    console.log(`📄 Procesando recepción de comprobante de pago de ${userPhone || "cliente sin número"}`);
    const latestOrder = userPhone ? await getLatestOrderForUser(userPhone) : null;

    const orderNumber = latestOrder ? `#${latestOrder.orderNumber}` : "(sin número vinculado)";
    const orderTotal = latestOrder?.total ? `${latestOrder.total.toLocaleString()} Gs.` : "N/A";

    const clientDisplay = userPhone
      ? `+${userPhone}`
      : `${state.pushname || "Contacto WhatsApp"} (${state.whatsappChatId}) [número no disponible]`;

    const adminSummary = `Comprobante de pago recibido de ${clientDisplay} para el pedido ${orderNumber} (Monto: ${orderTotal}).`;

    // Notificar al administrador
    await notifyAdminViaWhatsApp(`🔔 *Nuevo Comprobante de Pago*\n\nCliente: ${clientDisplay}\nPedido: ${orderNumber}\nMonto: ${orderTotal}\n\n👉 Por favor verificar la acreditación bancaria y confirmar el pago manualmente en el dashboard.`);

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
    let latestOrder = null;

    // Si no disponemos de un número telefónico (ej. chat originado desde @lid)
    if (!userPhone) {
      // Verificar si el cliente proporcionó número de pedido o teléfono en el mensaje
      const rawMsg = typeof lastMessage === "string" ? lastMessage : "";
      const orderNumMatch = rawMsg.match(/#?\s*(\d{4,6})\b/);
      const phoneMatch = rawMsg.match(/(?:09\d{8}|5959\d{8}|9\d{8})/);

      if (orderNumMatch) {
        const searchedNum = parseInt(orderNumMatch[1], 10);
        try {
          const snap = await db.collection("orders").where("orderNumber", "==", searchedNum).limit(1).get();
          if (!snap.empty) {
            latestOrder = { id: snap.docs[0].id, ...snap.docs[0].data() };
          }
        } catch (err) {
          console.warn("⚠️ Error buscando pedido por orderNumber:", err.message);
        }
      } else if (phoneMatch) {
        const phoneCandidate = phoneMatch[0];
        latestOrder = await getLatestOrderForUser(phoneCandidate);
      }

      // Si no tenemos pedido localizado por el mensaje, solicitar número de pedido o teléfono sin consultar Firestore con ""
      if (!latestOrder) {
        const askDetailsResponse =
          "Para poder consultar el estado de tu pedido, por favor indicanos tu *número de pedido* (ej. #1024) o el *número de teléfono* con el que realizaste la compra. 📦🔍";

        return {
          messages: [new AIMessage(askDetailsResponse)],
          activeAgent: "support",
        };
      }
    } else {
      console.log(`🔍 Consultando estado del pedido para ${userPhone}`);
      latestOrder = await getLatestOrderForUser(userPhone);
    }

    if (!latestOrder) {
      const notFoundResponse =
        `No encontramos ningún pedido registrado con tus datos en nuestro sistema.\n\n` +
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
  // CASO 4: MANEJO DE ENLACES EXTERNOS Y MULTIMEDIA (Punto 6)
  // -------------------------------------------------------------
  const urlPattern = /(?:https?:\/\/|www\.)[^\s]+|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be/i;
  const isVideo = state.incomingMedia?.mimetype?.startsWith("video/") || state.incomingMedia?.mimetype?.startsWith("audio/");

  if (urlPattern.test(lastMessage) || isVideo) {
    const linkMsg =
      "¡Hola! Por motivos de seguridad y limitaciones técnicas no puedo abrir enlaces externos ni ver videos en línea. 🔒📱\n\n" +
      "¿Qué producto o modelo viste en el enlace que te interesó? (Por ejemplo: vaso térmico, termo, billetera, kit de mate, taza, etc.). ¡Contame y con gusto te ayudo a cotizarlo! ✨";

    return {
      messages: [new AIMessage(linkMsg)],
      humanHandoffRequired: false,
      consecutiveMisunderstandings: 0,
      activeAgent: null,
    };
  }

  // -------------------------------------------------------------
  // CASO 5: DETECCIÓN DE RECLAMOS DIRECTOS (ESCALACIÓN A HANDOFF)
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
    "devolución",
    "queja",
    "tardaron mucho",
  ];

  const hasComplaint = complaintWords.some((w) => lastText.includes(w));
  if (hasComplaint) {
    const reason = `Reclamo del cliente: "${lastText.slice(0, 100)}"`;

    const complaintResponse =
      `Lamentamos mucho los inconvenientes con tu pedido. 😔\n\n` +
      `Ya derivé tu reclamo con un asesor humano de nuestro equipo para darte una solución inmediata. En breve te responderán por este medio.`;

    return {
      messages: [new AIMessage(complaintResponse)],
      humanHandoffRequired: true,
      humanHandoffReason: reason,
      intent: "human_handoff",
      activeAgent: null,
      consecutiveMisunderstandings: 0,
      awaitingMenuChoice: false,
      adminNotification: {
        type: "human_handoff",
        summary: reason,
      },
    };
  }

  // -------------------------------------------------------------
  // CASO 6: PREGUNTAS FRECUENTES (FAQ) MEDIANTE LLM CON DECISIÓN ESTRUCTURADA Y ESCALADA DE 4 FALLOS
  // -------------------------------------------------------------
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = createGeminiModel({ temperature: 0.2 });

      const systemPrompt = new SystemMessage(
        `Eres el asistente oficial de Atención al Cliente de HoDie Tienda de Regalos (Paraguay).
Tu objetivo es responder de manera muy amable, concisa y profesional en español de Paraguay a las consultas de los clientes.

${HODIE_KNOWLEDGE_BASE}

POLÍTICA DE DERIVACIÓN ESTRICTA (DECISIÓN ESTRUCTURADA):
1. "derivar" debe ser true ÚNICAMENTE si:
   - El cliente solicita explícitamente hablar con una persona, operador o asesor humano.
   - El cliente manifiesta un reclamo, queja o problema con un pedido.
2. Si el cliente pregunta por cotizaciones, precios, catálogo o disponibilidad de productos (termos, vasos, billeteras, kits de mate, etc.), indícale amablemente que sí los tenemos en nuestro catálogo y que con gusto le ayudamos a cotizar. En este caso: "understood": true, "derivar": false.
3. Si la consulta NO se puede responder con la base de conocimiento de HoDie o está fuera de nuestro rubro (por ejemplo: reparación de celulares, repuestos de autos, comida, etc.):
   "understood": false, "derivar": false. ¡NUNCA pongas derivar: true por una pregunta fuera de base! La derivación se maneja por escalada progresiva de intentos.
4. NUNCA prometas en el texto una derivación a asesor si "derivar" es false.

Responde ÚNICAMENTE en formato JSON válido con la siguiente estructura:
{
  "response": "respuesta amigable al cliente",
  "understood": true,
  "derivar": false,
  "motivo": null
}`
      );

      // Foco en el mensaje actual y sesión activa:
      // Excluir mensajes anteriores al corte de reactivación/sesión
      const cutoffIndex = state.sessionCutoffMessageCount || 0;
      const sessionMessages = state.messages.slice(cutoffIndex);
      const contextHistory = sessionMessages.slice(-8);

      const response = await model.invoke([systemPrompt, ...contextHistory]);
      let content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      content = content.replace(/```json/gi, "").replace(/```/g, "").trim();

      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        console.warn("⚠️ Error parseando JSON de supportAgent, usando heurística:", parseErr.message);
        parsed = {
          response: content,
          understood: true,
          derivar: false,
          motivo: null,
        };
      }

      // DECISIÓN ESTRUCTURADA:
      if (parsed.derivar) {
        const reason = parsed.motivo || "Solicitud de atención humana o reclamo detectado en FAQ";
        return {
          messages: [new AIMessage(parsed.response)],
          humanHandoffRequired: true,
          humanHandoffReason: reason,
          activeAgent: null,
          consecutiveMisunderstandings: 0,
          awaitingMenuChoice: false,
        };
      }

      // Si la consulta fue comprendida con éxito:
      if (parsed.understood) {
        return {
          messages: [new AIMessage(parsed.response)],
          humanHandoffRequired: false,
          activeAgent: null,
          consecutiveMisunderstandings: 0, // Reiniciar contador al entender
          awaitingMenuChoice: false,
        };
      }

      // ESCALADA UNIFICADA DE 4 FALLOS
      return handleMisunderstanding(state, {
        isBudget: false,
        promptStep: parsed.response,
        reason: "4 intentos consecutivos sin comprender la consulta del cliente",
      });
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
      "• *Minga Guazú:* Envío local gratuito (0 Gs.).\n" +
      "• *Resto del país:* Envío por transportadora con flete a abonar contra entrega al recibir.\n" +
      "• *Despacho:* Si tu pago ingresa antes del mediodía, se despacha en el día; si ingresa después, al día hábil siguiente.\n" +
      "• *Tiempo estimado transportadora:* 24 a 48 hs hábiles.";
  } else if (lastText.includes("donde") || lastText.includes("ubicacion") || lastText.includes("direccion")) {
    fallbackText = "📍 Nuestra tienda HoDie se encuentra en Barrio Centro, Minga Guazú, Alto Paraná, Paraguay. Hacemos envíos a todo el país.";
  } else if (lastText.includes("pago") || lastText.includes("transferencia") || lastText.includes("cuenta")) {
    fallbackText =
      "💳 *Métodos de pago:*\n\n" +
      "Aceptamos transferencias bancarias. Los datos de la cuenta se envían en el PDF oficial al confirmar el pedido. La confirmación es 100% manual por nuestro equipo.";
  }

  return {
    messages: [new AIMessage(fallbackText)],
    activeAgent: null,
    consecutiveMisunderstandings: 0,
    awaitingMenuChoice: false,
  };
};
