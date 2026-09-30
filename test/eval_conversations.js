if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1.");
  process.exit(1);
}

import dotenv from "dotenv";
dotenv.config();

import { compiledGraph } from "../src/agents/graph.js";
import { HumanMessage } from "@langchain/core/messages";

/**
 * Suite de Evaluación con Casos Reales y Variantes
 * Ejecuta los casos contra el grafo multi-agente con LLM real (gemini-3.8-flash)
 */

const TEST_CASES = [
  // 1. Casos Reales del Log de Producción
  {
    id: 1,
    name: "Caso real: Enlace de Facebook",
    input: "https://www.facebook.com/share/r/1Dog4s9jpT/?mibextid=wwXIfr",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "No debe derivar; debe indicar que no puede abrir enlaces y preguntar qué producto le interesó.",
  },
  {
    id: 2,
    name: "Caso real: 'Buenas noches' tras enlace",
    input: "Buenas noches",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Saludo normal, no debe derivar.",
  },
  {
    id: 3,
    name: "Caso real: 'Quiero 3 billeteras'",
    input: "Quiero 3 billeteras",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Mención de producto y cantidad debe ir directo a cotización.",
  },
  {
    id: 4,
    name: "Caso real: 'Buenas noches' tras cotizar billeteras",
    input: "Buenas noches",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Saludo no debe derivar.",
  },
  {
    id: 5,
    name: "Caso real: '¿Tienen billeteras?'",
    input: "¿Tienen billeteras?",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Consulta de producto del catálogo debe ir a budget o responder afirmativo sin derivar.",
  },

  // 2. Flujo de Cotización (Prueba Analia y variantes)
  {
    id: 6,
    name: "Cotización: 'Hola! Quiero un vaso térmico'",
    input: "Hola! Quiero un vaso térmico",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Intención de compra con saludo debe ir a budget.",
  },
  {
    id: 7,
    name: "Cotización: 'Quiero el vaso'",
    input: "Quiero el vaso",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Selección de producto debe ir a budget.",
  },
  {
    id: 8,
    name: "Cotización: 'Quiero 3 vasos'",
    input: "Quiero 3 vasos",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Cantidad + producto debe ir a budget.",
  },
  {
    id: 9,
    name: "Cotización: 'Precio de las tazas'",
    input: "Precio de las tazas",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Consulta de precio debe ir a budget.",
  },
  {
    id: 10,
    name: "Cotización: 'Quiero ver el catálogo de regalos'",
    input: "Quiero ver el catálogo de regalos",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Solicitud de catálogo debe ir a budget.",
  },

  // 3. Saludos Puros y Combinados
  {
    id: 11,
    name: "Saludo puro: 'Hola buenas tardes'",
    input: "Hola buenas tardes",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Saludo general atendido por soporte/asistente sin derivar.",
  },
  {
    id: 12,
    name: "Saludo combinado con producto: 'Buenas tardes, tienen termos?'",
    input: "Buenas tardes, tienen termos?",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Mención de producto prevalece sobre saludo -> budget.",
  },

  // 4. Soporte / FAQ Oficial
  {
    id: 13,
    name: "FAQ: '¿Hacen envíos a Itauguá?'",
    input: "¿Hacen envíos a Itauguá?",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Pregunta sobre envíos al interior debe ser respondida con política de transportadora sin derivar.",
  },
  {
    id: 14,
    name: "FAQ: '¿Dónde queda su tienda física?'",
    input: "¿Dónde queda su tienda física?",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Ubicación en Minga Guazú debe responderse sin derivar.",
  },
  {
    id: 15,
    name: "FAQ: '¿Cuáles son las formas de pago?'",
    input: "¿Cuáles son las formas de pago?",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Transferencia bancaria/depósito debe responderse sin derivar.",
  },

  // 5. Enlaces y Multimedia Externa
  {
    id: 16,
    name: "Multimedia: Enlace de Instagram Reel",
    input: "Me gustó este regalo https://www.instagram.com/reel/C3abcde1234/",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "No derivar ante enlace de Instagram; indicar que no se abren links y pedir el nombre.",
  },
  {
    id: 17,
    name: "Multimedia: Enlace de TikTok",
    input: "Tienen esto? https://vm.tiktok.com/ZM8x9yZ1/",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "No derivar ante enlace de TikTok.",
  },

  // 6. Comprobante de Pago
  {
    id: 18,
    name: "Comprobante: 'Ya transferí, envío el comprobante'",
    input: "Ya transferí, envío el comprobante de mi compra",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Recepción de comprobante avisa al admin pero no deriva al cliente a handoff activo.",
  },

  // 7. Solicitud Explícita de Humano
  {
    id: 19,
    name: "Handoff explícito: 'Quiero hablar con una persona'",
    input: "Quiero hablar con una persona",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Solicitud explícita de persona debe derivar inmediatamente.",
  },
  {
    id: 20,
    name: "Handoff explícito: 'Pasame con atención al cliente'",
    input: "Pasame con atención al cliente",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Solicitud de asesor humano debe derivar inmediatamente.",
  },

  // 8. Reclamos y Problemas
  {
    id: 21,
    name: "Reclamo: 'Mi producto vino roto y defectuoso'",
    input: "Mi producto vino roto y defectuoso",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Reclamo por producto dañado debe derivar inmediatamente.",
  },
  {
    id: 22,
    name: "Reclamo: 'No me llegó el paquete y tardaron mucho'",
    input: "No me llegó el paquete y tardaron mucho",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Queja por retraso/no entrega debe derivar a humano.",
  },

  // 9. Pedido Corporativo (> 100 unidades)
  {
    id: 23,
    name: "Corporativo: 'Quiero cotizar 150 termos para una empresa'",
    input: "Quiero cotizar 150 termos para una empresa",
    expectedAgent: "budget",
    expectedHandoff: true,
    description: "Presupuesto > 100 unidades debe canalizarse por budget y derivar por pedido corporativo.",
  },

  // 10. Escalada de 4 Fallos (Consultas sin sentido o fuera de rubro)
  // Se ejecutan en un mismo hilo para verificar la secuencia multi-turno
  {
    id: 24,
    name: "Escalada Fallo 1: '¿Reparan pantallas de celular?'",
    input: "¿Reparan pantallas de celular?",
    threadGroup: "escalation_seq",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Fallo 1: Reformular y aclarar que somos tienda de regalos.",
  },
  {
    id: 25,
    name: "Escalada Fallo 2: '¿Y cambian baterías de iPhone?'",
    input: "¿Y cambian baterías de iPhone?",
    threadGroup: "escalation_seq",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Fallo 2: Ofrecer opciones numeradas (1. Catálogo, 2. Cotizar, 3. Estado de pedido) y mencionar asesor.",
  },
  {
    id: 26,
    name: "Escalada Fallo 3: '¿Cuánto cobran la pizza con delivery?'",
    input: "¿Cuánto cobran la pizza con delivery?",
    threadGroup: "escalation_seq",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Fallo 3: Repetir opciones y ofrecer directamente asesor.",
  },
  {
    id: 27,
    name: "Escalada Fallo 4: 'Quiero empanadas de carne'",
    input: "Quiero empanadas de carne",
    threadGroup: "escalation_seq",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Fallo 4: Derivar a asesor humano.",
  },

  // 11. Recuperación y aceptación temprana en escalada
  {
    id: 28,
    name: "Escalada: Acepta asesor en Fallo 2",
    sequence: [
      { input: "¿Venden repuestos de autos?" }, // Fallo 1
      { input: "¿Tienen cubiertas?" }, // Fallo 2
      { input: "Sí, pasame con un asesor por favor" }, // Acepta asesor
    ],
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Al aceptar asesor durante la escalada, deriva de inmediato sin esperar al fallo 4.",
  },
  {
    id: 29,
    name: "Escalada: Recuperación en Fallo 2 con producto",
    sequence: [
      { input: "¿Venden motos?" }, // Fallo 1
      { input: "¿Alquilan departamentos?" }, // Fallo 2
      { input: "Disculpá, me equivoqué. Quiero un termo negro personalizado" }, // Entendió
    ],
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Si el cliente reconduce la consulta hacia un producto, el contador se reinicia y va a budget.",
  },
];

