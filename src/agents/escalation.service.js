import { AIMessage } from "@langchain/core/messages";

/**
 * Servicio unificado de escalada ante consultas o datos no comprendidos (4 intentos).
 * Compartido entre SupportAgent y BudgetAgent.
 *
 * Reglas del proyecto:
 * 1. El contador y umbral (4 intentos) son compartidos en `consecutiveMisunderstandings`.
 * 2. Si el cliente está fuera de cotización (SupportAgent):
 *    - Paso 1: Reformular la pregunta orientando sobre el rubro de regalos personalizados.
 *    - Pasos 2 y 3: Menú numerado (1. Catálogo, 2. Cotizar, 3. Estado de pedido) + ofrecer "Asesor".
 *      Activa la bandera `awaitingMenuChoice: true`.
 * 3. Si el cliente está dentro de una cotización (BudgetAgent):
 *    - Pasos 1, 2 y 3: Vuelven a solicitar el MISMO dato requerido en el paso actual
 *      con un ejemplo concreto y ofrecen escribir "Asesor". Nunca muestran el menú
 *      genérico ni pierden el `quoteContext`.
 * 4. Paso 4: Derivación formal a asesor humano marcando `humanHandoffRequired: true` y
 *    `activeAgent: null`.
 * 5. ALERTA AL ADMIN: Este servicio NUNCA llama a `notifyAdminHandoffAlert`.
 *    La alerta se dispara de forma centralizada y exclusiva desde `whatsapp.js`
 *    cuando `humanHandoffRequired` transiciona a `true`.
 *
 * @param {import("./state.js").AgentState} state
 * @param {Object} [options={}]
 * @param {boolean} [options.isBudget=false] - Indica si la escalada ocurre dentro del flujo de cotización
 * @param {string} [options.promptStep] - Mensaje de reformulación para paso 1
 * @param {string} [options.promptStep2] - Mensaje contextual para paso 2 (mismo dato + ejemplo + asesor)
 * @param {string} [options.promptStep3] - Mensaje contextual para paso 3 (mismo dato + ejemplo + asesor)
 * @param {string} [options.activeAgent] - Agente activo a mantener ("budget" | null)
 * @param {Object} [options.quoteContext] - Contexto de cotización a preservar intacto
 * @param {string} [options.reason] - Motivo de derivación para el paso 4
 * @returns {Partial<import("./state.js").AgentState>}
 */
