import { Annotation, messagesStateReducer } from "@langchain/langgraph";

/**
 * @typedef {Object} ShippingAddress
 * @property {string} city
 * @property {string} department
 * @property {string} street
 * @property {string} [instructions]
 */

/**
 * @typedef {Object} BillingAddress
 * @property {string} [rucOrCi]
 * @property {string} [businessName]
 * @property {string} [fiscalAddress]
 */

/**
 * @typedef {Object} User
 * @property {string} uid
 * @property {string} phoneNumber - Número de WhatsApp usado como identificador único
 * @property {string} displayName
 * @property {boolean} whatsapp_verified
 * @property {"incomplete" | "complete"} profile_status
 * @property {ShippingAddress[]} [addresses]
 * @property {BillingAddress} [billingAddress]
 * @property {"customer" | "admin"} role
 * @property {any} createdAt - Timestamp de Firestore
 */

/**
 * @typedef {Object} PackagingSelection
 * @property {string} name
 * @property {number} price
 * @property {string} [imageUrl]
 */

/**
 * @typedef {Object} QuoteContext
 * @property {"idle" | "product_selection" | "customization" | "packaging_selection" | "shipping_info" | "confirmation" | "completed"} step
 * @property {"name" | "city" | "street" | "phone" | null} [shippingStep]
 * @property {string | null} [selectedProductId]
 * @property {string | null} [selectedProductName]
 * @property {string | null} [selectedProductSku]
 * @property {number} [unitPrice]
 * @property {string | null} [customizationDetails]
 * @property {{ mimetype: string, data: string, filename?: string } | null} [customizationMedia]
 * @property {PackagingSelection | null} [selectedPackaging]
 * @property {number} quantity
 * @property {ShippingAddress | null} [shippingAddress]
 * @property {number} [subtotal]
 * @property {number} [shippingCost]
 * @property {number} [total]
 */

/**
 * @typedef {Object} IncomingMedia
 * @property {string} mimetype
 * @property {string} data - Base64 encoded string
 * @property {string} [filename]
 */

/**
 * @typedef {Object} AdminNotification
 * @property {"payment_proof" | "human_handoff" | "order_created"} type
 * @property {string} summary
 * @property {any} [details]
 */

export const createDefaultQuoteContext = () => ({
  step: "idle",
  shippingStep: null,
  quantity: 1,
  selectedProductId: null,
  selectedProductName: null,
  selectedProductSku: null,
  unitPrice: 0,
  customizationDetails: null,
  customizationImageUrl: null,
  customizationImagePending: false,
  customizationMedia: null,
  selectedPackaging: null,
  shippingAddress: null,
  subtotal: 0,
  shippingCost: 0,
  total: 0,
});

/**
 * LangGraph State Annotation Schema
 */
