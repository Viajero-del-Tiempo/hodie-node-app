if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1 (ej: npm run test:unit).");
  process.exit(1);
}

import "dotenv/config";
import app from "../src/app.js";
import { db } from "../src/config/firebase.js";
import { Timestamp } from "firebase-admin/firestore";
import { JWT_SECRET } from "../src/config/jwt.js";
import { whatsappClient, MessageMedia } from "../src/config/whatsapp.js";
import { budgetAgentNode, extractEngravingTextWithLLM, stemSpanish } from "../src/agents/nodes/budget.node.js";
import { sendOrderStatus } from "../src/services/whatsapp.service.js";
import jwt from "jsonwebtoken";
import { HumanMessage } from "@langchain/core/messages";

async function runOrderPdfDecouplingTests() {
  console.log("==================================================================");
  console.log("🧪 BATERÍA DE PRUEBAS: DESACOPLAMIENTO PEDIDO/PDF, PERSONALIZACIÓN Y FILTROS");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  const assert = (condition, title, details = "") => {
    if (condition) {
      console.log(`✅ [PASS] ${title}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${title} - ${details}`);
      failed++;
    }
  };

  const timestamp = Date.now();
  const createdOrderIds = [];
  const createdProductIds = [];
  const createdUserIds = [];

  // Variables para registrar mensajes simulados enviados por WhatsApp
  const sentWhatsappMessages = [];

  // Guardar implementación original de sendMessage
  const originalSendMessage = whatsappClient.sendMessage;

  // Iniciar servidor Express en puerto efímero
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  console.log(`🌐 Servidor de pruebas iniciado en ${baseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // SETUP: Crear producto y usuario de prueba
    // -------------------------------------------------------------
    const testProductId = `test-prod-pdf-${timestamp}`;
    createdProductIds.push(testProductId);
    await db.collection("products").doc(testProductId).set({
      name: "Vaso Térmico Acero Inoxidable",
      price: 85000,
      stock: 20,
      sku: `SKU-VASO-${timestamp}`,
      active: true,
      packagingPrices: {
        caja: 35000,
        bolsa: 20000,
      },
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    const testUserPhone = `595981${Math.floor(100000 + Math.random() * 900000)}`;
    const testUserId = `test-usr-${timestamp}`;
    createdUserIds.push(testUserId);
    await db.collection("users").doc(testUserId).set({
      uid: testUserId,
      phoneNumber: testUserPhone,
      displayName: "Analia Benitez",
      role: "customer",
      active: true,
      whatsapp_verified: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    const authToken = jwt.sign({ phone: testUserPhone }, JWT_SECRET, { expiresIn: "1h" });

    const testAdminPhone = `595982${Math.floor(100000 + Math.random() * 900000)}`;
    const testAdminId = `test-adm-${timestamp}`;
    createdUserIds.push(testAdminId);
    await db.collection("users").doc(testAdminId).set({
      uid: testAdminId,
      phoneNumber: testAdminPhone,
      displayName: "Admin Pruebas",
      role: "admin",
      active: true,
      whatsapp_verified: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    const adminAuthToken = jwt.sign({ phone: testAdminPhone }, JWT_SECRET, { expiresIn: "1h" });

    // Mock de WhatsApp: simular fallo específico de memoize al enviar MessageMedia (PDF)
    let simulatePdfFailure = true;

    whatsappClient.sendMessage = async (to, content, options) => {
      sentWhatsappMessages.push({ to, content, options });

      // Si el contenido es un MessageMedia (PDF) y está activo el flag de fallo
      if (simulatePdfFailure && (content instanceof MessageMedia || content?.mimetype === "application/pdf")) {
        throw new Error("Data passed to getter must include an id property (it's how we memoize) but got undefined");
      }

      return { id: { _serialized: `mock-msg-${Date.now()}` } };
    };

    // -------------------------------------------------------------
    // PRUEBA 1: Checkout Web con simulación de fallo en envío de PDF
    // -------------------------------------------------------------
    console.log("--- PRUEBA 1: Checkout Web con fallo en sendOrderPDF ---");
    {
      simulatePdfFailure = true;

      const webRes = await fetch(`${baseUrl}/orders/order/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          items: [
            {
              productId: testProductId,
              quantity: 1,
              customization: "analia",
            },
          ],
          shippingAddress: {
            street: "Avda. Monday 555",
            city: "Presidente Franco",
            department: "",
          },
        }),
      });

      const webData = await webRes.json();
      if (webData?.orderId) {
        createdOrderIds.push(webData.orderId);
      }

      assert(webRes.status === 200, "Checkout web responde HTTP 200 a pesar del fallo en PDF");
      assert(webData.status === "success", "Respuesta del checkout tiene status 'success'");
      assert(webData.pdfDelivered === false, "Respuesta del checkout indica pdfDelivered = false");
      assert(Boolean(webData.orderNumber), "Respuesta incluye orderNumber generado");

      if (webData.orderId) {
        const orderDoc = await db.collection("orders").doc(webData.orderId).get();
        assert(orderDoc.exists, "El pedido existe persistido en Firestore");
        const odata = orderDoc.data();
        assert(odata.pdfDelivered === false, "En Firestore pdfDelivered es false");
        assert(odata.shippingAddress?.department === "", "En Firestore el departamento no tiene fallback de 'Alto Paraná'");
        assert(odata.shippingMethod === "transportadora_contra_entrega", "Método de envío asignado correctamente para Presidente Franco");
      }

      // Verificar que se haya enviado mensaje de contingencia al cliente y alerta al admin
      const fallbackSent = sentWhatsappMessages.some((m) =>
        typeof m.content === "string" && m.content.includes("Tu comprobante oficial en PDF está siendo procesado")
      );
      assert(fallbackSent, "Se despachó el mensaje de texto de contingencia al cliente");

      const adminAlertSent = sentWhatsappMessages.some((m) =>
        typeof m.content === "string" && m.content.includes("falta enviar el PDF")
      );
      assert(adminAlertSent, "Se despachó la alerta al administrador informando el PDF pendiente");
    }

    // -------------------------------------------------------------
    // PRUEBA 2: BudgetAgent con confirmación y simulación de fallo en PDF
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 2: BudgetAgent con fallo en sendOrderPDF ---");
    {
      simulatePdfFailure = true;

      const stateConfirmation = {
        messages: [new HumanMessage("Sí, confirmo")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        pushname: "Analia",
        activeAgent: "budget",
        quoteContext: {
          step: "confirmation",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico Acero Inoxidable",
          selectedProductSku: `SKU-VASO-${timestamp}`,
          unitPrice: 85000,
          quantity: 1,
          subtotal: 85000,
          total: 85000,
          shippingAddress: {
            recipientName: "Analia Benitez",
            city: "Minga Guazú",
            department: "",
            street: "Km 16 lado Acaray",
          },
        },
      };

      const result = await budgetAgentNode(stateConfirmation);

      assert(result.humanHandoffRequired !== true, "BudgetAgent NUNCA deriva a handoff si el pedido se creó");
      assert(result.activeAgent === null, "activeAgent se desactiva tras cerrar la venta");
      assert(result.quoteContext?.reset === true, "quoteContext solicita reset");

      const responseText = result.messages?.[0]?.content || "";
      assert(responseText.includes("¡Tu pedido #"), "Mensaje de respuesta incluye el número de pedido generado");
      assert(
        responseText.includes("está confirmado") || responseText.includes("ha sido generado con éxito"),
        "Mensaje informa éxito y confirmación del pedido"
      );
      assert(
        responseText.includes("PDF"),
        "Mensaje menciona que el PDF está siendo preparado"
      );

      // Extraer número de pedido del mensaje y buscar en Firestore
      const match = responseText.match(/#(\w+)/);
      if (match) {
        const orderNum = match[1];
        const ordersQuery = await db.collection("orders").where("orderNumber", "==", orderNum).get();
        assert(!ordersQuery.empty, `Pedido #${orderNum} encontrado en Firestore`);
        if (!ordersQuery.empty) {
          const doc = ordersQuery.docs[0];
          createdOrderIds.push(doc.id);
          assert(doc.data().pdfDelivered === false, "Pedido generado por BudgetAgent tiene pdfDelivered: false");
          assert(doc.data().shippingAddress?.department === "", "Departamento guardado como string vacío (sin default)");
        }
      }
    }

    // -------------------------------------------------------------
    // PRUEBA 3: Extracción de Personalización con LLM y Bypass de Imagen
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 3: Personalización LLM y Bypass de Imagen ---");
    {
      // 3.a Caso: "analia" (mantener minúsculas sin alterar)
      const resAnalia = await extractEngravingTextWithLLM("analia");
      assert(resAnalia === "analia", `Extracción de 'analia' preserva minúsculas: '${resAnalia}'`);

      // 3.b Caso: "Quiero que diga «Feliz cumple Ma»" -> "Feliz cumple Ma"
      const resQuotes = await extractEngravingTextWithLLM("Quiero que diga «Feliz cumple Ma»");
      assert(resQuotes === "Feliz cumple Ma", `Extracción con comillas latinas: '${resQuotes}'`);

      // 3.c Caso: "sin personalización" -> "Sin grabado"
      const resNone = await extractEngravingTextWithLLM("sin personalización");
      assert(resNone === "Sin grabado", `Extracción de 'sin personalización': '${resNone}'`);

      // 3.d Bypass de imagen en BudgetAgent: Si hay incomingMedia, NO llamar LLM
      const stateWithImage = {
        messages: [new HumanMessage("Quiero este diseño")],
        incomingMedia: true,
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "customization",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico",
          unitPrice: 85000,
          quantity: 1,
        },
      };

      const resultImage = await budgetAgentNode(stateWithImage);
      assert(
        resultImage.quoteContext?.customizationProposed === "Diseño según imagen adjunta",
        "Imagen adjunta asigna automáticamente 'Diseño según imagen adjunta'"
      );
      assert(
        resultImage.quoteContext?.customizationSubStep === "confirm",
        "Pasa a sub-paso de confirmación explícita"
      );

      // 3.e Confirmación afirmativa del cliente ("Sí")
      const stateConfirmAffirmative = {
        messages: [new HumanMessage("Sí, correcto")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "customization",
          customizationSubStep: "confirm",
          customizationProposed: "analia",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico",
          unitPrice: 85000,
          quantity: 1,
        },
      };

      const resultAffirmative = await budgetAgentNode(stateConfirmAffirmative);
      assert(
        resultAffirmative.quoteContext?.step === "packaging_selection",
        "Al confirmar con 'Sí', avanza a selección de empaque"
      );
      assert(
        resultAffirmative.quoteContext?.customizationDetails === "analia",
        "Detalle de personalización guardado como 'analia'"
      );

      // 3.f Corrección del cliente: ("No, que diga María")
      const stateCorrection = {
        messages: [new HumanMessage("No, mejor que diga María")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "customization",
          customizationSubStep: "confirm",
          customizationProposed: "analia",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico",
          unitPrice: 85000,
          quantity: 1,
        },
      };

      const resultCorrection = await budgetAgentNode(stateCorrection);
      assert(
        resultCorrection.quoteContext?.step === "customization",
        "Permanece en paso de personalización tras corregir"
      );
      assert(
        resultCorrection.quoteContext?.customizationSubStep === "confirm",
        "Vuelve a solicitar confirmación de la corrección"
      );
      assert(
        resultCorrection.quoteContext?.customizationProposed === "María",
        `Nueva propuesta extraída correctamente: '${resultCorrection.quoteContext?.customizationProposed}'`
      );
    }

    // -------------------------------------------------------------
    // PRUEBA 4: Lematizador y Búsqueda por Palabras Clave (Tildes y Plurales)
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 4: Búsqueda por Palabras Clave y Lematizador ---");
    {
      // 4.a Lematizador stemSpanish
      const stem1 = stemSpanish("vasos");
      const stem2 = stemSpanish("vaso");
      assert(stem1 === stem2, `Lematizador unifica 'vasos' y 'vaso': '${stem1}'`);

      const stem3 = stemSpanish("térmicos");
      const stem4 = stemSpanish("termico");
      assert(stem3 === stem4, `Lematizador unifica 'térmicos' y 'termico': '${stem3}'`);

      // 4.b Búsqueda en budgetAgentNode con coincidencia única: "vasos térmicos"
      const stateProductSearch = {
        messages: [new HumanMessage("Quiero cotizar vasos térmicos")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "product_selection",
        },
      };

      const resultSearch = await budgetAgentNode(stateProductSearch);
      const searchContent = resultSearch.messages?.[0]?.content || "";

      assert(
        searchContent.includes("¿Te referís al") || resultSearch.quoteContext?.selectedProductId === testProductId,
        "Reconoce 'vasos térmicos' y asocia el producto 'Vaso Térmico Acero Inoxidable'"
      );
    }

    // -------------------------------------------------------------
    // PRUEBA 5: Persistencia de Personalización Web y Bot + Endpoint PATCH Admin
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 5: Personalización Web/Bot y Edición Admin ---");
    {
      // 5.a Web checkout con personalización explícita
      const resWebCust = await fetch(`${baseUrl}/orders/order/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          items: [
            {
              productId: testProductId,
              quantity: 1,
              customization: "Para el mejor papá del mundo",
            },
          ],
          shippingAddress: {
            street: "Avda. Monday 555",
            city: "Presidente Franco",
            department: "",
          },
        }),
      });

      const dataWebCust = await resWebCust.json();
      if (dataWebCust?.orderId) createdOrderIds.push(dataWebCust.orderId);

      assert(resWebCust.status === 200, "Pedido web con personalización responde HTTP 200");
      assert(dataWebCust.customizationPending === false, "Respuesta web indica customizationPending = false");

      if (dataWebCust?.orderId) {
        const doc = await db.collection("orders").doc(dataWebCust.orderId).get();
        const odata = doc.data();
        assert(odata.customizationPending === false, "Firestore: orden tiene customizationPending = false");
        assert(odata.items?.[0]?.customization === "Para el mejor papá del mundo", "Firestore: ítem contiene texto de personalización");
        assert(odata.items?.[0]?.customizationPending === false, "Firestore: ítem tiene customizationPending = false");
      }

      // 5.b Web checkout SIN personalización
      const resWebEmpty = await fetch(`${baseUrl}/orders/order/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          items: [
            {
              productId: testProductId,
              quantity: 1,
              customization: "",
            },
          ],
          shippingAddress: {
            street: "Avda. Monday 555",
            city: "Presidente Franco",
            department: "",
          },
        }),
      });

      const dataWebEmpty = await resWebEmpty.json();
      if (dataWebEmpty?.orderId) createdOrderIds.push(dataWebEmpty.orderId);

      assert(resWebEmpty.status === 200, "Pedido web sin personalización responde HTTP 200");
      assert(dataWebEmpty.customizationPending === true, "Respuesta web indica customizationPending = true");

      if (dataWebEmpty?.orderId) {
        const doc = await db.collection("orders").doc(dataWebEmpty.orderId).get();
        const odata = doc.data();
        assert(odata.customizationPending === true, "Firestore: orden sin personalización tiene customizationPending = true");
        assert(odata.items?.[0]?.customizationPending === true, "Firestore: ítem tiene customizationPending = true");

        // 5.c Actualización vía PATCH /admin/orders/:id/customization
        const patchRes = await fetch(`${baseUrl}/admin/orders/${dataWebEmpty.orderId}/customization`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminAuthToken}`,
          },
          body: JSON.stringify({
            itemIndex: 0,
            customization: "Texto cargado por el Administrador",
          }),
        });

        const patchData = await patchRes.json();
        assert(patchRes.status === 200, "PATCH /admin/orders/:id/customization responde HTTP 200");
        assert(patchData.success === true, "PATCH response indica success: true");

        const updatedDoc = await db.collection("orders").doc(dataWebEmpty.orderId).get();
        const udata = updatedDoc.data();
        assert(udata.customizationPending === false, "Tras PATCH admin, customizationPending de la orden se limpia a false");
        assert(udata.items?.[0]?.customization === "Texto cargado por el Administrador", "Tras PATCH admin, texto de personalización guardado");
        assert(udata.items?.[0]?.customizationPending === false, "Tras PATCH admin, customizationPending del ítem se limpia a false");
      }
    }

    // -------------------------------------------------------------
    // PRUEBA 6: Lógica de Subida de Imagen Cloudinary (Paso de Personalización vs Otros Pasos)
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 6: Restricción de Subida de Imagen a Cloudinary ---");
    {
      // 6.a Estado en paso "customization": Debe procesar la imagen y registrar la URL
      const stateInCustomization = {
        messages: [new HumanMessage("Te adjunto este logo")],
        incomingMedia: {
          url: "https://res.cloudinary.com/test-cloud/image/upload/v1/hodie-tienda/customizations/logo.png",
          mimetype: "image/png",
        },
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "customization",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico",
          unitPrice: 85000,
          quantity: 1,
        },
      };

      const resCustMedia = await budgetAgentNode(stateInCustomization);
      assert(
        resCustMedia.quoteContext?.customizationProposed === "Diseño según imagen adjunta",
        "En paso customization con media con url, propone 'Diseño según imagen adjunta'"
      );
      assert(
        resCustMedia.quoteContext?.customizationImageUrl === "https://res.cloudinary.com/test-cloud/image/upload/v1/hodie-tienda/customizations/logo.png",
        "Preserva customizationImageUrl devuelta por Cloudinary"
      );
      assert(
        resCustMedia.quoteContext?.customizationImagePending === false,
        "customizationImagePending es false cuando la subida fue exitosa"
      );

      // 6.b Estado en paso "customization" pero con archivo pesado o no admitido (uploadFailed = true)
      const stateFailedUpload = {
        messages: [new HumanMessage("Te adjunto un pdf con el diseño")],
        incomingMedia: {
          uploadFailed: true,
          mimetype: "application/pdf",
          reason: "unsupported_format",
        },
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "customization",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico",
          unitPrice: 85000,
          quantity: 1,
        },
      };

      const resFailedMedia = await budgetAgentNode(stateFailedUpload);
      assert(
        resFailedMedia.quoteContext?.customizationProposed === "Diseño según archivo adjunto en chat",
        "Archivo no admitido o pesado propone 'Diseño según archivo adjunto en chat'"
      );
      assert(
        resFailedMedia.quoteContext?.customizationImagePending === true,
        "Marca customizationImagePending = true para aviso al admin"
      );
    }

    // -------------------------------------------------------------
    // PRUEBA 7: Flujo de Cantidad (1 a 100), Handoff Corporativo (>100) y Aviso de Stock
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 7: Flujo de Cantidad, Handoff Corporativo y Stock ---");
    {
      // 7.a Cantidad detectada en el mensaje inicial ("Quiero 3 vasos térmicos")
      const stateQtyInMessage = {
        messages: [new HumanMessage("Quiero 3 vasos térmicos")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "product_selection",
        },
      };

      const resQtyInit = await budgetAgentNode(stateQtyInMessage);
      assert(resQtyInit.quoteContext?.quantity === 3, "Detecta cantidad 3 directamente del texto inicial");
      assert(
        resQtyInit.quoteContext?.step === "customization",
        "Salta el paso de selección de cantidad y avanza a personalización"
      );

      // 7.b Pedido corporativo (>100 unidades) -> Handoff inmediato
      const stateCorporate = {
        messages: [new HumanMessage("Necesito 150 vasos térmicos para una empresa")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "product_selection",
        },
      };

      const resCorp = await budgetAgentNode(stateCorporate);
      assert(resCorp.humanHandoffRequired === true, "Pedido > 100 unidades deriva a HumanHandoff");
      assert(
        resCorp.humanHandoffReason?.includes("pedido corporativo de 150 unidades"),
        `Motivo de handoff corporativo registrado: '${resCorp.humanHandoffReason}'`
      );

      // 7.c Supera stock disponible (stock = 20, cliente pide 25)
      const stateExcessStock = {
        messages: [new HumanMessage("25 unidades")],
        userPhoneNumber: testUserPhone,
        whatsappChatId: `${testUserPhone}@c.us`,
        activeAgent: "budget",
        quoteContext: {
          step: "quantity_selection",
          selectedProductId: testProductId,
          selectedProductName: "Vaso Térmico Acero Inoxidable",
          unitPrice: 85000,
        },
      };

      const resStock = await budgetAgentNode(stateExcessStock);
      const stockMsg = resStock.messages?.[0]?.content || "";
      assert(
        stockMsg.includes("20 unidades") && (stockMsg.includes("disponibles") || stockMsg.includes("en stock")),
        "Informa existencias disponibles cuando la cantidad supera el stock"
      );
      assert(
        stockMsg.includes("asesor") || stockMsg.includes("cotizar"),
        "Consulta si desea cotizar las unidades disponibles o contactar un asesor"
      );
      assert(
        resStock.quoteContext?.step === "quantity_selection",
        "Permanece en quantity_selection para confirmar decisión del cliente"
      );
    }

    // -------------------------------------------------------------
    // PRUEBA 8: Verificación de sendOrderStatus (Flete dinámico y personalización)
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA 8: sendOrderStatus (Flete Dinámico y Sin Mensaje de Bienvenida) ---");
    {
      // 8.a Envío local gratis con personalización pendiente
      await sendOrderStatus(`${testUserPhone}@c.us`, "pending", 85000, "local_gratis", { hasPendingCustomization: true });

      const lastMsg1 = sentWhatsappMessages[sentWhatsappMessages.length - 1];
      const body1 = typeof lastMsg1?.content === "string" ? lastMsg1.content : "";

      assert(body1.includes("Envío gratis (Minga Guazú)"), "sendOrderStatus incluye 'Envío gratis (Minga Guazú)' para local_gratis");
      assert(body1.includes("Personalización:"), "sendOrderStatus incluye aviso de personalización pendiente");
      assert(!body1.includes("¡Hola! Te damos la bienvenida"), "sendOrderStatus NO envía mensaje de bienvenida en pending");

      // 8.b Envío transportadora contra entrega sin personalización pendiente
      await sendOrderStatus(`${testUserPhone}@c.us`, "pending", 85000, "transportadora_contra_entrega", { hasPendingCustomization: false });

      const lastMsg2 = sentWhatsappMessages[sentWhatsappMessages.length - 1];
      const body2 = typeof lastMsg2?.content === "string" ? lastMsg2.content : "";

      assert(body2.includes("Pago contra entrega a la transportadora"), "sendOrderStatus incluye 'Pago contra entrega a la transportadora'");
      assert(!body2.includes("Personalización:"), "sendOrderStatus NO solicita personalización si hasPendingCustomization es false");
    }

  } finally {
    // -------------------------------------------------------------
    // LIMPIEZA ABSOLUTA DE RECURSOS DE PRUEBA
    // -------------------------------------------------------------
    console.log("\n🧹 Limpiando recursos de prueba en Firestore...");

    // 1. Eliminar pedidos creados
    for (const ordId of createdOrderIds) {
      try {
        await db.collection("orders").doc(ordId).delete();
        console.log(`  🗑️ Pedido eliminado: orders/${ordId}`);
      } catch (e) {
        console.warn(`  ⚠️ Error eliminando pedido ${ordId}:`, e.message);
      }
    }

    // 1.b Barrido de salvaguarda de pedidos residuales
    try {
      const snap = await db.collection("orders").get();
      for (const d of snap.docs) {
        const odata = d.data();
        if (
          d.id.startsWith("test-") ||
          odata.userId?.startsWith("test-") ||
          (Array.isArray(odata.items) && odata.items.some((i) => i.productId && String(i.productId).startsWith("test-")))
        ) {
          await d.ref.delete();
          console.log(`  🗑️ Pedido residual eliminado en barrido: orders/${d.id}`);
        }
      }
    } catch (e) {
      console.warn("  ⚠️ Error en barrido de salvaguarda:", e.message);
    }

    // 2. Eliminar productos de prueba
    for (const prodId of createdProductIds) {
      try {
        await db.collection("products").doc(prodId).delete();
        console.log(`  🗑️ Producto eliminado: products/${prodId}`);
      } catch (e) {
        console.warn(`  ⚠️ Error eliminando producto ${prodId}:`, e.message);
      }
    }

    // 3. Eliminar usuarios de prueba
    for (const usrId of createdUserIds) {
      try {
        await db.collection("users").doc(usrId).delete();
        console.log(`  🗑️ Usuario eliminado: users/${usrId}`);
      } catch (e) {
        console.warn(`  ⚠️ Error eliminando usuario ${usrId}:`, e.message);
      }
    }

    // Restaurar WhatsApp mock y cerrar servidor
    whatsappClient.sendMessage = originalSendMessage;
    server.close();
    console.log("✅ Servidor de prueba cerrado y Firestore 100% limpio.");
  }

  console.log("\n==================================================================");
  console.log(`📊 RESULTADO FINAL: ${passed} PASADAS, ${failed} FALLIDAS`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runOrderPdfDecouplingTests().catch((err) => {
  console.error("❌ Error fatal en pruebas de desacoplamiento PDF:", err);
  process.exit(1);
});
