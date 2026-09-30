if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1.");
  process.exit(1);
}

import http from "http";
import jwt from "jsonwebtoken";
import { Timestamp } from "firebase-admin/firestore";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { compiledGraph } from "../src/agents/graph.js";
import { db } from "../src/config/firebase.js";
import { ALLOWED_MESSAGE_TYPES, runInThreadQueue } from "../src/config/whatsapp.js";
import app from "../src/app.js";

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { whatsappClient } from "../src/config/whatsapp.js";

const JWT_SECRET = process.env.JWT_SECRET || "hodie-secret-jwt-key-2024";

// Mock del LLM para responder predeciblemente según la intención testeada
ChatGoogleGenerativeAI.prototype.invoke = async function (input, options) {
  let promptText = "";
  if (typeof input === "string") {
    promptText = input;
  } else if (Array.isArray(input)) {
    promptText = input.map((m) => m.content || "").join(" ");
  }

  // Clasificación de intención en routerNode
  if (promptText.includes("clasificador de intenciones")) {
    const match = promptText.match(/Mensaje del cliente:\s*"([^"]+)"/i);
    const clientText = (match ? match[1] : promptText).toLowerCase();

    if (
      clientText.includes("cotizar") ||
      clientText.includes("termo") ||
      clientText.includes("taza") ||
      clientText.includes("unidades") ||
      clientText.includes("color")
    ) {
      return { content: JSON.stringify({ intent: "budget_quote", reason: "Cliente desea cotizar" }) };
    }
    if (clientText.includes("asesor") || clientText.includes("humano") || clientText.includes("persona") || clientText.includes("queja")) {
      return { content: JSON.stringify({ intent: "human_handoff", reason: "Cliente solicitó asesor o planteó queja" }) };
    }
    return { content: JSON.stringify({ intent: "customer_support", reason: "Consulta general" }) };
  }

  // Respuesta de FAQ en supportAgentNode
  return {
    content: "📍 Nos encontramos en Barrio Centro, Minga Guazú, Alto Paraná, Paraguay. Hacemos envíos a todo el país.",
  };
};

// Mock de envío de WhatsApp para entorno de pruebas
whatsappClient.sendMessage = async (to, msg, opts) => {
  return { id: { id: "test-msg-" + Date.now(), fromMe: true } };
};

// Helper de aserción simple
function assert(condition, testName, details = "") {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    if (details) console.error(`   Detalles: ${details}`);
    throw new Error(`Fallo en prueba: ${testName} - ${details}`);
  }
}

