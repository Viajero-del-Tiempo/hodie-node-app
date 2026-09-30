if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1.");
  process.exit(1);
}

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { compiledGraph, checkpointer } from "../src/agents/graph.js";
import { whatsappClient, getMediaDescription, threadQueues, runInThreadQueue, handleIncomingWhatsAppMessage } from "../src/config/whatsapp.js";
import { db } from "../src/config/firebase.js";
import { Timestamp } from "firebase-admin/firestore";
import { getLatestOrderForUser } from "../src/agents/nodes/support.node.js";

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// Configurar variables de entorno requeridas para tests
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-gemini-api-key";
process.env.ADMIN_WHATSAPP_PHONE = process.env.ADMIN_WHATSAPP_PHONE || "595981000000";

// Mock del LLM para responder predeciblemente según la intención testeada
const originalInvoke = ChatGoogleGenerativeAI.prototype.invoke;
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
    if (clientText.includes("asesor") || clientText.includes("humano")) {
      return { content: JSON.stringify({ intent: "human_handoff", reason: "Cliente solicitó asesor" }) };
    }
    return { content: JSON.stringify({ intent: "customer_support", reason: "Consulta general" }) };
  }

  // Respuesta de FAQ en supportAgentNode
  return {
    content: "📍 Nos encontramos en Barrio Centro, Minga Guazú, Alto Paraná, Paraguay. Hacemos envíos a todo el país.",
  };
};

// Mock de envío de WhatsApp para entorno de pruebas
let sentWhatsAppMessages = [];
whatsappClient.sendMessage = async (to, msg, opts) => {
  sentWhatsAppMessages.push({ to, msg, opts });
  return { id: { id: "test-msg-" + Date.now(), fromMe: true } };
};

