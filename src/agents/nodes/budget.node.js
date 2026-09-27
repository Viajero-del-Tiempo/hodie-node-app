import { AIMessage } from "@langchain/core/messages";
import { db } from "../../config/firebase.js";
import {
  processAndSendOrder,
  generateUniqueOrderNumber,
  calculateQuoteTotals,
  determineShippingMethod,
} from "../../services/order.service.js";
import { sendOrderStatus } from "../../services/whatsapp.service.js";
import { notifyAdminHandoffAlert } from "./handoff.node.js";

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
    /\b(?:quiero|necesito|serian|serían|pedir)\s+(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num <= 500) return num;
    }
  }

  return null;
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
export const budgetAgentNode = async (state) => {
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
    let selectedProduct = null;

    // 1. Coincidencia por índice numérico (1, 2, 3...)
    const parsedIdx = parseInt(normalizedText, 10);
    if (!isNaN(parsedIdx) && parsedIdx >= 1 && parsedIdx <= products.length) {
      selectedProduct = products[parsedIdx - 1];
    }

    // 2. Coincidencia por nombre o SKU
    if (!selectedProduct) {
      selectedProduct = products.find((p) => {
        const normName = normalize(p.name);
        const normSku = normalize(p.sku);
        return normalizedText.includes(normName) || normalizedText.includes(normSku) ||
          normName.split(" ").some((word) => word.length > 4 && normalizedText.includes(word));
      });
    }

    // Manejo de respuesta inesperada: repreguntar amablemente
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

    // Si el usuario incluyó una cantidad en el mensaje (ej: "2 unidades", "x3")
    const detectedQty = extractQuantity(rawText) || 1;

    const responseText =
      `¡Excelente elección! Elegiste *${selectedProduct.name}* (Precio base: ${selectedProduct.price.toLocaleString()} Gs.). 🎨\n\n` +
      `¿Qué personalización te gustaría que lleve? Podés escribir una frase, nombre o dedicatoria, o enviarnos una foto/logo que quieras estampar o grabar.`;

    return {
      messages: [new AIMessage(responseText)],
      activeAgent: "budget",
      quoteContext: {
        selectedProductId: selectedProduct.id,
        selectedProductName: selectedProduct.name,
        selectedProductSku: selectedProduct.sku,
        selectedProductImageUrl: selectedProduct.imageUrls?.[0] || "",
        unitPrice: selectedProduct.price,
        quantity: detectedQty,
        step: "customization",
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

    // Guardar detalles del texto y foto si fue recibida
    const customizationText = rawText || "Diseño según imagen adjunta";
    const rawOptions = Object.entries(product.packagingPrices || {});
    const packagingOptions = [...rawOptions];
    if (!packagingOptions.some(([key, price]) => price === 0 || key === "estandar")) {
      packagingOptions.push(["estandar", 0]);
    }

    let packagingMessage =
      `¡Genial! Personalización registrada: _"${customizationText}"_. ✍️✨\n\n` +
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
        customizationDetails: customizationText,
        step: "packaging_selection",
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
      `• *Personalización:* ${currentContext.customizationDetails || "A convenir"}\n` +
      `• *Empaque:* ${selectedPkg.name} (${selectedPkg.price > 0 ? `+${selectedPkg.price.toLocaleString()} Gs.` : "Incluido"})\n` +
      `• *Subtotal:* ${subtotal.toLocaleString()} Gs.\n` +
      `• *Envío:* Pago contra entrega al recibir 🚚\n\n` +
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
        department: currentContext.shippingAddress?.department || "Alto Paraná",
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
        department: currentContext.shippingAddress?.department || "Alto Paraná",
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
          department: currentContext.shippingAddress?.department || "Alto Paraná",
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

        // Envía el mensaje con los datos bancarios para la transferencia (status pending)
        await sendOrderStatus(
          state.whatsappChatId || state.userPhoneNumber,
          "pending",
          orderResult.total || orderPayload.total
        );

        const shippingLabel =
          orderResult.shippingMethod === "local_gratis"
            ? "Envío local gratuito (Minga Guazú)"
            : "Envío por transportadora (flete con pago contra entrega)";

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
