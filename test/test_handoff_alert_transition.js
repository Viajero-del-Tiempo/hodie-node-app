if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1 (ej: npm run test:unit).");
  process.exit(1);
}

import http from "http";
import jwt from "jsonwebtoken";
import { Timestamp } from "firebase-admin/firestore";
import { HumanMessage } from "@langchain/core/messages";
import { compiledGraph } from "../src/agents/graph.js";
import { db } from "../src/config/firebase.js";
import { whatsappClient, handleIncomingWhatsAppMessage } from "../src/config/whatsapp.js";
import app from "../src/app.js";

const JWT_SECRET = process.env.JWT_SECRET || "hodie-secret-jwt-key-2024";

// Interceptar y contar alertas al admin
let adminAlertsSent = [];
const originalSendMessage = whatsappClient.sendMessage;
whatsappClient.sendMessage = async (to, msg, opts) => {
  if (to.includes(process.env.ADMIN_WHATSAPP_PHONE || "595983957102")) {
    adminAlertsSent.push({ to, msg, timestamp: Date.now() });
    console.log(`📢 [TEST MOCK] Alerta de WhatsApp enviada al admin (${to}):\n${msg.slice(0, 80)}...\n`);
  }
  return { id: { id: "test-msg-" + Date.now(), fromMe: true } };
};

function assert(condition, testName, details = "") {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    if (details) console.error(`   Detalles: ${details}`);
    throw new Error(`Fallo en prueba: ${testName} - ${details}`);
  }
}

async function runHandoffAlertTransitionTest() {
  console.log("==================================================================");
  console.log("🧪 TEST DE TRANSICIÓN Y GARANTÍA DE ALERTA DE HANDOFF (REQUISITO 9)");
  console.log("==================================================================\n");

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const timestamp = Date.now();
  const testPhone = `595981${Math.floor(100000 + Math.random() * 900000)}`;
  const testThreadId = `${testPhone}@c.us`;

  // Crear token de admin
  const tokenAdmin = jwt.sign(
    { phone: "595983957102", role: "admin", uid: `admin-${timestamp}` },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  // Crear usuario admin en Firestore para autenticación de resumeBot
  await db.collection("users").doc(`admin-${timestamp}`).set({
    uid: `admin-${timestamp}`,
    phoneNumber: "595983957102",
    displayName: "Admin Test",
    role: "admin",
  });

  try {
    adminAlertsSent = [];

    // PASO 1: Cliente deriva por primera vez (no derivado -> derivado)
    console.log("--- PASO 1: Primer mensaje solicitando persona (no derivado -> derivado) ---");
    await handleIncomingWhatsAppMessage({
      from: testThreadId,
      body: "Hola, quiero hablar con una persona por favor",
      type: "chat",
      fromMe: false,
      hasMedia: false,
      getContact: async () => ({ pushname: "Admin Test" }),
    });

    const state1 = await compiledGraph.getState({ configurable: { thread_id: testThreadId } });
    assert(state1.values?.humanHandoffRequired === true, "El hilo se encuentra en handoff activo tras el primer mensaje");
    assert(adminAlertsSent.length === 1, "Se envió exactamente 1 alerta al admin en la primera derivación", `Alertas enviadas: ${adminAlertsSent.length}`);

    // PASO 2: Cliente envía otro mensaje durante el handoff (silencio, no debe duplicar alerta)
    console.log("\n--- PASO 2: Mensaje adicional durante handoff activo (debe mantener silencio) ---");
    await handleIncomingWhatsAppMessage({
      from: testThreadId,
      body: "¿Hay alguien ahí?",
      type: "chat",
      fromMe: false,
      hasMedia: false,
      getContact: async () => ({ pushname: "Admin Test" }),
    });

    const state2 = await compiledGraph.getState({ configurable: { thread_id: testThreadId } });
    assert(state2.values?.intent === "handoff_active_silence", "El bot mantiene silencio durante handoff activo");
    assert(adminAlertsSent.length === 1, "NO se duplicó la alerta en mensajes posteriores durante el mismo handoff", `Alertas enviadas: ${adminAlertsSent.length}`);

    // PASO 3: Admin reactiva el bot mediante endpoint HTTP
    console.log("\n--- PASO 3: Admin reactiva el bot mediante POST /admin/chats/:threadId/resume-bot ---");
    const response = await fetch(`http://localhost:${port}/admin/chats/${encodeURIComponent(testThreadId)}/resume-bot`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenAdmin}`,
        "Content-Type": "application/json",
      },
    });

    assert(response.status === 200, "El endpoint resume-bot respondió 200 OK");
    const stateAfterResume = await compiledGraph.getState({ configurable: { thread_id: testThreadId } });
    assert(stateAfterResume.values?.humanHandoffRequired === false, "El bot está reactivado (humanHandoffRequired = false)");
    assert(stateAfterResume.values?.consecutiveMisunderstandings === 0, "El contador de fallos se reinició a 0");
    assert(Boolean(stateAfterResume.values?.resumedAt), "Se registró marca temporal resumedAt");

    // PASO 4: Cliente escribe y vuelve a derivar (no derivado -> derivado)
    console.log("\n--- PASO 4: Cliente escribe tras reactivación y vuelve a solicitar derivación ---");
    await handleIncomingWhatsAppMessage({
      from: testThreadId,
      body: "Buenas noches, pasame con un asesor",
      type: "chat",
      fromMe: false,
      hasMedia: false,
      getContact: async () => ({ pushname: "Admin Test" }),
    });

    const state3 = await compiledGraph.getState({ configurable: { thread_id: testThreadId } });
    assert(state3.values?.humanHandoffRequired === true, "El hilo volvió a quedar en handoff tras la segunda solicitud");
    assert(adminAlertsSent.length === 2, "Se enviaron exactamente DOS alertas en total (una por cada derivación)", `Total alertas enviadas: ${adminAlertsSent.length}`);

    console.log("\n==================================================================");
    console.log("🎉 TEST DE ALERTA DE HANDOFF EXITOSO: derivar -> reactivar -> derivar generó exactamente 2 alertas!");
    console.log("==================================================================");
  } finally {
    // Restaurar mock
    whatsappClient.sendMessage = originalSendMessage;
    server.close();
    // Limpieza
    try {
      await db.collection("handoff_threads").doc(testThreadId).delete();
      await db.collection("users").doc(`admin-${timestamp}`).delete();
    } catch {}
  }
}

runHandoffAlertTransitionTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test falló:", err);
    process.exit(1);
  });