export const AgentStateAnnotation = Annotation.Root({
  /**
   * Historial de mensajes de la conversación, acumulado con messagesStateReducer
   */
  messages: Annotation({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * Identificador canónico del usuario (número de teléfono normalizado, ej. "595981234567")
   */
  userPhoneNumber: Annotation({
    reducer: (prev, next) => {
      if (next && typeof next === "object" && next.reset === true) return "";
      return next !== undefined ? next : prev;
    },
    default: () => "",
  }),

  /**
   * Identificador de chat de WhatsApp tal cual lo entrega WhatsApp (@c.us o @lid).
   * Utilizado EXCLUSIVAMENTE para enviar mensajes de respuesta a través de WhatsApp.
   */
  whatsappChatId: Annotation({
    reducer: (prev, next) => {
      if (next && typeof next === "object" && next.reset === true) return "";
      return next !== undefined ? next : prev;
    },
    default: () => "",
  }),

  /**
   * Nombre público del contacto en WhatsApp (pushname / notifyName)
   */
  pushname: Annotation({
    reducer: (prev, next) => (next !== undefined ? next : prev),
    default: () => "",
  }),

  /**
   * Perfil del usuario cargado desde Firestore (colección 'users')
   * @type {User | null}
   */
  user: Annotation({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Clasificación de la intención detectada por el Router
   * 'budget_quote' | 'customer_support' | 'payment_proof' | 'order_status' | 'human_handoff' | 'general_faq'
   */
  intent: Annotation({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Agente activo para flujos multi-turno ('budget' | 'support' | null)
   */
  activeAgent: Annotation({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Contexto del proceso guiado de cotización.
   * El reset se dispara ÚNICAMENTE cuando se pasa la bandera explícita { reset: true },
   * evitando que actualizaciones legítimas con step: 'idle' descarten datos silenciosamente.
   * @type {QuoteContext}
   */
  quoteContext: Annotation({
    reducer: (current, next) => {
      if (next?.reset) {
        const { reset, ...rest } = next;
        return {
          ...createDefaultQuoteContext(),
          ...rest,
        };
      }
      return { ...current, ...next };
    },
    default: createDefaultQuoteContext,
  }),

  /**
   * Archivo multimedia entrante en el turno actual.
   * NOTA: Ningún nodo del sistema (router, budget, support) consume el binario o base64
   * de la imagen; solo requieren constatar la presencia del archivo y sus metadatos (mimetype, filename).
   * En cumplimiento con la opción (b), el reducer descarta cualquier payload pesado ('data')
   * para nunca exceder el límite de 1 MiB por documento en Firestore.
   * @type {IncomingMedia | null}
   */
  incomingMedia: Annotation({
    reducer: (_, next) => {
      if (!next) return null;
      if (typeof next === "object" && next.data) {
        const { data, ...metadata } = next;
        return metadata;
      }
      return next;
    },
    default: () => null,
  }),

  /**
   * Bandera que indica si la conversación fue derivada a un humano
   */
  humanHandoffRequired: Annotation({
    reducer: (_, next) => next,
    default: () => false,
  }),

  /**
   * Motivo por el cual se activó el handoff humano
   */
  humanHandoffReason: Annotation({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Notificación o alerta dirigida al administrador
   * @type {AdminNotification | null}
   */
  adminNotification: Annotation({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Contador de intentos seguidos sin entender al cliente (para escalada de 4 fallos)
   */
  consecutiveMisunderstandings: Annotation({
    reducer: (_, next) => (next !== undefined ? next : 0),
    default: () => 0,
  }),

  /**
   * Bandera que indica si el bot ofreció el menú de opciones (1. Catálogo, 2. Cotizar, 3. Estado de pedido)
   * y está esperando la selección del cliente. El router interpreta '1', '2', '3' solo cuando está activa.
   */
  awaitingMenuChoice: Annotation({
    reducer: (_, next) => Boolean(next),
    default: () => false,
  }),

  /**
   * Marca de tiempo de inicio de la sesión actual (milisegundos)
   */
  sessionStartTime: Annotation({
    reducer: (_, next) => (next !== undefined ? next : null),
    default: () => null,
  }),

  /**
   * Timestamp de corte de sesión: los mensajes anteriores a este timestamp no se envían al LLM
   */
  sessionCutoffTime: Annotation({
    reducer: (_, next) => (next !== undefined ? next : 0),
    default: () => 0,
  }),

  /**
   * Índice de corte de mensajes de la sesión actual: mensajes anteriores a este índice no se envían al LLM
   */
  sessionCutoffMessageCount: Annotation({
    reducer: (_, next) => (next !== undefined ? next : 0),
    default: () => 0,
  }),

  /**
   * Bandera temporal que indica si ya se despachó la alerta al administrador en el turno actual
   */
  adminAlertSent: Annotation({
    reducer: (_, next) => Boolean(next),
    default: () => false,
  }),

  /**
   * Marca temporal ISO de la última reactivación por un administrador
   */
  resumedAt: Annotation({
    reducer: (_, next) => (next !== undefined ? next : null),
    default: () => null,
  }),

  /**
   * Marca temporal del último mensaje procesado en el hilo
   */
  lastActivityTimestamp: Annotation({
    reducer: (_, next) => (next !== undefined ? next : null),
    default: () => null,
  }),
});
