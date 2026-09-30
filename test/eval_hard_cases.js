if (process.env.ALLOW_PROD_FIRESTORE_TESTS !== "1") {
  console.error("❌ ERROR: Este test interactúa con Firestore de producción. Debe ejecutarse con ALLOW_PROD_FIRESTORE_TESTS=1.");
  process.exit(1);
}

import dotenv from "dotenv";
dotenv.config();

import { compiledGraph } from "../src/agents/graph.js";
import { HumanMessage } from "@langchain/core/messages";

/**
 * Suite de Evaluación: 15 Casos Difíciles y Negativos
 * Evalúa desambiguación de asesor, precedencia de reclamos sobre productos,
 * fidelidad de catálogo dinámico (materiales y colores), cortesía y menú de escalada.
 */

const HARD_TEST_CASES = [
  // 1. Negativo de "asesor" en contexto de consulta de regalo
  {
    id: 1,
    name: "Negativo 'asesor': 'Mi hermano es asesor contable, ¿qué le puedo regalar?'",
    input: "Mi hermano es asesor contable, ¿qué le puedo regalar?",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Contiene 'asesor' como profesión del destinatario; debe ir a cotización/regalos y no derivar.",
  },

  // 2. Negativo de "atención al cliente" en consulta de horario
  {
    id: 2,
    name: "Negativo 'atención al cliente': '¿Cuál es el horario de atención al cliente?'",
    input: "¿Cuál es el horario de atención al cliente?",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Contiene 'atención al cliente' pero es una consulta informativa sobre horario.",
  },

  // 3. Reclamo con mención de producto (precedencia de reclamo sobre producto)
  {
    id: 3,
    name: "Reclamo con producto: 'La billetera que me llegó tiene un defecto en el cierre'",
    input: "La billetera que me llegó tiene un defecto en el cierre",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Menciona 'billetera' pero contiene reclamo 'defecto'; prima reclamo -> derivar a humano.",
  },

  // 4. Fidelidad de material (cuero sintético vs cuero genuino)
  {
    id: 4,
    name: "Material real: '¿Las billeteras son de cuero genuino?'",
    input: "¿Las billeteras son de cuero genuino?",
    expectedAgent: "support",
    expectedHandoff: false,
    checkContent: (res) => {
      const lower = res.toLowerCase();
      // No debe afirmar que son de cuero genuino, debe aclarar que son de cuero sintético
      return lower.includes("sintético") || lower.includes("sintetico") || lower.includes("no son de cuero genuino") || lower.includes("no disponemos de cuero genuino");
    },
    description: "Debe responder con la verdad del catálogo (cuero sintético) y no derivar.",
  },

  // 5. Consulta por color no disponible (kit de mate lila con stock 0)
  {
    id: 5,
    name: "Color no disponible: '¿Tienen kit de mate lila?'",
    input: "¿Tienen kit de mate lila?",
    expectedAgent: "support",
    expectedHandoff: false,
    checkContent: (res) => {
      const lower = res.toLowerCase();
      return (
        lower.includes("no") &&
        (lower.includes("lila") || lower.includes("disponible") || lower.includes("stock") || lower.includes("catálogo") || lower.includes("catalogo"))
      );
    },
    description: "Kit de mate lila no está disponible en Firestore; no inventar stock y ofrecer opciones.",
  },

  // 6. Cortesía sin derivación
  {
    id: 6,
    name: "Cortesía: '¡Muchas gracias por la atención, que tengan lindo día!'",
    input: "¡Muchas gracias por la atención, que tengan lindo día!",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Agradecimiento con 'atención'; no debe derivar por cortesía.",
  },

  // 7. Rechazo a bot / pedido explícito de humano
  {
    id: 7,
    name: "Rechazo a bot: 'No quiero hablar con un robot, pasame con una persona'",
    input: "No quiero hablar con un robot, pasame con una persona",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Solicitud inequívoca de persona humana; debe derivar inmediatamente.",
  },

  // 8. Reclamo de mal funcionamiento sobre producto
  {
    id: 8,
    name: "Reclamo funcional: 'El termo que compré no calienta nada'",
    input: "El termo que compré no calienta nada",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Reclamo de funcionamiento de termo; debe derivar a humano.",
  },

  // 9. Intención de compra mencionando 'ventas' / 'alguien'
  {
    id: 9,
    name: "Compra con 'ventas': 'Quiero hablar con alguien de ventas para comprar 3 vasos'",
    input: "Quiero hablar con alguien de ventas para comprar 3 vasos",
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Intención clara de compra de producto; canalizar por budget.",
  },

  // 10. Devolución por producto roto
  {
    id: 10,
    name: "Devolución / rotura: 'Me comunico para devolver una taza rota'",
    input: "Me comunico para devolver una taza rota",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Reclamo de rotura y devolución; debe derivar a humano.",
  },

  // 11. Consulta de color inexistente en catálogo
  {
    id: 11,
    name: "Color inexistente: '¿Tienen billeteras de color verde fosforescente?'",
    input: "¿Tienen billeteras de color verde fosforescente?",
    expectedAgent: "support",
    expectedHandoff: false,
    checkContent: (res) => {
      const lower = res.toLowerCase();
      return lower.includes("no") && (lower.includes("verde") || lower.includes("dispon") || lower.includes("color"));
    },
    description: "Color no existente en Firestore; indicar que no disponemos de ese color sin inventar.",
  },

  // 12. Disputa de cobro / sobrefacturación
  {
    id: 12,
    name: "Disputa de cobro: 'Quiero devolver el producto porque me cobraron de más'",
    input: "Quiero devolver el producto porque me cobraron de más",
    expectedAgent: "handoff",
    expectedHandoff: true,
    description: "Reclamo administrativo / sobrefacturación; debe derivar a humano.",
  },

  // 13. Selección de menú numérico '1' tras opciones de escalada
  {
    id: 13,
    name: "Menú numérico '1': Cliente responde '1' tras recibir opciones",
    sequence: [
      { input: "¿Reparan pantallas de iPhone?" }, // Fallo 1
      { input: "¿Y arreglan baterías de auto?" }, // Fallo 2 -> envía opciones 1, 2, 3
      { input: "1" }, // Selecciona 1 (Catálogo/Cotizar)
    ],
    expectedAgent: "budget",
    expectedHandoff: false,
    description: "Respuesta '1' tras menú de opciones de escalada debe ir a cotización/catálogo.",
  },

  // 14. Selección de menú numérico '3' tras opciones de escalada
  {
    id: 14,
    name: "Menú numérico '3': Cliente responde '3' tras recibir opciones",
    sequence: [
      { input: "¿Reparan pantallas de iPhone?" }, // Fallo 1
      { input: "¿Y arreglan baterías de auto?" }, // Fallo 2 -> envía opciones 1, 2, 3
      { input: "3" }, // Selecciona 3 (Estado de pedido)
    ],
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Respuesta '3' tras menú de opciones de escalada debe ir a consulta de estado de pedido.",
  },

  // 15. Negativo de 'asesores' en consulta sobre visitas a domicilio
  {
    id: 15,
    name: "Negativo 'asesores': '¿Tienen asesores que vengan a domicilio?'",
    input: "¿Tienen asesores que vengan a domicilio?",
    expectedAgent: "support",
    expectedHandoff: false,
    description: "Pregunta sobre modalidad presencial/domicilio; responder política de tienda física/envíos sin derivar.",
  },
];

