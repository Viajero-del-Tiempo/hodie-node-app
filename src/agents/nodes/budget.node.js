import { AIMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { db } from "../../config/firebase.js";
import {
  processAndSendOrder,
  generateUniqueOrderNumber,
  calculateQuoteTotals,
  determineShippingMethod,
} from "../../services/order.service.js";
import { sendOrderStatus, notifyAdminViaWhatsApp } from "../../services/whatsapp.service.js";
import { notifyAdminHandoffAlert } from "./handoff.node.js";

/**
 * Lematizador básico de español para normalizar tildes y plurales.
 * Permite emparejar "vasos" -> "vaso", "térmico"/"Térmicos" -> "termico", "termos" -> "termo".
 *
 * @param {string} word
 * @returns {string}
 */
export const stemSpanish = (word) => {
  if (!word || typeof word !== "string") return "";
  let w = word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (w.endsWith("ces") && w.length > 4) return w.slice(0, -3) + "z";
  if (w.endsWith("es") && w.length > 4) {
    const root = w.slice(0, -2);
    if (/[bcdfghjklmnpqrstvwxyz]$/.test(root)) return root;
  }
  if (w.endsWith("s") && w.length > 3 && !w.endsWith("is") && !w.endsWith("us")) {
    return w.slice(0, -1);
  }
  return w;
};

/**
 * Determina si un texto representa una afirmación o confirmación en español.
 * @param {string} text
 * @returns {boolean}
 */
export const isAffirmative = (text) => {
  const norm = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const affirmativeWords = [
    "si",
    "correcto",
    "exacto",
    "asies",
    "asi es",
    "dale",
    "ok",
    "confirmo",
    "confirmar",
    "claro",
    "esta bien",
    "está bien",
    "perfecto",
    "de una",
    "deacuerdo",
    "de acuerdo",
    "ese",
    "ese mismo",
    "esa",
    "esa misma",
  ];
  return affirmativeWords.includes(norm) || affirmativeWords.some((w) => norm === w || norm.startsWith(`${w} `) || norm.endsWith(` ${w}`));
};

/**
 * Extrae con LLM el texto a grabar EXACTAMENTE como lo escribió el cliente:
 * sin corregir ortografía, tildes, mayúsculas ni puntuación, solo quitando comillas envolventes
 * y frases conversacionales introductorias.
 *
 * @param {string} rawText
 * @returns {Promise<string>}
 */
export const extractEngravingTextWithLLM = async (rawText) => {
  if (!rawText || typeof rawText !== "string") return "";

  const norm = rawText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (
    norm === "sin personalizacion" ||
    norm === "sin grabado" ||
    norm === "nada" ||
    norm === "ninguno" ||
    norm === "ninguna" ||
    norm.includes("sin personalizacion") ||
    norm.includes("sin grabado")
  ) {
    return "Sin grabado";
  }

  try {
    const model = new ChatGoogleGenerativeAI({
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      temperature: 0,
      apiKey: process.env.GOOGLE_API_KEY,
    });

    const prompt = [
      "Eres un extractor de texto a grabar en productos personalizados.",
      "Tu única tarea es identificar el texto, nombre o dedicatoria que el cliente desea grabar en su producto a partir de su mensaje.",
      "",
      "REGLAS ESTRICTAS E INVIOLABLES:",
      "1. Extrae el texto EXACTAMENTE como lo escribió el cliente. NUNCA corrijas la ortografía, tildes, mayúsculas, minúsculas ni signos de puntuación.",
      "   - Si el cliente escribió \"analia\", devuelve \"analia\" (NO \"Analia\" ni \"Analía\").",
      "   - Si el cliente escribió \"Quiero que diga «Feliz cumple Ma»\", devuelve \"Feliz cumple Ma\".",
      "   - Si el cliente escribió \"Ponle 'Te amo'\", devuelve \"Te amo\".",
      "2. Elimina ÚNICAMENTE las frases conversacionales que introducen la petición (ej: \"Quiero que tenga mi nombre\", \"Quiero que diga\", \"Ponle\", \"Que tenga el nombre\", \"Grabar\", \"A nombre de\", \"Que diga\", \"Quisiera que diga\") y las comillas que envuelven al texto (\", ', «, », “, ”).",
      "3. Si el cliente indica que no desea personalizar (ej. \"sin personalización\", \"ninguno\", \"nada\"), devuelve exactamente \"Sin grabado\".",
      "4. Devuelve ÚNICAMENTE el texto extraído sin comillas, sin explicaciones ni palabras adicionales.",
      "",
      `Mensaje del cliente: "${rawText}"`,
      "Texto a grabar:"
    ].join("\n");

    const res = await model.invoke(prompt);
    let extracted = (typeof res?.content === "string" ? res.content : "").trim();
    extracted = extracted.replace(/^["'«“](.*)["'»”]$/, "$1").trim();
    if (extracted) return extracted;
  } catch (err) {
    console.warn("⚠️ Fallo en LLM para extracción de grabado, usando extractor regex de respaldo:", err.message);
  }

  // Respaldo regex determinista sin LLM
  let fallback = rawText.trim();
  const prefixRegex = /^(?:quiero\s+que\s+(?:diga|tenga(?:\s+el\s+nombre)?)|ponle|poner|grabar|que\s+diga|a\s+nombre\s+de)\s*:?\s*/i;
  fallback = fallback.replace(prefixRegex, "").trim();
  fallback = fallback.replace(/^["'«“](.*)["'»”]$/, "$1").trim();
  return fallback;
};

/**
 * Normaliza cadenas eliminando acentos y espacios
 * @param {string} text
 * @returns {string}
 */
const normalize = (text) =>
  (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/**
 * Obtiene el catálogo de productos disponibles en Firestore.
 * Si Firestore falla o la colección está vacía, devuelve un arreglo vacío [].
 * NUNCA recurre a un catálogo simulado ni hardcodeado para evitar cotizar precios o productos no reales.
 *
 * @returns {Promise<Array<any>>}
 */
export const getAvailableProducts = async () => {
  try {
    const snapshot = await db.collection("products").where("stock", ">", 0).get();
    if (!snapshot.empty) {
      return snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((p) => p.active !== false);
    }

    const allSnapshot = await db.collection("products").get();
    if (!allSnapshot.empty) {
      return allSnapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((p) => p.active !== false);
    }
  } catch (err) {
    console.warn("⚠️ No se pudo consultar productos en Firestore:", err.message);
  }

  return [];
};

/**
 * Nombres amigables de empaque alineados con el modelo de la tienda Angular (PackagingOption)
 */
export const PACKAGING_LABELS = {
  caja: "Caja de Regalo",
  bolsa: "Bolsa Decorativa",
  envoltorio: "Envoltorio Especial",
  estandar: "Empaque Estándar",
};

/**
 * Extrae la cantidad usando patrones genéricos independientes de los nombres de productos.
 * No depende de un catálogo cerrado ni de sustantivos específicos (tazas, termos, etc.).
 *
 * Ejemplos soportados:
 * - "2 unidades", "3 piezas", "5 uds", "1 unidad"
 * - "x2", "x 3", "2x"
 * - "cantidad: 4", "cantidad 2"
 * - "quiero 3", "necesito 2", "serían 5", "pedir 4"
 *
 * @param {string} text
 * @returns {number | null}
 */
export const extractQuantity = (text) => {
  if (!text || typeof text !== "string") return null;

  const patterns = [
    /\b(\d+)\s*(?:unidades?|unidad|u\b|piezas?|items?|uds?)\b/i,
    /\bx\s*(\d+)\b/i,
    /\b(\d+)\s*x\b/i,
    /\bcantidad[:\s]+(\d+)\b/i,
    /\b(?:quiero|necesito|serian|serían|pedir|dame|mandame)\s+(\d+)\b/i,
    /\b(\d+)\s+(?:vasos?|termos?|tazas?|billeteras?|remeras?|champañeras?|cuadros?|chopps?|regalos?|productos?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > 0) return num;
    }
  }

  return null;
};

export const SPANISH_NUMBER_WORDS = {
  uno: 1, una: 1, un: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
};

export const parseQuantity = (text) => {
  if (!text || typeof text !== "string") return null;
  const fromRegex = extractQuantity(text);
  if (fromRegex !== null) return fromRegex;

  const trimmed = text.trim();
  const directNum = parseInt(trimmed, 10);
  if (!isNaN(directNum) && String(directNum) === trimmed) {
    return directNum;
  }

  const matchDigits = text.match(/\b(\d+)\b/);
  if (matchDigits) {
    const num = parseInt(matchDigits[1], 10);
    if (!isNaN(num)) return num;
  }

  const norm = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const words = norm.split(/[\s,\.\-]+/);
  for (const word of words) {
    if (SPANISH_NUMBER_WORDS[word]) {
      return SPANISH_NUMBER_WORDS[word];
    }
  }

  return null;
};

const STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "de", "del", "con", "para", "por", "favor", "quiero",
  "quisiera", "cotizar", "me", "gustaria", "interesa",
  "precio", "cuanto", "cuesta", "producto", "hola",
  "buenos", "dias", "tardes", "noches", "que", "en"
]);

export const searchProductMatches = (text, products) => {
  if (!text || typeof text !== "string" || !Array.isArray(products) || products.length === 0) {
    return [];
  }
  const userTokens = text
    .split(/[\s,\.\-]+/)
    .map(stemSpanish)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  if (userTokens.length === 0) return [];

  const scoredMatches = products
    .map((p) => {
      const pNameTokens = p.name.split(/[\s,\.\-]+/).map(stemSpanish);
      const pSkuTokens = (p.sku || "").split(/[\s,\.\-]+/).map(stemSpanish);
      const allPTokens = [...pNameTokens, ...pSkuTokens];

      const score = userTokens.filter((uToken) =>
        allPTokens.some((pToken) => pToken === uToken || pToken.includes(uToken) || uToken.includes(pToken))
      ).length;

      return { product: p, score };
    })
    .filter((item) => item.score > 0);

  if (scoredMatches.length === 0) return [];

  const maxScore = Math.max(...scoredMatches.map((m) => m.score));
  return scoredMatches
    .filter((m) => m.score === maxScore)
    .map((m) => m.product);
};

/**
 * Normaliza y valida un número de teléfono paraguayo según reglas de negocio:
 * - Formato canónico: 595 + 9 dígitos (12 dígitos numéricos en total, ej. 595985930912).
 * - Si empieza con '09' (10 dígitos, ej. 0985930912), se normaliza a 595 + 9 dígitos (595985930912).
 * - Si empieza con '9' (9 dígitos, ej. 985930912), se antepone '595'.
 * - Si ya tiene 12 dígitos comenzando con '5959', se retorna tal cual.
 * - Cualquier otro formato, longitud o prefijo retorna null.
 *
 * @param {string} input
 * @returns {string | null}
 */
export const normalizeParaguayanPhone = (input) => {
  if (!input || typeof input !== "string") return null;
  // Quitar espacios, guiones, paréntesis, puntos y el "+" antes de validar
  const cleaned = input.replace(/[\s\-\(\)\.\+]/g, "").trim();
  const digits = cleaned.replace(/\D/g, "");

  // Si contenía caracteres inválidos no permitidos (ej. letras u otros símbolos)
  if (!digits || digits.length !== cleaned.length) {
    return null;
  }

  // 1. Si empieza con 09 y tiene 10 dígitos -> 595 + 9 dígitos
  if (/^09\d{8}$/.test(digits)) {
    return `595${digits.slice(1)}`;
  }

  // 2. Si tiene 12 dígitos y empieza con 5959
  if (/^5959\d{8}$/.test(digits)) {
    return digits;
  }

  // 3. Si tiene 9 dígitos y empieza con 9
  if (/^9\d{8}$/.test(digits)) {
    return `595${digits}`;
  }

  return null;
};

/**
 * Construye el mensaje de confirmación final con el resumen de la orden
 * @param {any} shippingAddress
 * @param {string} phone
 * @param {any} quoteContext
 * @returns {string}
 */
const buildConfirmationPrompt = (shippingAddress, phone, quoteContext) => {
  const locationStr = shippingAddress.department
    ? `${shippingAddress.city}, ${shippingAddress.department}`
    : shippingAddress.city;

  const shippingMethod = determineShippingMethod(shippingAddress.city);
  const shippingLabel =
    shippingMethod === "local_gratis"
      ? "Envío local gratuito (Minga Guazú)"
      : "Envío por transportadora (flete con pago contra entrega)";

  return (
    `🔍 *Confirmación Final de tu Pedido HoDie:*\n\n` +
    `• *Destinatario:* ${shippingAddress.recipientName}\n` +
    `• *Teléfono:* +${phone}\n` +
    `• *Ubicación:* ${locationStr}\n` +
    `• *Dirección:* ${shippingAddress.street}\n` +
    `• *Modalidad de Envío:* ${shippingLabel}\n` +
    `• *Producto:* ${quoteContext.selectedProductName} (x${quoteContext.quantity})\n` +
    `• *Empaque:* ${quoteContext.selectedPackaging?.name || "Estándar"}\n` +
    `• *Total:* *${(quoteContext.total || 0).toLocaleString()} Gs.*\n\n` +
    `¿Confirmás el pedido para generar el comprobante oficial en PDF con los datos para la transferencia? 📄\n\n` +
    `👉 Respondé *"Sí, confirmo"* para emitir tu orden, o *"Cancelar"* para anular.`
  );
};

/**
 * Nodo Presupuestador (BudgetAgent)
 *
 * Orquesta el flujo guiado multi-turno de presupuestación paso a paso:
 * 1. idle / inicio -> Muestra catálogo de productos -> product_selection
 * 2. product_selection -> Selecciona producto y cantidad -> customization
 * 3. customization -> Captura diseño/frase/imagen -> packaging_selection
 * 4. packaging_selection -> Selecciona empaque y calcula cotización -> shipping_info
 * 5. shipping_info -> Captura dirección y datos del cliente -> confirmation
 * 6. confirmation -> Si confirma: Invoca order.service.js, genera PDF, despacha por WhatsApp y resetea contexto.
 *
 * @param {import("../state.js").AgentState} state
 * @returns {Promise<Partial<import("../state.js").AgentState>>}
 */
export async function budgetAgentNode(state) {
  const lastMessage = state.messages[state.messages.length - 1]?.content || "";
  const rawText = typeof lastMessage === "string" ? lastMessage.trim() : "";
  const normalizedText = normalize(rawText);
  const currentContext = state.quoteContext || { step: "idle", quantity: 1 };

  // -------------------------------------------------------------
  // CONTROL DE CANCELACIÓN O PEDIDO DE ASESOR DENTRO DEL NODO
  // (Doble capa de seguridad por si el mensaje llegó directo a este nodo)
  // -------------------------------------------------------------
  const cancelPhrases = ["cancelar", "ya no quiero", "salir", "reiniciar", "anular"];
  if (cancelPhrases.some((p) => normalizedText.includes(p))) {
    return {
      messages: [new AIMessage("Cotización cancelada. Si querés consultar otra cosa o ver otros productos, escribinos cuando gustes. ¡Hasta pronto! 👋")],
      activeAgent: null,
      quoteContext: { reset: true },
    };
  }

  const humanPhrases = [
    "hablar con un asesor",
    "hablar con una persona",
    "asesor humano",
    "operador humano",
    "atencion personalizada",
    "atencion humana",
    "pasame con alguien",
    "pasame con un humano",
  ];
  if (humanPhrases.some((p) => normalizedText.includes(p))) {
    return {
      humanHandoffRequired: true,
      humanHandoffReason: "Cliente solicitó asesor humano durante la cotización",
      intent: "human_handoff",
      activeAgent: null,
    };
  }

  // -------------------------------------------------------------
  // VERIFICACIÓN DE DISPONIBILIDAD DEL CATÁLOGO REAL EN FIRESTORE
  // Si Firestore falla o la colección está vacía, NO ofrecer datos inventados.
  // Notificar al cliente y derivar de inmediato a un asesor humano.
  // -------------------------------------------------------------
  const products = await getAvailableProducts();
  if (!products || products.length === 0) {
    const reason = "Catálogo de productos no disponible o vacío en Firestore";
    await notifyAdminHandoffAlert({
      userPhoneNumber: state.userPhoneNumber,
      whatsappChatId: state.whatsappChatId,
      pushname: state.pushname,
      reason,
    });
    return {
      messages: [
        new AIMessage(
          "Disculpá, en este momento no puedo acceder a nuestro catálogo de productos en el sistema. Te comunico con un asesor de nuestro equipo para que te brinde la información y te ayude personalmente. 🧑‍💼"
        ),
      ],
      humanHandoffRequired: true,
      humanHandoffReason: reason,
      activeAgent: null,
    };
  }

  // -------------------------------------------------------------
  // PASO 0: INICIO (DESDE IDLE) O REINICIO
  // -------------------------------------------------------------
  if (!currentContext.step || currentContext.step === "idle") {
    const wantsCatalog = normalizedText.includes("catalogo");

    if (!wantsCatalog) {
      const topMatches = searchProductMatches(rawText, products);
      const detectedQty = extractQuantity(rawText);

      // Si el cliente pide más de 100 unidades en el primer mensaje -> handoff corporativo inmediato
      if (detectedQty && detectedQty > 100 && topMatches.length >= 1) {
        const matched = topMatches[0];
        const reason = `pedido corporativo de ${detectedQty} unidades de ${matched.name}`;
        await notifyAdminHandoffAlert({
          userPhoneNumber: state.userPhoneNumber,
          whatsappChatId: state.whatsappChatId,
          pushname: state.pushname,
          reason,
        });
        return {
          messages: [
            new AIMessage(
              `¡Hola! Para pedidos corporativos o mayoristas de ${detectedQty} unidades de *${matched.name}*, un asesor de nuestro equipo te va a atender de forma personalizada para ofrecerte la mejor tarifa y coordinar los detalles. Enseguida te escriben por acá. 🧑‍💼✨`
            ),
          ],
          humanHandoffRequired: true,
          humanHandoffReason: reason,
          activeAgent: null,
          quoteContext: { reset: true },
        };
      }

      // Coincidencia única en el primer mensaje
      if (topMatches.length === 1) {
        const matched = topMatches[0];
        return {
          messages: [
            new AIMessage(
              `¡Hola! Con mucho gusto te ayudo a cotizar en HoDie. 🎁✨\n\n¿Te referís al *${matched.name}*? (Respondé *"Sí"* para continuar o si preferís ver todas las opciones, escribí *"catálogo"*).`
            ),
          ],
          activeAgent: "budget",
          quoteContext: {
            step: "product_selection",
            pendingProductConfirmation: matched,
            detectedQuantity: detectedQty || null,
          },
        };
      }

      // Múltiples coincidencias en el primer mensaje
      if (topMatches.length > 1) {
        let filterMessage = `¡Hola! Con mucho gusto te ayudo a cotizar en HoDie. 🎁✨\n\nEncontramos estas opciones relacionadas con tu búsqueda:\n\n`;
        topMatches.forEach((p, idx) => {
          filterMessage += `${idx + 1}. *${p.name}* (${p.price.toLocaleString()} Gs.)\n   _${p.description || ""}_\n\n`;
        });
        filterMessage += `¿Cuál de ellos te gustaría cotizar? (Respondé con el número o nombre, o escribí *"catálogo"* para ver todas las opciones).`;

        return {
          messages: [new AIMessage(filterMessage)],
          activeAgent: "budget",
          quoteContext: {
            step: "product_selection",
            candidateProductIds: topMatches.map((p) => p.id),
            detectedQuantity: detectedQty || null,
          },
        };
      }
    }

    // Catálogo completo
    let catalogMessage = "¡Hola! Con mucho gusto te ayudo a cotizar tu regalo personalizado en HoDie. 🎁✨\n\nEstos son nuestros productos disponibles:\n\n";

    products.forEach((p, idx) => {
      catalogMessage += `${idx + 1}. *${p.name}* — ${p.price.toLocaleString()} Gs.\n   _${p.description}_\n\n`;
    });

    catalogMessage += "¿Cuál de estos productos te gustaría cotizar? (Podés responder con el número o el nombre del producto).";

    return {
      messages: [new AIMessage(catalogMessage)],
      activeAgent: "budget",
      quoteContext: {
        step: "product_selection",
        quantity: 1,
      },
    };
  }

  // -------------------------------------------------------------
  // PASO 1: SELECCIÓN DE PRODUCTO (product_selection)
  // -------------------------------------------------------------
  if (currentContext.step === "product_selection") {
    // Si el usuario pide el catálogo completo
    if (normalizedText.includes("catalogo")) {
      let catalogMessage = "Estos son todos nuestros productos disponibles en el catálogo:\n\n";
      products.forEach((p, idx) => {
        catalogMessage += `${idx + 1}. *${p.name}* — ${p.price.toLocaleString()} Gs.\n   _${p.description}_\n\n`;
      });
      catalogMessage += "¿Cuál de ellos te gustaría cotizar? (Respondé con el número o nombre).";
      return {
        messages: [new AIMessage(catalogMessage)],
        activeAgent: "budget",
        quoteContext: {
          ...currentContext,
          candidateProductIds: null,
          pendingProductConfirmation: null,
        },
      };
    }

    let selectedProduct = null;

    // A. Si estábamos esperando confirmación de un producto sugerido por palabra clave
    if (currentContext.pendingProductConfirmation) {
      const candidate = currentContext.pendingProductConfirmation;
      if (isAffirmative(normalizedText)) {
        selectedProduct = candidate;
      } else {
        currentContext.pendingProductConfirmation = null;
      }
    }

    // B. Selección directa por número (1, 2, 3...)
    if (!selectedProduct) {
      const pool = currentContext.candidateProductIds?.length
        ? products.filter((p) => currentContext.candidateProductIds.includes(p.id))
        : products;

      const parsedIdx = parseInt(normalizedText, 10);
      if (!isNaN(parsedIdx) && parsedIdx >= 1 && parsedIdx <= pool.length) {
        selectedProduct = pool[parsedIdx - 1];
      }
    }

    // C. Búsqueda por palabras clave con stemmer
    if (!selectedProduct) {
      const topMatches = searchProductMatches(rawText, products);

      if (topMatches.length === 1) {
        selectedProduct = topMatches[0];
      } else if (topMatches.length > 1) {
        const detectedQty = extractQuantity(rawText) || currentContext.detectedQuantity || null;
        if (detectedQty && detectedQty > 100) {
          const reason = `pedido corporativo de ${detectedQty} unidades de ${topMatches[0].name}`;
          await notifyAdminHandoffAlert({
            userPhoneNumber: state.userPhoneNumber,
            whatsappChatId: state.whatsappChatId,
            pushname: state.pushname,
            reason,
          });
          return {
            messages: [
              new AIMessage(
                `¡Excelente! Para pedidos corporativos o mayoristas de ${detectedQty} unidades, un asesor de nuestro equipo te va a atender de forma personalizada para ofrecerte la mejor tarifa y coordinar los detalles. Enseguida te escriben por acá. 🧑‍💼✨`
              ),
            ],
            humanHandoffRequired: true,
            humanHandoffReason: reason,
            activeAgent: null,
            quoteContext: { reset: true },
          };
        }

        let filterMessage = `Encontramos estas opciones relacionadas con tu búsqueda:\n\n`;
        topMatches.forEach((p, idx) => {
          filterMessage += `${idx + 1}. *${p.name}* (${p.price.toLocaleString()} Gs.)\n   _${p.description || ""}_\n\n`;
        });
        filterMessage += `¿Cuál de ellos te gustaría cotizar? (Respondé con el número o nombre).`;

        return {
          messages: [new AIMessage(filterMessage)],
          activeAgent: "budget",
          quoteContext: {
            ...currentContext,
            candidateProductIds: topMatches.map((p) => p.id),
            pendingProductConfirmation: null,
          },
        };
      }
    }

    // Manejo de respuesta inesperada: repreguntar amablemente mostrando el catálogo
    if (!selectedProduct) {
      let retryMessage = "No logré identificar qué producto deseás cotizar. 🤔\n\nPor favor respondé con el número de la opción:\n";
      products.forEach((p, idx) => {
        retryMessage += `${idx + 1}. *${p.name}* (${p.price.toLocaleString()} Gs.)\n`;
      });
      return {
        messages: [new AIMessage(retryMessage)],
        activeAgent: "budget",
      };
    }

    // Producto seleccionado con éxito: evaluar si ya se indicó la cantidad
    const detectedQty = extractQuantity(rawText) || currentContext.detectedQuantity || null;

    if (detectedQty !== null) {
      // 1. Más de 100 unidades -> derivar a handoff con motivo corporativo
      if (detectedQty > 100) {
        const reason = `pedido corporativo de ${detectedQty} unidades de ${selectedProduct.name}`;
        await notifyAdminHandoffAlert({
          userPhoneNumber: state.userPhoneNumber,
          whatsappChatId: state.whatsappChatId,
          pushname: state.pushname,
          reason,
        });
        return {
          messages: [
            new AIMessage(
              `¡Excelente! Para pedidos corporativos o mayoristas de ${detectedQty} unidades de *${selectedProduct.name}*, un asesor de nuestro equipo te va a atender de forma personalizada para ofrecerte la mejor tarifa y coordinar los detalles. Enseguida te escriben por acá. 🧑‍💼✨`
            ),
          ],
          humanHandoffRequired: true,
          humanHandoffReason: reason,
          activeAgent: null,
          quoteContext: { reset: true },
        };
      }

      // 2. Supera stock disponible
      const currentStock = Number(selectedProduct.stock);
      if (selectedProduct.stock !== undefined && selectedProduct.stock !== null && !isNaN(currentStock) && detectedQty > currentStock) {
        if (currentStock > 0) {
          const promptStock =
            `Actualmente contamos con *${currentStock} ${currentStock === 1 ? "unidad disponible" : "unidades disponibles"}* de *${selectedProduct.name}*. ` +
            `¿Te gustaría cotizar esa cantidad, o preferís hablar con un asesor? (Respondé *"sí"* para cotizar ${currentStock}, o *"asesor"* para consultar con nuestro equipo).`;

          return {
            messages: [new AIMessage(promptStock)],
            activeAgent: "budget",
            quoteContext: {
              ...currentContext,
              selectedProductId: selectedProduct.id,
              selectedProductName: selectedProduct.name,
              selectedProductSku: selectedProduct.sku,
              selectedProductImageUrl: selectedProduct.imageUrls?.[0] || "",
              unitPrice: selectedProduct.price,
              step: "quantity_selection",
              pendingStockAdjustment: {
                requestedQty: detectedQty,
                availableStock: currentStock,
              },
              candidateProductIds: null,
              pendingProductConfirmation: null,
              detectedQuantity: null,
            },
          };
        } else {
          const reason = `sin stock para ${selectedProduct.name}`;
          await notifyAdminHandoffAlert({
            userPhoneNumber: state.userPhoneNumber,
            whatsappChatId: state.whatsappChatId,
            pushname: state.pushname,
            reason,
          });
          return {
            messages: [
              new AIMessage(
                `Por el momento el producto *${selectedProduct.name}* se encuentra sin stock disponible. Te comunicamos con un asesor para consultar tiempos de reposición o alternativas similares. 🧑‍💼`
              ),
            ],
            humanHandoffRequired: true,
            humanHandoffReason: reason,
            activeAgent: null,
            quoteContext: { reset: true },
          };
        }
      }

      // 3. Cantidad válida en stock -> avanzar directamente a personalización
      const responseText =
        `¡Excelente elección! Elegiste *${selectedProduct.name}* (Cantidad: ${detectedQty} ${detectedQty === 1 ? "unidad" : "unidades"}). 🎨\n\n` +
        `¿Qué personalización te gustaría que lleve? Podés escribir una frase, nombre o dedicatoria, o enviarnos una foto/logo que quieras estampar o grabar.`;

      return {
        messages: [new AIMessage(responseText)],
        activeAgent: "budget",
        quoteContext: {
          ...currentContext,
          selectedProductId: selectedProduct.id,
          selectedProductName: selectedProduct.name,
          selectedProductSku: selectedProduct.sku,
          selectedProductImageUrl: selectedProduct.imageUrls?.[0] || "",
          unitPrice: selectedProduct.price,
          quantity: detectedQty,
          step: "customization",
          customizationSubStep: null,
          customizationProposed: null,
          candidateProductIds: null,
          pendingProductConfirmation: null,
          detectedQuantity: null,
        },
      };
    }

    // Cantidad no especificada previamente: solicitar al cliente (1 a 100)
    const askQuantityText =
      `¡Excelente elección! Elegiste *${selectedProduct.name}* (Precio base: ${selectedProduct.price.toLocaleString()} Gs.). 🎨\n\n` +
      `¿Cuántas unidades te gustaría cotizar? (Indicá un número del 1 al 100).`;

    return {
      messages: [new AIMessage(askQuantityText)],
      activeAgent: "budget",
      quoteContext: {
        ...currentContext,
        selectedProductId: selectedProduct.id,
        selectedProductName: selectedProduct.name,
        selectedProductSku: selectedProduct.sku,
        selectedProductImageUrl: selectedProduct.imageUrls?.[0] || "",
        unitPrice: selectedProduct.price,
        step: "quantity_selection",
        candidateProductIds: null,
        pendingProductConfirmation: null,
        detectedQuantity: null,
      },
    };
  }

  // -------------------------------------------------------------
  // PASO 1.5: SELECCIÓN DE CANTIDAD (quantity_selection)
  // -------------------------------------------------------------
  if (currentContext.step === "quantity_selection") {
    const selectedProduct = products.find((p) => p.id === currentContext.selectedProductId) || {
      name: currentContext.selectedProductName || "Producto",
      price: currentContext.unitPrice || 0,
    };

    // A. Manejo de respuesta a propuesta de ajuste por stock
    if (currentContext.pendingStockAdjustment) {
      const { availableStock, requestedQty } = currentContext.pendingStockAdjustment;
      if (isAffirmative(normalizedText) || normalizedText === String(availableStock) || normalizedText.includes(String(availableStock))) {
        const responseText =
          `Anotado: *${availableStock} ${availableStock === 1 ? "unidad" : "unidades"}*. 📝✨\n\n` +
          `¿Qué personalización te gustaría que lleve? Podés escribir una frase, nombre o dedicatoria, o enviarnos una foto/logo que quieras estampar o grabar.`;

        return {
          messages: [new AIMessage(responseText)],
          activeAgent: "budget",
          quoteContext: {
            ...currentContext,
            quantity: availableStock,
            step: "customization",
            pendingStockAdjustment: null,
            customizationSubStep: null,
            customizationProposed: null,
          },
        };
      } else if (normalizedText.includes("asesor") || normalizedText.includes("humano")) {
        const reason = `consulta por stock de ${requestedQty} unidades de ${selectedProduct.name} (disponible: ${availableStock})`;
        await notifyAdminHandoffAlert({
          userPhoneNumber: state.userPhoneNumber,
          whatsappChatId: state.whatsappChatId,
          pushname: state.pushname,
          reason,
        });
        return {
          messages: [
            new AIMessage(
              `Te comunicamos con un asesor para ayudarte con las existencias de *${selectedProduct.name}*. Enseguida te escriben. 🧑‍💼`
            ),
          ],
          humanHandoffRequired: true,
          humanHandoffReason: reason,
          activeAgent: null,
          quoteContext: { reset: true },
        };
      }
    }

    // B. Si el cliente pide asesor directamente
    if (normalizedText.includes("asesor") || normalizedText.includes("humano")) {
      const reason = `cliente solicitó asesor al definir cantidad para ${selectedProduct.name}`;
      await notifyAdminHandoffAlert({
        userPhoneNumber: state.userPhoneNumber,
        whatsappChatId: state.whatsappChatId,
        pushname: state.pushname,
        reason,
      });
      return {
        messages: [
          new AIMessage("Te comunico con un asesor de nuestro equipo para ayudarte. 🧑‍💼"),
        ],
        humanHandoffRequired: true,
        humanHandoffReason: reason,
        activeAgent: null,
        quoteContext: { reset: true },
      };
    }

    // C. Parsear cantidad
    const qty = parseQuantity(rawText);
    if (!qty || qty <= 0) {
      return {
        messages: [
          new AIMessage("Por favor indicá una cantidad válida entre 1 y 100 unidades (ejemplo: *1*, *2*, *5*)."),
        ],
        activeAgent: "budget",
      };
    }

    // D. Más de 100 unidades -> derivar a handoff con motivo corporativo
    if (qty > 100) {
      const reason = `pedido corporativo de ${qty} unidades de ${selectedProduct.name}`;
      await notifyAdminHandoffAlert({
        userPhoneNumber: state.userPhoneNumber,
        whatsappChatId: state.whatsappChatId,
        pushname: state.pushname,
        reason,
      });
      return {
        messages: [
          new AIMessage(
            `¡Excelente! Para pedidos corporativos o mayoristas de ${qty} unidades de *${selectedProduct.name}*, un asesor de nuestro equipo te va a atender de forma personalizada para ofrecerte la mejor tarifa y coordinar los detalles. Enseguida te escriben por acá. 🧑‍💼✨`
          ),
        ],
        humanHandoffRequired: true,
        humanHandoffReason: reason,
        activeAgent: null,
        quoteContext: { reset: true },
      };
    }

    // E. Supera stock disponible
    const currentStock = Number(selectedProduct.stock);
    if (selectedProduct.stock !== undefined && selectedProduct.stock !== null && !isNaN(currentStock) && qty > currentStock) {
      if (currentStock > 0) {
        const promptStock =
          `Actualmente contamos con *${currentStock} ${currentStock === 1 ? "unidad disponible" : "unidades disponibles"}* de *${selectedProduct.name}*. ` +
          `¿Te gustaría cotizar esa cantidad, o preferís hablar con un asesor? (Respondé *"sí"* para cotizar ${currentStock}, o *"asesor"* para consultar con nuestro equipo).`;

        return {
          messages: [new AIMessage(promptStock)],
          activeAgent: "budget",
          quoteContext: {
            ...currentContext,
            pendingStockAdjustment: {
              requestedQty: qty,
              availableStock: currentStock,
            },
          },
        };
      } else {
        const reason = `sin stock para ${selectedProduct.name}`;
        await notifyAdminHandoffAlert({
          userPhoneNumber: state.userPhoneNumber,
          whatsappChatId: state.whatsappChatId,
          pushname: state.pushname,
          reason,
        });
        return {
          messages: [
            new AIMessage(
              `Por el momento el producto *${selectedProduct.name}* se encuentra sin stock disponible. Te comunicamos con un asesor para consultar tiempos de reposición o alternativas similares. 🧑‍💼`
            ),
          ],
          humanHandoffRequired: true,
          humanHandoffReason: reason,
          activeAgent: null,
          quoteContext: { reset: true },
        };
      }
    }

    // F. Cantidad válida: avanzar a personalización
    const responseText =
      `Anotado: *${qty} ${qty === 1 ? "unidad" : "unidades"}*. 📝✨\n\n` +
      `¿Qué personalización te gustaría que lleve? Podés escribir una frase, nombre o dedicatoria, o enviarnos una foto/logo que quieras estampar o grabar.`;

    return {
      messages: [new AIMessage(responseText)],
      activeAgent: "budget",
      quoteContext: {
        ...currentContext,
        quantity: qty,
        step: "customization",
        pendingStockAdjustment: null,
        customizationSubStep: null,
        customizationProposed: null,
      },
    };
  }

  // -------------------------------------------------------------
  // PASO 2: PERSONALIZACIÓN (customization)
  // -------------------------------------------------------------
  if (currentContext.step === "customization") {
    const product = products.find((p) => p.id === currentContext.selectedProductId) || {
      packagingPrices: {
        caja: 35000,
        bolsa: 20000,
        envoltorio: 10000,
      },
    };

    // Sub-paso B: El cliente está respondiendo a la confirmación previa del texto a grabar
    if (currentContext.customizationSubStep === "confirm") {
      if (isAffirmative(normalizedText)) {
        // Confirmado por el cliente
        const finalCustomization = currentContext.customizationProposed || "Sin grabado";

        const rawOptions = Object.entries(product.packagingPrices || {});
        const packagingOptions = [...rawOptions];
        if (!packagingOptions.some(([key, price]) => price === 0 || key === "estandar")) {
          packagingOptions.push(["estandar", 0]);
        }

        let packagingMessage =
          `¡Genial! Personalización confirmada: _"${finalCustomization}"_. ✍️✨\n\n` +
          `Ahora, elegí la presentación o empaque para tu regalo:\n\n`;

        packagingOptions.forEach(([key, price], idx) => {
          const label = PACKAGING_LABELS[key.toLowerCase()] || key;
          const priceText = price > 0 ? `+${price.toLocaleString()} Gs.` : "Incluido (0 Gs.)";
          packagingMessage += `${idx + 1}. *${label}* (${priceText})\n`;
        });

        packagingMessage += `\n¿Cuál de estas opciones de empaque preferís? (Respondé con el número o nombre).`;

        return {
          messages: [new AIMessage(packagingMessage)],
          activeAgent: "budget",
          quoteContext: {
            ...currentContext,
            customizationDetails: finalCustomization,
            customizationImageUrl: currentContext.customizationImageUrl || null,
            customizationImagePending: Boolean(currentContext.customizationImagePending),
            customizationProposed: null,
            customizationSubStep: null,
            step: "packaging_selection",
          },
        };
      } else {
        // El cliente corrigió o envió un texto diferente
        let newProposed = "";
        let newImgUrl = currentContext.customizationImageUrl || null;
        let newImgPending = Boolean(currentContext.customizationImagePending);

        if (state.incomingMedia || lastMessage?.hasMedia) {
          if (state.incomingMedia === true || state.incomingMedia?.url) {
            newProposed = "Diseño según imagen adjunta";
            newImgUrl = typeof state.incomingMedia === "object" ? state.incomingMedia.url : "https://res.cloudinary.com/test/sample.jpg";
            newImgPending = false;
          } else {
            newProposed = "Diseño según archivo adjunto en chat";
            newImgPending = true;
            const clientDisplay = state.userPhoneNumber
              ? `+${state.userPhoneNumber}`
              : `${state.pushname || "Cliente"} (${state.whatsappChatId})`;
            await notifyAdminViaWhatsApp(
              `⚠️ *Alerta:* El cliente ${clientDisplay} envió un archivo para personalizar (${state.incomingMedia?.mimetype || "imagen/documento"}) que requiere ser tomado directamente del chat de WhatsApp.`
            );
          }
        } else {
          newProposed = await extractEngravingTextWithLLM(rawText);
        }

        const confirmPrompt =
          newProposed === "Sin grabado"
            ? `Vamos a procesar tu producto *sin grabado*. ¿Es correcto? (Respondé *"Sí"* para continuar o escribí la personalización que desees).`
            : `Vamos a grabar: *${newProposed}*. ¿Es correcto? (Respondé *"Sí"* para continuar o escribí la corrección).`;

        return {
          messages: [new AIMessage(confirmPrompt)],
          activeAgent: "budget",
          quoteContext: {
            ...currentContext,
            customizationProposed: newProposed,
            customizationImageUrl: newImgUrl,
            customizationImagePending: newImgPending,
            customizationSubStep: "confirm",
          },
        };
      }
    }

    // Sub-paso A: Primera recepción de texto o imagen de personalización
    let proposedText = "";
    let customizationImageUrl = null;
    let customizationImagePending = false;

    if (state.incomingMedia || lastMessage?.hasMedia) {
      if (state.incomingMedia === true || state.incomingMedia?.url) {
        proposedText = "Diseño según imagen adjunta";
        customizationImageUrl = typeof state.incomingMedia === "object" ? state.incomingMedia.url : "https://res.cloudinary.com/test/sample.jpg";
        customizationImagePending = false;
      } else {
        proposedText = "Diseño según archivo adjunto en chat";
        customizationImagePending = true;
        const clientDisplay = state.userPhoneNumber
          ? `+${state.userPhoneNumber}`
          : `${state.pushname || "Cliente"} (${state.whatsappChatId})`;
        await notifyAdminViaWhatsApp(
          `⚠️ *Alerta:* El cliente ${clientDisplay} envió un archivo para personalizar (${state.incomingMedia?.mimetype || "imagen/documento"}) que requiere ser tomado directamente del chat de WhatsApp.`
        );
      }
    } else {
      proposedText = await extractEngravingTextWithLLM(rawText);
    }

    const confirmPrompt =
      proposedText === "Sin grabado"
        ? `Vamos a procesar tu producto *sin grabado*. ¿Es correcto? (Respondé *"Sí"* para continuar o escribí la personalización que desees).`
        : `Vamos a grabar: *${proposedText}*. ¿Es correcto? (Respondé *"Sí"* para continuar o escribí la corrección).`;

    return {
      messages: [new AIMessage(confirmPrompt)],
      activeAgent: "budget",
      quoteContext: {
        ...currentContext,
        customizationProposed: proposedText,
        customizationImageUrl,
        customizationImagePending,
        customizationSubStep: "confirm",
      },
    };
  }

  // -------------------------------------------------------------
  // PASO 3: SELECCIÓN DE EMPAQUE (packaging_selection)
  // -------------------------------------------------------------
  if (currentContext.step === "packaging_selection") {
    const product = products.find((p) => p.id === currentContext.selectedProductId) || products[0];
    const rawOptions = Object.entries(product.packagingPrices || {});
    const packagingOptions = [...rawOptions];
    if (!packagingOptions.some(([key, price]) => price === 0 || key === "estandar")) {
      packagingOptions.push(["estandar", 0]);
    }

    let selectedPkg = null;

    // 1. Por índice numérico
    const parsedIdx = parseInt(normalizedText, 10);
    if (!isNaN(parsedIdx) && parsedIdx >= 1 && parsedIdx <= packagingOptions.length) {
      const [key, price] = packagingOptions[parsedIdx - 1];
      const label = PACKAGING_LABELS[key.toLowerCase()] || key;
      selectedPkg = { type: key, name: label, price };
    }

    // 2. Por texto (coincidencia con clave técnica o nombre amigable)
    if (!selectedPkg) {
      const found = packagingOptions.find(([key]) => {
        const label = PACKAGING_LABELS[key.toLowerCase()] || key;
        return (
          normalizedText.includes(normalize(key)) ||
          normalizedText.includes(normalize(label))
        );
      });
      if (found) {
        const [key, price] = found;
        const label = PACKAGING_LABELS[key.toLowerCase()] || key;
        selectedPkg = { type: key, name: label, price };
      }
    }

    // Manejo de respuesta inesperada: repreguntar opciones de empaque válidas
    if (!selectedPkg) {
      let retryMessage = "Por favor elegí una de las opciones de empaque válidas para este producto:\n\n";
      packagingOptions.forEach(([key, price], idx) => {
        const label = PACKAGING_LABELS[key.toLowerCase()] || key;
        const priceText = price > 0 ? `+${price.toLocaleString()} Gs.` : "Incluido";
        retryMessage += `${idx + 1}. *${label}* (${priceText})\n`;
      });
      return {
        messages: [new AIMessage(retryMessage)],
        activeAgent: "budget",
      };
    }

    // Si el usuario especificó una cantidad diferente en este turno
    const qtyInMsg = extractQuantity(rawText);
    const finalQuantity = qtyInMsg || currentContext.quantity || 1;

    // CÁLCULO DE TOTALES
    const { subtotal, shippingCost, total } = calculateQuoteTotals(
      currentContext.unitPrice || product.price,
      selectedPkg.price,
      finalQuantity
    );

    const quoteSummary =
      `📋 *Resumen de tu Cotización HoDie:*\n\n` +
      `• *Producto:* ${currentContext.selectedProductName} (${(currentContext.unitPrice || product.price).toLocaleString()} Gs. c/u)\n` +
      `• *Cantidad:* ${finalQuantity} unidad(es)\n` +
      `• *Personalización:* ${currentContext.customizationDetails || "Sin grabado"}\n` +
      `• *Empaque:* ${selectedPkg.name} (${selectedPkg.price > 0 ? `+${selectedPkg.price.toLocaleString()} Gs.` : "Incluido"})\n` +
      `• *Subtotal:* ${subtotal.toLocaleString()} Gs.\n` +
      `• *Envío:* Se define según tu ciudad 🚚\n\n` +
      `💰 *TOTAL A PAGAR:* *${total.toLocaleString()} Gs.*\n\n` +
      `Para coordinar la entrega de tu pedido, necesitamos algunos datos de envío.\n` +
      `¿Cuál es el *nombre y apellido* de la persona que recibirá el paquete? 👤`;

    return {
      messages: [new AIMessage(quoteSummary)],
      activeAgent: "budget",
      quoteContext: {
        selectedPackaging: selectedPkg,
        quantity: finalQuantity,
        subtotal,
        shippingCost,
        total,
        step: "shipping_info",
        shippingStep: "name",
        shippingAddress: {
          recipientName: "",
          city: "",
          department: "",
          street: "",
        },
      },
    };
  }

  // -------------------------------------------------------------
  // PASO 4: DATOS DE ENVÍO SECUENCIALES (shipping_info)
  // Preguntas separadas y explícitas para evitar desajustes o ambigüedades:
  // sub-paso "name" -> sub-paso "city" -> sub-paso "street" -> "confirmation"
  // -------------------------------------------------------------
  if (currentContext.step === "shipping_info") {
    const subStep = currentContext.shippingStep || "name";

    // 4.1 Nombre completo
    if (subStep === "name") {
      if (rawText.length < 2) {
        return {
          messages: [
            new AIMessage(
              "Por favor indicá el nombre y apellido completo de quien recibirá el pedido. 😊"
            ),
          ],
          activeAgent: "budget",
        };
      }

      const recipientName = rawText;
      return {
        messages: [
          new AIMessage(
            `¡Muchas gracias, *${recipientName}*! 👍\n\nAhora, ¿en qué *ciudad y departamento* se realizará la entrega? (Por ejemplo: _Minga Guazú, Alto Paraná_ o _Asunción, Central_) 🏙️`
          ),
        ],
        activeAgent: "budget",
        quoteContext: {
          shippingStep: "city",
          shippingAddress: {
            ...(currentContext.shippingAddress || {}),
            recipientName,
          },
        },
      };
    }

    // 4.2 Ciudad y departamento
    if (subStep === "city") {
      if (rawText.length < 3) {
        return {
          messages: [
            new AIMessage(
              "Por favor indicá la ciudad y el departamento de entrega para coordinar el delivery correctamente. 🏙️"
            ),
          ],
          activeAgent: "budget",
        };
      }

      const parts = rawText.split(/[,/-]/).map((s) => s.trim()).filter(Boolean);
      const city = parts[0] || rawText;
      const department = parts[1] || "";

      return {
        messages: [
          new AIMessage(
            `Excelente. Por último, ¿cuál es la *dirección exacta* de entrega (calle, número de casa o referencia para el repartidor)? 📍`
          ),
        ],
        activeAgent: "budget",
        quoteContext: {
          shippingStep: "street",
          shippingAddress: {
            ...(currentContext.shippingAddress || {}),
            city,
            department,
          },
        },
      };
    }

    // 4.3 Dirección exacta / calle y referencias
    if (subStep === "street") {
      if (rawText.length < 3) {
        return {
          messages: [
            new AIMessage(
              "Por favor indicanos la calle o referencias de tu casa o lugar de entrega. 📍"
            ),
          ],
          activeAgent: "budget",
        };
      }

      const street = rawText;
      const updatedShippingAddress = {
        recipientName:
          currentContext.shippingAddress?.recipientName ||
          state.user?.displayName ||
          "Cliente",
        city: currentContext.shippingAddress?.city || "Minga Guazú",
        department: currentContext.shippingAddress?.department || "",
        street,
        instructions: street,
      };

      // Si no tenemos un userPhoneNumber válido (ej. cliente desde @lid),
      // solicitamos el teléfono paraguayo antes de pasar a la confirmación
      if (!state.userPhoneNumber) {
        return {
          messages: [
            new AIMessage(
              "Excelente. Para coordinar la entrega y mantenerte informado sobre tu paquete, ¿cuál es tu *número de teléfono paraguayo*? (Por ejemplo: _0981 123456_ o _595981123456_) 📱"
            ),
          ],
          activeAgent: "budget",
          quoteContext: {
            shippingAddress: updatedShippingAddress,
            shippingStep: "phone",
          },
        };
      }

      const confirmPrompt = buildConfirmationPrompt(
        updatedShippingAddress,
        state.userPhoneNumber,
        currentContext
      );

      return {
        messages: [new AIMessage(confirmPrompt)],
        activeAgent: "budget",
        quoteContext: {
          shippingAddress: updatedShippingAddress,
          shippingStep: null,
          step: "confirmation",
        },
      };
    }

    // 4.4 Número de teléfono de contacto (cuando el cliente escribió desde @lid sin número resuelto)
    if (subStep === "phone") {
      const normalizedPhone = normalizeParaguayanPhone(rawText);
      if (!normalizedPhone) {
        const attempts = (currentContext.invalidPhoneAttempts || 0) + 1;
        if (attempts >= 3) {
          const reason = "Dificultad al registrar número de teléfono (3 intentos fallidos)";
          console.log(`⚠️ Cliente superó límite de 3 intentos fallidos ingresando teléfono. Derivando a HumanHandoff.`);
          await notifyAdminHandoffAlert({
            userPhoneNumber: state.userPhoneNumber,
            whatsappChatId: state.whatsappChatId,
            pushname: state.pushname,
            reason,
          });

          const handoffMsg =
            "Veo que tenemos dificultades para registrar tu número de teléfono. 👤\n\n" +
            "Te transfiero con un asesor humano de nuestro equipo para asistirte con la orden y coordinar los datos personalmente. ¡En breve te escriben por este chat! ✨";
          return {
            messages: [new AIMessage(handoffMsg)],
            humanHandoffRequired: true,
            humanHandoffReason: reason,
            intent: "human_handoff",
            activeAgent: null,
            quoteContext: {
              ...currentContext,
              invalidPhoneAttempts: attempts,
            },
          };
        }

        return {
          messages: [
            new AIMessage(
              "El número ingresado no parece ser un número de teléfono válido de Paraguay. Por favor ingresá un número paraguayo de contacto (ej. _0981 123456_ o _595981123456_): 📱"
            ),
          ],
          activeAgent: "budget",
          quoteContext: {
            ...currentContext,
            invalidPhoneAttempts: attempts,
          },
        };
      }

      const finalShippingAddress = {
        recipientName:
          currentContext.shippingAddress?.recipientName ||
          state.user?.displayName ||
          "Cliente",
        city: currentContext.shippingAddress?.city || "Minga Guazú",
        department: currentContext.shippingAddress?.department || "",
        street: currentContext.shippingAddress?.street || "",
        instructions: currentContext.shippingAddress?.street || "",
      };

      const confirmPrompt = buildConfirmationPrompt(
        finalShippingAddress,
        normalizedPhone,
        currentContext
      );

      return {
        messages: [new AIMessage(confirmPrompt)],
        activeAgent: "budget",
        userPhoneNumber: normalizedPhone,
        quoteContext: {
          shippingAddress: finalShippingAddress,
          shippingStep: null,
          step: "confirmation",
          invalidPhoneAttempts: 0,
        },
      };
    }
  }

  // -------------------------------------------------------------
  // PASO 5: CONFIRMACIÓN Y EMISIÓN DE ORDEN (confirmation)
  // -------------------------------------------------------------
  if (currentContext.step === "confirmation") {
    const isAffirmative =
      normalizedText.includes("si") ||
      normalizedText.includes("confirmo") ||
      normalizedText.includes("dale") ||
      normalizedText.includes("ok") ||
      normalizedText.includes("correcto");

    if (isAffirmative) {
      console.log(`🛍️ Cliente ${state.userPhoneNumber} confirmó el pedido. Invocando generateUniqueOrderNumber y order.service.js...`);

      const orderNumber = await generateUniqueOrderNumber();
      const orderId = `ord-${Date.now()}-${orderNumber}`;

      const orderPayload = {
        id: orderId,
        orderNumber,
        userId: state.user?.uid || `usr-${state.userPhoneNumber}`,
        userDisplayName: currentContext.shippingAddress?.recipientName || state.user?.displayName || "Cliente",
        userPhoneNumber: state.userPhoneNumber,
        whatsappChatId: state.whatsappChatId || "",
        items: [
          {
            productId: currentContext.selectedProductId || "prod-custom",
            productName: currentContext.selectedProductName || "Regalo Personalizado",
            productSku: currentContext.selectedProductSku || "HOD-CUSTOM",
            quantity: currentContext.quantity || 1,
            price: currentContext.unitPrice || 0,
            imageUrl: "",
            customization: currentContext.customizationDetails || "",
            customizationImageUrl: currentContext.customizationImageUrl || "",
            customizationImagePending: Boolean(currentContext.customizationImagePending),
            selectedPackaging: currentContext.selectedPackaging
              ? {
                  name: currentContext.selectedPackaging.name,
                  price: currentContext.selectedPackaging.price,
                  imageUrl: "",
                }
              : undefined,
          },
        ],
        shippingAddress: {
          city: currentContext.shippingAddress?.city || "Minga Guazú",
          department: currentContext.shippingAddress?.department || "",
          street: currentContext.shippingAddress?.street || "Dirección a coordinar",
          instructions: currentContext.shippingAddress?.instructions || "",
        },
        status: "pending",
        subtotal: currentContext.subtotal || 0,
        shippingCost: 0,
        shippingMethod: determineShippingMethod(currentContext.shippingAddress?.city),
        total: currentContext.total || 0,
      };

      try {
        // Reutilización directa del servicio de órdenes existente
        const orderResult = await processAndSendOrder(orderPayload);

        const shippingLabel =
          orderResult.shippingMethod === "local_gratis"
            ? "Envío local gratuito (Minga Guazú)"
            : "Envío por transportadora (flete con pago contra entrega)";

        if (orderResult.pdfDelivered) {
          // Envía el mensaje con los datos bancarios para la transferencia (status pending)
          await sendOrderStatus(
            state.whatsappChatId || state.userPhoneNumber,
            "pending",
            orderResult.total || orderPayload.total,
            orderResult.shippingMethod
          );

          const successMessage =
            `🎉 *¡Tu pedido #${orderNumber} ha sido generado con éxito!*\n\n` +
            `📦 *Modalidad de entrega:* ${shippingLabel}\n` +
            `💰 *Total a transferir:* *${(orderResult.total || orderPayload.total).toLocaleString()} Gs.*\n\n` +
            `Te acabamos de enviar el comprobante oficial en PDF con todos los detalles y los datos de la cuenta bancaria para realizar la transferencia.\n\n` +
            `Cuando hagas la transferencia, simplemente envianos una foto del comprobante por este chat para que nuestro equipo lo verifique e inicie la producción. ¡Muchas gracias! 🎁✨`;

          return {
            messages: [new AIMessage(successMessage)],
            activeAgent: null,
            quoteContext: { reset: true },
          };
        } else {
          // El PDF no pudo ser entregado de inmediato, pero la orden existe y processAndSendOrder ya envió datos bancarios
          const pendingPdfMessage =
            `🎉 *¡Tu pedido #${orderNumber} está confirmado!*\n\n` +
            `📦 *Modalidad de entrega:* ${shippingLabel}\n` +
            `💰 *Total a transferir:* *${(orderResult.total || orderPayload.total).toLocaleString()} Gs.*\n\n` +
            `Tu comprobante en PDF está siendo preparado y te lo haremos llegar a la brevedad. ` +
            `Con los datos que te enviamos arriba ya podés realizar la transferencia y remitirnos el comprobante por acá. ¡Muchas gracias! 🎁✨`;

          return {
            messages: [new AIMessage(pendingPdfMessage)],
            activeAgent: null,
            quoteContext: { reset: true },
          };
        }
      } catch (orderErr) {
        console.error("❌ Error emitiendo pedido en BudgetAgent:", orderErr);
        const reason = `Fallo al emitir pedido: ${orderErr.message}`;
        await notifyAdminHandoffAlert({
          userPhoneNumber: state.userPhoneNumber,
          whatsappChatId: state.whatsappChatId,
          pushname: state.pushname,
          reason,
        });
        const errorMessage =
          "Hubo un inconveniente al generar tu orden. Un asesor de nuestro equipo se comunicará contigo enseguida para finalizar tu pedido.";
        return {
          messages: [new AIMessage(errorMessage)],
          humanHandoffRequired: true,
          humanHandoffReason: reason,
          activeAgent: null,
        };
      }
    }

    // Si no es confirmación afirmativa ni cancelación, repreguntar
    const reconfirmMessage =
      `Para emitir tu pedido necesitamos tu confirmación final.\n\n` +
      `¿Deseas confirmar la compra por *${(currentContext.total || 0).toLocaleString()} Gs.*? Respondé *"Sí, confirmo"* para emitir el comprobante, o *"Cancelar"* para anular.`;

    return {
      messages: [new AIMessage(reconfirmMessage)],
      activeAgent: "budget",
    };
  }

  // Fallback de seguridad
  return {
    messages: [new AIMessage("¿En qué más te puedo ayudar con tu pedido?")],
    activeAgent: null,
  };
};
