import { AIMessage } from "@langchain/core/messages";

/**
 * Notifica al administrador por WhatsApp sobre un evento relevante de derivación a asesor humano.
 * Compartido por los tres caminos de derivación: handoffNode, supportNode y budgetNode.
 *
 * @param {Object} params
 * @param {string} [params.userPhoneNumber]
 * @param {string} [params.whatsappChatId]
 * @param {string} [params.pushname]
 * @param {string} [params.reason]
 * @param {Object} [params.quoteContext]
 * @param {string} [params.orderNumber]
 * @param {Object} [params.state]
 */
export const notifyAdminHandoffAlert = async ({
  userPhoneNumber,
  whatsappChatId,
  pushname,
  reason,
  quoteContext,
  orderNumber,
  state,
}) => {
  const adminPhone = process.env.ADMIN_WHATSAPP_PHONE;
  if (!adminPhone) return false;

  const phone = userPhoneNumber || state?.userPhoneNumber;
  const chatId = whatsappChatId || state?.whatsappChatId;
  const name = pushname || state?.pushname;
  const ctx = quoteContext || state?.quoteContext;
  const ordNum = orderNumber || ctx?.orderNumber;

  const hasPhone = Boolean(phone && !phone.includes("@"));
  const clientDisplay = hasPhone
    ? `+${phone}`
    : `${name || "Contacto WhatsApp"} (${chatId || "ID no disponible"}) [número no disponible]`;

  const formalReason = reason || state?.humanHandoffReason || "Solicitud de atención humana o derivación";

  console.log(`🚨 Activando HumanHandoff para ${clientDisplay}. Motivo: ${formalReason}`);

  // Construir líneas de contexto detallado de cotización/pedido si existen en el estado
  const contextLines = [];

  if (ctx?.step) {
    const stepLabel = ctx.shippingStep ? `${ctx.step} (${ctx.shippingStep})` : ctx.step;
    contextLines.push(`• *Paso de cotización:* ${stepLabel}`);
  }
  if (ctx?.selectedProductName) {
    contextLines.push(`• *Producto:* ${ctx.selectedProductName}`);
  }
  if (ctx?.quantity) {
    contextLines.push(`• *Cantidad:* ${ctx.quantity}`);
  }
  const customization = ctx?.customizationDetails || ctx?.customizationProposed;
  if (customization) {
    contextLines.push(`• *Personalización:* ${customization}`);
  }
  if (ctx?.selectedPackaging?.name) {
    contextLines.push(`• *Empaque:* ${ctx.selectedPackaging.name}`);
  }
  if (ctx?.shippingAddress?.city) {
    contextLines.push(`• *Ciudad:* ${ctx.shippingAddress.city}`);
  }
  if (ctx?.shippingAddress?.street) {
    contextLines.push(`• *Dirección:* ${ctx.shippingAddress.street}`);
  }
  if (ctx?.total) {
    contextLines.push(`• *Total:* ${ctx.total.toLocaleString()} Gs.`);
  }
  if (ordNum) {
    contextLines.push(`• *Pedido:* #${ordNum}`);
  }

  const contextSection = contextLines.length > 0 ? `\n${contextLines.join("\n")}\n` : "";

  const adminChatId = adminPhone.includes("@") ? adminPhone : `${adminPhone}@c.us`;
  const adminAlert =
    `🚨 *Derivación a Asesor Humano*\n\n` +
    `• *Cliente:* ${clientDisplay}\n` +
    `• *ChatId:* ${chatId || "no provisto"}\n` +
    `• *Motivo:* ${formalReason}\n` +
    contextSection +
    `\n👉 El bot ha suspendido respuestas automáticas para este cliente. Por favor continuar la conversación directamente.`;

  let sent = false;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { whatsappClient } = await import("../../config/whatsapp.js");
      if (whatsappClient && typeof whatsappClient.sendMessage === "function") {
        await whatsappClient.sendMessage(adminChatId, adminAlert, { sendSeen: false });
        console.log(`📢 Alerta de handoff enviada al WhatsApp del admin (${adminPhone})`);
        sent = true;
        break;
      }
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  }

  if (!sent && lastError) {
    console.error(`🚨 Error enviando alerta de handoff al admin (${adminPhone}) tras 3 intentos:`, lastError.message);
  }

  return sent;
};

/**
 * Nodo de Handoff Humano (Terminal)
 *
 * Marca `humanHandoffRequired: true`, desactiva el agente activo (`activeAgent: null`),
 * envía una notificación formal al WhatsApp del administrador y devuelve un mensaje
 * cordial de transferencia al cliente informándole que un asesor continuará la atención.
 *
 * @param {import("../state.js").AgentState} state
 * @returns {Promise<Partial<import("../state.js").AgentState>>}
 */
export const handoffNode = async (state) => {
  const reason = state.humanHandoffReason || "Solicitud de atención humana o derivación";

  // Respuesta cordial al cliente
  const clientResponse =
    `Te he comunicado con un asesor de nuestro equipo para atenderte personalmente. 👤\n\n` +
    `En breve una persona te responderá directamente por este chat. ¡Muchas gracias por tu paciencia! ✨`;

  return {
    messages: [new AIMessage(clientResponse)],
    humanHandoffRequired: true,
    humanHandoffReason: reason,
    activeAgent: null,
    adminNotification: null,
  };
};