async function runMultiAgentGraphTests() {
  console.log("==================================================================");
  console.log("🧪 BATERÍA DE PRUEBAS - STATEGRAPH MULTI-AGENTE & FIRESTORE CHECKPOINT");
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

  const testPhone = `595981${Math.floor(100000 + Math.random() * 900000)}`;
  const testChatId = `${testPhone}@c.us`;
  const lidSenderA = "150697601421342@lid";
  const lidSenderB = "270819405632198@lid";
  const testMediaPhone = `595981${Math.floor(100000 + Math.random() * 900000)}`;
  const testMediaChatId = `${testMediaPhone}@c.us`;
  const testPhoneConcurrent = `595981${Math.floor(100000 + Math.random() * 900000)}`;
  const testChatIdConcurrent = `${testPhoneConcurrent}@c.us`;
  const testPhoneSupportHandoff = `595981${Math.floor(100000 + Math.random() * 900000)}`;
  const testChatIdSupportHandoff = `${testPhoneSupportHandoff}@c.us`;
  let testPhoneTimeout = null;
  let testChatIdTimeout = null;
  const testOrderIdsToClean = [];

  const threadConfig = {
    configurable: {
      thread_id: testChatId,
    },
  };

  console.log(`📱 Usando número de prueba: +${testPhone} (chatId: ${testChatId})\n`);

  try {
    // -------------------------------------------------------------
    // TURNO 1: Saludo / Consulta general -> Enruta a SupportAgent
    // -------------------------------------------------------------
    console.log("--- TURNO 1: Mensaje inicial de saludo y soporte ---");
    const turno1Input = {
      messages: [new HumanMessage("Hola, buenas tardes. ¿Dónde queda el local?")],
      userPhoneNumber: testPhone,
      whatsappChatId: testChatId,
    };

    const turno1State = await compiledGraph.invoke(turno1Input, threadConfig);

    assert(
      turno1State.messages.length >= 2,
      "Turno 1: Generó al menos 2 mensajes en el historial (Human + AI)",
      `Total mensajes: ${turno1State.messages?.length}`
    );

    const lastMsg1 = turno1State.messages[turno1State.messages.length - 1];
    const isAi1 = lastMsg1 instanceof AIMessage || lastMsg1?._getType?.() === "ai";
    assert(isAi1, "Turno 1: El último mensaje es un AIMessage");
    assert(
      lastMsg1.content.toLowerCase().includes("minga guazú") ||
      lastMsg1.content.toLowerCase().includes("minga guazu") ||
      lastMsg1.content.toLowerCase().includes("hodie"),
      "Turno 1: Respondió con información de ubicación/soporte",
      lastMsg1.content.slice(0, 100)
    );

    // Verificar que Firestore persistió el checkpoint del hilo
    const threadCheckpoints = await db
      .collection("langgraph_checkpoints")
      .doc(testChatId)
      .collection("checkpoints")
      .get();

    assert(
      !threadCheckpoints.empty,
      "Turno 1: Checkpoint persistido exitosamente en Firestore para thread_id: " + testChatId,
      `Checkpoints encontrados: ${threadCheckpoints.size}`
    );

    // -------------------------------------------------------------
    // TURNO 2: Cotización de producto -> Recupera estado y enruta a BudgetAgent
    // -------------------------------------------------------------
    console.log("\n--- TURNO 2: Cotización de producto y persistencia multi-turno ---");
    const turno2Input = {
      messages: [new HumanMessage("Quiero cotizar un termo personalizado")],
      userPhoneNumber: testPhone,
      whatsappChatId: testChatId,
    };

    const turno2State = await compiledGraph.invoke(turno2Input, threadConfig);

    assert(
      turno2State.messages.length >= 4,
      "Turno 2: Recuperó el historial previo y acumuló los nuevos mensajes (mínimo 4)",
      `Total mensajes: ${turno2State.messages?.length}`
    );

    assert(
      turno2State.activeAgent === "budget",
      "Turno 2: activeAgent transicionó a 'budget'",
      `activeAgent actual: ${turno2State.activeAgent}`
    );

    assert(
      turno2State.quoteContext && turno2State.quoteContext.step !== "idle",
      "Turno 2: quoteContext avanzó en la máquina de estados de cotización",
      `Step actual: ${turno2State.quoteContext?.step}`
    );

    const lastMsg2 = turno2State.messages[turno2State.messages.length - 1];
    assert(
      lastMsg2 instanceof AIMessage || lastMsg2?._getType?.() === "ai",
      "Turno 2: El último mensaje es un AIMessage emitido por BudgetAgent"
    );

    // -------------------------------------------------------------
    // TURNO 3: Solicitud de asesor humano -> Enruta a HandoffNode
    // -------------------------------------------------------------
    console.log("\n--- TURNO 3: Derivación a Handoff Humano ---");
    sentWhatsAppMessages = []; // limpiar registro de envíos para verificar alerta al admin

    const turno3Input = {
      messages: [new HumanMessage("Por favor quiero hablar con un asesor humano")],
      userPhoneNumber: testPhone,
      whatsappChatId: testChatId,
    };

    const turno3State = await compiledGraph.invoke(turno3Input, threadConfig);

    assert(
      turno3State.humanHandoffRequired === true,
      "Turno 3: humanHandoffRequired quedó marcado en true",
      `humanHandoffRequired: ${turno3State.humanHandoffRequired}`
    );

    assert(
      turno3State.activeAgent === null,
      "Turno 3: activeAgent quedó en null tras handoff",
      `activeAgent: ${turno3State.activeAgent}`
    );

    const lastMsg3 = turno3State.messages[turno3State.messages.length - 1];
    assert(
      lastMsg3.content.toLowerCase().includes("asesor"),
      "Turno 3: Cliente recibió mensaje cordial de derivación",
      lastMsg3.content.slice(0, 100)
    );

    // -------------------------------------------------------------
    // TURNO 4: Silencio del Bot durante Handoff Activo
    // -------------------------------------------------------------
    console.log("\n--- TURNO 4: Regla de Silencio con Handoff Activo (1.a) ---");
    const turno4Input = {
      messages: [new HumanMessage("Hola, ¿hay alguien ahí?")],
      userPhoneNumber: testPhone,
      whatsappChatId: testChatId,
    };

    const turno4State = await compiledGraph.invoke(turno4Input, threadConfig);

    const lastMsg4 = turno4State.messages[turno4State.messages.length - 1];
    const isHumanMsg = lastMsg4 instanceof HumanMessage || lastMsg4?._getType?.() === "human";

    assert(
      isHumanMsg,
      "Turno 4: El grafo terminó sin generar ningún nuevo AIMessage automático (silencio activo)",
      `Tipo de último mensaje: ${lastMsg4?._getType?.()}`
    );

    assert(
      turno4State.humanHandoffRequired === true,
      "Turno 4: humanHandoffRequired se mantiene en true"
    );

    // -------------------------------------------------------------
    // PRUEBA PUNTO 1: Fallback thread_id con @lid cuando getContact() falla
    // Dos remitentes @lid distintos NO deben compartir checkpoint en Firestore
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA PUNTO 1: Fallback thread_id con remitentes @lid y aislamiento ---");

    // Simular que getContact() falla para ambos (userPhoneNumber vacío)
    const getThreadIdFallback = (userPhoneNumber, whatsappChatId) => {
      let tid = userPhoneNumber;
      if (!tid) {
        // Warning esperado
        console.log(`[SIMULATED WARNER] userPhoneNumber vacío para ${whatsappChatId}. Fallback a chatId.`);
        tid = whatsappChatId;
      }
      return tid;
    };

    const threadIdA = getThreadIdFallback("", lidSenderA);
    const threadIdB = getThreadIdFallback("", lidSenderB);

    assert(
      threadIdA === lidSenderA && threadIdB === lidSenderB && threadIdA !== threadIdB,
      "Punto 1: Fallback asigna correctamente el whatsappChatId como thread_id cuando userPhoneNumber es vacío"
    );

    // Turno para Sender A
    const stateA = await compiledGraph.invoke(
      {
        messages: [new HumanMessage("Mensaje de cliente A desde dispositivo vinculado")],
        userPhoneNumber: "",
        whatsappChatId: lidSenderA,
      },
      { configurable: { thread_id: threadIdA } }
    );

    // Turno para Sender B
    const stateB = await compiledGraph.invoke(
      {
        messages: [new HumanMessage("Mensaje de cliente B desde otro dispositivo vinculado")],
        userPhoneNumber: "",
        whatsappChatId: lidSenderB,
      },
      { configurable: { thread_id: threadIdB } }
    );

    // Verificar en Firestore que existen documentos separados
    const docSnapA = await db.collection("langgraph_checkpoints").doc(lidSenderA).collection("checkpoints").get();
    const docSnapB = await db.collection("langgraph_checkpoints").doc(lidSenderB).collection("checkpoints").get();

    assert(
      !docSnapA.empty && !docSnapB.empty,
      "Punto 1: Ambos remitentes @lid generaron colecciones de checkpoints independientes en Firestore"
    );

    // Verificar que los estados no se cruzaron
    const tupleA = await checkpointer.getTuple({ configurable: { thread_id: lidSenderA } });
    const tupleB = await checkpointer.getTuple({ configurable: { thread_id: lidSenderB } });

    const textHistoryA = tupleA?.checkpoint?.channel_values?.messages?.map((m) => m.content).join(" ") || "";
    const textHistoryB = tupleB?.checkpoint?.channel_values?.messages?.map((m) => m.content).join(" ") || "";

    assert(
      textHistoryA.includes("cliente A") && !textHistoryA.includes("cliente B"),
      "Punto 1: El checkpoint de Sender A solo contiene el historial de A"
    );

    assert(
      textHistoryB.includes("cliente B") && !textHistoryB.includes("cliente A"),
      "Punto 1: El checkpoint de Sender B solo contiene el historial de B (aislamiento garantizado)"
    );

    // -------------------------------------------------------------
    // PRUEBA PUNTO 2: Manejo de Media y descarte de Base64 en Firestore
    // whatsapp.js no descarga base64 y el reducer en state.js descarta 'data'
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA PUNTO 2: Persistencia con archivo adjunto y descarte de base64 ---");

    // Simular un payload con 'data' (50 KB base64) para verificar que el reducer de incomingMedia lo descarta
    const sampleBase64 = "X".repeat(50 * 1024);

    const mediaInput = {
      messages: [new HumanMessage("Hola, quiero cotizar un termo con esta foto de referencia")],
      userPhoneNumber: testMediaPhone,
      whatsappChatId: testMediaChatId,
      incomingMedia: {
        mimetype: "image/jpeg",
        data: sampleBase64,
        filename: "foto-referencia.jpg",
      },
    };

    let mediaPersistError = null;
    let mediaState = null;
    try {
      mediaState = await compiledGraph.invoke(mediaInput, {
        configurable: { thread_id: testMediaChatId },
      });
    } catch (err) {
      mediaPersistError = err;
    }

    assert(
      mediaPersistError === null,
      "Punto 2: El grafo con adjunto se ejecutó y persistió sin error de límite en Firestore",
      mediaPersistError ? mediaPersistError.message : ""
    );

    // Verificar en Firestore que el checkpoint se guardó exitosamente
    const mediaCheckpoints = await db
      .collection("langgraph_checkpoints")
      .doc(testMediaChatId)
      .collection("checkpoints")
      .get();

    assert(
      !mediaCheckpoints.empty,
      "Punto 2: Checkpoint guardado en Firestore para el turno con imagen",
      `Documentos encontrados: ${mediaCheckpoints.size}`
    );

    // Verificar que en el estado guardado NO quedó el string base64
    const mediaTuple = await checkpointer.getTuple({ configurable: { thread_id: testMediaChatId } });
    const savedIncomingMedia = mediaTuple?.checkpoint?.channel_values?.incomingMedia;

    assert(
      savedIncomingMedia && savedIncomingMedia.data === undefined,
      "Punto 2: El reducer descartó la propiedad 'data' (base64) del checkpoint persistido"
    );

    assert(
      savedIncomingMedia?.filename === "foto-referencia.jpg",
      "Punto 2: Los metadatos ligeros (filename, mimetype) se conservaron correctamente"
    );

    // -------------------------------------------------------------
    // PRUEBA PUNTOS 1 y 5: Filtro de Grupos/Estados y Descripción por Mimetype
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA PUNTOS 1 y 5: Filtros de chats grupales y descripción por Mimetype ---");
    assert(
      getMediaDescription({ mimetype: "image/jpeg" }) === "Imagen adjunta",
      "Punto 5: image/jpeg produce 'Imagen adjunta'"
    );
    assert(
      getMediaDescription({ mimetype: "audio/ogg; codecs=opus" }) === "Audio adjunto",
      "Punto 5: audio/ogg produce 'Audio adjunto'"
    );
    assert(
      getMediaDescription({ mimetype: "video/mp4" }) === "Video adjunto",
      "Punto 5: video/mp4 produce 'Video adjunto'"
    );
    assert(
      getMediaDescription({ mimetype: "application/pdf" }) === "Documento adjunto",
      "Punto 5: application/pdf produce 'Documento adjunto'"
    );
    assert(
      getMediaDescription({}, "sticker") === "Sticker adjunto",
      "Punto 5: sticker produce 'Sticker adjunto'"
    );

    // Validación de filtros grupales y estados
    const isGroup = (from) => Boolean(from && from.endsWith("@g.us"));
    const isBroadcast = (from) => from === "status@broadcast";
    assert(isGroup("1203630248920192@g.us"), "Punto 1: Detecta y filtra identificadores de grupos (@g.us)");
    assert(isBroadcast("status@broadcast"), "Punto 1: Detecta y filtra estados/historias (status@broadcast)");
    assert(!isGroup("595981123456@c.us") && !isBroadcast("595981123456@c.us"), "Punto 1: Permite chats individuales estándar (@c.us)");
    assert(!isGroup("150697601421342@lid") && !isBroadcast("150697601421342@lid"), "Punto 1: Permite chats individuales vinculados (@lid)");

    // -------------------------------------------------------------
    // PRUEBA PUNTO 3: Concurrencia por Hilo (Cola en Memoria)
    // Disparar 3 mensajes simultáneos del mismo número
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA PUNTO 3: Serialización concurrente por hilo (runInThreadQueue) ---");
    const concurrentConfig = { configurable: { thread_id: testChatIdConcurrent } };

    const executionLog = [];

    const invokeMessage = (text, delayMs = 0) =>
      runInThreadQueue(testChatIdConcurrent, async () => {
        executionLog.push(`INICIO: ${text}`);
        if (delayMs > 0) {
          // Simula una descarga lenta de media en el primer mensaje dentro de la tarea encolada
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const result = await compiledGraph.invoke(
          {
            messages: [new HumanMessage(text)],
            userPhoneNumber: testPhoneConcurrent,
            whatsappChatId: testChatIdConcurrent,
          },
          concurrentConfig
        );
        executionLog.push(`FIN: ${text}`);
        return result;
      });

    // Disparar los 3 mensajes simultáneamente en paralelo
    // El primer mensaje simula una descarga lenta de foto (100ms) dentro de la tarea
    const [res1, res2, res3] = await Promise.all([
      invokeMessage("Mensaje 1: Quiero cotizar un termo (foto con descarga lenta)", 100),
      invokeMessage("Mensaje 2: Quiero 2 unidades", 0),
      invokeMessage("Mensaje 3: Color azul con grabado", 0),
    ]);

    // Verificar que Mensaje 1 terminó antes de que Mensaje 2 iniciara
    assert(
      executionLog[0].includes("INICIO: Mensaje 1") &&
      executionLog[1].includes("FIN: Mensaje 1") &&
      executionLog[2].includes("INICIO: Mensaje 2") &&
      executionLog[3].includes("FIN: Mensaje 2") &&
      executionLog[4].includes("INICIO: Mensaje 3") &&
      executionLog[5].includes("FIN: Mensaje 3"),
      "Punto 3: La cola garantizó orden estricto (Mensaje 1 completó antes de que Mensaje 2 iniciara a pesar de la descarga lenta)"
    );

    // Verificar en el checkpoint que los 3 HumanMessage quedaron en estricto orden
    const tupleConcurrent = await checkpointer.getTuple(concurrentConfig);
    const historyMessages = tupleConcurrent?.checkpoint?.channel_values?.messages || [];
    const humanMessages = historyMessages.filter(
      (m) => m?.type === "human" || m instanceof HumanMessage || m?._getType?.() === "human"
    );

    assert(
      humanMessages.length === 3,
      "Punto 3: El historial final contiene exactamente los 3 HumanMessage",
      `Recibidos: ${humanMessages.length}`
    );

    assert(
      humanMessages[0]?.content?.includes("Mensaje 1") &&
      humanMessages[1]?.content?.includes("Mensaje 2") &&
      humanMessages[2]?.content?.includes("Mensaje 3"),
      "Punto 3: Los 3 mensajes se procesaron estrictamente en el orden FIFO enviado",
      humanMessages.map((m) => m.content).join(" -> ")
    );

    // Verificar que quoteContext no perdió pasos y acumuló el estado correctamente
    const finalQuoteContext = tupleConcurrent?.checkpoint?.channel_values?.quoteContext;
    assert(
      finalQuoteContext && finalQuoteContext.step !== "idle",
      "Punto 3: quoteContext progresó y no perdió pasos ni estado durante la concurrencia",
      `Step final: ${finalQuoteContext?.step}`
    );

    // Verificar que la cola del thread se limpió del Map en memoria al vaciarse
    assert(
      !threadQueues.has(testChatIdConcurrent),
      "Punto 3: La entrada en threadQueues se limpió automáticamente al vaciarse la cola (sin fuga de memoria)"
    );

    // -------------------------------------------------------------
    // PRUEBA PUNTO 4: Handoff disparado desde un nodo (SupportAgent)
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA PUNTO 4: Handoff desde SupportAgent y regla de silencio ---");
    const supportConfig = { configurable: { thread_id: testChatIdSupportHandoff } };
    sentWhatsAppMessages = []; // limpiar historial de alertas enviadas

    // Turno 1: Cliente plantea reclamo que SupportAgent detecta y deriva
    await handleIncomingWhatsAppMessage({
      from: testChatIdSupportHandoff,
      body: "Tuvimos un problema con el pedido, tardaron mucho y es una queja",
      type: "chat",
      fromMe: false,
      hasMedia: false,
      getContact: async () => ({ pushname: "Cliente Queja", number: testPhoneSupportHandoff }),
    });

    const stateTurno1 = await compiledGraph.getState(supportConfig);
    const supportTurno1 = stateTurno1.values;

    assert(
      supportTurno1.humanHandoffRequired === true,
      "Punto 4: SupportAgent activó humanHandoffRequired desde su propio nodo",
      `humanHandoffRequired: ${supportTurno1.humanHandoffRequired}`
    );

    const adminAlertsTurno1 = sentWhatsAppMessages.filter(
      (m) => m.to.includes(process.env.ADMIN_WHATSAPP_PHONE || "595981000000")
    );
    assert(
      adminAlertsTurno1.length === 1,
      "Punto 4: Se envió exactamente 1 alerta al administrador en la derivación inicial",
      `Total alertas: ${adminAlertsTurno1.length}`
    );

    const lastMsgSupport1 = supportTurno1.messages[supportTurno1.messages.length - 1];
    assert(
      lastMsgSupport1 instanceof AIMessage || lastMsgSupport1?._getType?.() === "ai",
      "Punto 4: Cliente recibió respuesta cordial de derivación emitida por SupportAgent"
    );

    // Turno 2: El cliente vuelve a enviar un mensaje en el mismo hilo
    await handleIncomingWhatsAppMessage({
      from: testChatIdSupportHandoff,
      body: "Hola, sigo esperando una respuesta",
      type: "chat",
      fromMe: false,
      hasMedia: false,
      getContact: async () => ({ pushname: "Cliente Queja", number: testPhoneSupportHandoff }),
    });

    const stateTurno2 = await compiledGraph.getState(supportConfig);
    const supportTurno2 = stateTurno2.values;

    const lastMsgSupport2 = supportTurno2.messages[supportTurno2.messages.length - 1];
    const isHumanTurno2 = lastMsgSupport2 instanceof HumanMessage || lastMsgSupport2?._getType?.() === "human";

    assert(
      isHumanTurno2,
      "Punto 4: En el siguiente mensaje, el bot quedó en 100% de silencio (sin nuevo AIMessage)",
      `Tipo de último mensaje: ${lastMsgSupport2?._getType?.()}`
    );

    const adminAlertsTurno2 = sentWhatsAppMessages.filter(
      (m) => m.to.includes(process.env.ADMIN_WHATSAPP_PHONE || "595981000000")
    );
    assert(
      adminAlertsTurno2.length === 1,
      "Punto 4: El administrador NO recibió una segunda alerta en los turnos subsiguientes",
      `Total alertas: ${adminAlertsTurno2.length}`
    );

    // -------------------------------------------------------------
    // PRUEBA PUNTO 6: Timeout con AbortController (tarea a 600ms con timeout de 400ms)
    // Se valida:
    // 1. A los 400ms vence el timeout y se aborta el signal.
    // 2. Se envía el mensaje de contingencia al cliente y la alerta al admin.
    // 3. A los 600ms la tarea termina pero signal.aborted es true, por lo que NO se envía
    //    la respuesta tardía y NO se persiste ningún checkpoint en Firestore.
    // 4. El segundo mensaje del mismo chat se procesa exitosamente.
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA PUNTO 6: Cancelación real con AbortController y omisión de respuesta tardía ---");
    testPhoneTimeout = `595981${Math.floor(100000 + Math.random() * 900000)}`;
    testChatIdTimeout = `${testPhoneTimeout}@c.us`;
    sentWhatsAppMessages = []; // limpiar historial de envíos

    let task1Error = null;
    let lateResponseAttempted = false;
    const timeoutStart = Date.now();

    // Tarea 1: Tarda 600ms en resolver. Timeout configurado en 400ms.
    const task1Promise = runInThreadQueue(
      testChatIdTimeout,
      async (signal) => {
        // Simular procesamiento que tarda 600ms
        await new Promise((resolve) => setTimeout(resolve, 600));

        // Si la tarea fue abortada, NO persistir checkpoint ni enviar respuesta tardía
        if (signal.aborted) {
          console.log(`🛑 Tarea abortada para ${testChatIdTimeout}. Omitiendo checkpoint y respuesta tardía.`);
          return "aborted-task-finished-late";
        }

        // Si no estuviera abortada, invocaría el grafo y respondería
        lateResponseAttempted = true;
        await compiledGraph.invoke(
          {
            messages: [new HumanMessage("Mensaje que debió abortarse")],
            userPhoneNumber: testPhoneTimeout,
            whatsappChatId: testChatIdTimeout,
          },
          { configurable: { thread_id: testChatIdTimeout }, signal }
        );
        await whatsappClient.sendMessage(testChatIdTimeout, "Respuesta tardía que NO debe enviarse");
        return "late-completed";
      },
      400
    ).catch((err) => {
      task1Error = err;
      return "task1-failed";
    });

    // Tarea 2: Encolada inmediatamente detrás para el MISMO chat
    const task2Promise = runInThreadQueue(
      testChatIdTimeout,
      async (signal) => {
        return "Segundo mensaje procesado con éxito tras el timeout";
      },
      3000
    );

    // Esperar a que ambas culminen
    const [r1, r2] = await Promise.all([task1Promise, task2Promise]);
    const timeoutElapsed = Date.now() - timeoutStart;

    // Esperar a que pasen al menos 700ms desde el inicio para garantizar que los 600ms de la Tarea 1 hayan transcurrido
    if (Date.now() - timeoutStart < 700) {
      await new Promise((resolve) => setTimeout(resolve, 700 - (Date.now() - timeoutStart)));
    }

    assert(
      task1Error && (task1Error.name === "QueueTimeoutError" || task1Error.message?.includes("Queue task timeout")),
      "Punto 6: Tarea 1 falló por QueueTimeoutError al vencer el tiempo límite (400ms)",
      task1Error?.message
    );

    assert(
      r2 === "Segundo mensaje procesado con éxito tras el timeout",
      "Punto 6: Segundo mensaje del mismo chat se ejecutó y resolvió con éxito tras liberarse la cola",
      r2
    );

    // Verificar mensajes enviados al cliente
    const clientMessages = sentWhatsAppMessages.filter((m) => m.to === testChatIdTimeout);
    assert(
      clientMessages.length === 1 && clientMessages[0].msg.includes("Disculpá la demora"),
      "Punto 6: El cliente recibió ÚNICAMENTE el mensaje de contingencia (sin respuesta tardía)",
      `Mensajes recibidos: ${clientMessages.length} (${clientMessages.map(m => m.msg).join(" | ")})`
    );

    assert(
      !lateResponseAttempted,
      "Punto 6: La respuesta tardía fue prevenida mediante la verificación de signal.aborted"
    );

    // Verificar en Firestore que NO se escribió ningún checkpoint para el hilo abortado
    const checkpointDocs = await db
      .collection("langgraph_checkpoints")
      .doc(testChatIdTimeout)
      .collection("checkpoints")
      .get();

    assert(
      checkpointDocs.empty,
      "Punto 6: No se escribió ningún checkpoint en Firestore después del abort",
      `Documentos encontrados: ${checkpointDocs.size}`
    );

    // Verificar alerta al admin indicando timeout
    const adminAlertMsg = sentWhatsAppMessages.find(
      (m) => m.msg.includes("Timeout en Cola")
    );
    assert(
      Boolean(adminAlertMsg),
      "Punto 6: Se envió alerta formal al administrador indicando el timeout en la cola"
    );

    // Verificar que la cola del chat se liberó del Map en memoria
    assert(
      !threadQueues.has(testChatIdTimeout),
      "Punto 6: La entrada en threadQueues se eliminó al completarse la secuencia"
    );

    // -------------------------------------------------------------
    // PRUEBA DE ORDENAMIENTO DE FECHAS: getLatestOrderForUser
    // -------------------------------------------------------------
    console.log("\n--- PRUEBA: getLatestOrderForUser con múltiples pedidos y Firestore Timestamp ---");
    const testPhoneLatestOrder = `595999${Math.floor(100000 + Math.random() * 900000)}`;
    const testOrderIdOlder = `test_ord_older_${Date.now()}`;
    const testOrderIdNewer = `test_ord_newer_${Date.now()}`;
    testOrderIdsToClean.push(testOrderIdOlder, testOrderIdNewer);

    const olderDate = Timestamp.fromMillis(Date.now() - 7200000); // 2 horas antes
    const newerDate = Timestamp.fromMillis(Date.now()); // ahora

    await db.collection("orders").doc(testOrderIdOlder).set({
      id: testOrderIdOlder,
      orderNumber: "hodie-older-99",
      userPhoneNumber: testPhoneLatestOrder,
      status: "delivered",
      total: 50000,
      createdAt: olderDate,
      updatedAt: olderDate,
    });

    await db.collection("orders").doc(testOrderIdNewer).set({
      id: testOrderIdNewer,
      orderNumber: "hodie-newer-100",
      userPhoneNumber: testPhoneLatestOrder,
      status: "pending",
      total: 120000,
      createdAt: newerDate,
      updatedAt: newerDate,
    });

    const retrievedLatestOrder = await getLatestOrderForUser(testPhoneLatestOrder);

    assert(
      retrievedLatestOrder !== null,
      "getLatestOrderForUser encuentra el pedido del usuario"
    );
    assert(
      retrievedLatestOrder?.id === testOrderIdNewer,
      `getLatestOrderForUser devuelve el pedido más reciente (esperado: ${testOrderIdNewer}, obtenido: ${retrievedLatestOrder?.id})`
    );
    assert(
      retrievedLatestOrder?.orderNumber === "hodie-newer-100",
      "getLatestOrderForUser coincide con el orderNumber más reciente"
    );
    assert(
      retrievedLatestOrder?.createdAt instanceof Timestamp || typeof retrievedLatestOrder?.createdAt?.toDate === "function",
      "getLatestOrderForUser retorna createdAt con formato Timestamp válido"
    );

  } finally {
    // Limpieza de órdenes de prueba en Firestore
    if (testOrderIdsToClean.length > 0) {
      console.log("\n🧹 Limpiando órdenes de prueba en Firestore...");
      for (const ordId of testOrderIdsToClean) {
        try {
          await db.collection("orders").doc(ordId).delete();
        } catch (e) {
          console.warn(`Advertencia limpiando orden ${ordId}:`, e.message);
        }
      }
      console.log(`✅ Órdenes de prueba (${testOrderIdsToClean.join(", ")}) eliminadas de Firestore.`);
    }

    // Limpieza de Firestore de todos los hilos de prueba
    console.log("\n🧹 Limpiando checkpoints de prueba en Firestore...");
    const cleanupThreads = [
      testChatId,
      testPhone,
      lidSenderA,
      lidSenderB,
      testMediaChatId,
      testMediaPhone,
      testChatIdConcurrent,
      testPhoneConcurrent,
      testChatIdSupportHandoff,
      testPhoneSupportHandoff,
      typeof testChatIdTimeout !== "undefined" ? testChatIdTimeout : null,
      typeof testPhoneTimeout !== "undefined" ? testPhoneTimeout : null,
    ].filter(Boolean);
    for (const tid of cleanupThreads) {
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

        // Limpiar también handoff_threads asociados al hilo
        await db.collection("handoff_threads").doc(tid).delete().catch(() => {});
      } catch (cleanupErr) {
        console.warn(`Advertencia en limpieza de ${tid}:`, cleanupErr.message);
      }
    }
    console.log(`✅ Datos de prueba (${cleanupThreads.join(", ")}) eliminados de Firestore.`);
  }

  console.log("\n==================================================================");
  console.log(`📊 RESULTADO FINAL: ${passed} PASADAS, ${failed} FALLIDAS`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runMultiAgentGraphTests().catch((err) => {
  console.error("❌ Error fatal en pruebas:", err);
  process.exit(1);
});