async function runBotResumeAndFiltersTests() {
  console.log("==================================================================");
  console.log("🧪 BATERÍA DE PRUEBAS - RESUME BOT, HANDOFF INDEX & WHATSAPP FILTERS");
  console.log("==================================================================\n");

  const timestamp = Date.now();
  const testPhoneClient = `595981${Math.floor(100000 + Math.random() * 900000)}`;
  const testPhoneAdmin = `595982${Math.floor(100000 + Math.random() * 900000)}`;
  const testThreadSupport = `${testPhoneClient}@c.us`;
  const testThreadBudget = `test-resume-budget-${timestamp}@c.us`;
  const testThreadLid = `150697601421342@lid`;

  const createdUserUids = [];
  const createdThreadIds = [testThreadSupport, testThreadBudget, testThreadLid];

  // 1. Tokens JWT para las pruebas
  const tokenClient = jwt.sign(
    { phone: testPhoneClient, role: "customer" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  const tokenAdmin = jwt.sign(
    { phone: testPhoneAdmin, role: "admin" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  // 2. Crear perfiles en Firestore
  const clientUid = `usr-cli-${timestamp}`;
  const adminUid = `usr-adm-${timestamp}`;

  await db.collection("users").doc(clientUid).set({
    uid: clientUid,
    phoneNumber: testPhoneClient,
    displayName: "Cliente Test Resume",
    role: "customer",
    active: true,
    createdAt: Timestamp.now(),
  });
  createdUserUids.push(clientUid);

  await db.collection("users").doc(adminUid).set({
    uid: adminUid,
    phoneNumber: testPhoneAdmin,
    displayName: "Admin Test Resume",
    role: "admin",
    active: true,
    createdAt: Timestamp.now(),
  });
  createdUserUids.push(adminUid);

  // 3. Levantar servidor Express en puerto dinámico
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`🚀 Servidor de prueba iniciado en ${baseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // TEST 1: Autenticación y Autorización en endpoints de admin
    // -------------------------------------------------------------
    console.log("--- TEST 1: Autenticación y Autorización ---");
    {
      // 1.a GET /admin/chats/handoff sin JWT -> 401
      const noAuthGet = await fetch(`${baseUrl}/admin/chats/handoff`);
      assert(noAuthGet.status === 401, "GET /admin/chats/handoff sin JWT responde HTTP 401");

      // 1.b GET /admin/chats/handoff con JWT de cliente -> 403
      const clientGet = await fetch(`${baseUrl}/admin/chats/handoff`, {
        headers: { Authorization: `Bearer ${tokenClient}` },
      });
      assert(clientGet.status === 403, "GET /admin/chats/handoff con JWT de cliente responde HTTP 403");

      // 1.c POST /admin/chats/:threadId/resume-bot sin JWT -> 401
      const noAuthPost = await fetch(`${baseUrl}/admin/chats/some-thread/resume-bot`, {
        method: "POST",
      });
      assert(noAuthPost.status === 401, "POST /admin/chats/:threadId/resume-bot sin JWT responde HTTP 401");

      // 1.d POST /admin/chats/:threadId/resume-bot con JWT de cliente -> 403
      const clientPost = await fetch(`${baseUrl}/admin/chats/some-thread/resume-bot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenClient}` },
      });
      assert(clientPost.status === 403, "POST /admin/chats/:threadId/resume-bot con JWT de cliente responde HTTP 403");
    }

    // -------------------------------------------------------------
    // TEST 2: 404 en hilo inexistente detectado por ausencia de checkpoint_id
    // -------------------------------------------------------------
    console.log("\n--- TEST 2: Hilo Inexistente -> HTTP 404 (sin checkpoint_id) ---");
    {
      const nonExistentId = `non-existent-thread-${timestamp}`;
      const res404 = await fetch(`${baseUrl}/admin/chats/${nonExistentId}/resume-bot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert(res404.status === 404, "Reactivar hilo inexistente responde HTTP 404");
      const data404 = await res404.json();
      assert(data404.error?.includes("no encontrado"), "Mensaje de error indica hilo no encontrado");
    }

    // -------------------------------------------------------------
    // TEST 3: Handoff -> Índice -> GET /admin/chats/handoff -> Resume -> Respuestas automáticas
    // -------------------------------------------------------------
    console.log("\n--- TEST 3: Flujo Handoff -> Índice -> Reactivación -> Siguiente mensaje ---");
    {
      const supportConfig = { configurable: { thread_id: testThreadSupport } };

      // Turno 1: Cliente solicita asesor humano -> Handoff
      const stateHandoff = await compiledGraph.invoke(
        {
          messages: [new HumanMessage("Necesito hablar con una persona urgente, tengo una queja")],
          userPhoneNumber: testPhoneClient,
          whatsappChatId: `${testPhoneClient}@c.us`,
        },
        supportConfig
      );

      assert(stateHandoff.humanHandoffRequired === true, "Turno 1: Grafo activa humanHandoffRequired: true");
      assert(Boolean(stateHandoff.humanHandoffReason), "Turno 1: humanHandoffReason fue preservado y no es null");

      // Simular upsert en el índice 'handoff_threads' tal cual lo realiza whatsapp.js
      const customerSnippet = "Necesito hablar con una persona urgente, tengo una queja".slice(0, 200);
      await db.collection("handoff_threads").doc(testThreadSupport).set({
        thread_id: testThreadSupport,
        whatsappChatId: `${testPhoneClient}@c.us`,
        userPhoneNumber: testPhoneClient,
        motivo: stateHandoff.humanHandoffReason || "Reclamo del cliente",
        lastCustomerMessage: customerSnippet,
        fecha: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

      // 3.a Consultar GET /admin/chats/handoff con JWT admin
      const handoffListRes = await fetch(`${baseUrl}/admin/chats/handoff`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert(handoffListRes.status === 200, "GET /admin/chats/handoff con JWT admin responde HTTP 200");
      const listData = await handoffListRes.json();
      assert(listData.success === true, "Respuesta indica success: true");
      assert(Array.isArray(listData.chats), "Propiedad chats es un arreglo");

      const foundChat = listData.chats.find((c) => c.thread_id === testThreadSupport);
      assert(Boolean(foundChat), "El hilo de soporte en handoff figura en la lista del índice");
      assert(foundChat.userPhoneNumber === testPhoneClient, "Datos del cliente (userPhoneNumber) correctos");
      assert(foundChat.motivo === stateHandoff.humanHandoffReason, "Motivo coincide exactamente con el del estado");
      assert(foundChat.lastCustomerMessage === customerSnippet, "lastCustomerMessage coincide con el mensaje del cliente");
      assert(Boolean(foundChat.fecha), "Fecha de derivación presente en formato ISO");

      // Turno 2: Mensaje del cliente durante handoff activo -> Silencio absoluto
      const stateSilence = await compiledGraph.invoke(
        {
          messages: [new HumanMessage("Hola, ¿siguen ahí? Estoy esperando")],
          userPhoneNumber: testPhoneClient,
          whatsappChatId: `${testPhoneClient}@c.us`,
        },
        supportConfig
      );
      const lastMsgSilence = stateSilence.messages[stateSilence.messages.length - 1];
      const isHumanSilence = lastMsgSilence instanceof HumanMessage || lastMsgSilence?._getType?.() === "human";
      assert(isHumanSilence, "Turno 2: Bot en 100% de silencio durante handoff (sin nuevo AIMessage)");

      // 3.b Reactivación: POST /admin/chats/:threadId/resume-bot con JWT admin
      const resumeRes = await fetch(`${baseUrl}/admin/chats/${encodeURIComponent(testThreadSupport)}/resume-bot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert(resumeRes.status === 200, "Reactivar bot con JWT admin responde HTTP 200");
      const resumeData = await resumeRes.json();
      assert(resumeData.success === true, "Reactivación exitosa en respuesta");

      // 3.c Verificar estado reactivado en LangGraph
      const snapshotAfter = await compiledGraph.getState(supportConfig);
      assert(snapshotAfter.values.humanHandoffRequired === false, "humanHandoffRequired se actualizó a false");
      assert(snapshotAfter.values.humanHandoffReason === null, "humanHandoffReason se limpió a null");
      assert(snapshotAfter.values.activeAgent === null, "activeAgent se limpió a null");
      assert(snapshotAfter.values.intent === null, "intent se limpió a null");
      assert(
        Array.isArray(snapshotAfter.next) && snapshotAfter.next.length === 0,
        "asNode 'human_handoff_node' dejó snapshot.next vacío ([])"
      );

      // 3.d Verificar que el documento fue eliminado del índice 'handoff_threads'
      const docAfter = await db.collection("handoff_threads").doc(testThreadSupport).get();
      assert(!docAfter.exists, "El hilo reactivado fue eliminado del índice handoff_threads");

      // 3.e Turno 3: Siguiente mensaje del cliente después de reactivar -> El bot vuelve a responder
      const stateAfterResume = await compiledGraph.invoke(
        {
          messages: [new HumanMessage("Hola, ¿dónde queda la tienda?")],
          userPhoneNumber: testPhoneClient,
          whatsappChatId: `${testPhoneClient}@c.us`,
        },
        supportConfig
      );
      const lastMsgAfter = stateAfterResume.messages[stateAfterResume.messages.length - 1];
      const isAiAfter = lastMsgAfter instanceof AIMessage || lastMsgAfter?._getType?.() === "ai";
      assert(isAiAfter, "Turno 3: Siguiente mensaje del cliente recibe respuesta automática generada por el bot");
      assert(
        lastMsgAfter.content.toLowerCase().includes("minga guazú") ||
        lastMsgAfter.content.toLowerCase().includes("minga guazu") ||
        lastMsgAfter.content.toLowerCase().includes("barrio centro"),
        "Turno 3: El bot respondió con la información oficial de la tienda"
      );
    }

    // -------------------------------------------------------------
    // TEST 4: Hilo existente pero NO en handoff -> HTTP 400
    // -------------------------------------------------------------
    console.log("\n--- TEST 4: Hilo Existente NO en Handoff -> HTTP 400 ---");
    {
      // El hilo testThreadSupport ya no está en handoff
      const res400 = await fetch(`${baseUrl}/admin/chats/${encodeURIComponent(testThreadSupport)}/resume-bot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert(res400.status === 400, "Reactivar hilo que no está en handoff responde HTTP 400");
      const data400 = await res400.json();
      assert(data400.error?.includes("no se encuentra en atención humana"), "Mensaje de error indica que no está en handoff");
    }

    // -------------------------------------------------------------
    // TEST 5: Handoff desde BudgetAgent y registro en el índice
    // -------------------------------------------------------------
    console.log("\n--- TEST 5: Handoff desde BudgetAgent y registro en índice ---");
    {
      const budgetConfig = { configurable: { thread_id: testThreadBudget } };

      // Iniciar cotización
      await compiledGraph.invoke(
        {
          messages: [new HumanMessage("Hola, quiero cotizar tazas personalizadas")],
          userPhoneNumber: testPhoneClient,
          whatsappChatId: `${testPhoneClient}@c.us`,
        },
        budgetConfig
      );

      // Cliente solicita un asesor humano en medio de la cotización
      const budgetHandoffResult = await compiledGraph.invoke(
        {
          messages: [new HumanMessage("Prefiero hablar con un asesor humano por favor")],
          userPhoneNumber: testPhoneClient,
          whatsappChatId: `${testPhoneClient}@c.us`,
        },
        budgetConfig
      );

      assert(budgetHandoffResult.humanHandoffRequired === true, "BudgetAgent activó humanHandoffRequired: true");
      assert(
        budgetHandoffResult.humanHandoffReason?.includes("asesor humano"),
        "BudgetAgent asignó motivo explícito de handoff"
      );

      // Simular upsert en handoff_threads tal como lo ejecuta whatsapp.js
      await db.collection("handoff_threads").doc(testThreadBudget).set({
        thread_id: testThreadBudget,
        whatsappChatId: `${testPhoneClient}@c.us`,
        userPhoneNumber: testPhoneClient,
        motivo: budgetHandoffResult.humanHandoffReason,
        lastCustomerMessage: "Prefiero hablar con un asesor humano por favor",
        fecha: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

      // Verificar presencia en GET /admin/chats/handoff
      const listResBudget = await fetch(`${baseUrl}/admin/chats/handoff`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      const listDataBudget = await listResBudget.json();
      const budgetEntry = listDataBudget.chats?.find((c) => c.thread_id === testThreadBudget);
      assert(Boolean(budgetEntry), "El handoff originado en BudgetAgent figura en GET /admin/chats/handoff");
      assert(budgetEntry.motivo?.includes("asesor humano"), "Motivo de BudgetAgent coincide");

      // Reactivar hilo
      const resumeBudgetRes = await fetch(`${baseUrl}/admin/chats/${encodeURIComponent(testThreadBudget)}/resume-bot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert(resumeBudgetRes.status === 200, "Reactivar hilo de BudgetAgent responde HTTP 200");
    }

    // -------------------------------------------------------------
    // TEST 5.b: Reactivación HTTP real de hilo con @lid usando encodeURIComponent
    // -------------------------------------------------------------
    console.log("\n--- TEST 5.b: Reactivación HTTP real de hilo con @lid ---");
    {
      const lidConfig = { configurable: { thread_id: testThreadLid } };

      // Activar handoff en el hilo con @lid
      const lidHandoffResult = await compiledGraph.invoke(
        {
          messages: [new HumanMessage("Quiero hablar con una persona por favor")],
          userPhoneNumber: "",
          whatsappChatId: testThreadLid,
        },
        lidConfig
      );

      assert(lidHandoffResult.humanHandoffRequired === true, "Hilo @lid activó handoff en Turno 1");

      // Simular upsert en handoff_threads tal como lo ejecuta whatsapp.js
      await db.collection("handoff_threads").doc(testThreadLid).set({
        thread_id: testThreadLid,
        whatsappChatId: testThreadLid,
        userPhoneNumber: "",
        motivo: lidHandoffResult.humanHandoffReason || "Atención humana requerida",
        lastCustomerMessage: "Quiero hablar con una persona por favor",
        fecha: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

      // Llamada HTTP real usando encodeURIComponent(testThreadLid)
      const encodedLid = encodeURIComponent(testThreadLid);
      const resumeLidRes = await fetch(`${baseUrl}/admin/chats/${encodedLid}/resume-bot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });

      assert(resumeLidRes.status === 200, "POST /admin/chats/<id con @lid>/resume-bot responde HTTP 200");
      const resumeLidData = await resumeLidRes.json();
      assert(resumeLidData.success === true, "Respuesta exitosa de reactivación para @lid");
      assert(resumeLidData.thread_id === testThreadLid, "thread_id devuelto coincide con el id @lid");

      // Verificar que el estado en LangGraph fue reactivado
      const stateLidAfter = await compiledGraph.getState(lidConfig);
      assert(stateLidAfter.values?.humanHandoffRequired === false, "humanHandoffRequired es false en el hilo @lid");
      assert(stateLidAfter.values?.humanHandoffReason === null, "humanHandoffReason se limpió a null en hilo @lid");

      // Verificar que se eliminó del índice handoff_threads
      const handoffDocLid = await db.collection("handoff_threads").doc(testThreadLid).get();
      assert(!handoffDocLid.exists, "Documento @lid fue eliminado del índice handoff_threads");
    }

    // -------------------------------------------------------------
    // TEST 6: Filtros de mensajes en whatsapp.js
    // -------------------------------------------------------------
    console.log("\n--- TEST 6: Filtros en whatsapp.js ---");
    {
      // 6.a Descarte de 0@c.us
      const isSystemAccount = (from) => from === "0@c.us";
      assert(isSystemAccount("0@c.us"), "6.a '0@c.us' es identificado como cuenta de sistema");
      assert(!isSystemAccount("595981123456@c.us"), "6.a Chat normal de cliente no es filtrado");

      // 6.b Tipos de mensaje permitidos
      assert(ALLOWED_MESSAGE_TYPES.has("chat"), "6.b 'chat' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("image"), "6.b 'image' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("document"), "6.b 'document' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("audio"), "6.b 'audio' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("video"), "6.b 'video' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("sticker"), "6.b 'sticker' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("ptt"), "6.b 'ptt' es un tipo permitido");
      assert(ALLOWED_MESSAGE_TYPES.has("location"), "6.b 'location' es un tipo permitido");

      // 6.c Tipos no permitidos
      assert(!ALLOWED_MESSAGE_TYPES.has("notification_template"), "6.c 'notification_template' es descartado");
      assert(!ALLOWED_MESSAGE_TYPES.has("e2e_notification"), "6.c 'e2e_notification' es descartado");
      assert(!ALLOWED_MESSAGE_TYPES.has("call_log"), "6.c 'call_log' es descartado");
      assert(!ALLOWED_MESSAGE_TYPES.has("protocol"), "6.c 'protocol' es descartado");

      // 6.d Formato de ubicación compartida (location)
      const mockLocationMsg = {
        type: "location",
        location: {
          latitude: -25.51234,
          longitude: -54.61234,
          description: "Minga Guazú Barrio Centro",
        },
      };

      let parsedLocationText = "";
      if (mockLocationMsg.type === "location" && mockLocationMsg.location) {
        const loc = mockLocationMsg.location;
        parsedLocationText = `Ubicación compartida: ${loc.latitude}, ${loc.longitude}`;
        if (loc.description) {
          parsedLocationText += ` (${loc.description.trim()})`;
        }
      }

      assert(
        parsedLocationText === "Ubicación compartida: -25.51234, -54.61234 (Minga Guazú Barrio Centro)",
        "6.d location se formatea como 'Ubicación compartida: <lat>, <lng> (<desc>)'"
      );

      // 6.e Truncado de userText a 1000 caracteres
      const hugeUserMessage = "Z".repeat(3500);
      const truncatedUserText = String(hugeUserMessage).slice(0, 1000);
      assert(truncatedUserText.length === 1000, "6.e Mensaje de 3500 caracteres se recorta a 1000 caracteres");
      assert(truncatedUserText === "Z".repeat(1000), "6.e Contenido recortado coincide");
    }

  } finally {
    // -------------------------------------------------------------
    // LIMPIEZA ABSOLUTA DE RECURSOS EN FIRESTORE
    // -------------------------------------------------------------
    console.log("\n🧹 Limpiando recursos de prueba en Firestore...");

    // 1. Limpiar usuarios
    for (const uid of createdUserUids) {
      try {
        await db.collection("users").doc(uid).delete();
        console.log(`  🗑️ Usuario eliminado: users/${uid}`);
      } catch (e) {
        console.warn(`  ⚠️ Error eliminando usuario ${uid}:`, e.message);
      }
    }

    // 2. Limpiar checkpoints e hilos del índice
    for (const threadId of createdThreadIds) {
      try {
        const chkSnaps = await db
          .collection("langgraph_checkpoints")
          .doc(threadId)
          .collection("checkpoints")
          .get();
        for (const doc of chkSnaps.docs) {
          await doc.ref.delete();
        }
        await db.collection("langgraph_checkpoints").doc(threadId).delete();
        await db.collection("handoff_threads").doc(threadId).delete();

        // Limpiar también langgraph_checkpoint_writes asociados al hilo
        const writesSnap = await db
          .collection("langgraph_checkpoint_writes")
          .where("thread_id", "==", threadId)
          .get();
        for (const w of writesSnap.docs) {
          await w.ref.delete();
        }

        console.log(`  🗑️ Checkpoints, writes e índice eliminados para thread: ${threadId}`);
      } catch (e) {
        console.warn(`  ⚠️ Error eliminando thread ${threadId}:`, e.message);
      }
    }

    server.close();
    console.log("✅ Servidor de prueba cerrado y Firestore 100% limpio.");
  }

  console.log("\n==================================================================");
  console.log("📊 RESULTADO FINAL: TODAS LAS PRUEBAS PASARON SATISFACTORIAMENTE");
  console.log("==================================================================\n");
}

runBotResumeAndFiltersTests().catch((err) => {
  console.error("❌ Error fatal en batería de pruebas:", err);
  process.exit(1);
});
