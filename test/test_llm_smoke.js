if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con el entorno de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1 (ej: npm run test:llm).");
  process.exit(1);
}

import dotenv from "dotenv";
dotenv.config();

import { HumanMessage } from "@langchain/core/messages";
import { routerNode } from "../src/agents/nodes/router.node.js";
import { supportAgentNode } from "../src/agents/nodes/support.node.js";

const SHIPPING_FALLBACK_TEXT =
  "🚚 *Envíos en HoDie:*\n\n" +
  "• *Minga Guazú:* Envío local gratuito (0 Gs.).\n" +
  "• *Resto del país:* Envío por transportadora con flete a abonar contra entrega al recibir.\n" +
  "• *Despacho:* Si tu pago ingresa antes del mediodía, se despacha en el día; si ingresa después, al día hábil siguiente.\n" +
  "• *Tiempo estimado transportadora:* 24 a 48 hs hábiles.";

const GENERIC_FALLBACK_TEXT =
  "¡Hola! No estoy seguro de tener la respuesta exacta a tu consulta. 🤔\n\n" +
  "• Si querés que te atienda una persona de nuestro equipo, escribí *'Asesor'* o *'Humano'* y te transfiero enseguida.\n" +
  "• Si deseás cotizar un regalo personalizado, contame qué producto te interesa (tazas, termos, etc.). 😊";

async function runLlmSmokeTest() {
  console.log("==================================================================");
  console.log("🧪 SMOKE TEST - LLM REAL CON MODELO CONFIGURADO Y CREDENCIALES");
  console.log("==================================================================");

  const modelUsed = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    console.error("❌ ERROR: No se encontró GEMINI_API_KEY ni GOOGLE_API_KEY en el entorno.");
    process.exit(1);
  }

  console.log(`🤖 Modelo en uso: ${modelUsed}`);
  console.log(`🔑 API Key configurada: ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}\n`);

  let failures = 0;

  // -------------------------------------------------------------
  // TEST 1: Router con "Me gustaría saber si trabajan con empresas"
  // -------------------------------------------------------------
  console.log("--- TEST 1: Invocación de RouterNode con 'Me gustaría saber si trabajan con empresas' ---");
  const routerState = {
    messages: [new HumanMessage("Me gustaría saber si trabajan con empresas")],
    userPhoneNumber: "595981000000",
    whatsappChatId: "595981000000@c.us",
  };

  const startRouter = Date.now();
  let routerResult;
  try {
    routerResult = await routerNode(routerState);
  } catch (err) {
    routerResult = { error: err.message };
  }
  const routerElapsedMs = Date.now() - startRouter;

  console.log(`⏱️  Tiempo de respuesta Router: ${routerElapsedMs} ms`);
  console.log(`📦 Resultado Router: intent='${routerResult?.intent}', reason='${routerResult?.humanHandoffReason || "N/A"}'`);

  const routerReason = routerResult?.humanHandoffReason || "";
  const isRouterFallback =
    routerResult?.intent === "human_handoff" &&
    (routerReason.includes("Fallback por fallo de clasificación") || routerReason.includes("404") || routerReason.includes("Error"));

  if (isRouterFallback) {
    console.error(`❌ [FAIL] RouterNode cayó en fallback de error: "${routerReason}"`);
    failures++;
  } else if (!routerResult?.intent) {
    console.error("❌ [FAIL] RouterNode no devolvió ningún intent.");
    failures++;
  } else {
    console.log(`✅ [PASS] RouterNode clasificó exitosamente con LLM real (${modelUsed}). Intent: '${routerResult.intent}'`);
  }

  console.log("");

  // -------------------------------------------------------------
  // TEST 2: SupportAgent con "Hacen envíos?"
  // -------------------------------------------------------------
  console.log("--- TEST 2: Invocación de SupportAgent con 'Hacen envíos?' ---");
  const supportState = {
    messages: [new HumanMessage("Hacen envíos?")],
    userPhoneNumber: "595981000000",
    whatsappChatId: "595981000000@c.us",
    intent: "customer_support",
  };

  const startSupport = Date.now();
  let supportResult;
  try {
    supportResult = await supportAgentNode(supportState);
  } catch (err) {
    supportResult = { error: err.message };
  }
  const supportElapsedMs = Date.now() - startSupport;

  console.log(`⏱️  Tiempo de respuesta SupportAgent: ${supportElapsedMs} ms`);

  const lastMsg = supportResult?.messages?.[supportResult?.messages?.length - 1];
  const responseContent = typeof lastMsg?.content === "string" ? lastMsg.content : "";

  console.log(`💬 Respuesta obtenida:\n"${responseContent.slice(0, 200)}..."\n`);

  const isExactShippingFallback = responseContent.trim() === SHIPPING_FALLBACK_TEXT.trim();
  const isExactGenericFallback = responseContent.trim() === GENERIC_FALLBACK_TEXT.trim();

  if (isExactShippingFallback) {
    console.error("❌ [FAIL] SupportAgent devolvió exactamente el texto de respaldo fijo de envíos.");
    failures++;
  } else if (isExactGenericFallback) {
    console.error("❌ [FAIL] SupportAgent devolvió exactamente el texto de respaldo fijo genérico.");
    failures++;
  } else if (!responseContent || responseContent.length < 10) {
    console.error("❌ [FAIL] SupportAgent no generó una respuesta válida.");
    failures++;
  } else {
    console.log(`✅ [PASS] SupportAgent generó respuesta dinámica con LLM real (${modelUsed}).`);
  }

  console.log("\n==================================================================");
  if (failures === 0) {
    console.log(`🎉 SMOKE TEST EXITOSO: Todas las llamadas al LLM (${modelUsed}) respondieron correctamente.`);
    console.log("==================================================================");
    process.exit(0);
  } else {
    console.error(`💥 SMOKE TEST FALLIDO: ${failures} prueba(s) fallaron.`);
    console.log("==================================================================");
    process.exit(1);
  }
}

runLlmSmokeTest().catch((err) => {
  console.error("❌ Error inesperado en test_llm_smoke:", err);
  process.exit(1);
});