async function runEvaluation() {
  console.log("==================================================================");
  console.log("🚀 INICIANDO SUITE DE EVALUACIÓN CON LLM REAL (29 CASOS)");
  console.log(`🤖 Modelo: ${process.env.GEMINI_MODEL || "gemini-3.8-flash"}`);
  console.log("==================================================================\n");

  const results = [];
  const sessionGroupThreads = {};

  for (const testCase of TEST_CASES) {
    const threadId = testCase.threadGroup
      ? (sessionGroupThreads[testCase.threadGroup] ??= `eval_grp_${Date.now()}_${Math.random().toString(36).substring(7)}`)
      : `eval_case_${testCase.id}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    process.stdout.write(`⏳ Ejecutando Caso ${testCase.id}: "${testCase.name}"... `);

    try {
      let finalState = null;

      if (testCase.sequence) {
        for (const step of testCase.sequence) {
          const inputState = {
            messages: [new HumanMessage(step.input)],
            whatsappChatId: threadId,
            userPhoneNumber: "595981000000",
          };
          finalState = await compiledGraph.invoke(inputState, {
            configurable: { thread_id: threadId },
          });
        }
      } else {
        const inputState = {
          messages: [new HumanMessage(testCase.input)],
          whatsappChatId: threadId,
          userPhoneNumber: "595981000000",
        };
        finalState = await compiledGraph.invoke(inputState, {
          configurable: { thread_id: threadId },
        });
      }

      // Determinar agente real que respondió
      const actualHandoff = Boolean(finalState.humanHandoffRequired);
      let actualAgent = "support";

      if (actualHandoff && (finalState.intent === "human_handoff" || !finalState.activeAgent)) {
        actualAgent = "handoff";
      } else if (finalState.activeAgent === "budget" || finalState.intent === "budget_quote") {
        actualAgent = "budget";
      } else if (finalState.intent === "customer_support" || finalState.intent === "order_status" || finalState.intent === "payment_proof") {
        actualAgent = "support";
      } else if (actualHandoff) {
        actualAgent = "handoff";
      }

      // En el caso 23 (pedido corporativo), si se canalizó por budget y derivó, actualAgent puede ser budget o handoff
      let agentMatched = actualAgent === testCase.expectedAgent;
      if (testCase.id === 23 && (actualAgent === "budget" || actualAgent === "handoff") && actualHandoff) {
        agentMatched = true;
      }

      const handoffMatched = actualHandoff === testCase.expectedHandoff;
      const passed = agentMatched && handoffMatched;

      const lastAiMessage = finalState.messages?.[finalState.messages.length - 1]?.content || "";
      const snippet = typeof lastAiMessage === "string" ? lastAiMessage.replace(/\n+/g, " ").slice(0, 70) : "";

      results.push({
        id: testCase.id,
        name: testCase.name,
        input: testCase.input || testCase.sequence?.[testCase.sequence.length - 1]?.input,
        expectedAgent: testCase.expectedAgent,
        actualAgent,
        expectedHandoff: testCase.expectedHandoff,
        actualHandoff,
        agentMatched,
        handoffMatched,
        passed,
        reason: finalState.humanHandoffReason || "",
        responseSnippet: snippet,
      });

      console.log(passed ? "✅ OK" : `❌ FALLÓ (Esperaba: ${testCase.expectedAgent}, Derivar=${testCase.expectedHandoff} | Obtuvo: ${actualAgent}, Derivar=${actualHandoff})`);
    } catch (err) {
      console.log(`💥 ERROR: ${err.message}`);
      results.push({
        id: testCase.id,
        name: testCase.name,
        input: testCase.input,
        expectedAgent: testCase.expectedAgent,
        actualAgent: "error",
        expectedHandoff: testCase.expectedHandoff,
        actualHandoff: true,
        agentMatched: false,
        handoffMatched: false,
        passed: false,
        reason: err.message,
        responseSnippet: "",
      });
    }
  }

  // Métricas
  const total = results.length;
  const agentCorrect = results.filter((r) => r.agentMatched).length;
  const handoffCorrect = results.filter((r) => r.handoffMatched).length;
  const totalPassed = results.filter((r) => r.passed).length;
  const totalDerivations = results.filter((r) => r.actualHandoff).length;

  console.log("\n==================================================================");
  console.log("📊 RESULTADOS DE LA EVALUACIÓN");
  console.log("==================================================================");
  console.log(`Total de Casos Evaluados: ${total}`);
  console.log(`Exactitud de Ruteo: ${agentCorrect}/${total} (${((agentCorrect / total) * 100).toFixed(1)}%)`);
  console.log(`Tasa de Derivación a Humano: ${totalDerivations}/${total} (${((totalDerivations / total) * 100).toFixed(1)}%) (Esperada: 6/29 = 20.7%)`);
  console.log(`Casos Aprobados al 100%: ${totalPassed}/${total} (${((totalPassed / total) * 100).toFixed(1)}%)`);
  console.log("==================================================================\n");

  console.log("### Tabla de Casos de Prueba\n");
  console.log("| # | Caso | Entrada | Agente Esp. | Agente Real | Derivar Esp. | Derivar Real | Estado | Respuesta / Motivo |");
  console.log("|---|------|---------|-------------|-------------|--------------|--------------|:------:|--------------------|");

  for (const r of results) {
    const statusIcon = r.passed ? "✅ PASS" : "❌ FAIL";
    const cleanInput = (r.input || "").replace(/\|/g, "\\|");
    const cleanSnippet = (r.responseSnippet || r.reason || "").replace(/\|/g, "\\|").slice(0, 45);
    console.log(
      `| ${r.id} | ${r.name} | "${cleanInput.slice(0, 30)}" | ${r.expectedAgent} | ${r.actualAgent} | ${r.expectedHandoff ? "Sí" : "No"} | ${r.actualHandoff ? "Sí" : "No"} | ${statusIcon} | ${cleanSnippet}... |`
    );
  }

  const failedCases = results.filter((r) => !r.passed);
  if (failedCases.length > 0) {
    console.log("\n### Casos que Fallaron:");
    for (const f of failedCases) {
      console.log(`- **Caso ${f.id} (${f.name})**: Entrada "${f.input}". Esperaba Agente=${f.expectedAgent}, Derivar=${f.expectedHandoff}. Obtuvo Agente=${f.actualAgent}, Derivar=${f.actualHandoff}. Motivo: ${f.reason || "Respuesta: " + f.responseSnippet}`);
    }
  } else {
    console.log("\n🎉 ¡Todos los casos pasaron exitosamente!");
  }

  return { total, agentCorrect, handoffCorrect, totalPassed, totalDerivations, results };
}

runEvaluation()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal evaluation error:", err);
    process.exit(1);
  });
