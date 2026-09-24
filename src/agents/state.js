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
 * @property {"name" | "city" | "street" | null} [shippingStep]
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
   * Archivo multimedia entrante en el turno actual
   * @type {IncomingMedia | null}
   */
  incomingMedia: Annotation({
    reducer: (_, next) => next,
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
});
