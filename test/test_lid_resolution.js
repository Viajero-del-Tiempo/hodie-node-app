if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1 (ej: npm run test:unit).");
  process.exit(1);
}

import { HumanMessage } from "@langchain/core/messages";
import { db } from "../src/config/firebase.js";
import { whatsappClient, resolvePhoneFromChatId } from "../src/config/whatsapp.js";
import { budgetAgentNode, normalizeParaguayanPhone } from "../src/agents/nodes/budget.node.js";
import { handoffNode, notifyAdminHandoffAlert } from "../src/agents/nodes/handoff.node.js";
import { supportAgentNode } from "../src/agents/nodes/support.node.js";
import { compiledGraph } from "../src/agents/graph.js";

/**
 * Suite de verificación completa para resolución de @lid,
 * thread_id, manejo sin número y blindaje de alertas admin.
 */

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failedTests++;
  }
}

async function runTests() {
  console.log("==================================================================");
  console.log("🧪 INICIANDO TEST SUITE: RESOLUCIÓN @lid Y MANEJO SIN NÚMERO");
  console.log("==================================================================\n");

  const originalGetContactLidAndPhone = whatsappClient.getContactLidAndPhone;
  const originalSendMessage = whatsappClient.sendMessage;
  const createdOrderIdsToClean = [];
  let testE2eLidChatId = null;
  let testLidChatId = null;
  let unresolvableChatId = null;

  try {
    // -------------------------------------------------------------
    // TEST 1: @c.us resuelve directo sin invocar getContactLidAndPhone
    // -------------------------------------------------------------
    console.log("Test 1: @c.us resuelve directo a dígitos...");
    let clientCalled = false;
    whatsappClient.getContactLidAndPhone = async () => {
      clientCalled = true;
      return [];
    };

    const phoneFromCus = await resolvePhoneFromChatId("595981234567@c.us");
    assert(phoneFromCus === "595981234567", "@c.us extrae dígitos correctamente (595981234567)");
    assert(!clientCalled, "No invocó whatsappClient.getContactLidAndPhone para @c.us");

    // -------------------------------------------------------------
    // TEST 2: @lid resuelve vía getContactLidAndPhone y queda en caché en Firestore
    // -------------------------------------------------------------
    console.log("\nTest 2: @lid resuelve vía getContactLidAndPhone y almacena en caché en Firestore...");
    const testLid = "test_lid_778899";
    testLidChatId = `${testLid}@lid`;
    const expectedPhone = "595985930912";

    // Limpiar documento previo si existiera
    await db.collection("lid_phone_map").doc(testLid).delete();

    let lidCallCount = 0;
    whatsappClient.getContactLidAndPhone = async (userIds) => {
      lidCallCount++;
      return [{ lid: userIds[0], pn: `${expectedPhone}@c.us` }];
    };

    // Primera llamada -> debe consultar cliente y cachear en Firestore
    const resolvedPhone1 = await resolvePhoneFromChatId(testLidChatId);
    assert(resolvedPhone1 === expectedPhone, `Primera llamada resolvió teléfono esperado (${expectedPhone})`);
    assert(lidCallCount === 1, "getContactLidAndPhone fue invocado 1 vez");

    // Verificar persistencia en Firestore
    const cachedDoc = await db.collection("lid_phone_map").doc(testLid).get();
    assert(cachedDoc.exists, "Documento persistido en colección lid_phone_map en Firestore");
    assert(cachedDoc.data()?.phoneNumber === expectedPhone, `phoneNumber guardado correctamente (${cachedDoc.data()?.phoneNumber})`);

    // Segunda llamada -> debe leer de Firestore sin invocar al cliente
    const resolvedPhone2 = await resolvePhoneFromChatId(testLidChatId);
    assert(resolvedPhone2 === expectedPhone, `Segunda llamada resolvió el mismo teléfono (${expectedPhone})`);
    assert(lidCallCount === 1, "La segunda llamada NO invocó getContactLidAndPhone (utilizó caché de Firestore)");

    // Limpiar documento de test
    await db.collection("lid_phone_map").doc(testLid).delete();

    // -------------------------------------------------------------
    // TEST 3: @lid irresoluble devuelve "" y no guarda en caché; userPhoneNumber queda vacío
    // -------------------------------------------------------------
    console.log("\nTest 3: @lid irresoluble devuelve \"\" y no persiste en caché...");
    const unresolvableLid = "test_lid_unresolvable_445566";
    unresolvableChatId = `${unresolvableLid}@lid`;

    await db.collection("lid_phone_map").doc(unresolvableLid).delete();

    whatsappClient.getContactLidAndPhone = async () => {
      // Simula que WhatsApp no conoce el pn del lid
      return [{ lid: unresolvableChatId, pn: undefined }];
    };

    const emptyResult = await resolvePhoneFromChatId(unresolvableChatId);
    assert(emptyResult === "", "@lid irresoluble retornó cadena vacía \"\"");
    assert(emptyResult !== unresolvableLid, "NUNCA devolvió el LID como si fuera teléfono");

    const shouldNotExistDoc = await db.collection("lid_phone_map").doc(unresolvableLid).get();
    assert(!shouldNotExistDoc.exists, "No se guardó nada en Firestore para LID irresoluble");

    // Caso de error/excepción en getContactLidAndPhone
    whatsappClient.getContactLidAndPhone = async () => {
      throw new Error("Puppeteer connection lost");
    };
    const errorResult = await resolvePhoneFromChatId(unresolvableChatId);
    assert(errorResult === "", "En caso de excepción en getContactLidAndPhone retorna \"\"");

    // -------------------------------------------------------------
    // TEST 4: BudgetAgent pide teléfono si falta y valida 09...
    // -------------------------------------------------------------
    console.log("\nTest 4: BudgetAgent validación y solicitud de teléfono paraguayo...");
    // 4.a Pruebas de limpieza y normalización con formatos especiales
    assert(normalizeParaguayanPhone("+595 981 234-567") === "595981234567", "+595 981 234-567 normalizado a 595981234567");
    assert(normalizeParaguayanPhone("0981-234567") === "595981234567", "0981-234567 normalizado a 595981234567");
    assert(normalizeParaguayanPhone("(0981) 234 567") === "595981234567", "(0981) 234 567 normalizado a 595981234567");
    assert(normalizeParaguayanPhone("981234567") === "595981234567", "981234567 normalizado a 595981234567");
    assert(normalizeParaguayanPhone("0985 930 912") === "595985930912", "0985 930 912 normalizado a 595985930912");
    assert(normalizeParaguayanPhone("150697601421342") === null, "LID de 15 dígitos rechazado como teléfono (null)");
    assert(normalizeParaguayanPhone("12345") === null, "Número corto inválido rechazado (null)");
    assert(normalizeParaguayanPhone("0981abc123") === null, "Texto alfanumérico rechazado (null)");

    // Sub-paso street con userPhoneNumber vacío -> debe solicitar teléfono y pasar a shippingStep: 'phone'
    const budgetStateNoPhone = {
      messages: [new HumanMessage("Calle Carlos Antonio López 456")],
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      quoteContext: {
        step: "shipping_info",
        shippingStep: "street",
        quantity: 1,
        selectedProductId: "prod-1",
        selectedProductName: "Taza Mágica",
        shippingAddress: {
          recipientName: "María Benítez",
          city: "Minga Guazú",
          department: "Alto Paraná",
        },
      },
    };

    const budgetRespStreet = await budgetAgentNode(budgetStateNoPhone);
    assert(
      budgetRespStreet.quoteContext?.shippingStep === "phone",
      "Tras ingresar calle sin userPhoneNumber, pasa a shippingStep: 'phone'"
    );
    const streetMsg = budgetRespStreet.messages[0]?.content || "";
    assert(
      streetMsg.includes("número de teléfono paraguayo"),
      "Mensaje solicita explícitamente teléfono paraguayo al cliente"
    );

    // Interceptar envíos de WhatsApp para validar alertas al admin en intentos fallidos
    let phoneAttemptsAlerts = [];
    whatsappClient.sendMessage = async (chatId, text) => {
      phoneAttemptsAlerts.push({ chatId, text });
      return { id: { _serialized: `msg-${Date.now()}` } };
    };
    process.env.ADMIN_WHATSAPP_PHONE = "595981000000";

    // Sub-paso phone con input inválido (Intento 1)
    const budgetStateInvalid1 = {
      messages: [new HumanMessage("150697601421342")], // Cliente manda el LID o texto inválido
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      consecutiveMisunderstandings: 0,
      quoteContext: {
        ...budgetRespStreet.quoteContext,
        step: "shipping_info",
        shippingStep: "phone",
      },
    };

    const budgetRespInvalid1 = await budgetAgentNode(budgetStateInvalid1);
    assert(
      budgetRespInvalid1.consecutiveMisunderstandings === 1,
      "Intento 1 fallido incrementa consecutiveMisunderstandings a 1"
    );
    assert(
      budgetRespInvalid1.humanHandoffRequired !== true,
      "Intento 1 fallido aún no deriva a handoff"
    );

    // Intento 2 fallido
    const budgetStateInvalid2 = {
      messages: [new HumanMessage("número inválido")],
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      consecutiveMisunderstandings: 1,
      quoteContext: {
        ...budgetRespInvalid1.quoteContext,
        step: "shipping_info",
        shippingStep: "phone",
      },
    };
    const budgetRespInvalid2 = await budgetAgentNode(budgetStateInvalid2);
    assert(
      budgetRespInvalid2.consecutiveMisunderstandings === 2,
      "Intento 2 fallido incrementa consecutiveMisunderstandings a 2"
    );
    assert(
      budgetRespInvalid2.humanHandoffRequired !== true,
      "Intento 2 fallido aún no deriva a handoff"
    );

    // Intento 3 fallido
    const budgetStateInvalid3 = {
      messages: [new HumanMessage("otra cosa")],
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      consecutiveMisunderstandings: 2,
      quoteContext: {
        ...budgetRespInvalid2.quoteContext,
        step: "shipping_info",
        shippingStep: "phone",
      },
    };
    const budgetRespInvalid3 = await budgetAgentNode(budgetStateInvalid3);
    assert(
      budgetRespInvalid3.consecutiveMisunderstandings === 3,
      "Intento 3 fallido incrementa consecutiveMisunderstandings a 3"
    );
    assert(
      budgetRespInvalid3.humanHandoffRequired !== true,
      "Intento 3 fallido aún no deriva a handoff (espera 4 intentos)"
    );

    // Intento 4 fallido -> Derivación automática a handoff manteniendo quoteContext
    const budgetStateInvalid4 = {
      messages: [new HumanMessage("sigo sin poner número")],
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      consecutiveMisunderstandings: 3,
      quoteContext: {
        ...budgetRespInvalid3.quoteContext,
        step: "shipping_info",
        shippingStep: "phone",
      },
    };
    const budgetRespInvalid4 = await budgetAgentNode(budgetStateInvalid4);
    assert(
      budgetRespInvalid4.consecutiveMisunderstandings === 4,
      "Intento 4 fallido establece consecutiveMisunderstandings a 4"
    );
    assert(
      budgetRespInvalid4.humanHandoffRequired === true,
      "Intento 4 fallido activa humanHandoffRequired: true"
    );
    assert(
      budgetRespInvalid4.activeAgent === null,
      "Intento 4 desactiva el activeAgent a null"
    );
    assert(
      Boolean(budgetRespInvalid4.quoteContext?.shippingAddress),
      "Intento 4 preserva el quoteContext intacto para el asesor humano"
    );
    assert(
      phoneAttemptsAlerts.length === 0,
      "budgetAgentNode NO envía alertas directamente (regla: solo whatsapp.js despacha alertas)"
    );

    // Sub-paso phone con número válido que empieza con 09
    const budgetStateValidPhone = {
      messages: [new HumanMessage("0985 930 912")],
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      consecutiveMisunderstandings: 2,
      quoteContext: {
        ...budgetRespStreet.quoteContext,
        step: "shipping_info",
        shippingStep: "phone",
      },
    };

    const budgetRespValid = await budgetAgentNode(budgetStateValidPhone);
    assert(
      budgetRespValid.userPhoneNumber === "595985930912",
      "userPhoneNumber normalizado y guardado en estado (595985930912)"
    );
    assert(
      budgetRespValid.consecutiveMisunderstandings === 0,
      "Ingreso válido de teléfono resetea consecutiveMisunderstandings a 0"
    );
    assert(
      budgetRespValid.quoteContext?.step === "confirmation",
      "Avanza al paso 'confirmation' tras validar el teléfono"
    );
    const confirmMsg = budgetRespValid.messages[0]?.content || "";
    assert(
      confirmMsg.includes("• *Teléfono:* +595985930912"),
      "Confirmación muestra teléfono con formato oficial (+595985930912)"
    );
    assert(
      !confirmMsg.includes("150697601421342"),
      "Confirmación NO contiene el LID en ninguna parte"
    );

    // -------------------------------------------------------------
    // TEST 5: Alertas al admin sin LID con "+"
    // -------------------------------------------------------------
    console.log("\nTest 5: Alerta admin sin número formateada correctamente (sin LID con '+')...");
    let sentAdminMessages = [];
    whatsappClient.sendMessage = async (chatId, text) => {
      sentAdminMessages.push({ chatId, text });
      return { id: { _serialized: `msg-${Date.now()}` } };
    };

    process.env.ADMIN_WHATSAPP_PHONE = "595981000000";

    const handoffState = {
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      pushname: "Laura Gómez",
      reason: "Consulta compleja de personalización",
      humanHandoffReason: "Consulta compleja de personalización",
      messages: [new HumanMessage("Quiero hablar con una persona")],
    };

    await notifyAdminHandoffAlert(handoffState);

    assert(sentAdminMessages.length > 0, "Alerta de handoff fue enviada al admin");
    const adminAlertText = sentAdminMessages[0]?.text || "";
    assert(
      adminAlertText.includes("Laura Gómez (150697601421342@lid) [número no disponible]"),
      "Alerta muestra nombre del contacto, whatsappChatId y 'número no disponible'"
    );
    assert(
      !adminAlertText.includes("+150697601421342"),
      "Alerta NUNCA muestra el LID con '+' adelante"
    );
    assert(
      !adminAlertText.includes("+cliente"),
      "Alerta no contiene fallback anticuado '+cliente'"
    );

    // Test adicional: SupportAgent cuando userPhoneNumber está vacío
    console.log("\nTest adicional: SupportAgent consulta de pedidos sin número...");
    const supportStateNoPhone = {
      userPhoneNumber: "",
      whatsappChatId: "150697601421342@lid",
      intent: "order_status",
      messages: [new HumanMessage("¿Cómo está mi pedido?")],
    };

    const supportResp = await supportAgentNode(supportStateNoPhone);
    const supportMsg = supportResp.messages[0]?.content || "";
    assert(
      supportMsg.includes("número de pedido") && supportMsg.includes("número de teléfono"),
      "SupportAgent solicita número de pedido o teléfono de compra en vez de buscar con \"\""
    );

    // -------------------------------------------------------------
    // TEST 6: Flujo E2E multi-turno con @lid irresoluble -> Pedido en Firestore con userPhoneNumber
    // -------------------------------------------------------------
    console.log("\nTest 6: E2E con @lid irresoluble, captura de teléfono y persistencia de pedido...");
    testE2eLidChatId = `test_lid_e2e_${Date.now()}@lid`;
    const e2eConfig = { configurable: { thread_id: testE2eLidChatId } };

    // 1. Simular que getContactLidAndPhone no resuelve el número de este LID
    whatsappClient.getContactLidAndPhone = async () => [{ lid: testE2eLidChatId, pn: undefined }];

    // Simular el despacho de turnos tal como lo hace whatsappClient.on("message"):
    // Sólo incluye userPhoneNumber si resolvePhoneFromChatId devolvió algo no vacío.
    const dispatchIncomingMessage = async (text) => {
      const resolved = await resolvePhoneFromChatId(testE2eLidChatId);
      const inputState = {
        messages: [new HumanMessage(text)],
        ...(resolved ? { userPhoneNumber: resolved } : {}),
        whatsappChatId: testE2eLidChatId,
      };
      return compiledGraph.invoke(inputState, e2eConfig);
    };

    // Turno 1: Iniciar cotización
    await dispatchIncomingMessage("Hola, quiero cotizar");

    // Turno 2: Selección de producto (Opción 1 del catálogo)
    await dispatchIncomingMessage("1");

    // Turno 2.b: Cantidad (1 unidad)
    await dispatchIncomingMessage("1");

    // Turno 3: Personalización
    await dispatchIncomingMessage("Con grabado láser");

    // Turno 3.b: Confirmación explícita de la personalización propuesta
    await dispatchIncomingMessage("Sí");

    // Turno 4: Empaque (Opción 1)
    await dispatchIncomingMessage("1");

    // Turno 5: Nombre del destinatario
    await dispatchIncomingMessage("Carlos Benítez");

    // Turno 6: Ciudad y departamento
    await dispatchIncomingMessage("Minga Guazú");

    // Turno 7: Calle -> El bot detecta que no hay teléfono y pasa a 'phone'
    const e2eTurn7 = await dispatchIncomingMessage("Km 16 Monday");
    assert(
      e2eTurn7.quoteContext?.shippingStep === "phone",
      "E2E: Tras calle, solicita número de teléfono porque @lid no tenía número resuelto"
    );

    // Turno 8: Cliente escribe "0981 234 567"
    const e2eTurn8 = await dispatchIncomingMessage("0981 234 567");
    assert(
      e2eTurn8.userPhoneNumber === "595981234567",
      "E2E: BudgetAgent normalizó y guardó userPhoneNumber: '595981234567'"
    );
    assert(
      e2eTurn8.quoteContext?.step === "confirmation",
      "E2E: quoteContext avanzó a 'confirmation'"
    );

    // Turno 9: Cliente confirma el pedido con "Sí, confirmo"
    // Gracias a la corrección en whatsapp.js, el "" del @lid no pisa "595981234567"
    const e2eTurn9 = await dispatchIncomingMessage("Sí, confirmo");
    assert(
      e2eTurn9.activeAgent === null,
      "E2E: activeAgent queda en null tras confirmación de pedido"
    );

    // Verificar en Firestore que el pedido guardado tiene userPhoneNumber = "595981234567"
    const orderSnap = await db
      .collection("orders")
      .where("whatsappChatId", "==", testE2eLidChatId)
      .limit(1)
      .get();

    assert(!orderSnap.empty, "E2E: Pedido encontrado en Firestore para el cliente @lid");
    if (!orderSnap.empty) {
      const orderDoc = orderSnap.docs[0];
      const orderData = orderDoc.data();
      createdOrderIdsToClean.push(orderDoc.id);

      assert(
        orderData.userPhoneNumber === "595981234567",
        `E2E: Pedido en Firestore guardó userPhoneNumber = "595981234567" (obtenido: "${orderData.userPhoneNumber}")`
      );
      assert(
        orderData.whatsappChatId === testE2eLidChatId,
        `E2E: Pedido en Firestore guardó whatsappChatId = "${testE2eLidChatId}"`
      );
      assert(
        orderData.status === "pending",
        "E2E: Pedido guardado en estado 'pending'"
      );
    }

  } finally {
    // Restaurar métodos originales
    whatsappClient.getContactLidAndPhone = originalGetContactLidAndPhone;
    whatsappClient.sendMessage = originalSendMessage;

    // Limpieza de órdenes de prueba creadas
    for (const ordId of createdOrderIdsToClean) {
      try {
        await db.collection("orders").doc(ordId).delete();
      } catch (err) {
        console.warn(`Advertencia eliminando orden ${ordId}:`, err.message);
      }
    }

    // Limpieza exhaustiva de checkpoints y writes de hilos de prueba
    const threadsToClean = [
      testLidChatId,
      unresolvableChatId,
      typeof testE2eLidChatId !== "undefined" ? testE2eLidChatId : null,
      "150697601421342@lid",
    ].filter(Boolean);

    for (const tid of threadsToClean) {
      try {
        const threadRef = db.collection("langgraph_checkpoints").doc(tid);
        const subDocs = await threadRef.collection("checkpoints").get();
        for (const d of subDocs.docs) {
          await d.ref.delete();
        }
        await threadRef.delete();

        // Limpiar también langgraph_checkpoint_writes asociados al hilo
        const writesSnap = await db
          .collection("langgraph_checkpoint_writes")
          .where("thread_id", "==", tid)
          .get();
        for (const w of writesSnap.docs) {
          await w.ref.delete();
        }

        await db.collection("handoff_threads").doc(tid).delete();
      } catch (err) {
        console.warn(`Advertencia limpiando thread ${tid}:`, err.message);
      }
    }
  }

  console.log("\n==================================================================");
  console.log(`📊 RESULTADO DE TESTS: ${passedTests} aprobados, ${failedTests} fallidos.`);
  console.log("==================================================================");

  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Error ejecutando test suite:", err);
  process.exit(1);
});
