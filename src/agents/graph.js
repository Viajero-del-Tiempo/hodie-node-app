import { StateGraph, END } from "@langchain/langgraph";
import { AgentStateAnnotation } from "./state.js";
import { FirestoreCheckpointSaver } from "./checkpointer/firestore.checkpointer.js";
import { routerNode, routeMessage } from "./nodes/router.node.js";
import { budgetAgentNode } from "./nodes/budget.node.js";
import { supportAgentNode } from "./nodes/support.node.js";
import { handoffNode } from "./nodes/handoff.node.js";

/**
 * Topología del grafo multi-agente de HoDie:
 *
 * 1. Entry point: "router_node" (orquestador que clasifica y decide el flujo).
 * 2. Enrutamiento condicional desde "router_node":
 *    a) Si el handoff humano ya estaba activo de un turno anterior (intervención humana en curso),
 *       el router finaliza directamente en END sin invocar ningún agente (silencio del bot).
 *    b) Si se solicita handoff, hay quejas o fallo/timeout del clasificador -> "human_handoff_node".
 *    c) Si hay intención de presupuesto o conversación activa de cotización -> "budget_agent_node".
 *    d) Si hay consultas de soporte, seguimiento, comprobantes o FAQ -> "support_agent_node".
 * 3. Todos los agentes ejecutores terminan su turno volviendo al final del grafo (END).
 */

const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("router_node", routerNode)
  .addNode("budget_agent_node", budgetAgentNode)
  .addNode("support_agent_node", supportAgentNode)
  .addNode("human_handoff_node", handoffNode);

workflow.setEntryPoint("router_node");

workflow.addConditionalEdges(
  "router_node",
  (state) => {
    // 1.a Silencio durante handoff humano activo:
    // Si el router detectó handoff ya activo (intent === "handoff_active_silence"),
    // terminar inmediatamente en END sin invocar ningún agente (silencio del bot).
    // Esta señal es determinística y no depende de campos secundarios (como humanHandoffReason
    // o adminNotification) que otros nodos ejecutores pudieran haber dejado cargados.
    if (state.intent === "handoff_active_silence") {
      return END;
    }

    // Delegación oficial a través de la función de enrutamiento del router
    return routeMessage(state);
  },
  {
    human_handoff_node: "human_handoff_node",
    budget_agent_node: "budget_agent_node",
    support_agent_node: "support_agent_node",
    [END]: END,
  }
);

// Nodos terminales retornan a END al finalizar su turno
workflow.addEdge("budget_agent_node", END);
workflow.addEdge("support_agent_node", END);
workflow.addEdge("human_handoff_node", END);

// Checkpointer en Firestore para persistencia conversacional por hilo (userPhoneNumber)
export const checkpointer = new FirestoreCheckpointSaver();

// Grafo compilado listo para invocación
export const compiledGraph = workflow.compile({
  checkpointer,
});
