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
 */
export const notifyAdminHandoffAlert = async ({
  userPhoneNumber,
  whatsappChatId,
  pushname,
  reason,
}) => {
  const adminPhone = process.env.ADMIN_WHATSAPP_PHONE;
  if (!adminPhone) return;

  const hasPhone = Boolean(userPhoneNumber && !userPhoneNumber.includes("@"));
  const clientDisplay = hasPhone
    ? `+${userPhoneNumber}`
    : `${pushname || "Contacto WhatsApp"} (${whatsappChatId || "ID no disponible"}) [número no disponible]`;

  const formalReason = reason || "Solicitud de atención humana o derivación";

  console.log(`🚨 Activando HumanHandoff para ${clientDisplay}. Motivo: ${formalReason}`);

  try {
    const { whatsappClient } = await import("../../config/whatsapp.js");
    const adminChatId = adminPhone.includes("@") ? adminPhone : `${adminPhone}@c.us`;
    const adminAlert =
      `🚨 *Derivación a Asesor Humano*\n\n` +
      `• *Cliente:* ${clientDisplay}\n` +
      `• *Motivo:* ${formalReason}\n\n` +
      `👉 El bot ha suspendido respuestas automáticas para este cliente. Por favor continuar la conversación directamente.`;

    await whatsappClient.sendMessage(adminChatId, adminAlert, { sendSeen: false });
    console.log(`📢 Alerta de handoff enviada al WhatsApp del admin (${adminPhone})`);
  } catch (err) {
    console.warn("⚠️ No se pudo enviar notificación WhatsApp al admin:", err.message);
  }
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

  // 1. Notificar al administrador por WhatsApp mediante helper compartido
  await notifyAdminHandoffAlert({
    userPhoneNumber: state.userPhoneNumber,
    whatsappChatId: state.whatsappChatId,
    pushname: state.pushname,
    reason,
  });

  // 2. Respuesta cordial al cliente
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
