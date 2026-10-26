import { createHash } from "node:crypto";
import { modelUsageForComponent } from "../utils/model-usage.util.js";

export const maskedChat = chatId => "chat-" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 12);
const consumption = usage => ({ calls: usage.calls, tokens: usage.reportedTokens,
  cachedContentTokenCount: usage.cachedContentTokenCount, cacheUsageReportedCalls: usage.cacheUsageReportedCalls,
  usageComplete: usage.usageComplete });
// No recibe argumentos de herramientas, mensajes, resultados libres ni prompts.
export function createAgentTurnTelemetry({ chatId, logger }) {
  const chat = maskedChat(chatId);
  let batch = null, tools = [];
  return {
    start({ batchId }) { batch = batchId; tools = []; },
    tool({ batchId, name, code, durationMs }) {
      if (!batchId || batchId === batch) tools.push(name);
      logger({ event: "agent_tool", chat, batch: batchId ?? batch, tool: name, code, durationMs });
    },
    finish({ batchId, groupedMessages, media, outcome, durationMs, queueWaitMs, handoff, usage }) {
      logger({ event: "agent_turn", chat, batch: batchId, groupedMessages, media, result: outcome,
        durationMs, queueWaitMs, tools: [...tools], handoff, consumption: {
          agent: consumption(modelUsageForComponent(usage, "agent")),
          transcription: consumption(modelUsageForComponent(usage, "transcription")),
        } });
      batch = null; tools = [];
    },
  };
}
