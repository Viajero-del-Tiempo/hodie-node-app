if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1 (ej: npm run test:unit).");
  process.exit(1);
}

import { AgentStateAnnotation } from "../src/agents/state.js";
import {
  resolveChatId,
  sendOrderStatus,
  sendOrderPDF,
  sendVerificationCode,
  sendWelcomeMessage,
  sendErrorMessage,
  sendLimitError,
} from "../src/services/whatsapp.service.js";
import { whatsappClient } from "../src/config/whatsapp.js";
import { processAndSendOrder, updateOrderStatusAndNotify } from "../src/services/order.service.js";
import { updateAdminOrderStatus } from "../src/controllers/admin.order.controller.js";
import { db } from "../src/config/firebase.js";
import { Timestamp } from "firebase-admin/firestore";
import fs from "fs";
import path from "path";

async function runTests() {
  console.log("==================================================================");
  console.log("🧪 BATERÍA DE PRUEBAS - DECOUPLING userPhoneNumber vs whatsappChatId");
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

  // Identificadores de recursos de prueba para aislamiento total
  const timestamp = Date.now();
  const testProductId = `test-prod-chatid-${timestamp}`;
  const testOrderId4 = `test-ord-t4-${timestamp}`;
  const testOrderId6Lid = `test-ord-t6-lid-${timestamp}`;
  const testOrderId6Old = `test-ord-t6-old-${timestamp}`;

  const createdOrderIds = [];
  const originalSendMessage = whatsappClient.sendMessage;

  try {
    // -------------------------------------------------------------
    // SETUP: Crear producto de prueba propio en Firestore (NO usar catálogo real)
    // -------------------------------------------------------------
    console.log(`🛠️ Creando producto de prueba propio: ${testProductId}...`);
    await db.collection("products").doc(testProductId).set({
      name: "Producto de Prueba Automatizada",
      sku: `TEST-SKU-${timestamp}`,
      stock: 10,
      price: 50000,
      createdAt: new Date(),
    });

    // -------------------------------------------------------------
    // TEST 1: resolveChatId
    // -------------------------------------------------------------
    console.log("\n--- TEST 1: resolveChatId Behavior ---");
    {
      const lidRecipient = "150697601421342@lid";
      const resolvedLid = resolveChatId(lidRecipient, "test1");
      assert(resolvedLid === "150697601421342@lid", "Conserva @lid sin alterar");

      const cusRecipient = "595981234567@c.us";
      const resolvedCus = resolveChatId(cusRecipient, "test1");
      assert(resolvedCus === "595981234567@c.us", "Conserva @c.us sin alterar");

      let warned = false;
      const originalWarn = console.warn;
      console.warn = (...args) => {
        warned = true;
      };
      const phoneFallback = "595981999888";
      const resolvedFallback = resolveChatId(phoneFallback, "testFallback");
      console.warn = originalWarn;

      assert(resolvedFallback === "595981999888@c.us", "Fallback a @c.us correcto");
      assert(warned === true, "Fallback genera advertencia en consola");
    }

    // -------------------------------------------------------------
    // TEST 2: AgentStateAnnotation (userPhoneNumber & whatsappChatId reducers)
    // -------------------------------------------------------------
    console.log("\n--- TEST 2: AgentStateAnnotation Reducers ---");
    {
      const userPhoneSpec = AgentStateAnnotation.spec.userPhoneNumber;
      const whatsappChatIdSpec = AgentStateAnnotation.spec.whatsappChatId;

      assert(typeof userPhoneSpec?.operator === "function", "userPhoneNumber tiene reducer (operator)");
      assert(typeof whatsappChatIdSpec?.operator === "function", "whatsappChatId tiene reducer (operator)");

      // Test inicial
      const r1 = whatsappChatIdSpec.operator("", "150697601421342@lid");
      assert(r1 === "150697601421342@lid", "whatsappChatId se inicializa correctamente con @lid");

      // Test persistencia ante update parcial (undefined)
      const r2 = whatsappChatIdSpec.operator(r1, undefined);
      assert(r2 === "150697601421342@lid", "whatsappChatId persiste cuando no se incluye en el nodo");

      // Test reseteo explícito { reset: true }
      const r3 = whatsappChatIdSpec.operator(r2, { reset: true });
      assert(r3 === "", "whatsappChatId se limpia con { reset: true }");

      // Mismo comportamiento para userPhoneNumber
      const p1 = userPhoneSpec.operator("", "595981123456");
      const p2 = userPhoneSpec.operator(p1, undefined);
      const p3 = userPhoneSpec.operator(p2, { reset: true });
      assert(p2 === "595981123456" && p3 === "", "userPhoneNumber persiste y responde a reset");
    }

    // -------------------------------------------------------------
    // TEST 3: Intercepción de whatsappClient.sendMessage
    // -------------------------------------------------------------
    console.log("\n--- TEST 3: Envío directo a @lid sin concatenar @c.us ---");
    {
      let lastSentTo = null;
      let lastMsg = null;
      whatsappClient.sendMessage = async (to, msg) => {
        lastSentTo = to;
        lastMsg = msg;
        return { id: "msg-123" };
      };

      // sendOrderStatus con @lid
      await sendOrderStatus("123456789@lid", "paid", 150000);
      assert(lastSentTo === "123456789@lid", "sendOrderStatus envía exactamente a @lid", `Recibió: ${lastSentTo}`);

      // sendOrderStatus con @c.us
      await sendOrderStatus("595981111222@c.us", "delivered", 0);
      assert(lastSentTo === "595981111222@c.us", "sendOrderStatus envía exactamente a @c.us", `Recibió: ${lastSentTo}`);

      // sendVerificationCode
      await sendVerificationCode("123456789@lid", "123456");
      assert(lastSentTo === "123456789@lid", "sendVerificationCode envía a @lid");

      // sendWelcomeMessage
      await sendWelcomeMessage("123456789@lid");
      assert(lastSentTo === "123456789@lid", "sendWelcomeMessage envía a @lid");

      // sendErrorMessage
      await sendErrorMessage("123456789@lid");
      assert(lastSentTo === "123456789@lid", "sendErrorMessage envía a @lid");

      // sendLimitError
      await sendLimitError("123456789@lid");
      assert(lastSentTo === "123456789@lid", "sendLimitError envía a @lid");

      // sendOrderPDF
      const dummyPdf = path.join(process.cwd(), "temp", "test_dummy.pdf");
      fs.writeFileSync(dummyPdf, "dummy pdf content");
      try {
        await sendOrderPDF("123456789@lid", dummyPdf);
        assert(lastSentTo === "123456789@lid", "sendOrderPDF envía a @lid");
      } finally {
        if (fs.existsSync(dummyPdf)) fs.unlinkSync(dummyPdf);
      }
    }

    // -------------------------------------------------------------
    // TEST 4: processAndSendOrder guarda y usa whatsappChatId con producto de prueba propio
    // -------------------------------------------------------------
    console.log("\n--- TEST 4: processAndSendOrder guarda y usa whatsappChatId ---");
    {
      let sentPdfTo = null;
      whatsappClient.sendMessage = async (to, msg) => {
        sentPdfTo = to;
        return { id: "pdf-sent" };
      };

      const orderPayload = {
        id: testOrderId4,
        userId: "usr-test-isolated",
        userDisplayName: "Cliente Test Propio",
        userPhoneNumber: "595981333444",
        whatsappChatId: "9876543210@lid",
        items: [
          {
            productId: testProductId,
            productName: "Producto de Prueba Automatizada",
            productSku: `TEST-SKU-${timestamp}`,
            quantity: 2,
            price: 50000,
          },
        ],
        shippingAddress: {
          city: "Asunción",
          department: "Central",
          street: "Palma 123",
        },
        subtotal: 100000,
        total: 100000,
      };

      const res = await processAndSendOrder(orderPayload);
      createdOrderIds.push(testOrderId4);

      const savedDoc = await db.collection("orders").doc(testOrderId4).get();
      const savedData = savedDoc.data();

      assert(res.success === true, "processAndSendOrder completó exitosamente");
      assert(savedData?.whatsappChatId === "9876543210@lid", "Firestore guarda whatsappChatId en Order");
      assert(savedData?.userPhoneNumber === "595981333444", "Firestore guarda userPhoneNumber intacto");
      assert(sentPdfTo === "9876543210@lid", "PDF fue enviado a whatsappChatId (@lid) y NO a userPhoneNumber@c.us");
      assert(savedData?.createdAt instanceof Timestamp, "createdAt de la orden guardada es una instancia de Firestore Timestamp");
      assert(typeof savedData?.createdAt?.toDate === "function", "createdAt tiene método toDate()");
    }

    // -------------------------------------------------------------
    // TEST 4.b: Inyección de createdAt falso (2020) es ignorada en pedidos nuevos
    // -------------------------------------------------------------
    console.log("\n--- TEST 4.b: Inyección de createdAt falso (2020) es ignorada ---");
    {
      const fakeCreatedAtOrderId = `test-ord-fake-date-${timestamp}`;
      const fakeDatePayload = {
        id: fakeCreatedAtOrderId,
        userId: "usr-test-isolated",
        userDisplayName: "Cliente Fecha Falsa",
        userPhoneNumber: "595981444555",
        whatsappChatId: "9876543211@lid",
        createdAt: "2020-01-01T00:00:00.000Z", // Inyección de fecha del año 2020 en el payload
        items: [
          {
            productId: testProductId,
            productName: "Producto de Prueba Automatizada",
            productSku: `TEST-SKU-${timestamp}`,
            quantity: 1,
            price: 50000,
          },
        ],
        shippingAddress: {
          city: "Asunción",
          department: "Central",
          street: "Palma 123",
        },
        subtotal: 50000,
        total: 50000,
      };

      await processAndSendOrder(fakeDatePayload);
      createdOrderIds.push(fakeCreatedAtOrderId);

      const savedFakeDoc = await db.collection("orders").doc(fakeCreatedAtOrderId).get();
      const savedFakeData = savedFakeDoc.data();

      const savedDate = savedFakeData?.createdAt?.toDate();
      const now = new Date();
      const isWithinLastMinute = savedDate && Math.abs(now.getTime() - savedDate.getTime()) < 60000;

      assert(savedFakeData?.createdAt instanceof Timestamp, "createdAt de la orden guardada es Timestamp");
      assert(savedDate?.getFullYear() !== 2020, "createdAt del documento NO es el año 2020");
      assert(isWithinLastMinute, "createdAt del documento tiene la fecha actual");

      // -------------------------------------------------------------
      // TEST 4.c: Re-procesar pedido existente conserva el createdAt original de Firestore
      // -------------------------------------------------------------
      console.log("\n--- TEST 4.c: Re-procesamiento de pedido existente conserva createdAt original ---");
      const originalCreatedAt = savedFakeData.createdAt;

      // Re-procesar la misma orden pero enviando otro createdAt diferente en el payload
      const reprocessPayload = {
        ...fakeDatePayload,
        createdAt: "2019-12-31T23:59:59.000Z",
        total: 50000,
      };

      await processAndSendOrder(reprocessPayload);
      const reprocessedDoc = await db.collection("orders").doc(fakeCreatedAtOrderId).get();
      const reprocessedData = reprocessedDoc.data();

      assert(
        reprocessedData?.createdAt?.toMillis() === originalCreatedAt.toMillis(),
        "Re-procesar pedido existente conserva el createdAt original leído de Firestore y no el del payload"
      );
    }

    // -------------------------------------------------------------
    // TEST 5: updateOrderStatusAndNotify con whatsappChatId y fallback
    // -------------------------------------------------------------
    console.log("\n--- TEST 5: updateOrderStatusAndNotify con whatsappChatId ---");
    {
      let sentTo = null;
      whatsappClient.sendMessage = async (to, msg) => {
        sentTo = to;
        return { id: "msg-status" };
      };

      // 1. Directo con whatsappChatId
      await updateOrderStatusAndNotify({
        whatsappChatId: "123456789@lid",
        status: "paid",
        amount: 50000,
      });
      assert(sentTo === "123456789@lid", "updateOrderStatusAndNotify usa whatsappChatId directamente");

      // 2. Con phone fallback (genera advertencia pero funciona)
      await updateOrderStatusAndNotify({
        phone: "595981777888",
        status: "shipped",
        amount: 50000,
      });
      assert(sentTo === "595981777888@c.us", "updateOrderStatusAndNotify hace fallback a phone@c.us");
    }

    // -------------------------------------------------------------
    // TEST 6: updateAdminOrderStatus y ciclo de inventario con producto de prueba propio
    // -------------------------------------------------------------
    console.log("\n--- TEST 6: updateAdminOrderStatus y control de stock real en producto de prueba ---");
    {
      let notifiedTo = null;
      whatsappClient.sendMessage = async (to, msg) => {
        notifiedTo = to;
        return { id: "msg-admin" };
      };

      // Crear pedido de prueba en Firestore vinculado al producto de prueba propio (stock inicial: 10)
      await db.collection("orders").doc(testOrderId6Lid).set({
        orderNumber: `test-${timestamp}-1`,
        status: "pending",
        userPhoneNumber: "595981111222",
        whatsappChatId: "150697601421342@lid",
        total: 100000,
        items: [
          {
            productId: testProductId,
            quantity: 3,
            price: 50000,
          },
        ],
        createdAt: new Date(),
      });
      createdOrderIds.push(testOrderId6Lid);

      // Transición 1: pending -> preparing (debe DESCONTAR stock de 10 a 7 en el producto de prueba)
      const reqPreparing = {
        params: { id: testOrderId6Lid },
        body: { status: "preparing" },
      };
      const resPreparing = {
        json: () => resPreparing,
        status: () => resPreparing,
      };

      await updateAdminOrderStatus(reqPreparing, resPreparing);

      const prodAfterDeduct = (await db.collection("products").doc(testProductId).get()).data();
      assert(
        Number(prodAfterDeduct.stock) === 7,
        "updateAdminOrderStatus descontó correctamente 3 unidades de stock del producto de prueba (10 -> 7)",
        `Stock actual: ${prodAfterDeduct.stock}`
      );
      assert(
        notifiedTo === "150697601421342@lid",
        "updateAdminOrderStatus notificó el cambio de estado a whatsappChatId (@lid)"
      );

      // Transición 2: preparing -> cancelled (debe RESTITUIR stock de 7 a 10 en el producto de prueba)
      const reqCancel = {
        params: { id: testOrderId6Lid },
        body: { status: "cancelled" },
      };
      const resCancel = {
        json: () => resCancel,
        status: () => resCancel,
      };

      await updateAdminOrderStatus(reqCancel, resCancel);

      const prodAfterRestore = (await db.collection("products").doc(testProductId).get()).data();
      assert(
        Number(prodAfterRestore.stock) === 10,
        "updateAdminOrderStatus restituyó correctamente el stock del producto de prueba al cancelar (7 -> 10)",
        `Stock actual: ${prodAfterRestore.stock}`
      );

      // Caso B: Pedido sin whatsappChatId (fallback a phone@c.us)
      await db.collection("orders").doc(testOrderId6Old).set({
        orderNumber: `test-${timestamp}-2`,
        status: "pending",
        userPhoneNumber: "595981555666",
        total: 50000,
        items: [],
        createdAt: new Date(),
      });
      createdOrderIds.push(testOrderId6Old);

      const reqOld = {
        params: { id: testOrderId6Old },
        body: { status: "preparing" },
      };
      const resOld = {
        json: () => resOld,
        status: () => resOld,
      };

      await updateAdminOrderStatus(reqOld, resOld);
      assert(
        notifiedTo === "595981555666@c.us",
        "updateAdminOrderStatus usa fallback para órdenes antiguas sin whatsappChatId"
      );
    }

  } finally {
    // -------------------------------------------------------------
    // LIMPIEZA ABSOLUTA GARANTIZADA (try/finally)
    // -------------------------------------------------------------
    console.log("\n🧹 Limpiando datos de prueba generados en Firestore...");

    // 1. Eliminar pedidos de prueba creados
    for (const ordId of createdOrderIds) {
      try {
        await db.collection("orders").doc(ordId).delete();
        console.log(`  🗑️ Pedido de prueba eliminado: orders/${ordId}`);
      } catch (cleanErr) {
        console.warn(`  ⚠️ Error eliminando pedido ${ordId}:`, cleanErr.message);
      }
    }

    // 2. Eliminar producto de prueba propio
    try {
      await db.collection("products").doc(testProductId).delete();
      console.log(`  🗑️ Producto de prueba eliminado: products/${testProductId}`);
    } catch (cleanProdErr) {
      console.warn(`  ⚠️ Error eliminando producto ${testProductId}:`, cleanProdErr.message);
    }

    // 3. Restaurar mocks
    whatsappClient.sendMessage = originalSendMessage;
    console.log("✅ Limpieza de Firestore finalizada sin alterar datos reales de catálogo ni clientes.");
  }

  console.log("\n==================================================================");
  console.log(`📊 RESULTADO FINAL: ${passed} PASADAS, ${failed} FALLIDAS`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Error fatal en test:", err);
  process.exit(1);
});