export const handleMisunderstanding = (state, options = {}) => {
  const currentFailures = (state.consecutiveMisunderstandings || 0) + 1;
  const isBudget = Boolean(options.isBudget ?? (state.activeAgent === "budget"));
  const preservedQuoteContext = options.quoteContext !== undefined ? options.quoteContext : state.quoteContext;

  // -------------------------------------------------------------
  // ESCALADA DENTRO DE UNA COTIZACIÓN (BudgetAgent)
  // -------------------------------------------------------------
  if (isBudget) {
    if (currentFailures === 1) {
      const step1Text =
        options.promptStep ||
        "Por favor indícanos el dato solicitado para poder avanzar con tu cotización. 📝";

      return {
        messages: [new AIMessage(step1Text)],
        humanHandoffRequired: false,
        consecutiveMisunderstandings: 1,
        activeAgent: "budget",
        awaitingMenuChoice: false,
        quoteContext: preservedQuoteContext,
      };
    }

    if (currentFailures === 2) {
      const step2Text =
        options.promptStep2 ||
        `${options.promptStep || "No logré comprender tu respuesta."}\n\n💡 Podés escribir el dato solicitado o enviar *"Asesor"* si preferís atención humana.`;

      return {
        messages: [new AIMessage(step2Text)],
        humanHandoffRequired: false,
        consecutiveMisunderstandings: 2,
        activeAgent: "budget",
        awaitingMenuChoice: false,
        quoteContext: preservedQuoteContext,
      };
    }

    if (currentFailures === 3) {
      const step3Text =
        options.promptStep3 ||
        `${options.promptStep || "Seguimos sin validar tu respuesta."}\n\n👉 Respondé con el dato solicitado o escribí *"Asesor"* para que un miembro de nuestro equipo te asista directamente.`;

      return {
        messages: [new AIMessage(step3Text)],
        humanHandoffRequired: false,
        consecutiveMisunderstandings: 3,
        activeAgent: "budget",
        awaitingMenuChoice: false,
        quoteContext: preservedQuoteContext,
      };
    }

    // Paso >= 4: Derivar a humano manteniendo el quoteContext intacto
    const f4Reason = options.reason || "4 intentos consecutivos sin comprender el dato de cotización";
    const f4Text =
      "Tuvimos dificultades para registrar tus datos tras varios intentos. 👤 " +
      "Te transfiero con un asesor de nuestro equipo para asistirte con la cotización personalmente. " +
      "¡En breve te escriben por este chat! ✨";

    return {
      messages: [new AIMessage(f4Text)],
      humanHandoffRequired: true,
      humanHandoffReason: f4Reason,
      activeAgent: null,
      consecutiveMisunderstandings: 4,
      awaitingMenuChoice: false,
      quoteContext: preservedQuoteContext,
    };
  }

  // -------------------------------------------------------------
  // ESCALADA FUERA DE COTIZACIÓN (SupportAgent / General)
  // -------------------------------------------------------------
  if (currentFailures === 1) {
    const f1Text =
      options.promptStep ||
      "¡Hola! En HoDie nos especializamos exclusivamente en regalos personalizados " +
      "(termos, vasos térmicos con abridor, billeteras grabadas, kits de mate y tazas). 🤔\n\n" +
      "¿Deseas información sobre alguno de nuestros productos o tenés alguna duda sobre envíos?";

    return {
      messages: [new AIMessage(f1Text)],
      humanHandoffRequired: false,
      consecutiveMisunderstandings: 1,
      activeAgent: null,
      awaitingMenuChoice: false,
    };
  }

  if (currentFailures === 2) {
    const f2Text =
      "No estoy seguro de comprender tu consulta. 🤔 Para poder ayudarte mejor, por favor elegí una de estas opciones escribiendo el número:\n\n" +
      "1️⃣ *Ver catálogo* de regalos personalizados.\n" +
      "2️⃣ *Cotizar* un producto.\n" +
      "3️⃣ Consultar el *estado de un pedido* existente.\n\n" +
      "💡 También podés escribir *'Asesor'* si preferís hablar directamente con una persona de nuestro equipo.";

    return {
      messages: [new AIMessage(f2Text)],
      humanHandoffRequired: false,
      consecutiveMisunderstandings: 2,
      activeAgent: null,
      awaitingMenuChoice: true,
    };
  }

  if (currentFailures === 3) {
    const f3Text =
      "Sigo sin comprender lo que necesitas. 💬 Te recuerdo las opciones disponibles:\n\n" +
      "1️⃣ Ver catálogo de regalos.\n" +
      "2️⃣ Cotizar un regalo personalizado.\n" +
      "3️⃣ Estado de tu pedido.\n\n" +
      "👉 Si tu consulta requiere atención especial, respondé *'Asesor'* y te comunico enseguida con una persona de nuestro equipo.";

    return {
      messages: [new AIMessage(f3Text)],
      humanHandoffRequired: false,
      consecutiveMisunderstandings: 3,
      activeAgent: null,
      awaitingMenuChoice: true,
    };
  }

  // Paso >= 4: Derivar a asesor humano
  const f4Reason = options.reason || "4 intentos consecutivos sin comprender la consulta del cliente";
  const f4Text =
    "He tenido dificultades para comprender tu consulta tras varios intentos. 👤 " +
    "Para brindarte una mejor atención, te estoy comunicando directamente con un asesor de nuestro equipo.\n\n" +
    "En breve una persona te responderá por este chat. ¡Muchas gracias por tu paciencia! ✨";

  return {
    messages: [new AIMessage(f4Text)],
    humanHandoffRequired: true,
    humanHandoffReason: f4Reason,
    activeAgent: null,
    consecutiveMisunderstandings: 4,
    awaitingMenuChoice: false,
  };
};