async function runHardEvaluation() {
  console.log("==================================================================");
  console.log("🚀 EJECUTANDO SUITE DE EVALUACIÓN: 15 CASOS DIFÍCILES");
  console.log("==================================================================\n");

  const results = [];

  for (const testCase of HARD_TEST_CASES) {
    const threadId = `eval_hard_${Date.now()}_${testCase.id}`;
    process.stdout.write(`[Caso ${testCase.id}/15] ${testCase.name} ... `);

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
      } else if (
        finalState.intent === "customer_support" ||
        finalState.intent === "order_status" ||
        finalState.intent === "payment_proof"
      ) {
        actualAgent = "support";
      } else if (actualHandoff) {
        actualAgent = "handoff";
      }

      const agentMatched = actualAgent === testCase.expectedAgent;
      const handoffMatched = actualHandoff === testCase.expectedHandoff;

      const lastAiMessage = finalState.messages?.[finalState.messages.length - 1]?.content || "";
      let contentPassed = true;
      if (typeof testCase.checkContent === "function" && typeof lastAiMessage === "string") {
        contentPassed = testCase.checkContent(lastAiMessage);
      }

      const passed = agentMatched && handoffMatched && contentPassed;
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
        contentPassed,
        passed,
        reason: finalState.humanHandoffReason || "",
        responseSnippet: snippet,
      });

      console.log(
        passed
          ? "✅ OK"
          : `❌ FALLÓ (Esperaba: ${testCase.expectedAgent}, Derivar=${testCase.expectedHandoff} | Obtuvo: ${actualAgent}, Derivar=${actualHandoff}${!contentPassed ? " [Contenido erróneo]" : ""})`
      );
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
        contentPassed: false,
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
  const contentCorrect = results.filter((r) => r.contentPassed).length;
  const totalPassed = results.filter((r) => r.passed).length;
  const totalDerivations = results.filter((r) => r.actualHandoff).length;

  console.log("\n==================================================================");
  console.log("📊 RESULTADOS DE LA EVALUACIÓN: CASOS DIFÍCILES");
  console.log("==================================================================");
  console.log(`Total de Casos Evaluados: ${total}`);
  console.log(`Exactitud de Ruteo: ${agentCorrect}/${total} (${((agentCorrect / total) * 100).toFixed(1)}%)`);
  console.log(`Exactitud de Handoff: ${handoffCorrect}/${total} (${((handoffCorrect / total) * 100).toFixed(1)}%)`);
  console.log(`Exactitud de Contenido Verificado: ${contentCorrect}/${total} (${((contentCorrect / total) * 100).toFixed(1)}%)`);
  console.log(`Tasa de Derivación a Humano: ${totalDerivations}/${total} (${((totalDerivations / total) * 100).toFixed(1)}%) (Esperada: 5/15 = 33.3%)`);
  console.log(`Casos Aprobados al 100%: ${totalPassed}/${total} (${((totalPassed / total) * 100).toFixed(1)}%)`);
  console.log("==================================================================\n");

  console.log("### Tabla de Casos Difíciles\n");
  console.log("| # | Caso | Entrada | Agente Esp. | Agente Real | Derivar Esp. | Derivar Real | Estado | Respuesta / Motivo |");
  console.log("|---|------|---------|-------------|-------------|--------------|--------------|:------:|--------------------|");

  for (const r of results) {
    const statusIcon = r.passed ? "✅ PASS" : "❌ FAIL";
    const cleanInput = (r.input || "").replace(/\|/g, "\\|");
    const cleanSnippet = (r.responseSnippet || r.reason || "").replace(/\|/g, "\\|").slice(0, 45);
    console.log(
      `| ${r.id} | ${r.name.slice(0, 25)} | "${cleanInput.slice(0, 25)}" | ${r.expectedAgent} | ${r.actualAgent} | ${r.expectedHandoff ? "Sí" : "No"} | ${r.actualHandoff ? "Sí" : "No"} | ${statusIcon} | ${cleanSnippet}... |`
    );
  }

  const failedCases = results.filter((r) => !r.passed);
  if (failedCases.length > 0) {
    console.log("\n### Casos que Fallaron:");
    for (const f of failedCases) {
      console.log(
        `- **Caso ${f.id} (${f.name})**: Entrada "${f.input}". Esperaba Agente=${f.expectedAgent}, Derivar=${f.expectedHandoff}. Obtuvo Agente=${f.actualAgent}, Derivar=${f.actualHandoff}. Motivo: ${f.reason || "Respuesta: " + f.responseSnippet}`
      );
    }
  } else {
    console.log("\n🎉 ¡Todos los casos difíciles pasaron exitosamente!");
  }

  return { total, agentCorrect, handoffCorrect, totalPassed, totalDerivations, results };
}

runHardEvaluation()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal hard evaluation error:", err);
    process.exit(1);
  });
